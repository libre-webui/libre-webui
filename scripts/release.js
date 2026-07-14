#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const semver = require('semver');
const { git, npm, projectRoot } = require('./lib/command');
const {
  collectReleaseEvidence,
  createReleaseSection,
  getPreviousTag,
  updateChangelogWithSection,
} = require('./lib/releaseNotes');
const { parsePorcelainStatus } = require('./lib/releaseStatus');

const releaseFiles = [
  'CHANGELOG.md',
  'package.json',
  'package-lock.json',
  'frontend/package.json',
  'backend/package.json',
];

class ReleaseManager {
  constructor(options = {}) {
    this.options = options;
    this.changelogPath = path.join(projectRoot, 'CHANGELOG.md');
    this.packageJsonPaths = [
      path.join(projectRoot, 'package.json'),
      path.join(projectRoot, 'frontend/package.json'),
      path.join(projectRoot, 'backend/package.json'),
    ];
    this.packageLockPath = path.join(projectRoot, 'package-lock.json');
  }

  async createRelease(releaseType = null) {
    console.log('🚀 Starting Libre WebUI release process...\n');
    this.ensureCleanWorkingTree();

    const currentVersion = this.getCurrentVersion();
    const previousTag = getPreviousTag();
    const evidence = collectReleaseEvidence({
      changelogPath: this.changelogPath,
      fromRef: previousTag,
    });

    if (evidence.commits.length === 0 && !evidence.unreleasedNotes) {
      console.log('ℹ️  No releasable changes found.');
      return;
    }

    this.printEvidenceSummary(evidence);

    const nextVersion = this.determineNextVersion(
      currentVersion,
      evidence.commits,
      releaseType
    );
    console.log(`📦 Current version: ${currentVersion}`);
    console.log(`📦 Next version: ${nextVersion}\n`);

    console.log('📝 Generating release notes from git history...');
    const releaseSection = await createReleaseSection(nextVersion, evidence, {
      useAI: !this.options.noAI,
    });

    console.log('📝 Updating package files...');
    this.updatePackageJsonVersions(nextVersion);
    this.updatePackageLockVersion(nextVersion);

    console.log('📝 Updating CHANGELOG.md...');
    updateChangelogWithSection(this.changelogPath, releaseSection);

    console.log('🎨 Formatting release files...');
    npm(['run', 'format']);

    this.ensureOnlyReleaseFilesChanged();

    console.log('🔍 Running pre-release checks...');
    npm(['run', 'lint']);
    npm(['run', 'build']);

    console.log('📝 Committing release changes...');
    git(['add', ...releaseFiles]);
    git(['commit', '-m', `chore(release): ${nextVersion}`]);

    console.log('🏷️  Creating git tag...');
    git(['tag', '-a', `v${nextVersion}`, '-m', `Release v${nextVersion}`]);
    this.verifyTag(nextVersion);

    console.log(`\n✅ Release v${nextVersion} created successfully!`);
    console.log('\n📋 Next steps:');
    console.log(`  1. Review the release: git show v${nextVersion}`);
    console.log('  2. Push the release commit: git push origin main');
    console.log(`  3. Push this release tag: git push origin v${nextVersion}`);
  }

  ensureCleanWorkingTree() {
    try {
      git(['diff', '--exit-code'], { silent: true });
      git(['diff', '--cached', '--exit-code'], { silent: true });
    } catch {
      console.error(
        '❌ Working directory is not clean. Commit or stash changes before releasing.'
      );
      process.exit(1);
    }
  }

  ensureOnlyReleaseFilesChanged() {
    const status = git(['status', '--porcelain'], { silent: true });
    const changedPaths = parsePorcelainStatus(status);

    const unexpected = changedPaths.filter(
      changedPath => !releaseFiles.includes(changedPath)
    );

    if (unexpected.length > 0) {
      console.error('❌ Release formatting changed non-release files:');
      unexpected.forEach(file => console.error(`  - ${file}`));
      console.error(
        'Commit or revert those changes before running release again.'
      );
      process.exit(1);
    }
  }

