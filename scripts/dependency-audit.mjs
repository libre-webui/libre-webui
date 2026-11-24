#!/usr/bin/env node
/*
 * Dependency audit gate.
 *
 * Runs `npm audit` and fails on any moderate-or-higher finding, except
 * findings that trace only to an advisory listed below. An advisory is listed
 * only when it has no fixed release and the vulnerable code runs at build or
 * lint time on this repository's own inputs. Each entry stops counting as
 * soon as npm can install a fix for the advisory's own package, so the gate
 * fails again and the entry has to be removed with the upgrade.
 *
 * Usage:
 *   node scripts/dependency-audit.mjs                  run npm audit here
 *   node scripts/dependency-audit.mjs --report <file>  read a saved JSON report
 *   --github-output                                    write findings=<n> to
 *                                                      $GITHUB_OUTPUT and exit 0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Entry shape: [npm advisory source id, { id: 'GHSA-…', package, reason }].
// Empty since 2026-11-24: GitHub withdrew GHSA-fc5q-39xc-vjpf (picomatch), the
// only entry, on 2026-11-18, and npm audit no longer reports it.
export const TOLERATED_ADVISORIES = new Map();

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

/**
 * Splits an `npm audit --json` report into blocking and tolerated findings.
 * `verdict` is false when the report carries no metadata, which is what npm
 * writes when the advisory service could not be reached.
 */
export function evaluateAuditReport(report, tolerated = TOLERATED_ADVISORIES) {
  if (!report?.metadata?.vulnerabilities) {
    return { verdict: false, blocking: [], tolerated: [], expired: [] };
  }
  const vulnerabilities = report.vulnerabilities ?? {};

  const active = new Set();
  const expired = [];
  for (const [source, entry] of tolerated) {
    const own = vulnerabilities[entry.package];
    const listed = own?.via?.some(
      via => typeof via === 'object' && via?.source === source
    );
    if (!listed) continue;
    if (own.fixAvailable === true) expired.push(entry.id);
    else active.add(source);
  }

  const memo = new Map();
  const sourcesOf = (name, visiting) => {
    if (memo.has(name)) return memo.get(name);
    const vulnerability = vulnerabilities[name];
    if (!vulnerability || visiting.has(name)) return new Set();
    const next = new Set(visiting).add(name);
    const sources = new Set();
    for (const via of vulnerability.via ?? []) {
      if (typeof via === 'string') {
        for (const source of sourcesOf(via, next)) sources.add(source);
      } else if (via && via.source !== undefined) {
        sources.add(via.source);
      }
    }
    memo.set(name, sources);
    return sources;
  };

  const blocking = [];
  const allowed = [];
  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if ((SEVERITY_RANK[vulnerability.severity] ?? 0) < SEVERITY_RANK.moderate) {
      continue;
    }
    const sources = sourcesOf(name, new Set());
    if (sources.size > 0 && [...sources].every(source => active.has(source))) {
      allowed.push(name);
    } else {
      blocking.push({ name, severity: vulnerability.severity });
    }
  }
  return { verdict: true, blocking, tolerated: allowed, expired };
}

function readReport(args, root) {
  const reportFlag = args.indexOf('--report');
  if (reportFlag !== -1) {
    const file = args[reportFlag + 1];
    if (!file) throw new Error('--report needs a file path');
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  }
  const result = spawnSync('npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
  try {
    return JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr ?? '');
    return null;
  }
}

function main(args) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const result = evaluateAuditReport(readReport(args, root));

  if (!result.verdict) {
    console.error(
      'npm audit produced no verdict (advisory service unreachable?).'
    );
  } else {
    for (const id of result.expired) {
      console.error(
        `${id} can now be fixed; upgrade and remove it from scripts/dependency-audit.mjs.`
      );
    }
    for (const { name, severity } of result.blocking) {
      console.error(`${name}: ${severity}`);
    }
    if (result.blocking.length === 0) {
      const reasons = [...TOLERATED_ADVISORIES.values()]
        .map(entry => `${entry.id}: ${entry.reason}`)
        .join(' ');
      console.log(
        'Dependency audit passed: no untolerated moderate-or-higher findings.' +
          (result.tolerated.length > 0
            ? ` ${result.tolerated.length} entries trace only to tolerated advisories. ${reasons}`
            : '')
      );
    }
  }

  const findings = result.verdict ? result.blocking.length : -1;
  if (args.includes('--github-output')) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `findings=${findings}\n`);
    console.log(
      findings < 0
        ? 'npm audit produced no verdict'
        : `npm audit findings (moderate+, untolerated): ${findings}`
    );
    return 0;
  }
  return findings === 0 ? 0 : 1;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
) {
  process.exitCode = main(process.argv.slice(2));
}
