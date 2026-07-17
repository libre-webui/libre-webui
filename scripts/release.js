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
  'helm/libre-webui/Chart.yaml',
];

class ReleaseManager {
  constructor(options = {}) {
    this.options = options;
    this.projectRoot = options.projectRoot || projectRoot;
    this.changelogPath = path.join(this.projectRoot, 'CHANGELOG.md');
    this.packageJsonPaths = [
      path.join(this.projectRoot, 'package.json'),
      path.join(this.projectRoot, 'frontend/package.json'),
      path.join(this.projectRoot, 'backend/package.json'),
    ];
    this.packageLockPath = path.join(this.projectRoot, 'package-lock.json');
    this.helmChartPath = path.join(
      this.projectRoot,
      'helm/libre-webui/Chart.yaml'
    );
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
    this.ensureTagAvailable(nextVersion);

    console.log('📝 Generating release notes from git history...');
    const releaseSection = await createReleaseSection(nextVersion, evidence, {
      useAI: !this.options.noAI,
    });

    console.log('📝 Updating version files...');
    this.updateHelmChartVersions(currentVersion, nextVersion);
    this.updatePackageJsonVersions(nextVersion);
    this.updatePackageLockVersion(nextVersion);

    console.log('📝 Updating CHANGELOG.md...');
    updateChangelogWithSection(this.changelogPath, releaseSection);

    console.log('🎨 Formatting release files...');
    npm(['run', 'format']);

    this.ensureOnlyReleaseFilesChanged();

    console.log('🔍 Running the complete pre-release gate...');
    npm(['run', 'release:check']);
    this.ensureOnlyReleaseFilesChanged();

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

  ensureTagAvailable(version) {
    const tag = git(['tag', '-l', `v${version}`], { silent: true });
    if (tag.trim()) {
      throw new Error(
        `Tag v${version} already exists locally; refusing to create a partial release`
      );
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
      console.log(`  ✅ ${path.relative(this.projectRoot, packageJsonPath)}`);
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
    console.log(
      `  ✅ ${path.relative(this.projectRoot, this.packageLockPath)}`
    );
  }

  updateHelmChartVersions(currentVersion, newVersion) {
    const chart = fs.readFileSync(this.helmChartPath, 'utf8');
    const chartVersion = this.readHelmVersion(chart, 'version');
    const appVersion = this.readHelmVersion(chart, 'appVersion');

    if (chartVersion !== currentVersion || appVersion !== currentVersion) {
      throw new Error(
        `Helm version policy requires chart version and appVersion to both match the current package version ${currentVersion}; found ${chartVersion} and ${appVersion}`
      );
    }

    const updatedChart = chart
      .replace(/^version:.*$/m, `version: ${newVersion}`)
      .replace(/^appVersion:.*$/m, `appVersion: "${newVersion}"`);

    fs.writeFileSync(this.helmChartPath, updatedChart);
    console.log(`  ✅ ${path.relative(this.projectRoot, this.helmChartPath)}`);
  }

  readHelmVersion(chart, key) {
    const match = chart.match(
      new RegExp(`^${key}:\\s*["']?([^"'\\s#]+)["']?(?:\\s+#.*)?$`, 'm')
    );

    if (!match) {
      throw new Error(`Unable to read ${key} from the Helm chart`);
    }

    return match[1];
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

function run() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const manager = new ReleaseManager(options);
  manager.createRelease(options.releaseType).catch(error => {
    console.error(`❌ Release failed: ${error.message}`);
    process.exit(1);
  });
}

if (require.main === module) {
  run();
}

module.exports = {
  ReleaseManager,
  releaseFiles,
};
