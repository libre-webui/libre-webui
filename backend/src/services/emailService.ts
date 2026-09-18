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
 * Outbound email for notifications.
 *
 * Administrators configure one SMTP server under Settings > User Management
 * > Access & policies; environment variables seed the same fields for
 * container deployments. Users then opt in per kind of notification from
 * Settings > Notifications. Delivery rides the durable job runtime like Web
 * Push, so a slow relay never blocks the request that produced the event and
 * a transient failure is retried.
 */

import { encryptionService } from './encryptionService.js';
import {
  getSystemSettings,
  setSystemSettings,
} from './systemSettingsService.js';
import { userModel } from '../models/userModel.js';
import preferencesService from './preferencesService.js';
import {
  extractEmailAddress,
  isEmailAddress,
  sendSmtpMail,
  verifySmtpConnection,
  SmtpError,
  type SmtpConfig,
  type SmtpSecurity,
} from '../utils/smtpClient.js';
import { createLogger } from '../utils/logger.js';
import {
  DEFAULT_EMAIL_MARKDOWN_THEME,
  escapeHtml,
  renderMarkdownForEmail,
} from '../utils/emailMarkdown.js';
import type { EmailNotificationPreferences } from '../types/index.js';
import {
  EMAIL_DELIVER_IDEMPOTENCY_SCOPE,
  EMAIL_DELIVER_JOB_TYPE,
} from '../platform/jobs/domainJobContracts.js';

const logger = createLogger('email');

const KEYS = {
  enabled: 'email.enabled',
  host: 'email.smtp.host',
  port: 'email.smtp.port',
  security: 'email.smtp.security',
  username: 'email.smtp.username',
  password: 'email.smtp.password',
  from: 'email.smtp.from',
  rejectUnauthorized: 'email.smtp.reject_unauthorized',
  appUrl: 'email.app_url',
} as const;

const ENV = {
  host: 'SMTP_HOST',
  port: 'SMTP_PORT',
  security: 'SMTP_SECURITY',
  username: 'SMTP_USER',
  password: 'SMTP_PASSWORD',
  from: 'SMTP_FROM',
  rejectUnauthorized: 'SMTP_TLS_REJECT_UNAUTHORIZED',
  appUrl: 'BASE_URL',
} as const;

const SECURITY_MODES: readonly SmtpSecurity[] = ['tls', 'starttls', 'none'];
const MAX_TEXT_LENGTH = 6_000;
const MAX_SUBJECT_LENGTH = 200;

export type EmailSettingSource = 'stored' | 'env' | 'default';

/** What administrators see: everything except the password itself. */
export interface EmailSettingsView {
  enabled: boolean;
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  passwordConfigured: boolean;
  from: string;
  rejectUnauthorized: boolean;
  appUrl: string;
  /** Host, sender and port are present, whatever the enabled switch says. */
  configured: boolean;
  /** Enabled and configured: users may opt in. */
  available: boolean;
  sources: Record<
    'host' | 'port' | 'security' | 'username' | 'password' | 'from' | 'appUrl',
    EmailSettingSource
  >;
}

export interface EmailSettingsUpdate {
  enabled?: boolean;
  host?: string;
  port?: number | string;
  security?: string;
  username?: string;
  /** `undefined` keeps the stored password; an empty string clears it. */
  password?: string;
  from?: string;
  rejectUnauthorized?: boolean;
  appUrl?: string;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailDeliveryPayload extends EmailMessage {
  /** Which preference authorized the message; kept for the ledger. */
  kind: keyof EmailNotificationPreferences | 'test';
}

export class EmailSettingsError extends Error {
  readonly name = 'EmailSettingsError';
}

const envValue = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined ? undefined : value.trim();
};

const parsePort = (value: string | undefined): number | undefined => {
  if (value === undefined || value === '') return undefined;
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? port
    : undefined;
};

const parseSecurity = (value: string | undefined): SmtpSecurity | undefined => {
  const lowered = value?.trim().toLowerCase();
  return SECURITY_MODES.find(mode => mode === lowered);
};

const parseBoolean = (value: string | undefined): boolean | undefined => {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
};

const defaultPortFor = (security: SmtpSecurity): number =>
  security === 'tls' ? 465 : 587;

