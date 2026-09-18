/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * A small SMTP submission client on top of node:net and node:tls.
 *
 * It speaks exactly what an outbound notification needs: EHLO, optional
 * STARTTLS, AUTH PLAIN or LOGIN, one MAIL FROM, one or more RCPT TO, DATA and
 * QUIT. Every reply is awaited before the next command so any server that
 * follows RFC 5321 works, and every step is bounded by a timeout so a stalled
 * relay cannot hold a request open. The MIME body is built here too, so no
 * mail library is pulled into the dependency tree.
 */

import net from 'net';
import tls from 'tls';
import crypto from 'crypto';
import os from 'os';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SmtpConfig {
  host: string;
  port: number;
  /**
   * `tls` opens an implicit TLS connection (port 465 style), `starttls`
   * connects in clear text and upgrades before any credential is sent,
   * `none` stays in clear text (for relays on a trusted network only).
   */
  security: SmtpSecurity;
  username?: string;
  password?: string;
  /** Verify the server certificate. Only disable for a self-signed relay. */
  rejectUnauthorized?: boolean;
  /** Per-step timeout in milliseconds. */
  timeoutMs?: number;
  /** Name announced in EHLO; defaults to the host name. */
  clientName?: string;
}

export interface SmtpMessage {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Extra headers, values are sanitized against header injection. */
  headers?: Record<string, string>;
}

export type SmtpErrorCode =
  | 'ERR_SMTP_CONFIG'
  | 'ERR_SMTP_CONNECT'
  | 'ERR_SMTP_TIMEOUT'
  | 'ERR_SMTP_TLS'
  | 'ERR_SMTP_AUTH'
  | 'ERR_SMTP_REJECTED'
  | 'ERR_SMTP_RESPONSE';

export interface SmtpReply {
  code: number;
  lines: string[];
}

export class SmtpError extends Error {
  readonly name = 'SmtpError';
  readonly code: SmtpErrorCode;
  readonly reply?: SmtpReply;

  constructor(code: SmtpErrorCode, message: string, reply?: SmtpReply) {
    super(message);
    this.code = code;
    this.reply = reply;
  }
}

export interface SmtpSendResult {
  accepted: string[];
  /** The final DATA reply text, useful for queue ids in logs. */
  response: string;
}

export interface SmtpVerifyResult {
  greeting: string;
  extensions: string[];
  secure: boolean;
  authenticated: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 64 * 1024;
const ADDRESS_FORBIDDEN = new Set([...'<>"\',;']);

const isAddressPart = (part: string): boolean => {
  if (!part) return false;
  for (const character of part) {
    if (ADDRESS_FORBIDDEN.has(character) || /\s/.test(character)) return false;
  }
  return true;
};

/**
 * True when `value` looks like a bare mailbox address (no display name):
 * one `@`, a non-empty local part, and a domain with a dot that has text on
 * both sides. Written without a backtracking regex on purpose.
 */
export const isEmailAddress = (value: string): boolean => {
  const trimmed = value.trim();
  const at = trimmed.indexOf('@');
  if (at <= 0 || at !== trimmed.lastIndexOf('@')) return false;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || dot === domain.length - 1) return false;
  return (
    isAddressPart(local) &&
    isAddressPart(domain.slice(0, dot)) &&
    isAddressPart(domain.slice(dot + 1))
  );
};

/** Pulls the bare address out of `Display Name <user@host>` or a plain address. */
export const extractEmailAddress = (value: string): string | null => {
  const trimmed = value.trim();
  const angled = trimmed.match(/<([^<>]+)>\s*$/);
  const candidate = (angled ? angled[1] : trimmed).trim();
  return isEmailAddress(candidate) ? candidate : null;
};

const stripHeaderBreaks = (value: string): string =>
  value.replace(/[\r\n\0]+/g, ' ').trim();

const needsEncodedWord = (value: string): boolean => /[^\x20-\x7e]/.test(value);

const encodeHeaderWord = (value: string): string =>
  needsEncodedWord(value)
    ? `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
    : value;

const wrapBase64 = (bytes: Buffer): string =>
  bytes
    .toString('base64')
    .replace(/(.{76})/g, '$1\r\n')
    .replace(/\r\n$/, '');

const encodeMailbox = (value: string): string => {
  const trimmed = stripHeaderBreaks(value);
  const angled = trimmed.match(/^(.*?)\s*<([^<>]+)>$/);
  if (!angled) return trimmed;
  const name = angled[1].replace(/^"|"$/g, '');
  const address = angled[2].trim();
  if (!name) return `<${address}>`;
  const encodedName = needsEncodedWord(name)
    ? encodeHeaderWord(name)
    : `"${name.replace(/["\\]/g, '\\$&')}"`;
  return `${encodedName} <${address}>`;
};

