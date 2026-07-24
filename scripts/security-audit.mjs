#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const auditThreshold = 'moderate';
const severityRank = new Map([
  ['info', 0],
  ['low', 1],
  ['moderate', 2],
  ['high', 3],
  ['critical', 4],
]);

export const auditExceptions = new Map([
  [
    'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
    {
      dependency: 'react-router',
      expiresAt: '2026-08-31T23:59:59Z',
      expectedVersions: {
        'react-router': '7.18.1',
        'react-router-dom': '7.18.1',
      },
      rationale:
        'Libre WebUI uses React Router only as a declarative browser SPA and does not use the affected unstable RSC APIs.',
      forbiddenSourcePatterns: [
        /\bRSCStaticRouter\b/,
        /\brouteRSCServerRequest\b/,
        /\bunstable_[A-Za-z]*RSC[A-Za-z]*\b/i,
        /\bunstable_(?:getRequest|createCallServer)\b/,
      ],
    },
  ],
]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const entryPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(entryPath);
    }

    return /\.(?:[cm]?[jt]sx?)$/.test(entry.name) ? [entryPath] : [];
  });
}

function dependencyVersions(lockfile, dependency) {
  const packageSuffix = `/node_modules/${dependency}`;

  return new Set(
    Object.entries(lockfile.packages ?? {})
      .filter(([packagePath]) => {
        return (
          packagePath === `node_modules/${dependency}` ||
          packagePath.endsWith(packageSuffix)
        );
      })
      .map(([, metadata]) => metadata.version)
  );
}

export function loadAuditContext(root = projectRoot, now = new Date()) {
  const frontendSource = path.join(root, 'frontend', 'src');
  const files = sourceFiles(frontendSource);

  return {
    now,
    sourceTexts: files.map(filePath => fs.readFileSync(filePath, 'utf8')),
    frontendManifest: JSON.parse(
      fs.readFileSync(path.join(root, 'frontend', 'package.json'), 'utf8')
    ),
    lockfile: JSON.parse(
      fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')
    ),
  };
}

function exceptionIsApplicable(exception, context) {
  if (context.now.getTime() > Date.parse(exception.expiresAt)) {
    return false;
  }

  if (context.sourceTexts.length === 0) {
    return false;
  }

  const usesForbiddenApi = context.sourceTexts.some(source => {
    return exception.forbiddenSourcePatterns.some(pattern =>
      pattern.test(source)
    );
  });
  if (usesForbiddenApi) {
    return false;
  }

  const directRouterVersion =
    context.frontendManifest.dependencies?.['react-router-dom'];
  if (directRouterVersion !== exception.expectedVersions['react-router-dom']) {
    return false;
  }

  return Object.entries(exception.expectedVersions).every(
    ([dependency, expectedVersion]) => {
      const versions = dependencyVersions(context.lockfile, dependency);
      return versions.size === 1 && versions.has(expectedVersion);
    }
  );
}

function validateReport(report) {
  if (
    report?.error ||
    report?.auditReportVersion !== 2 ||
    typeof report.vulnerabilities !== 'object' ||
    report.vulnerabilities === null ||
    typeof report.metadata?.vulnerabilities !== 'object' ||
    report.metadata.vulnerabilities === null
  ) {
    throw new Error('npm audit returned an incomplete or error report');
  }
}

export function evaluateAuditReport(
  report,
  context,
  exceptions = auditExceptions
) {
  validateReport(report);

  const minimumRank = severityRank.get(auditThreshold);
  const relevant = Object.entries(report.vulnerabilities).filter(
    ([, vulnerability]) => {
      if (!severityRank.has(vulnerability.severity)) {
        throw new Error(
          `npm audit returned an unknown severity: ${vulnerability.severity}`
        );
      }
      if (!Array.isArray(vulnerability.via)) {
        throw new Error('npm audit returned malformed advisory causes');
      }

      return severityRank.get(vulnerability.severity) >= minimumRank;
    }
  );
  const exceptedDependencies = new Set();
  const acknowledgedUrls = new Set();

  let changed = true;
  while (changed) {
    changed = false;

    for (const [dependency, vulnerability] of relevant) {
      if (
        exceptedDependencies.has(dependency) ||
        vulnerability.via.length === 0
      ) {
        continue;
      }

      const matchedUrls = [];
      const allCausesAreExcepted = vulnerability.via.every(cause => {
        if (typeof cause === 'string') {
          return exceptedDependencies.has(cause);
        }
        if (typeof cause !== 'object' || cause === null) {
          throw new Error('npm audit returned a malformed advisory cause');
        }

        const exception = exceptions.get(cause.url);
        const isExcepted =
          exception?.dependency === cause.dependency &&
          exceptionIsApplicable(exception, context);
        if (isExcepted) {
          matchedUrls.push(cause.url);
        }
        return isExcepted;
      });

      if (allCausesAreExcepted) {
        exceptedDependencies.add(dependency);
        matchedUrls.forEach(url => acknowledgedUrls.add(url));
        changed = true;
      }
    }
  }

  return {
    acknowledgedUrls,
    blocking: relevant.filter(
      ([dependency]) => !exceptedDependencies.has(dependency)
    ),
  };
}

function runAudit() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(
    npmCommand,
    ['audit', '--json', `--audit-level=${auditThreshold}`],
    {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      shell: process.platform === 'win32',
    }
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`npm audit failed with exit code ${result.status}`);
  }
  if (!result.stdout.trim()) {
    throw new Error('npm audit returned an empty report');
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
    throw new Error('npm audit did not return valid JSON');
  }
}

function main() {
  const report = runAudit();
  const { acknowledgedUrls, blocking } = evaluateAuditReport(
    report,
    loadAuditContext()
  );

  if (blocking.length > 0) {
    console.error(
      `npm audit found ${blocking.length} blocking package advisories at or above ${auditThreshold}:`
    );
    for (const [dependency, vulnerability] of blocking) {
      const references = vulnerability.via
        .filter(cause => typeof cause === 'object' && cause !== null)
        .map(cause => cause.url)
        .filter(Boolean);
      console.error(
        `- ${dependency} (${vulnerability.severity})${references.length ? `: ${references.join(', ')}` : ''}`
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log('npm audit found 0 applicable vulnerabilities.');
  for (const url of acknowledgedUrls) {
    const exception = auditExceptions.get(url);
    console.log(`- Acknowledged until ${exception.expiresAt}: ${url}`);
    console.log(`  ${exception.rationale}`);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invokedPath) {
  main();
}
