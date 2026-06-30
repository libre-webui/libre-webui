import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { buildDeterministicReleaseNotes } = require('./lib/releaseNotes.js');

test('release notes use changed-file evidence instead of duplicate commit dumps', () => {
  const notes = buildDeterministicReleaseNotes('0.12.0', {
    changedFiles: [
      { status: 'A', to: 'backend/src/routes/libreClaw.ts' },
      { status: 'A', to: 'frontend/src/pages/LibreClawPage.tsx' },
      { status: 'M', to: 'frontend/src/i18n/locales/fr.json' },
      { status: 'A', to: 'docs/31-LIBRE_CLAW_INTEGRATION.md' },
      { status: 'D', to: 'plugins/openclaw-agent.json' },
      { status: 'M', to: 'frontend/src/utils/artifactParser.ts' },
      { status: 'M', to: 'frontend/src/utils/api/authApi.ts' },
      { status: 'M', to: 'package-lock.json' },
    ],
    commits: [
      {
        body: '',
        date: '2026-06-30',
        hash: 'a'.repeat(40),
        shortHash: 'aaaaaaa',
        subject: 'Add Libre Claw i18n keys',
      },
      {
        body: '',
        date: '2026-06-30',
        hash: 'b'.repeat(40),
        shortHash: 'bbbbbbb',
        subject: 'fix: harden artifact title sanitization',
      },
    ],
    date: '2026-06-30',
    dependencyUpdates: ['axios', 'vite'],
    diffStat: '',
    fromRef: 'v0.11.0',
    localeFileCount: 25,
    localeFilesChanged: 1,
    range: 'v0.11.0..HEAD',
    toRef: 'HEAD',
    unreleasedNotes: '',
  });

  assert.match(notes, /first-class Libre Claw agent surface/);
  assert.match(notes, /Refreshed 2 dependencies, including axios and vite\./);
  assert.doesNotMatch(notes, /Add Libre Claw i18n keys/);
  assert.doesNotMatch(notes, /\b---\b/);
});
