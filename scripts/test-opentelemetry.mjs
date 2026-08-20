/*
 * Opt-in OpenTelemetry export (OBS-02).
 *
 * Covers: OTLP/HTTP JSON shapes for traces, cumulative counters, and log
 * records; the exporter staying dark without an endpoint; attribute
 * redaction canaries; bounded drop-oldest buffers; collector failure
 * never throwing or blocking; and the durable-job execution wrapper.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

process.env.LOG_LEVEL = 'debug';
delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

const importBuilt = file =>
  import(pathToFileURL(path.resolve('backend/dist', file)).href);
const otel = await importBuilt('observability/otel.js');

const startCollector = async () => {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      received.push({
        path: req.url,
        headers: req.headers,
        body: JSON.parse(body),
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const { port } = server.address();
  return { server, received, endpoint: `http://127.0.0.1:${port}` };
};

test('exporter is dark without an endpoint', async () => {
  otel.resetOtel();
  assert.equal(otel.isOtelEnabled(), false);
  otel.recordOtelSpan({
    name: 'ignored',
    startMs: Date.now(),
    endMs: Date.now(),
    ok: true,
  });
  otel.incrementOtelCounter('ignored');
  otel.recordOtelLog('info', 'test', 'ignored');
  assert.deepEqual(otel.otelStats(), {
    bufferedSpans: 0,
    bufferedLogs: 0,
    counterSeries: 0,
    droppedSpans: 0,
    droppedLogs: 0,
    exportFailures: 0,
  });
  await otel.flushOtel();
});

test('spans, counters, and logs export in OTLP JSON shape', async t => {
  const { server, received, endpoint } = await startCollector();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  process.env.OTEL_EXPORTER_OTLP_HEADERS = 'x-otlp-auth=collector-cred';
  process.env.OTEL_SERVICE_NAME = 'libre-test';
  t.after(() => {
    server.close();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_HEADERS;
    delete process.env.OTEL_SERVICE_NAME;
    otel.resetOtel();
  });
  otel.resetOtel();

  const start = Date.now() - 25;
  otel.recordOtelSpan({
    name: 'GET /api/probe',
    kind: 2,
    startMs: start,
    endMs: Date.now(),
    ok: true,
    attributes: {
      'http.response.status_code': 200,
      requestSecretToken: 'CANARY-ATTR-SECRET',
      preview: `${'x'.repeat(600)}CANARY-ATTR-PROMPT`,
    },
  });
  otel.incrementOtelCounter('http.server.requests', { method: 'GET' }, 2);
  otel.incrementOtelCounter('http.server.requests', { method: 'GET' });
  otel.recordOtelLog('warn', 'test-scope', 'something happened');
  await otel.flushOtel();

  const byPath = Object.fromEntries(
    received.map(entry => [entry.path, entry])
  );
  const traces = byPath['/v1/traces'];
  assert.ok(traces, 'traces exported');
  assert.equal(traces.headers['x-otlp-auth'], 'collector-cred');
  const resourceAttrs =
    traces.body.resourceSpans[0].resource.attributes;
  assert.deepEqual(resourceAttrs[0], {
    key: 'service.name',
    value: { stringValue: 'libre-test' },
  });
  const span = traces.body.resourceSpans[0].scopeSpans[0].spans[0];
  assert.equal(span.name, 'GET /api/probe');
  assert.equal(span.kind, 2);
  assert.match(span.traceId, /^[0-9a-f]{32}$/);
  assert.match(span.spanId, /^[0-9a-f]{16}$/);
  assert.match(span.startTimeUnixNano, /^\d+$/);
  assert.equal(span.status.code, 1);
  const serializedSpan = JSON.stringify(span);
  assert.doesNotMatch(serializedSpan, /CANARY-ATTR-SECRET/);
  assert.doesNotMatch(serializedSpan, /CANARY-ATTR-PROMPT/);
  assert.match(serializedSpan, /http\.response\.status_code/);

  const metrics = byPath['/v1/metrics'];
  assert.ok(metrics, 'metrics exported');
  const metric = metrics.body.resourceMetrics[0].scopeMetrics[0].metrics[0];
  assert.equal(metric.name, 'http.server.requests');
  assert.equal(metric.sum.isMonotonic, true);
  assert.equal(metric.sum.aggregationTemporality, 2);
  assert.equal(metric.sum.dataPoints[0].asInt, '3');

  const logs = byPath['/v1/logs'];
  assert.ok(logs, 'logs exported');
  const record = logs.body.resourceLogs[0].scopeLogs[0].logRecords[0];
  assert.equal(record.severityText, 'warn');
  assert.equal(record.body.stringValue, 'something happened');
});

test('collector failure drops the batch without throwing', async t => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
  t.after(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otel.resetOtel();
  });
  otel.resetOtel();
  otel.recordOtelSpan({
    name: 'doomed',
    startMs: Date.now(),
    endMs: Date.now(),
    ok: true,
  });
  await otel.flushOtel();
  assert.equal(otel.otelStats().bufferedSpans, 0, 'batch dropped');
  assert.ok(otel.otelStats().exportFailures >= 1);
});

test('span buffer is bounded and drops oldest', async t => {
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:9';
  t.after(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otel.resetOtel();
  });
  otel.resetOtel();
  for (let index = 0; index < 2100; index += 1) {
    otel.recordOtelSpan({
      name: `span-${index}`,
      startMs: Date.now(),
      endMs: Date.now(),
      ok: true,
    });
  }
  const stats = otel.otelStats();
  assert.equal(stats.bufferedSpans, 2048);
  assert.equal(stats.droppedSpans, 52);
});

test('durable-job wrapper records success and failure outcomes', async t => {
  const { server, received, endpoint } = await startCollector();
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = endpoint;
  t.after(() => {
    server.close();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    otel.resetOtel();
  });
  otel.resetOtel();

  const value = await otel.instrumentDurableJobExecution(
    'test.job.v1',
    1,
    async () => 'done'
  );
  assert.equal(value, 'done');
  await assert.rejects(
    otel.instrumentDurableJobExecution('test.job.v1', 2, async () => {
      throw new Error('handler failed');
    }),
    /handler failed/
  );
  await otel.flushOtel();

  const traces = received.find(entry => entry.path === '/v1/traces');
  const spans = traces.body.resourceSpans[0].scopeSpans[0].spans;
  assert.equal(spans.length, 2);
  assert.equal(spans[0].status.code, 1);
  assert.equal(spans[1].status.code, 2);
  const metrics = received.find(entry => entry.path === '/v1/metrics');
  const series = metrics.body.resourceMetrics[0].scopeMetrics[0].metrics;
  const outcomes = series
    .map(metric => metric.sum.dataPoints[0].attributes)
    .map(attrs => attrs.find(a => a.key === 'outcome')?.value.stringValue)
    .sort();
  assert.deepEqual(outcomes, ['failure', 'success']);
});
