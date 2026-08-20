/*
 * Structured privacy-safe logging (OBS-01).
 *
 * Covers: JSON log lines with stable fields, secret-key redaction and
 * prompt-length truncation canaries, request-id assignment and inbound
 * header validation, query-string stripping in access logs, correlation
 * propagation into the security audit trail, and unchanged text-mode
 * output for the default profile.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-obs-log-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.JWT_SECRET = 'structured-logging-test-secret-that-is-long-enough';
process.env.LOG_LEVEL = 'debug';
delete process.env.LOG_FORMAT;

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);

const [logging, contextModule, middleware, audit] = await Promise.all([
  importBuilt('utils/logger.js'),
  importBuilt('observability/requestContext.js'),
  importBuilt('middleware/index.js'),
  importBuilt('services/securityAuditService.js'),
]);
const { createLogger, redactLogFields, getLogFormat } = logging;
const { runWithLogContext } = contextModule;
const express = (await import('express')).default;

test.after(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const captureStreams = fn => {
  const stdout = [];
  const stderr = [];
  const originalOut = process.stdout.write.bind(process.stdout);
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = chunk => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = chunk => {
    stderr.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalOut;
    process.stderr.write = originalErr;
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') };
};

test('redaction drops credential-shaped keys at every depth', () => {
  const redacted = redactLogFields({
    password: 'canary-password',
    apiKey: 'canary-key',
    authorization: 'canary-auth',
    Cookie: 'canary-cookie',
    providerToken: 'canary-token',
    nested: { clientSecret: 'canary-secret', fine: 'kept' },
    list: [{ jwt: 'canary-jwt', ok: 1 }],
    note: 'ok',
  });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /canary-/);
  assert.match(serialized, /"note":"ok"/);
  assert.match(serialized, /"fine":"kept"/);
  assert.match(serialized, /"ok":1/);
});

test('redaction truncates prompt-sized strings', () => {
  const prompt = `${'a'.repeat(600)}CANARY-PROMPT-TAIL`;
  const redacted = redactLogFields({ preview: prompt });
  const serialized = JSON.stringify(redacted);
  assert.doesNotMatch(serialized, /CANARY-PROMPT-TAIL/);
  assert.match(serialized, /truncated/);
});

test('JSON mode emits stable fields and carries correlation ids', () => {
  process.env.LOG_FORMAT = 'json';
  assert.equal(getLogFormat(), 'json');
  const log = createLogger('obs-test');
  const { stdout, stderr } = captureStreams(() => {
    runWithLogContext({ requestId: 'req-fixed-0001', jobId: 'job-77' }, () => {
      log.info('hello world', { durationMs: 5 });
      log.error('boom');
    });
  });
  const infoLine = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(infoLine.level, 'info');
  assert.equal(infoLine.scope, 'obs-test');
  assert.equal(infoLine.message, 'hello world');
  assert.equal(infoLine.requestId, 'req-fixed-0001');
  assert.equal(infoLine.jobId, 'job-77');
  assert.equal(infoLine.details.durationMs, 5);
  assert.ok(!Number.isNaN(Date.parse(infoLine.ts)));
  const errorLine = JSON.parse(stderr.trim().split('\n').at(-1));
  assert.equal(errorLine.level, 'error');
  assert.equal(errorLine.requestId, 'req-fixed-0001');
  delete process.env.LOG_FORMAT;
});

test('JSON mode never emits credential or prompt canaries', () => {
  process.env.LOG_FORMAT = 'json';
  const log = createLogger('obs-canary');
  const { stdout, stderr } = captureStreams(() => {
    log.info('provider call', {
      authorization: 'Bearer CANARY-BEARER',
      body: { messages: [{ content: `${'p'.repeat(600)}CANARY-PROMPT` }] },
      refreshToken: 'CANARY-REFRESH',
      status: 200,
    });
    log.warn(new Error('upstream said CANARY-SAFE-MESSAGE'));
  });
  const combined = stdout + stderr;
  assert.doesNotMatch(combined, /CANARY-BEARER/);
  assert.doesNotMatch(combined, /CANARY-REFRESH/);
  assert.doesNotMatch(combined, /CANARY-PROMPT/);
  assert.match(combined, /"status":200/);
  // Error messages themselves are kept: services already sanitize them.
  assert.match(combined, /CANARY-SAFE-MESSAGE/);
  delete process.env.LOG_FORMAT;
});

test('text mode keeps the existing prefixed console shape', () => {
  delete process.env.LOG_FORMAT;
  const log = createLogger('obs-text');
  const calls = [];
  const original = console.info;
  console.info = (...args) => calls.push(args);
  try {
    log.info('plain message');
  } finally {
    console.info = original;
  }
  assert.deepEqual(calls, [['[obs-text]', 'plain message']]);
});

const startApp = async () => {
  const app = express();
  app.use(middleware.requestContext);
  app.use(middleware.accessLogger);
  app.get('/probe', (req, res) => {
    res.json({ ok: true });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
};

test('request ids are assigned, echoed, and validated', async () => {
  const { server, base } = await startApp();
  try {
    const fresh = await fetch(`${base}/probe`);
    const assigned = fresh.headers.get('x-request-id');
    assert.ok(assigned && assigned.length >= 8, 'assigns a request id');

    const sane = await fetch(`${base}/probe`, {
      headers: { 'X-Request-Id': 'proxy-abc-12345678' },
    });
    assert.equal(sane.headers.get('x-request-id'), 'proxy-abc-12345678');

    const hostile = await fetch(`${base}/probe`, {
      headers: { 'X-Request-Id': 'bad-id?' },
    });
    const replaced = hostile.headers.get('x-request-id');
    assert.notEqual(replaced, 'bad-id?');
    assert.match(replaced, /^[A-Za-z0-9-]{16,}$/);
  } finally {
    server.close();
  }
});

test('access log strips query strings and carries the request id', async () => {
  process.env.LOG_FORMAT = 'json';
  const { server, base } = await startApp();
  try {
    let stdout = '';
    const originalOut = process.stdout.write.bind(process.stdout);
    process.stdout.write = chunk => {
      stdout += String(chunk);
      return true;
    };
    try {
      await fetch(`${base}/probe?token=CANARY-QUERY-SECRET&q=hello`, {
        headers: { 'X-Request-Id': 'query-canary-req-1' },
      });
      // The finish event fires before the response resolves, but give the
      // event loop one turn to flush the callback deterministically.
      await new Promise(resolve => setTimeout(resolve, 50));
    } finally {
      process.stdout.write = originalOut;
    }
    // The test runner interleaves its own protocol frames on stdout, so
    // extract structured log objects by shape rather than by line.
    const lines = [...stdout.matchAll(/\{"ts":[^\n]*\}/g)].flatMap(match => {
      try {
        return [JSON.parse(match[0])];
      } catch {
        return [];
      }
    });
    const access = lines.find(line => line.scope === 'http');
    assert.ok(access, 'access log line is emitted');
    assert.match(access.message, /GET \/probe 200 \d+ms/);
    assert.equal(access.requestId, 'query-canary-req-1');
    assert.doesNotMatch(stdout, /CANARY-QUERY-SECRET/);
  } finally {
    server.close();
    delete process.env.LOG_FORMAT;
  }
});

test('audit events default their request id from the log context', () => {
  const event = runWithLogContext({ requestId: 'audit-corr-123' }, () =>
    audit.buildAuditEvent({ action: 'test.action', result: 'success' })
  );
  assert.equal(event.request_id, 'audit-corr-123');
  const explicit = runWithLogContext({ requestId: 'audit-corr-123' }, () =>
    audit.buildAuditEvent({
      action: 'test.action',
      result: 'success',
      requestId: 'explicit-wins',
    })
  );
  assert.equal(explicit.request_id, 'explicit-wins');
  const outside = audit.buildAuditEvent({
    action: 'test.action',
    result: 'success',
  });
  assert.equal(outside.request_id, null);
});
