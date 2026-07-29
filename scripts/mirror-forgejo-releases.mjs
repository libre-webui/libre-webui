#!/usr/bin/env node

import {
  assertValidTag,
  mirrorAllForgejoReleases,
  mirrorForgejoRelease,
  redactSecrets,
} from './lib/forgejoReleaseMirror.mjs';

function usage() {
  return [
    'Usage:',
    '  node scripts/mirror-forgejo-releases.mjs --tag vX.Y.Z [--dry-run]',
    '  node scripts/mirror-forgejo-releases.mjs --all [--dry-run]',
  ].join('\n');
}

function parseArguments(argv) {
  let tag = null;
  let all = false;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--tag') {
      if (tag !== null || index + 1 >= argv.length) {
        throw new Error(`Invalid --tag argument\n${usage()}`);
      }
      tag = assertValidTag(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argument === '--all') {
      all = true;
      continue;
    }

    if (argument === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (argument === '--help' || argument === '-h') {
      return { help: true };
    }

    throw new Error(`Unknown argument ${argument}\n${usage()}`);
  }

  if ((tag === null && !all) || (tag !== null && all)) {
    throw new Error(`Choose exactly one of --tag or --all\n${usage()}`);
  }

  return { tag, all, dryRun, help: false };
}

function printSummary(summary) {
  const assets = summary.assets;
  console.log(
    [
      summary.tag,
      `release=${summary.release}`,
      `assets(created=${assets.created}`,
      `updated=${assets.updated}`,
      `unchanged=${assets.unchanged}`,
      `would-create=${assets.wouldCreate}`,
      `would-update=${assets.wouldUpdate})`,
    ].join(' ')
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const githubToken = process.env.GITHUB_TOKEN || '';
  const forgejoToken = process.env.FORGEJO_TOKEN || '';
  const commonOptions = {
    githubToken,
    forgejoToken,
    dryRun: options.dryRun,
  };

  if (options.all) {
    const summaries = await mirrorAllForgejoReleases({
      ...commonOptions,
      onProgress: printSummary,
    });
    console.log(`Mirrored ${summaries.length} GitHub releases to Forgejo.`);
    return;
  }

  const summary = await mirrorForgejoRelease({
    ...commonOptions,
    tag: options.tag,
  });
  printSummary(summary);
}

const secrets = [
  process.env.GITHUB_TOKEN || '',
  process.env.FORGEJO_TOKEN || '',
].filter(Boolean);

main().catch(error => {
  console.error(
    redactSecrets(error instanceof Error ? error.message : error, secrets)
  );
  process.exitCode = 1;
});
