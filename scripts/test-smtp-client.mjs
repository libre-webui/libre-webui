import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const {
  buildMimeMessage,
  extractEmailAddress,
  isEmailAddress,
  sendSmtpMail,
  verifySmtpConnection,
  SmtpError,
} = await import(
  pathToFileURL(path.resolve('backend/dist/utils/smtpClient.js')).href
);

/**
 * A scripted SMTP server: enough of RFC 5321 to exercise the client, with
 * hooks to reject a step or go silent so failure paths are covered too.
 */
const startFakeSmtp = async (options = {}) => {
  const sessions = [];
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const session = {
      commands: [],
      message: '',
      auth: null,
    };
    sessions.push(session);
    let buffer = '';
    let inData = false;
    const reply = line => socket.write(`${line}\r\n`);
    const authMechanisms = options.auth ?? 'PLAIN LOGIN';
    let loginStep = null;
    reply('220 fake.test ESMTP ready');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const index = buffer.indexOf('\r\n');
        if (index === -1) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            if (options.rejectData) {
              reply('554 5.7.1 message rejected');
            } else {
              reply('250 2.0.0 queued as fake-1');
            }
            continue;
          }
          session.message += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        session.commands.push(line);
        if (loginStep === 'user') {
          session.auth = { mechanism: 'LOGIN', user: line };
          loginStep = 'pass';
          reply('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 'pass') {
          session.auth.pass = line;
          loginStep = null;
          reply(
            Buffer.from(line, 'base64').toString('utf8') ===
              (options.password ?? 'secret')
              ? '235 2.7.0 authenticated'
              : '535 5.7.8 bad credentials'
          );
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') {
          const lines = ['250-fake.test greets you', '250-8BITMIME'];
          if (authMechanisms) lines.push(`250-AUTH ${authMechanisms}`);
          lines.push('250 SIZE 1048576');
          for (const entry of lines) reply(entry);
        } else if (
          verb === 'AUTH' &&
          line.toUpperCase().startsWith('AUTH PLAIN')
        ) {
          const token = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64')
            .toString('utf8')
            .split('\0');
          session.auth = { mechanism: 'PLAIN', user: token[1], pass: token[2] };
          reply(
            token[2] === (options.password ?? 'secret')
              ? '235 2.7.0 authenticated'
              : '535 5.7.8 bad credentials'
          );
        } else if (verb === 'AUTH' && line.toUpperCase() === 'AUTH LOGIN') {
          loginStep = 'user';
          reply('334 VXNlcm5hbWU6');
        } else if (verb === 'MAIL') {
          reply('250 2.1.0 sender ok');
        } else if (verb === 'RCPT') {
          if (
            options.rejectRecipient &&
            line.includes(options.rejectRecipient)
          ) {
            reply('550 5.1.1 no such user');
          } else {
            reply('250 2.1.5 recipient ok');
          }
        } else if (verb === 'DATA') {
          if (options.hangOnData) return;
          inData = true;
          reply('354 end data with <CR><LF>.<CR><LF>');
        } else if (verb === 'QUIT') {
          reply('221 2.0.0 bye');
          socket.end();
        } else {
          reply('500 5.5.1 unknown command');
        }
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    sessions,
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise(resolve => server.close(resolve));
    },
  };
};

const baseConfig = port => ({
  host: '127.0.0.1',
  port,
  security: 'none',
  timeoutMs: 2_000,
  clientName: 'libre-test',
});

test('address helpers accept mailboxes and reject junk', () => {
  assert.equal(isEmailAddress('robin@example.test'), true);
  assert.equal(isEmailAddress('not an address'), false);
  assert.equal(isEmailAddress('a@b'), false);
  assert.equal(
    extractEmailAddress('Libre WebUI <notify@example.test>'),
    'notify@example.test'
  );
  assert.equal(extractEmailAddress('<broken'), null);
});

test('the MIME builder encodes headers, strips header breaks and wraps HTML', () => {
  const single = buildMimeMessage(
    {
      from: 'Libre WebUI <notify@example.test>',
      to: ['Robin <robin@example.test>'],
      subject: 'Mentioned in #général\r\nBcc: attacker@example.test',
      text: 'Bonjour.\n.leading dot line',
    },
    { date: new Date('2026-09-16T12:00:00Z') }
  );
  assert.match(single, /^From: "Libre WebUI" <notify@example\.test>\r\n/);
  assert.match(single, /\r\nSubject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=\r\n/);
  assert.doesNotMatch(single, /\r\nBcc:/);
  assert.match(single, /\r\nDate: Wed, 16 Sep 2026 12:00:00 \+0000\r\n/);
  assert.match(single, /\r\nContent-Type: text\/plain; charset=utf-8\r\n/);
  const encodedBody = single.split('\r\n\r\n')[1].trim();
  assert.equal(
    Buffer.from(encodedBody, 'base64').toString('utf8'),
    'Bonjour.\n.leading dot line'
  );

  const multipart = buildMimeMessage({
    from: 'notify@example.test',
    to: ['robin@example.test'],
    subject: 'Plain',
    text: 'text body',
    html: '<p>html body</p>',
  });
  assert.match(
    multipart,
    /Content-Type: multipart\/alternative; boundary="=_libre_[a-f0-9]+"/
  );
  assert.equal(
    (multipart.match(/Content-Transfer-Encoding: base64/g) ?? []).length,
    2
  );
  assert.match(multipart, /--=_libre_[a-f0-9]+--\r\n$/);
});