const normalizeAppUrl = (value: string): string => {
  // Strip trailing slashes without a regex: an end-anchored /\/+$/ backtracks
  // polynomially on a long run of slashes (CodeQL js/polynomial-redos).
  let trimmed = value.trim();
  let end = trimmed.length;
  while (end > 0 && trimmed.charCodeAt(end - 1) === 0x2f) {
    end -= 1;
  }
  trimmed = trimmed.slice(0, end);
  if (!trimmed) return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EmailSettingsError(
      'The application URL must be a valid http(s) URL.'
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EmailSettingsError('The application URL must use http or https.');
  }
  return trimmed;
};

const normalizeHost = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!/^[A-Za-z0-9.\-[\]:]+$/.test(trimmed) || trimmed.length > 253) {
    throw new EmailSettingsError('The SMTP host is not valid.');
  }
  return trimmed;
};

const normalizeFrom = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (!extractEmailAddress(trimmed)) {
    throw new EmailSettingsError(
      'The sender must be an email address, optionally with a display name.'
    );
  }
  return trimmed;
};

interface ResolvedSettings {
  view: EmailSettingsView;
  password: string;
}

class EmailService {
  private cache: ResolvedSettings | null = null;

  /** Drops the memoized settings; called after every admin update. */
  invalidate(): void {
    this.cache = null;
  }

  private async resolve(): Promise<ResolvedSettings> {
    if (this.cache) return this.cache;
    const stored = await getSystemSettings(Object.values(KEYS));

    const pick = <T>(
      key: keyof typeof ENV,
      parse: (value: string | undefined) => T | undefined,
      fallback: T
    ): { value: T; source: EmailSettingSource } => {
      // A stored value wins; a cleared field falls back to the environment
      // so an operator-provided default can be restored from the UI.
      const storedValue = stored[KEYS[key]];
      if (storedValue !== undefined && storedValue !== '') {
        const parsed = parse(storedValue);
        if (parsed !== undefined) return { value: parsed, source: 'stored' };
      }
      const parsed = parse(envValue(ENV[key]));
      if (parsed !== undefined) return { value: parsed, source: 'env' };
      return { value: fallback, source: 'default' };
    };

    const text = (value: string | undefined) =>
      value === undefined || value === '' ? undefined : value;

    const host = pick('host', text, '');
    const security = pick(
      'security',
      parseSecurity,
      'starttls' as SmtpSecurity
    );
    const port = pick('port', parsePort, defaultPortFor(security.value));
    const username = pick('username', text, '');
    const from = pick('from', text, '');
    const rejectUnauthorized = pick('rejectUnauthorized', parseBoolean, true);
    const appUrl = pick('appUrl', text, '');

    let password = '';
    let passwordSource: EmailSettingSource = 'default';
    const storedPassword = stored[KEYS.password];
    if (storedPassword) {
      try {
        password = encryptionService.decryptAuthenticated(storedPassword);
        passwordSource = 'stored';
      } catch (error) {
        logger.error('The stored SMTP password could not be decrypted', {
          error,
        });
      }
    } else {
      const fromEnv = envValue(ENV.password);
      if (fromEnv) {
        password = fromEnv;
        passwordSource = 'env';
      }
    }

    const enabled = stored[KEYS.enabled] === 'true';
    const configured = host.value.length > 0 && from.value.length > 0;
    const resolved: ResolvedSettings = {
      password,
      view: {
        enabled,
        host: host.value,
        port: port.value,
        security: security.value,
        username: username.value,
        passwordConfigured: password.length > 0,
        from: from.value,
        rejectUnauthorized: rejectUnauthorized.value,
        appUrl: appUrl.value,
        configured,
        available: enabled && configured,
        sources: {
          host: host.source,
          port: port.source,
          security: security.source,
          username: username.source,
          password: passwordSource,
          from: from.source,
          appUrl: appUrl.source,
        },
      },
    };
    this.cache = resolved;
    return resolved;
  }

  async getSettings(): Promise<EmailSettingsView> {
    return (await this.resolve()).view;
  }

  /** Whether users may opt into email notifications right now. */
  async isAvailable(): Promise<boolean> {
    return (await this.resolve()).view.available;
  }

