import assert from 'node:assert/strict';
import test from 'node:test';

import { auditExceptions, evaluateAuditReport } from './security-audit.mjs';

const advisoryUrl = 'https://github.com/advisories/GHSA-qwww-vcr4-c8h2';

function createContext(overrides = {}) {
  return {
    now: new Date('2026-07-24T12:00:00Z'),
    sourceTexts: [
      "import { BrowserRouter, Routes, Route } from 'react-router-dom';",
    ],
    frontendManifest: {
      dependencies: {
        'react-router-dom': '7.18.1',
      },
    },
    lockfile: {
      packages: {
        'frontend/node_modules/react-router': { version: '7.18.1' },
        'frontend/node_modules/react-router-dom': { version: '7.18.1' },
      },
    },
    ...overrides,
  };
}

function createReport(extraVulnerabilities = {}) {
  const vulnerabilities = {
    'react-router': {
      name: 'react-router',
      severity: 'high',
      via: [
        {
          dependency: 'react-router',
          severity: 'high',
          title: 'RSC-only CSRF advisory',
          url: advisoryUrl,
        },
      ],
    },
    'react-router-dom': {
      name: 'react-router-dom',
      severity: 'high',
      via: ['react-router'],
    },
    ...extraVulnerabilities,
  };

  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: {
      vulnerabilities: {
        info: 0,
        low: 0,
        moderate: 0,
        high: Object.keys(vulnerabilities).length,
        critical: 0,
        total: Object.keys(vulnerabilities).length,
      },
    },
  };
}

test('security audit acknowledges only the declarative-SPA RSC advisory', () => {
  const result = evaluateAuditReport(createReport(), createContext());

  assert.deepEqual(result.blocking, []);
  assert.deepEqual([...result.acknowledgedUrls], [advisoryUrl]);
});

test('security audit blocks any additional advisory', () => {
  const result = evaluateAuditReport(
    createReport({
      postcss: {
        name: 'postcss',
        severity: 'high',
        via: [
          {
            dependency: 'postcss',
            severity: 'high',
            title: 'Unexpected advisory',
            url: 'https://github.com/advisories/GHSA-unexpected',
          },
        ],
      },
    }),
    createContext()
  );

  assert.deepEqual(
    result.blocking.map(([dependency]) => dependency),
    ['postcss']
  );
});

test('security audit exception fails closed when its scope changes', async t => {
  const invalidContexts = [
    {
      name: 'expired exception',
      context: createContext({ now: new Date('2026-09-01T00:00:00Z') }),
    },
    {
      name: 'unstable RSC API usage',
      context: createContext({
        sourceTexts: ['const router = unstable_RSCHydratedRouter();'],
      }),
    },
    {
      name: 'empty source scan',
      context: createContext({ sourceTexts: [] }),
    },
    {
      name: 'manifest version drift',
      context: createContext({
        frontendManifest: {
          dependencies: { 'react-router-dom': '^7.18.1' },
        },
      }),
    },
    {
      name: 'lockfile version drift',
      context: createContext({
        lockfile: {
          packages: {
            'node_modules/react-router': { version: '8.3.0' },
            'node_modules/react-router-dom': { version: '7.18.1' },
          },
        },
      }),
    },
  ];

  for (const { name, context } of invalidContexts) {
    await t.test(name, () => {
      const result = evaluateAuditReport(createReport(), context);
      assert.deepEqual(
        result.blocking.map(([dependency]) => dependency),
        ['react-router', 'react-router-dom']
      );
      assert.deepEqual([...result.acknowledgedUrls], []);
    });
  }
});

test('security audit rejects malformed and error reports', () => {
  assert.throws(
    () =>
      evaluateAuditReport(
        { error: { code: 'EAUDIT' } },
        createContext(),
        auditExceptions
      ),
    /incomplete or error report/
  );

  const malformedReport = createReport();
  malformedReport.vulnerabilities['react-router'].via = null;
  assert.throws(
    () => evaluateAuditReport(malformedReport, createContext()),
    /malformed advisory causes/
  );

  const unknownSeverityReport = createReport();
  unknownSeverityReport.vulnerabilities['react-router'].severity = 'urgent';
  assert.throws(
    () => evaluateAuditReport(unknownSeverityReport, createContext()),
    /unknown severity/
  );
});