test('a message is delivered with PLAIN auth and dot stuffing survives the wire', async () => {
  const smtp = await startFakeSmtp();
  try {
    const result = await sendSmtpMail(
      { ...baseConfig(smtp.port), username: 'relay', password: 'secret' },
      {
        from: 'Libre WebUI <notify@example.test>',
        to: ['robin@example.test'],
        subject: 'Hello',
        text: 'line one\n.dot line\nline three',
      }
    );
    assert.deepEqual(result.accepted, ['robin@example.test']);
    assert.equal(result.response, '2.0.0 queued as fake-1');
    const [session] = smtp.sessions;
    assert.equal(session.auth.mechanism, 'PLAIN');
    assert.equal(session.auth.user, 'relay');
    assert.equal(session.commands[0], 'EHLO libre-test');
    assert.ok(session.commands.includes('MAIL FROM:<notify@example.test>'));
    assert.ok(session.commands.includes('RCPT TO:<robin@example.test>'));
    assert.equal(session.commands.at(-1), 'QUIT');
    const body = session.message.split('\r\n\r\n')[1].trim();
    assert.equal(
      Buffer.from(body, 'base64').toString('utf8'),
      'line one\n.dot line\nline three'
    );
    // Nothing in the stored message starts with a bare dot: base64 never
    // produces one, and the server un-stuffed what the client stuffed.
    assert.doesNotMatch(session.message, /\r\n\.\S/);
  } finally {
    await smtp.close();
  }
});

test('LOGIN is used when PLAIN is not offered, and bad credentials are an auth error', async () => {
  const smtp = await startFakeSmtp({ auth: 'LOGIN' });
  try {
    const verified = await verifySmtpConnection({
      ...baseConfig(smtp.port),
      username: 'relay',
      password: 'secret',
    });
    assert.equal(verified.authenticated, true);
    assert.equal(verified.secure, false);
    assert.equal(smtp.sessions[0].auth.mechanism, 'LOGIN');
    assert.equal(
      Buffer.from(smtp.sessions[0].auth.user, 'base64').toString('utf8'),
      'relay'
    );

    await assert.rejects(
      verifySmtpConnection({
        ...baseConfig(smtp.port),
        username: 'relay',
        password: 'wrong',
      }),
      error => error instanceof SmtpError && error.code === 'ERR_SMTP_AUTH'
    );
  } finally {
    await smtp.close();
  }
});

test('credentials are never sent in clear text when TLS was expected', async () => {
  const smtp = await startFakeSmtp();
  try {
    await assert.rejects(
      verifySmtpConnection({
        ...baseConfig(smtp.port),
        security: 'starttls',
        username: 'relay',
        password: 'secret',
      }),
      error => error instanceof SmtpError && error.code === 'ERR_SMTP_TLS'
    );
    assert.equal(
      smtp.sessions[0].commands.some(line => line.startsWith('AUTH')),
      false
    );
  } finally {
    await smtp.close();
  }
});

test('a rejected recipient and a rejected message surface as rejections with the reply', async () => {
  const smtp = await startFakeSmtp({ rejectRecipient: 'nobody@' });
  try {
    await assert.rejects(
      sendSmtpMail(baseConfig(smtp.port), {
        from: 'notify@example.test',
        to: ['nobody@example.test'],
        subject: 'x',
        text: 'y',
      }),
      error =>
        error instanceof SmtpError &&
        error.code === 'ERR_SMTP_REJECTED' &&
        error.reply.code === 550
    );
  } finally {
    await smtp.close();
  }
  const rejecting = await startFakeSmtp({ rejectData: true });
  try {
    await assert.rejects(
      sendSmtpMail(baseConfig(rejecting.port), {
        from: 'notify@example.test',
        to: ['robin@example.test'],
        subject: 'x',
        text: 'y',
      }),
      error =>
        error instanceof SmtpError &&
        error.code === 'ERR_SMTP_REJECTED' &&
        error.reply.code === 554
    );
  } finally {
    await rejecting.close();
  }
});

test('a silent server times out instead of hanging the caller', async () => {
  const smtp = await startFakeSmtp({ hangOnData: true });
  try {
    const started = Date.now();
    await assert.rejects(
      sendSmtpMail(
        { ...baseConfig(smtp.port), timeoutMs: 300 },
        {
          from: 'notify@example.test',
          to: ['robin@example.test'],
          subject: 'x',
          text: 'y',
        }
      ),
      error => error instanceof SmtpError && error.code === 'ERR_SMTP_TIMEOUT'
    );
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await smtp.close();
  }
});

test('an unreachable host is a connection error', async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address();
  await new Promise(resolve => probe.close(resolve));
  await assert.rejects(
    verifySmtpConnection(baseConfig(port)),
    error => error instanceof SmtpError && error.code === 'ERR_SMTP_CONNECT'
  );
});

test('invalid configuration is refused before any connection is made', async () => {
  await assert.rejects(
    verifySmtpConnection({ host: 'bad host', port: 25, security: 'none' }),
    error => error instanceof SmtpError && error.code === 'ERR_SMTP_CONFIG'
  );
  await assert.rejects(
    verifySmtpConnection({ host: 'mail.test', port: 70000, security: 'none' }),
    error => error instanceof SmtpError && error.code === 'ERR_SMTP_CONFIG'
  );
  await assert.rejects(
    verifySmtpConnection({
      host: 'mail.test',
      port: 25,
      security: 'none',
      username: 'only-user',
    }),
    error => error instanceof SmtpError && error.code === 'ERR_SMTP_CONFIG'
  );
});