  async updateSettings(
    update: EmailSettingsUpdate
  ): Promise<EmailSettingsView> {
    const current = await this.resolve();
    const values: Record<string, string> = {};

    if (update.host !== undefined)
      values[KEYS.host] = normalizeHost(update.host);
    if (update.security !== undefined) {
      const security = parseSecurity(update.security);
      if (!security) {
        throw new EmailSettingsError('The SMTP security mode is not valid.');
      }
      values[KEYS.security] = security;
    }
    if (update.port !== undefined) {
      const raw = String(update.port).trim();
      if (raw === '') {
        values[KEYS.port] = '';
      } else {
        const port = parsePort(raw);
        if (port === undefined) {
          throw new EmailSettingsError(
            'The SMTP port must be between 1 and 65535.'
          );
        }
        values[KEYS.port] = String(port);
      }
    }
    if (update.username !== undefined) {
      values[KEYS.username] = update.username.trim().slice(0, 320);
    }
    if (update.password !== undefined) {
      const password = update.password;
      if (password.length > 1024) {
        throw new EmailSettingsError('The SMTP password is too long.');
      }
      values[KEYS.password] = password
        ? encryptionService.encrypt(password)
        : '';
    }
    if (update.from !== undefined)
      values[KEYS.from] = normalizeFrom(update.from);
    if (update.rejectUnauthorized !== undefined) {
      values[KEYS.rejectUnauthorized] = update.rejectUnauthorized
        ? 'true'
        : 'false';
    }
    if (update.appUrl !== undefined) {
      values[KEYS.appUrl] = normalizeAppUrl(update.appUrl);
    }

    const nextHost =
      update.host !== undefined ? values[KEYS.host] : current.view.host;
    const nextFrom =
      update.from !== undefined ? values[KEYS.from] : current.view.from;
    const nextUsername =
      update.username !== undefined
        ? values[KEYS.username]
        : current.view.username;
    const nextPasswordConfigured =
      update.password !== undefined
        ? update.password.length > 0
        : current.view.passwordConfigured;
    if (update.enabled !== undefined) {
      if (update.enabled && (!nextHost || !nextFrom)) {
        throw new EmailSettingsError(
          'Enable email only with an SMTP host and a sender address configured.'
        );
      }
      values[KEYS.enabled] = update.enabled ? 'true' : 'false';
    }
    if (
      (nextUsername && !nextPasswordConfigured) ||
      (!nextUsername && nextPasswordConfigured)
    ) {
      throw new EmailSettingsError(
        'SMTP authentication needs both a username and a password.'
      );
    }

    if (Object.keys(values).length > 0) {
      await setSystemSettings(values);
    }
    this.invalidate();
    return (await this.resolve()).view;
  }

  private async smtpConfig(): Promise<SmtpConfig> {
    const { view, password } = await this.resolve();
    if (!view.configured) {
      throw new EmailSettingsError(
        'Configure an SMTP host and a sender address first.'
      );
    }
    return {
      host: view.host,
      port: view.port,
      security: view.security,
      ...(view.username ? { username: view.username, password } : {}),
      rejectUnauthorized: view.rejectUnauthorized,
    };
  }

  /**
   * Opens a session with the configured server and, when a recipient is
   * given, sends a short test message. Runs synchronously so the admin sees
   * the real failure.
   */
  async test(options: {
    to?: string;
    requestedBy: string;
  }): Promise<{ authenticated: boolean; sentTo: string | null }> {
    const config = await this.smtpConfig();
    const { view } = await this.resolve();
    const recipient = options.to?.trim() || '';
    if (recipient && !isEmailAddress(recipient)) {
      throw new EmailSettingsError(
        'The test recipient is not a valid address.'
      );
    }
    if (!recipient) {
      const session = await verifySmtpConnection(config);
      return { authenticated: session.authenticated, sentTo: null };
    }
    const message = renderNotificationEmail({
      heading: 'Libre WebUI email is working',
      lines: [
        `This test message was requested by ${options.requestedBy}.`,
        'Notifications you opt into will arrive from this address.',
      ],
      appUrl: view.appUrl,
    });
    await sendSmtpMail(config, {
      from: view.from,
      to: [recipient],
      subject: 'Libre WebUI test message',
      ...message,
    });
    return { authenticated: Boolean(view.username), sentTo: recipient };
  }

  /** Performs one delivery; the durable job handler calls this. */
  async deliver(payload: EmailDeliveryPayload): Promise<void> {
    const { view } = await this.resolve();
    if (!view.available) {
      throw new EmailSettingsError('Email delivery is turned off.');
    }
    const config = await this.smtpConfig();
    await sendSmtpMail(config, {
      from: view.from,
      to: [payload.to],
      subject: payload.subject.slice(0, MAX_SUBJECT_LENGTH),
      text: payload.text,
      ...(payload.html ? { html: payload.html } : {}),
    });
  }

