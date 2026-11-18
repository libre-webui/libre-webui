import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TOLERATED_ADVISORIES,
  evaluateAuditReport,
} from './dependency-audit.mjs';

const report = vulnerabilities => ({
  metadata: { vulnerabilities: { high: Object.keys(vulnerabilities).length } },
  vulnerabilities,
});

const picomatchChain = (
  fixAvailable = { name: 'vite', isSemVerMajor: true }
) => ({
  picomatch: {
    severity: 'high',
    via: [
      {
        source: 1247710,
        url: 'https://github.com/advisories/GHSA-fc5q-39xc-vjpf',
      },
    ],
    fixAvailable,
  },
  tinyglobby: { severity: 'high', via: ['picomatch'], fixAvailable: true },
  vite: {
    severity: 'high',
    via: ['picomatch', 'tinyglobby'],
    fixAvailable: false,
  },
});

test('findings that trace only to a tolerated advisory pass', () => {
  const result = evaluateAuditReport(report(picomatchChain()));
  assert.equal(result.verdict, true);
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.tolerated.sort(), [
    'picomatch',
    'tinyglobby',
    'vite',
  ]);
});

test('a tolerated advisory stops counting once npm can install its fix', () => {
  const result = evaluateAuditReport(report(picomatchChain(true)));
  assert.deepEqual(result.expired, ['GHSA-fc5q-39xc-vjpf']);
  assert.equal(result.blocking.length, 3);
});

test('any other moderate-or-higher advisory still fails', () => {
  const result = evaluateAuditReport(
    report({
      ...picomatchChain(),
      lodash: {
        severity: 'moderate',
        via: [{ source: 999 }],
        fixAvailable: true,
      },
      vite: {
        severity: 'high',
        via: ['picomatch', { source: 1000 }],
        fixAvailable: false,
      },
    })
  );
  assert.deepEqual(result.blocking.map(item => item.name).sort(), [
    'lodash',
    'vite',
  ]);
});

test('low findings are ignored and a report without metadata is no verdict', () => {
  const low = evaluateAuditReport(
    report({
      debug: { severity: 'low', via: [{ source: 1 }], fixAvailable: true },
    })
  );
  assert.deepEqual(low.blocking, []);
  assert.equal(evaluateAuditReport({}).verdict, false);
  assert.equal(evaluateAuditReport(null).verdict, false);
});

test('every tolerated advisory names its package and a reason', () => {
  for (const [source, entry] of TOLERATED_ADVISORIES) {
    assert.equal(typeof source, 'number');
    assert.match(entry.id, /^GHSA-/);
    assert.ok(entry.package);
    assert.ok(entry.reason.length > 40);
  }
});
