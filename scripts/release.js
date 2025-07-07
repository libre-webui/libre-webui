#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const semver = require('semver');

/**
 * Release script for Libre WebUI
 * Automatically updates version, generates changelog, and creates git tags
 */

class ReleaseManager {
  constructor() {
    this.packageJsonPaths = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', 'frontend', 'package.json'),
      path.join(__dirname, '..', 'backend', 'package.json')
    ];
    this.changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
  }

  /**
   * Execute shell command and return output
   */
  exec(command, options = {}) {
    try {
      const result = execSync(command, { 
        encoding: 'utf8', 
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options 
      });
      return result ? result.trim() : '';
    } catch (error) {
      console.error(`Error executing command: ${command}`);
      console.error(error.message);
      process.exit(1);
    }
  }

  /**
   * Get current version from package.json
   */
  getCurrentVersion() {
    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPaths[0], 'utf8'));
    return packageJson.version;
  }

  /**
   * Update version in all package.json files
   */
  updatePackageVersion(newVersion) {
    this.packageJsonPaths.forEach(packageJsonPath => {
      if (fs.existsSync(packageJsonPath)) {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        packageJson.version = newVersion;
        fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
        console.log(`  ✅ Updated ${path.relative(path.join(__dirname, '..'), packageJsonPath)}`);
      }
    });
  }

  /**
   * Get commits since last tag
   */
  getCommitsSinceLastTag() {
    try {
      const lastTag = this.exec('git describe --tags --abbrev=0', { silent: true });
      return this.exec(`git log ${lastTag}..HEAD --oneline`, { silent: true }).split('\n').filter(line => line.trim());
    } catch {
      // No previous tags
      return this.exec('git log --oneline', { silent: true }).split('\n').filter(line => line.trim());
    }
  }

  /**
   * Parse conventional commits
   */
  parseCommits(commits) {
    const features = [];
    const fixes = [];
    const improvements = [];
    const docs = [];
    const other = [];

    commits.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+\s+/, '');
      
      if (message.match(/^feat(\(.+\))?:/)) {
        features.push(message.replace(/^feat(\(.+\))?:\s*/, ''));
      } else if (message.match(/^fix(\(.+\))?:/)) {
        fixes.push(message.replace(/^fix(\(.+\))?:\s*/, ''));
      } else if (message.match(/^(refactor|perf|style|chore)(\(.+\))?:/)) {
        improvements.push(message.replace(/^(refactor|perf|style|chore)(\(.+\))?:\s*/, ''));
      } else if (message.match(/^docs(\(.+\))?:/)) {
        docs.push(message.replace(/^docs(\(.+\))?:\s*/, ''));
      } else {
        other.push(message);
      }
    });

    return { features, fixes, improvements, docs, other };
  }

  /**
   * Generate changelog content for new version
   */
  generateChangelogSection(version, parsedCommits) {
    const date = new Date().toISOString().split('T')[0];
    let section = `## [${version}] - ${date}\n\n`;

    if (parsedCommits.features.length > 0) {
      section += '### ✨ Added\n\n';
      parsedCommits.features.forEach(feature => {
        section += `- ${feature}\n`;
      });
      section += '\n';
    }

    if (parsedCommits.improvements.length > 0) {
      section += '### 🔧 Technical Improvements\n\n';
      parsedCommits.improvements.forEach(improvement => {
        section += `- ${improvement}\n`;
      });
      section += '\n';
    }

    if (parsedCommits.fixes.length > 0) {
      section += '### 🐛 Bug Fixes\n\n';
      parsedCommits.fixes.forEach(fix => {
        section += `- ${fix}\n`;
      });
      section += '\n';
    }

    if (parsedCommits.docs.length > 0) {
      section += '### 📚 Documentation\n\n';
      parsedCommits.docs.forEach(doc => {
        section += `- ${doc}\n`;
      });
      section += '\n';
    }

    if (parsedCommits.other.length > 0) {
      section += '### 🔄 Other Changes\n\n';
      parsedCommits.other.forEach(change => {
        section += `- ${change}\n`;
      });
      section += '\n';
    }

    return section;
  }

  /**
   * Update changelog with new version
   */
  updateChangelog(version, parsedCommits) {
    const changelogContent = fs.readFileSync(this.changelogPath, 'utf8');
    const newSection = this.generateChangelogSection(version, parsedCommits);
    
    // Find the [Unreleased] section and replace it
    const unreleasedSectionRegex = /## \[Unreleased\][\s\S]*?(?=## \[|$)/;
    const unreleasedSection = `## [Unreleased]

### ✨ Added

### 🔧 Technical Improvements

### 🐛 Bug Fixes

### 📚 Documentation

`;

    const updatedChangelog = changelogContent.replace(
      unreleasedSectionRegex,
      unreleasedSection + '\n' + newSection
    );

    fs.writeFileSync(this.changelogPath, updatedChangelog);
  }

  /**
   * Determine next version based on commits
   */
  determineNextVersion(currentVersion, commits, releaseType = null, forceType = false) {
    if (forceType && releaseType) {
      return semver.inc(currentVersion, releaseType);
    }
    
    if (releaseType) {
      return semver.inc(currentVersion, releaseType);
    }

    const hasBreaking = commits.some(commit => 
      commit.includes('BREAKING CHANGE') || commit.includes('!')
    );
    const hasFeatures = commits.some(commit => 
      commit.match(/^[a-f0-9]+\s+feat(\(.+\))?:/)
    );

    if (hasBreaking) {
      return semver.inc(currentVersion, 'major');
    } else if (hasFeatures) {
      return semver.inc(currentVersion, 'minor');
    } else {
      return semver.inc(currentVersion, 'patch');
    }
  }

  /**
   * Create a new release
   */
  createRelease(releaseType = null, forceType = false) {
    console.log('🚀 Starting release process...\n');

    // Check if working directory is clean
    try {
      this.exec('git diff --exit-code', { silent: true });
      this.exec('git diff --cached --exit-code', { silent: true });
    } catch {
      console.error('❌ Working directory is not clean. Please commit or stash your changes.');
      process.exit(1);
    }

    // Get current version and commits
    const currentVersion = this.getCurrentVersion();
    const commits = this.getCommitsSinceLastTag();
    
    if (commits.length === 0) {
      console.log('ℹ️  No new commits since last release.');
      return;
    }

    console.log(`📝 Found ${commits.length} commits since last release:`);
    commits.forEach(commit => console.log(`  - ${commit}`));
    console.log();

    // Determine next version
    const nextVersion = this.determineNextVersion(currentVersion, commits, releaseType, forceType);
    console.log(`📦 Current version: ${currentVersion}`);
    console.log(`📦 Next version: ${nextVersion}\n`);

    // Parse commits for changelog
    const parsedCommits = this.parseCommits(commits);

    // Update package.json version
    console.log('📝 Updating package.json files...');
    this.updatePackageVersion(nextVersion);

    // Update changelog
    console.log('📝 Updating CHANGELOG.md...');
    this.updateChangelog(nextVersion, parsedCommits);

    // Run any pre-release scripts (linting, building, etc.)
    console.log('🔍 Running pre-release checks...');
    this.exec('npm run lint');
    this.exec('npm run build');

    // Commit changes
    console.log('📝 Committing release changes...');
    this.exec('git add .');
    this.exec(`git commit -m "chore(release): ${nextVersion}"`);

    // Create git tag
    console.log('🏷️  Creating git tag...');
    this.exec(`git tag -a v${nextVersion} -m "Release v${nextVersion}"`);

    console.log(`\n✅ Release v${nextVersion} created successfully!`);
    console.log('\n📋 Next steps:');
    console.log('  1. Review the changes:');
    console.log(`     git show v${nextVersion}`);
    console.log('  2. Push to remote:');
    console.log('     git push origin main && git push origin --tags');
    console.log('  3. Create a GitHub release from the tag');
  }
}

// CLI interface
const args = process.argv.slice(2);
const releaseType = args.find(arg => ['patch', 'minor', 'major'].includes(arg));
const forcePatch = args.includes('--patch');
const forceMinor = args.includes('--minor');
const forceMajor = args.includes('--major');

if (releaseType && !['patch', 'minor', 'major'].includes(releaseType)) {
  console.error(`❌ Invalid release type: ${releaseType}`);
  console.error(`Valid types: patch, minor, major`);
  process.exit(1);
}

// Determine the final release type
let finalReleaseType = releaseType;
if (forcePatch) finalReleaseType = 'patch';
if (forceMinor) finalReleaseType = 'minor';
if (forceMajor) finalReleaseType = 'major';

const releaseManager = new ReleaseManager();
releaseManager.createRelease(finalReleaseType, forcePatch || forceMinor || forceMajor);