  /**
   * Resolves whether `userId` wants email for `kind` and has an address on
   * file. Returns the address or null; every producer goes through here.
   */
  async recipientFor(
    userId: string,
    kind: keyof EmailNotificationPreferences
  ): Promise<string | null> {
    if (!(await this.isAvailable())) return null;
    const preferences = await preferencesService.getPreferences(userId);
    if (!preferences.emailNotifications?.[kind]) return null;
    const user = await userModel.getUserById(userId);
    if (!user || user.status !== 'active') return null;
    const address = user.email?.trim() ?? '';
    return isEmailAddress(address) ? address : null;
  }

  /**
   * Queues one message for `userId` when the preference allows it. Best
   * effort: failures are logged, never thrown to the producer.
   */
  async notify(input: {
    userId: string;
    kind: keyof EmailNotificationPreferences;
    subject: string;
    heading: string;
    lines: string[];
    /** Rendered as Markdown below the plain lines. */
    markdown?: string;
    href?: string;
    linkLabel?: string;
    dedupeKey: string;
  }): Promise<boolean> {
    try {
      const to = await this.recipientFor(input.userId, input.kind);
      if (!to) return false;
      const { view } = await this.resolve();
      const body = renderNotificationEmail({
        heading: input.heading,
        lines: input.lines,
        ...(input.markdown ? { markdown: input.markdown } : {}),
        appUrl: view.appUrl,
        ...(input.href ? { href: input.href } : {}),
        ...(input.linkLabel ? { linkLabel: input.linkLabel } : {}),
      });
      const payload: EmailDeliveryPayload = {
        kind: input.kind,
        to,
        subject: input.subject.slice(0, MAX_SUBJECT_LENGTH),
        ...body,
      };
      const { getDurableJobRuntime } =
        await import('../platform/jobs/durableJobRuntime.js');
      await getDurableJobRuntime().service.enqueue({
        jobType: EMAIL_DELIVER_JOB_TYPE,
        actorUserId: input.userId,
        payload: { mode: 'encrypted', value: { ...payload } },
        idempotencyScope: EMAIL_DELIVER_IDEMPOTENCY_SCOPE,
        idempotencyKey: `${input.userId}:${input.dedupeKey}`,
        maxAttempts: 3,
      });
      return true;
    } catch (error) {
      logger.warn('Email notification could not be queued', {
        kind: input.kind,
        error,
      });
      return false;
    }
  }

  /** A channel mention: the in-app notification title and preview. */
  async notifyChannelMention(input: {
    userId: string;
    title: string;
    preview?: string;
    href?: string;
    notificationId: string;
  }): Promise<boolean> {
    return this.notify({
      userId: input.userId,
      kind: 'channelMentions',
      subject: input.title,
      heading: input.title,
      lines: input.preview ? [input.preview] : [],
      ...(input.href
        ? { href: input.href, linkLabel: 'Open the channel' }
        : {}),
      dedupeKey: `mention:${input.notificationId}`,
    });
  }

  /** An automation run settled, with whatever result text is available. */
  async notifyAutomationRun(input: {
    userId: string;
    runId: string;
    automationName: string;
    status: 'succeeded' | 'failed';
    error?: string | null;
    result?: string | null;
    href?: string;
  }): Promise<boolean> {
    const succeeded = input.status === 'succeeded';
    const lines: string[] = [];
    let markdown: string | undefined;
    if (succeeded) {
      const result = (input.result ?? '').trim();
      if (result) {
        markdown = truncate(result, MAX_TEXT_LENGTH);
      } else {
        lines.push(
          'The run finished. Open Libre WebUI to see the full result.'
        );
      }
    } else {
      lines.push(
        input.error?.trim()
          ? `Error: ${truncate(input.error.trim(), 1_000)}`
          : 'The run failed without an error message.'
      );
    }
    return this.notify({
      userId: input.userId,
      kind: 'automationRuns',
      subject: `${succeeded ? 'Automation finished' : 'Automation failed'}: ${input.automationName}`,
      heading: `"${input.automationName}" ${succeeded ? 'finished' : 'failed'}`,
      lines,
      ...(markdown ? { markdown } : {}),
      ...(input.href ? { href: input.href, linkLabel: 'Open the result' } : {}),
      dedupeKey: `automation-run:${input.runId}`,
    });
  }
}

const truncate = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;