/**
 * Builds the RFC 5322 message: text only, or multipart/alternative when HTML
 * is supplied. Bodies travel as base64 so line length and 8-bit content never
 * depend on server extensions.
 */
export const buildMimeMessage = (
  message: SmtpMessage,
  options: { date?: Date; messageIdDomain?: string } = {}
): string => {
  const fromAddress = extractEmailAddress(message.from);
  if (!fromAddress) {
    throw new SmtpError('ERR_SMTP_CONFIG', 'The sender address is not valid.');
  }
  const date = options.date ?? new Date();
  const domain =
    options.messageIdDomain ?? fromAddress.slice(fromAddress.indexOf('@') + 1);
  const headers: string[] = [
    `From: ${encodeMailbox(message.from)}`,
    `To: ${message.to.map(encodeMailbox).join(', ')}`,
    `Subject: ${encodeHeaderWord(stripHeaderBreaks(message.subject))}`,
    `Date: ${date.toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  for (const [name, value] of Object.entries(message.headers ?? {})) {
    const cleanName = name.replace(/[^A-Za-z0-9-]/g, '');
    if (!cleanName) continue;
    headers.push(`${cleanName}: ${stripHeaderBreaks(value)}`);
  }

  const textPart = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.text, 'utf8')),
  ].join('\r\n');

  if (!message.html) {
    return `${headers.join('\r\n')}\r\n${textPart}\r\n`;
  }

  const boundary = `=_libre_${crypto.randomBytes(12).toString('hex')}`;
  const htmlPart = [
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(message.html, 'utf8')),
  ].join('\r\n');
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    textPart,
    `--${boundary}`,
    htmlPart,
    `--${boundary}--`,
    '',
  ].join('\r\n');
};

/** Escapes leading dots so the body can never terminate DATA early. */
const dotStuff = (body: string): string =>
  body.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..');

interface Connection {
  socket: net.Socket;
  timeoutMs: number;
  buffer: string;
  extensions: string[];
  secure: boolean;
}

const failure = (
  code: SmtpErrorCode,
  message: string,
  reply?: SmtpReply
): SmtpError => new SmtpError(code, message, reply);

const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
  what: string
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        failure(
          'ERR_SMTP_TIMEOUT',
          `The mail server did not respond to ${what} within ${timeoutMs} ms.`
        )
      );
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });

const readReply = (connection: Connection, what: string): Promise<SmtpReply> =>
  withTimeout(
    new Promise<SmtpReply>((resolve, reject) => {
      const { socket } = connection;
      const tryParse = (): boolean => {
        const lines = connection.buffer.split('\r\n');
        const complete: string[] = [];
        for (let index = 0; index < lines.length - 1; index += 1) {
          const line = lines[index];
          complete.push(line);
          if (/^\d{3}(?: |$)/.test(line)) {
            connection.buffer = lines.slice(index + 1).join('\r\n');
            const code = Number.parseInt(line.slice(0, 3), 10);
            const consistent = complete.every(
              entry => entry.slice(0, 3) === line.slice(0, 3)
            );
            if (!consistent) {
              reject(
                failure(
                  'ERR_SMTP_RESPONSE',
                  'The mail server sent a malformed multi-line reply.'
                )
              );
              return true;
            }
            resolve({ code, lines: complete.map(entry => entry.slice(4)) });
            return true;
          }
          if (!/^\d{3}-/.test(line)) {
            reject(
              failure(
                'ERR_SMTP_RESPONSE',
                `The mail server sent an unexpected line: ${line.slice(0, 80)}`
              )
            );
            return true;
          }
        }
        if (connection.buffer.length > MAX_REPLY_BYTES) {
          reject(
            failure('ERR_SMTP_RESPONSE', 'The mail server reply is too long.')
          );
          return true;
        }
        return false;
      };
      const cleanup = () => {
        socket.off('data', onData);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const onData = (chunk: Buffer) => {
        connection.buffer += chunk.toString('utf8');
        if (tryParse()) cleanup();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(
          failure('ERR_SMTP_CONNECT', `Connection error: ${error.message}`)
        );
      };
      const onClose = () => {
        cleanup();
        reject(
          failure(
            'ERR_SMTP_CONNECT',
            `The mail server closed the connection during ${what}.`
          )
        );
      };
      if (tryParse()) return;
      socket.on('data', onData);
      socket.on('error', onError);
      socket.on('close', onClose);
    }),
    connection.timeoutMs,
    what
  );

const command = async (
  connection: Connection,
  line: string,
  what: string,
  expected: number[]
): Promise<SmtpReply> => {
  connection.socket.write(`${line}\r\n`);
  const reply = await readReply(connection, what);
  if (!expected.includes(reply.code)) {
    const text = reply.lines.join(' ');
    if (what === 'AUTH') {
      throw failure(
        'ERR_SMTP_AUTH',
        `The mail server rejected the credentials (${reply.code} ${text}).`,
        reply
      );
    }
    throw failure(
      reply.code >= 500 || reply.code >= 400
        ? 'ERR_SMTP_REJECTED'
        : 'ERR_SMTP_RESPONSE',
      `${what} failed (${reply.code} ${text}).`,
      reply
    );
  }
  return reply;
};

const ehlo = async (connection: Connection, clientName: string) => {
  const reply = await command(connection, `EHLO ${clientName}`, 'EHLO', [250]);
  connection.extensions = reply.lines
    .slice(1)
    .map(line => line.trim().toUpperCase());
};

const hasExtension = (connection: Connection, name: string): boolean =>
  connection.extensions.some(
    entry => entry === name || entry.startsWith(`${name} `)
  );

const authMechanisms = (connection: Connection): string[] => {
  const line = connection.extensions.find(entry => entry.startsWith('AUTH'));
  if (!line) return [];
  return line
    .replace(/^AUTH[= ]/, '')
    .split(/\s+/)
    .filter(Boolean);
};

const sanitizeClientName = (value: string): string => {
  const cleaned = value.replace(/[^A-Za-z0-9.-]/g, '').slice(0, 253);
  return cleaned || 'libre-webui';
};

const openSocket = (
  config: SmtpConfig,
  timeoutMs: number
): Promise<{ socket: net.Socket; secure: boolean }> =>
  withTimeout(
    new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        reject(
          failure(
            'ERR_SMTP_CONNECT',
            `Could not connect to ${config.host}:${config.port} (${error.message}).`
          )
        );
      };
      if (config.security === 'tls') {
        const socket = tls.connect(
          {
            host: config.host,
            port: config.port,
            servername: config.host,
            rejectUnauthorized: config.rejectUnauthorized !== false,
          },
          () => {
            socket.off('error', onError);
            resolve({ socket, secure: true });
          }
        );
        socket.once('error', onError);
        return;
      }
      const socket = net.connect(
        { host: config.host, port: config.port },
        () => {
          socket.off('error', onError);
          resolve({ socket, secure: false });
        }
      );
      socket.once('error', onError);
    }),
    timeoutMs,
    'the connection'
  );

const upgradeToTls = (
  connection: Connection,
  config: SmtpConfig
): Promise<void> =>
  withTimeout(
    new Promise<void>((resolve, reject) => {
      const plain = connection.socket;
      plain.removeAllListeners('data');
      const secured = tls.connect(
        {
          socket: plain,
          servername: config.host,
          rejectUnauthorized: config.rejectUnauthorized !== false,
        },
        () => {
          secured.off('error', onError);
          connection.socket = secured;
          connection.secure = true;
          connection.buffer = '';
          resolve();
        }
      );
      const onError = (error: Error) => {
        reject(failure('ERR_SMTP_TLS', `STARTTLS failed: ${error.message}`));
      };
      secured.once('error', onError);
    }),
    connection.timeoutMs,
    'STARTTLS'
  );

const validateConfig = (config: SmtpConfig): void => {
  if (!config.host || !/^[A-Za-z0-9.\-[\]:]+$/.test(config.host)) {
    throw failure('ERR_SMTP_CONFIG', 'The SMTP host is not valid.');
  }
  if (
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535
  ) {
    throw failure(
      'ERR_SMTP_CONFIG',
      'The SMTP port must be between 1 and 65535.'
    );
  }
  if (!['tls', 'starttls', 'none'].includes(config.security)) {
    throw failure('ERR_SMTP_CONFIG', 'The SMTP security mode is not valid.');
  }
  if (
    (config.username && !config.password) ||
    (!config.username && config.password)
  ) {
    throw failure(
      'ERR_SMTP_CONFIG',
      'SMTP authentication needs both a username and a password.'
    );
  }
};

const authenticate = async (connection: Connection, config: SmtpConfig) => {
  if (!config.username) return false;
  if (!connection.secure && config.security !== 'none') {
    throw failure(
      'ERR_SMTP_TLS',
      'Refusing to send credentials over an unencrypted connection.'
    );
  }
  const mechanisms = authMechanisms(connection);
  const password = config.password ?? '';
  if (mechanisms.includes('PLAIN') || mechanisms.length === 0) {
    const token = Buffer.from(
      `\0${config.username}\0${password}`,
      'utf8'
    ).toString('base64');
    await command(connection, `AUTH PLAIN ${token}`, 'AUTH', [235]);
    return true;
  }
  if (mechanisms.includes('LOGIN')) {
    await command(connection, 'AUTH LOGIN', 'AUTH', [334]);
    await command(
      connection,
      Buffer.from(config.username, 'utf8').toString('base64'),
      'AUTH',
      [334]
    );
    await command(
      connection,
      Buffer.from(password, 'utf8').toString('base64'),
      'AUTH',
      [235]
    );
    return true;
  }
  throw failure(
    'ERR_SMTP_AUTH',
    `The mail server offers no supported authentication mechanism (${mechanisms.join(', ')}).`
  );
};

const closeQuietly = (connection: Connection | null) => {
  if (!connection) return;
  const { socket } = connection;
  socket.removeAllListeners('error');
  socket.on('error', () => undefined);
  socket.end();
  setTimeout(() => socket.destroy(), 1_000).unref();
};

const connect = async (config: SmtpConfig): Promise<Connection> => {
  validateConfig(config);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const clientName = sanitizeClientName(config.clientName ?? os.hostname());
  const { socket, secure } = await openSocket(config, timeoutMs);
  const connection: Connection = {
    socket,
    timeoutMs,
    buffer: '',
    extensions: [],
    secure,
  };
  socket.setNoDelay(true);
  try {
    const greeting = await readReply(connection, 'the greeting');
    if (greeting.code !== 220) {
      throw failure(
        'ERR_SMTP_RESPONSE',
        `The mail server refused the session (${greeting.code} ${greeting.lines.join(' ')}).`,
        greeting
      );
    }
    await ehlo(connection, clientName);
    if (config.security === 'starttls') {
      if (!hasExtension(connection, 'STARTTLS')) {
        throw failure(
          'ERR_SMTP_TLS',
          'The mail server does not offer STARTTLS on this port.'
        );
      }
      await command(connection, 'STARTTLS', 'STARTTLS', [220]);
      await upgradeToTls(connection, config);
      await ehlo(connection, clientName);
    }
    return connection;
  } catch (error) {
    // A half-open session must not outlive the failure that ended it.
    closeQuietly(connection);
    throw error;
  }
};

const quit = async (connection: Connection) => {
  try {
    connection.socket.write('QUIT\r\n');
    await readReply(connection, 'QUIT');
  } catch {
    // The message is already accepted; a rude close is not a failure.
  } finally {
    closeQuietly(connection);
  }
};

/**
 * Opens a session, authenticates when credentials are configured, and closes
 * again without sending anything. Used by the admin "Test connection" action.
 */
export async function verifySmtpConnection(
  config: SmtpConfig
): Promise<SmtpVerifyResult> {
  let connection: Connection | null = null;
  try {
    connection = await connect(config);
    const authenticated = await authenticate(connection, config);
    const result: SmtpVerifyResult = {
      greeting: connection.extensions[0] ?? '',
      extensions: [...connection.extensions],
      secure: connection.secure,
      authenticated,
    };
    await quit(connection);
    connection = null;
    return result;
  } catch (error) {
    closeQuietly(connection);
    throw error;
  }
}

/** Delivers one message and returns the accepted recipients. */
export async function sendSmtpMail(
  config: SmtpConfig,
  message: SmtpMessage
): Promise<SmtpSendResult> {
  const fromAddress = extractEmailAddress(message.from);
  if (!fromAddress) {
    throw failure('ERR_SMTP_CONFIG', 'The sender address is not valid.');
  }
  const recipients = message.to.map(extractEmailAddress);
  if (recipients.length === 0 || recipients.some(entry => !entry)) {
    throw failure('ERR_SMTP_CONFIG', 'A recipient address is not valid.');
  }
  const mime = buildMimeMessage(message);

  let connection: Connection | null = null;
  try {
    connection = await connect(config);
    await authenticate(connection, config);
    await command(connection, `MAIL FROM:<${fromAddress}>`, 'MAIL FROM', [250]);
    const accepted: string[] = [];
    for (const recipient of recipients as string[]) {
      await command(
        connection,
        `RCPT TO:<${recipient}>`,
        'RCPT TO',
        [250, 251]
      );
      accepted.push(recipient);
    }
    await command(connection, 'DATA', 'DATA', [354]);
    connection.socket.write(`${dotStuff(mime)}\r\n.\r\n`);
    const reply = await readReply(connection, 'the message');
    if (reply.code !== 250) {
      throw failure(
        'ERR_SMTP_REJECTED',
        `The mail server rejected the message (${reply.code} ${reply.lines.join(' ')}).`,
        reply
      );
    }
    await quit(connection);
    connection = null;
    return { accepted, response: reply.lines.join(' ') };
  } catch (error) {
    closeQuietly(connection);
    throw error;
  }
}
