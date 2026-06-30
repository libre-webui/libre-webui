#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  collectReleaseEvidence,
  createReleaseSection,
  getPreviousTag,
  projectRoot,
  updateChangelogWithSection,
} = require('./lib/releaseNotes');

const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
const packageJsonPath = path.join(projectRoot, 'package.json');

function getVersion(args) {
  const explicitVersion = args.find(arg => /^\d+\.\d+\.\d+/.test(arg));
  if (explicitVersion) return explicitVersion;

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  return packageJson.version;
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find(arg => ['show', 'update'].includes(arg)) || 'show';
  const version = getVersion(args);
  const evidence = collectReleaseEvidence({
    changelogPath,
    fromRef: getPreviousTag(),
  });

  if (evidence.commits.length === 0 && !evidence.unreleasedNotes) {
    console.log('ℹ️  No unreleased changes found.');
    return;
  }

  const section = await createReleaseSection(version, evidence, {
    useAI: !args.includes('--no-ai') && process.env.CHANGELOG_AI !== '0',
  });

  if (command === 'update') {
    updateChangelogWithSection(changelogPath, section);
    console.log('✅ CHANGELOG.md updated.');
    return;
  }

  console.log(section.trim());
}

main().catch(error => {
  console.error(`❌ Changelog generation failed: ${error.message}`);
  process.exit(1);
});