/** Joins a stored app URL with an in-app path; null when no URL is set. */
export const absoluteAppLink = (
  appUrl: string,
  href: string
): string | null => {
  if (!appUrl) return null;
  if (/^https?:\/\//i.test(href)) return href;
  return `${appUrl}${href.startsWith('/') ? '' : '/'}${href}`;
};

/** The website's light palette, inlined because mail clients drop stylesheets. */
const BRAND = {
  page: '#f3f0ea',
  surface: '#fffdf9',
  text: '#0a0a0b',
  muted: '#67635d',
  accent: '#ff7b52',
  accentDeep: '#bd4225',
  border: 'rgba(10, 10, 11, 0.14)',
  logo: 'https://librewebui.org/logo-dark.png',
  site: 'https://librewebui.org',
} as const;

/**
 * Plain text plus an HTML alternative in the website's look: the wordmark
 * on top, one card with the content, a coral call to action, and a quiet
 * footer. `markdown` is rendered; `lines` stay plain paragraphs.
 */
export const renderNotificationEmail = (input: {
  heading: string;
  lines: string[];
  markdown?: string;
  appUrl: string;
  href?: string;
  linkLabel?: string;
}): { text: string; html: string } => {
  const link = input.href ? absoluteAppLink(input.appUrl, input.href) : null;
  const textParts = [input.heading, '', ...input.lines];
  if (input.markdown) textParts.push(input.markdown.trim());
  if (link) textParts.push('', `${input.linkLabel ?? 'Open'}: ${link}`);
  textParts.push(
    '',
    'Sent by Libre WebUI. Change what you receive under Settings > Notifications.'
  );

  const theme = DEFAULT_EMAIL_MARKDOWN_THEME;
  const paragraphs = input.lines
    .map(
      line =>
        `<p style="margin:0 0 12px;line-height:1.55;white-space:pre-wrap;font-family:${theme.fontBody};color:${BRAND.text}">${escapeHtml(line)}</p>`
    )
    .join('');
  const body = input.markdown
    ? renderMarkdownForEmail(input.markdown, theme)
    : '';
  const button = link
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td style="border-radius:999px;background:${BRAND.accentDeep}"><a href="${escapeHtml(link)}" style="display:inline-block;padding:11px 20px;border-radius:999px;font-family:${theme.fontBody};font-size:14px;font-weight:600;color:#ffffff;text-decoration:none">${escapeHtml(input.linkLabel ?? 'Open')}</a></td></tr></table>`
    : '';
  const settingsLink = input.appUrl
    ? `<a href="${escapeHtml(input.appUrl)}" style="color:${BRAND.muted};text-decoration:underline">Settings &gt; Notifications</a>`
    : 'Settings &gt; Notifications';
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">',
    `<title>${escapeHtml(input.heading)}</title></head>`,
    `<body style="margin:0;padding:0;background:${BRAND.page};color:${BRAND.text};font-family:${theme.fontBody}">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.page}"><tr><td align="center" style="padding:32px 16px">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">`,
    `<tr><td style="padding:0 4px 18px"><a href="${BRAND.site}" style="text-decoration:none;color:${BRAND.text}"><img src="${BRAND.logo}" width="28" height="28" alt="" style="vertical-align:middle;border:0;border-radius:6px"> <span style="vertical-align:middle;margin-left:8px;font-family:'Space Grotesk', ${theme.fontBody};font-size:17px;font-weight:700;letter-spacing:-0.01em">Libre WebUI</span></a></td></tr>`,
    `<tr><td style="background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:12px;padding:28px 28px 22px">`,
    `<h1 style="margin:0 0 16px;font-family:'Space Grotesk', ${theme.fontBody};font-size:22px;line-height:1.25;font-weight:700;letter-spacing:-0.01em;color:${BRAND.text}">${escapeHtml(input.heading)}</h1>`,
    paragraphs,
    body,
    button,
    '</td></tr>',
    `<tr><td style="padding:18px 4px 0;font-size:12px;line-height:1.6;color:${BRAND.muted}">Sent by Libre WebUI. Change what you receive under ${settingsLink}.<br><a href="${BRAND.site}" style="color:${BRAND.muted};text-decoration:none">librewebui.org</a></td></tr>`,
    '</table></td></tr></table></body></html>',
  ].join('');
  return { text: textParts.join('\n'), html };
};

/** True for failures worth retrying from the durable job handler. */
export const isTransientEmailError = (error: unknown): boolean => {
  if (!(error instanceof SmtpError)) return false;
  switch (error.code) {
    case 'ERR_SMTP_CONNECT':
    case 'ERR_SMTP_TIMEOUT':
    case 'ERR_SMTP_RESPONSE':
      return true;
    case 'ERR_SMTP_REJECTED':
      return (error.reply?.code ?? 500) < 500;
    default:
      return false;
  }
};

export const emailService = new EmailService();