  getCurrentVersion() {
    const packageJson = JSON.parse(
      fs.readFileSync(this.packageJsonPaths[0], 'utf8')
    );
    return packageJson.version;
  }

  determineNextVersion(currentVersion, commits, releaseType = null) {
    if (releaseType) {
      return semver.inc(currentVersion, releaseType);
    }

    const hasBreaking = commits.some(commit =>
      /BREAKING CHANGE|^\w+(?:\(.+\))?!:/.test(
        `${commit.subject}\n${commit.body}`
      )
    );
    const hasFeature = commits.some(commit =>
      /^feat(?:\(.+\))?:/.test(commit.subject)
    );

    if (hasBreaking) return semver.inc(currentVersion, 'major');
    if (hasFeature) return semver.inc(currentVersion, 'minor');
    return semver.inc(currentVersion, 'patch');
  }

  updatePackageJsonVersions(newVersion) {
    for (const packageJsonPath of this.packageJsonPaths) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      packageJson.version = newVersion;
      fs.writeFileSync(
        packageJsonPath,
        `${JSON.stringify(packageJson, null, 2)}\n`
      );
      console.log(`  ✅ ${path.relative(projectRoot, packageJsonPath)}`);
    }
  }

  updatePackageLockVersion(newVersion) {
    if (!fs.existsSync(this.packageLockPath)) return;

    const packageLock = JSON.parse(
      fs.readFileSync(this.packageLockPath, 'utf8')
    );
    packageLock.version = newVersion;

    const workspacePackages = ['', 'frontend', 'backend'];
    for (const workspacePackage of workspacePackages) {
      if (packageLock.packages?.[workspacePackage]) {
        packageLock.packages[workspacePackage].version = newVersion;
      }
    }

    fs.writeFileSync(
      this.packageLockPath,
      `${JSON.stringify(packageLock, null, 2)}\n`
    );
    console.log(`  ✅ ${path.relative(projectRoot, this.packageLockPath)}`);
  }

  printEvidenceSummary(evidence) {
    console.log(
      `📝 Found ${evidence.commits.length} commits since ${evidence.fromRef || 'the beginning'}`
    );
    evidence.commits.slice(0, 8).forEach(commit => {
      console.log(`  - ${commit.shortHash} ${commit.subject}`);
    });
    if (evidence.commits.length > 8) {
      console.log(`  ... and ${evidence.commits.length - 8} more`);
    }
    console.log(`📁 ${evidence.changedFiles.length} changed files\n`);
  }

  verifyTag(version) {
    const tag = git(['tag', '-l', `v${version}`], { silent: true });
    if (tag.trim() !== `v${version}`) {
      throw new Error(`Tag verification failed for v${version}`);
    }
    console.log(`  ✅ Tag v${version} verified`);
  }
}

function parseArgs(args) {
  const releaseType = args
    .map(arg => arg.replace(/^--/, ''))
    .find(arg => ['patch', 'minor', 'major'].includes(arg));

  const invalidReleaseType = args
    .map(arg => arg.replace(/^--/, ''))
    .find(arg => ['patch', 'minor', 'major'].includes(arg) === false);

  if (invalidReleaseType && !['no-ai', 'help'].includes(invalidReleaseType)) {
    console.error(`❌ Invalid release argument: ${invalidReleaseType}`);
    printUsage();
    process.exit(1);
  }

  return {
    help: args.includes('--help') || args.includes('help'),
    noAI: args.includes('--no-ai'),
    releaseType,
  };
}

function printUsage() {
  console.log(`Usage: node scripts/release.js [patch|minor|major] [--no-ai]

Environment:
  CHANGELOG_AI=0                 Disable AI release notes
  CHANGELOG_AI_MODEL=glm-5.2:cloud
  OLLAMA_BASE_URL=http://127.0.0.1:11434
  CHANGELOG_AI_TIMEOUT_MS=180000
`);
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  printUsage();
  process.exit(0);
}

const manager = new ReleaseManager(options);
manager.createRelease(options.releaseType).catch(error => {
  console.error(`❌ Release failed: ${error.message}`);
  process.exit(1);
});
