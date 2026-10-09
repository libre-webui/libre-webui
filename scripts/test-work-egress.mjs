import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import test, { after } from 'node:test';
import tls from 'node:tls';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const dist = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { createCertificateAuthority, issueServerCertificate } =
  await dist('utils/x509.js');
const {
  WorkEgressProxy,
  compileHostPatterns,
  createEgressPlaceholder,
  parseConnectTarget,
  publicOnlyLookup,
} = await dist('services/workEgressProxy.js');
const { RELAY_SCRIPT, RelayMultiplexer } = await dist(
  'services/workEgressRelay.js'
);

const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});

/** A fake upstream fleet: one HTTPS server answering for several hosts. */
async function startUpstream() {
  const authority = createCertificateAuthority('Test upstream CA');
  const certificates = new Map();
  const contextFor = host => {
    if (!certificates.has(host)) {
      const issued = issueServerCertificate(authority, host);
      certificates.set(
        host,
        tls.createSecureContext({
          key: issued.privateKeyPem,
          cert: issued.certificatePem,
        })
      );
    }
    return certificates.get(host);
  };
  const seen = [];
  const server = https.createServer(
    {
      SNICallback: (host, callback) => callback(null, contextFor(host)),
      ...(() => {
        const fallback = issueServerCertificate(authority, 'fallback.test');
        return { key: fallback.privateKeyPem, cert: fallback.certificatePem };
      })(),
    },
    (request, response) => {
      const chunks = [];
      request.on('data', chunk => chunks.push(chunk));
      request.on('end', () => {
        seen.push({
          host: request.headers.host,
          url: request.url,
          authorization: request.headers.authorization,
          apiKey: request.headers['x-api-key'],
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write('data: one\n\n');
        setTimeout(() => response.end('data: two\n\n'), 10);
      });
    }
  );
  server.on('upgrade', (request, socket) => {
    seen.push({
      host: request.headers.host,
      url: request.url,
      authorization: request.headers.authorization,
      upgrade: request.headers.upgrade,
    });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n'
    );
    socket.on('data', data =>
      socket.write(Buffer.concat([Buffer.from('echo:'), data]))
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  return { authority, port: server.address().port, seen, server };
}

/** Resolve every *.example.test name to loopback, as a test resolver. */
const loopbackLookup = (hostname, options, callback) => {
  if (!hostname.endsWith('.example.test')) {
    publicOnlyLookup(hostname, options, callback);
    return;
  }
  if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
  else callback(null, '127.0.0.1', 4);
};

/** Expose a session on a local port so ordinary clients can use it. */
async function listenSession(session) {
  const server = net.createServer(socket => session.accept(socket));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  closers.push(
    () =>
      new Promise(resolve => {
        session.close();
        server.close(() => resolve());
      })
  );
  return server.address().port;
}

/** Open a CONNECT tunnel through the proxy; resolves with status + socket. */
function connectThrough(proxyPort, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      method: 'CONNECT',
      path: target,
    });
    request.on('connect', (response, socket) =>
      resolve({ status: response.statusCode, socket })
    );
    request.on('error', reject);
    request.end();
  });
}

/** One HTTPS request over an established CONNECT tunnel. */
function requestOverTunnel(socket, host, ca, headers, body = '') {
  return new Promise((resolve, reject) => {
    const request = https.request({
      host,
      servername: host,
      path: '/v1/messages?key=x',
      method: 'POST',
      headers: { 'content-length': Buffer.byteLength(body), ...headers },
      // No agent: with one, Node dials the host itself and ignores this.
      createConnection: () =>
        tls.connect({ socket, servername: host, ca: [ca] }),
    });
    request.on('response', response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('the private authority issues certificates TLS clients accept', async () => {
  const authority = createCertificateAuthority();
  const leaf = issueServerCertificate(authority, 'Runtime.US-East-1.Kiro.dev');
  const caCertificate = new crypto.X509Certificate(authority.certificatePem);
  const certificate = new crypto.X509Certificate(leaf.certificatePem);
  assert.equal(caCertificate.ca, true);
  assert.equal(certificate.ca, false);
  assert.ok(certificate.checkIssued(caCertificate));
  assert.ok(certificate.verify(caCertificate.publicKey));
  assert.equal(
    certificate.checkHost('runtime.us-east-1.kiro.dev'),
    'runtime.us-east-1.kiro.dev'
  );
  assert.equal(certificate.checkHost('evil.kiro.dev'), undefined);
  assert.match(
    certificate.keyUsage?.join(',') ?? '',
    /1\.3\.6\.1\.5\.5\.7\.3\.1/
  );
  assert.throws(
    () => issueServerCertificate(authority, '10.0.0.1'),
    /not a DNS host name/
  );
  assert.throws(
    () => issueServerCertificate(authority, 'bad host'),
    /not a DNS host name/
  );

  const server = tls.createServer(
    { key: leaf.privateKeyPem, cert: leaf.certificatePem },
    socket => socket.end('ok')
  );
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const reply = await new Promise((resolve, reject) => {
      const client = tls.connect({
        port: server.address().port,
        host: '127.0.0.1',
        servername: 'runtime.us-east-1.kiro.dev',
        ca: [authority.certificatePem],
      });
      client.on('data', data => resolve(`${client.authorized}:${data}`));
      client.on('error', reject);
    });
    assert.equal(reply, 'true:ok');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('host patterns match exactly one label per wildcard', () => {
  const matches = compileHostPatterns([
    'api.anthropic.com',
    'runtime.*.kiro.dev',
    'management.*.kiro.dev',
  ]);
  assert.equal(matches('api.anthropic.com'), true);
  assert.equal(matches('API.Anthropic.com'), true);
  assert.equal(matches('runtime.us-east-1.kiro.dev'), true);
  assert.equal(matches('management.eu-central-1.kiro.dev'), true);
  assert.equal(matches('runtime.a.b.kiro.dev'), false);
  assert.equal(matches('xruntime.us-east-1.kiro.dev'), false);
  assert.equal(matches('runtime.us-east-1.kiro.dev.attacker.test'), false);
  assert.equal(matches('evil-api.anthropic.com'), false);
  assert.equal(matches('api.anthropic.com.attacker.test'), false);
  assert.equal(compileHostPatterns(['bad pattern!'])('bad pattern!'), false);
});

test('CONNECT targets are parsed strictly', () => {
  assert.deepEqual(parseConnectTarget('api.openai.com:443'), {
    host: 'api.openai.com',
    port: 443,
  });
  assert.deepEqual(parseConnectTarget('[2001:db8::1]:8443'), {
    host: '2001:db8::1',
    port: 8443,
  });
  for (const bad of [
    undefined,
    '',
    'host',
    'host:0',
    'host:70000',
    'a b:443',
    'host:44x',
  ]) {
    assert.equal(parseConnectTarget(bad), undefined, String(bad));
  }
});

test('placeholders are random and recognizable', () => {
  const first = createEgressPlaceholder();
  const second = createEgressPlaceholder();
  assert.match(first, /^lwui_ph_[0-9a-f]{48}$/);
  assert.notEqual(first, second);
});

test('the default resolver refuses private destinations', async () => {
  const error = await new Promise(resolve =>
    publicOnlyLookup('localhost', { all: true }, error => resolve(error))
  );
  assert.equal(error?.code, 'EGRESS_PRIVATE_ADDRESS');
});

test('a credential is injected only on its own intercepted host', async () => {
  const upstream = await startUpstream();
  const proxy = new WorkEgressProxy({
    lookup: loopbackLookup,
    upstreamCa: [upstream.authority.certificatePem],
    upstreamPort: () => upstream.port,
  });
  const anthropic = createEgressPlaceholder();
  const kiro = createEgressPlaceholder();
  const events = [];
  const { session, certificateAuthorityPem } = proxy.createSession({
    credentials: [
      {
        name: 'ANTHROPIC_API_KEY',
        placeholder: anthropic,
        secret: 'sk-real-anthropic',
        hosts: ['api.example.test'],
      },
      {
        name: 'KIRO_API_KEY',
        placeholder: kiro,
        secret: 'ksk-real-kiro',
        hosts: ['runtime.*.example.test'],
      },
    ],
    allowOtherHosts: true,
    onEvent: event => events.push(event),
  });
  const proxyPort = await listenSession(session);

  const tunnel = await connectThrough(proxyPort, 'api.example.test:443');
  assert.equal(tunnel.status, 200);
  const reply = await requestOverTunnel(
    tunnel.socket,
    'api.example.test',
    certificateAuthorityPem,
    { 'x-api-key': anthropic, authorization: `Bearer ${kiro}` },
    `{"secret":"${anthropic}"}`
  );
  assert.equal(reply.status, 200);
  assert.equal(reply.body, 'data: one\n\ndata: two\n\n');
  const seen = upstream.seen.at(-1);
  assert.equal(seen.apiKey, 'sk-real-anthropic');
  // The Kiro placeholder belongs to other hosts and is not replaced here.
  assert.equal(seen.authorization, `Bearer ${kiro}`);
  // Bodies are never rewritten.
  assert.equal(seen.body, `{"secret":"${anthropic}"}`);
  assert.ok(
    events.some(
      event =>
        event.type === 'substitute' && event.credential === 'ANTHROPIC_API_KEY'
    )
  );
  assert.ok(
    !events.some(
      event =>
        event.type === 'substitute' && event.credential === 'KIRO_API_KEY'
    )
  );
  assert.equal(session.stats.intercepts, 1);

  const regional = await connectThrough(
    proxyPort,
    'runtime.us-east-1.example.test:443'
  );
  const regionalReply = await requestOverTunnel(
    regional.socket,
    'runtime.us-east-1.example.test',
    certificateAuthorityPem,
    { authorization: `Bearer ${kiro}`, 'x-api-key': anthropic }
  );
  assert.equal(regionalReply.status, 200);
  assert.equal(upstream.seen.at(-1).authorization, 'Bearer ksk-real-kiro');
  assert.equal(upstream.seen.at(-1).apiKey, anthropic);
});

test('hosts without a credential are opaque tunnels, or refused without network', async () => {
  const upstream = await startUpstream();
  const placeholder = createEgressPlaceholder();
  const proxy = new WorkEgressProxy({
    lookup: loopbackLookup,
    upstreamCa: [upstream.authority.certificatePem],
    upstreamPort: () => upstream.port,
  });
  const open = proxy.createSession({
    credentials: [
      {
        name: 'OPENAI_API_KEY',
        placeholder,
        secret: 'sk-real-openai',
        hosts: ['api.example.test'],
      },
    ],
    allowOtherHosts: true,
  });
  const openPort = await listenSession(open.session);
  const tunnel = await connectThrough(openPort, 'cdn.example.test:443');
  assert.equal(tunnel.status, 200);
  // Not intercepted: the client sees the upstream's own certificate and the
  // placeholder reaches the upstream untouched.
  const reply = await requestOverTunnel(
    tunnel.socket,
    'cdn.example.test',
    upstream.authority.certificatePem,
    { authorization: `Bearer ${placeholder}` }
  );
  assert.equal(reply.status, 200);
  assert.equal(upstream.seen.at(-1).authorization, `Bearer ${placeholder}`);
  assert.equal(open.session.stats.tunnels, 1);

  const events = [];
  const closed = proxy.createSession({
    credentials: [
      {
        name: 'OPENAI_API_KEY',
        placeholder,
        secret: 'sk-real-openai',
        hosts: ['api.example.test'],
      },
    ],
    allowOtherHosts: false,
    supportHosts: ['models.example.test'],
    onEvent: event => events.push(event),
  });
  const closedPort = await listenSession(closed.session);
  const denied = await connectThrough(closedPort, 'cdn.example.test:443');
  assert.equal(denied.status, 403);
  assert.ok(events.some(event => event.type === 'deny'));
  const support = await connectThrough(closedPort, 'models.example.test:443');
  assert.equal(support.status, 200);
  support.socket.destroy();
  const api = await connectThrough(closedPort, 'api.example.test:443');
  assert.equal(api.status, 200);
  const apiReply = await requestOverTunnel(
    api.socket,
    'api.example.test',
    closed.certificateAuthorityPem,
    { authorization: `Bearer ${placeholder}` }
  );
  assert.equal(apiReply.status, 200);
  assert.equal(upstream.seen.at(-1).authorization, 'Bearer sk-real-openai');
});

test('private address literals are never tunnelled', async () => {
  const proxy = new WorkEgressProxy();
  const { session } = proxy.createSession({
    credentials: [],
    allowOtherHosts: true,
  });
  const port = await listenSession(session);
  for (const target of ['127.0.0.1:22', '10.0.0.5:443', '169.254.169.254:80']) {
    const result = await connectThrough(port, target);
    assert.equal(result.status, 403, target);
  }
  const named = await connectThrough(port, 'localhost:5432');
  assert.equal(named.status, 502);
});

test('WebSocket upgrades are intercepted with the credential injected', async () => {
  const upstream = await startUpstream();
  const placeholder = createEgressPlaceholder();
  const proxy = new WorkEgressProxy({
    lookup: loopbackLookup,
    upstreamCa: [upstream.authority.certificatePem],
    upstreamPort: () => upstream.port,
  });
  const { session, certificateAuthorityPem } = proxy.createSession({
    credentials: [
      {
        name: 'CODEX_API_KEY',
        placeholder,
        secret: 'sk-real-codex',
        hosts: ['api.example.test'],
      },
    ],
    allowOtherHosts: false,
  });
  const port = await listenSession(session);
  const tunnel = await connectThrough(port, 'api.example.test:443');
  const secure = tls.connect({
    socket: tunnel.socket,
    servername: 'api.example.test',
    ca: [certificateAuthorityPem],
  });
  await new Promise((resolve, reject) => {
    secure.once('secureConnect', resolve);
    secure.once('error', reject);
  });
  secure.write(
    [
      'GET /v1/responses HTTP/1.1',
      'Host: api.example.test',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      `Authorization: Bearer ${placeholder}`,
      '',
      '',
    ].join('\r\n')
  );
  let received = '';
  await new Promise(resolve => {
    secure.on('data', data => {
      received += data.toString('utf8');
      if (received.includes('\r\n\r\n') && !received.includes('echo:')) {
        secure.write('ping');
      }
      if (received.includes('echo:ping')) resolve();
    });
  });
  assert.match(received, /^HTTP\/1\.1 101 /);
  const seen = upstream.seen.at(-1);
  assert.equal(seen.upgrade, 'websocket');
  assert.equal(seen.authorization, 'Bearer sk-real-codex');
  secure.destroy();
});

test('the relay carries proxy connections over one stdio channel', async () => {
  const upstream = await startUpstream();
  const placeholder = createEgressPlaceholder();
  const proxy = new WorkEgressProxy({
    lookup: loopbackLookup,
    upstreamCa: [upstream.authority.certificatePem],
    upstreamPort: () => upstream.port,
  });
  const { session, certificateAuthorityPem } = proxy.createSession({
    credentials: [
      {
        name: 'OPENROUTER_API_KEY',
        placeholder,
        secret: 'sk-or-real',
        hosts: ['api.example.test'],
      },
    ],
    allowOtherHosts: false,
  });
  // A child node process stands in for `docker exec -i … node -e`.
  const child = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const relay = new RelayMultiplexer(child.stdout, child.stdin);
  relay.on('connection', stream => session.accept(stream));
  closers.push(async () => {
    relay.close();
    session.close();
    await new Promise(resolve =>
      child.exitCode === null ? child.once('exit', resolve) : resolve()
    );
  });
  const relayPort = await relay.ready;
  assert.ok(Number.isInteger(relayPort) && relayPort > 0);

  const replies = await Promise.all(
    [0, 1, 2].map(async index => {
      const tunnel = await connectThrough(relayPort, 'api.example.test:443');
      assert.equal(tunnel.status, 200);
      return requestOverTunnel(
        tunnel.socket,
        'api.example.test',
        certificateAuthorityPem,
        { authorization: `Bearer ${placeholder}` },
        'x'.repeat(200_000 + index)
      );
    })
  );
  for (const reply of replies) {
    assert.equal(reply.status, 200);
    assert.equal(reply.body, 'data: one\n\ndata: two\n\n');
  }
  const recent = upstream.seen.slice(-3);
  assert.deepEqual(
    recent.map(entry => entry.authorization),
    ['Bearer sk-or-real', 'Bearer sk-or-real', 'Bearer sk-or-real']
  );
  assert.deepEqual(
    recent.map(entry => entry.body.length).sort(),
    [200_000, 200_001, 200_002]
  );

  const denied = await connectThrough(relayPort, 'elsewhere.example.test:443');
  assert.equal(denied.status, 403);

  relay.close();
  await new Promise(resolve =>
    child.exitCode === null ? child.once('exit', resolve) : resolve()
  );
  assert.equal(child.exitCode, 0);
});

test('a malformed relay frame closes the relay instead of throwing', async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const output = new PassThrough();
  const relay = new RelayMultiplexer(input, output);
  const closed = new Promise(resolve => relay.once('close', resolve));
  const header = Buffer.alloc(9);
  header[0] = 3;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(64 * 1024 * 1024, 5);
  input.write(header);
  const error = await closed;
  assert.match(String(error?.message), /oversized frame/);
  await assert.rejects(relay.ready, /oversized frame/);
});
