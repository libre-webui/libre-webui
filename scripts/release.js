#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
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
   * Execute shell command with validation
   */
  exec(command, options = {}) {
    // Validate command is a string and not empty
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('Invalid command: must be a non-empty string');
    }

    // For specific safe commands that need shell features, use execSync with validation
    const shellCommands = [
      'git diff --exit-code',
      'git diff --cached --exit-code',
      'git describe --tags --abbrev=0',
      'git log',
      'npm run lint',
      'npm run build',
      'git add .',
      'git commit',
      'git tag'
    ];

    const needsShell = shellCommands.some(cmd => command.includes(cmd));

    if (needsShell) {
      // Validate command starts with known safe patterns
      const safePatterns = [
        /^git\s+/,
        /^npm\s+run\s+/,
        /^git\s+log\s+[\w\-\.]+\.\.HEAD\s+--oneline$/,
        /^git\s+commit\s+-m\s+"/,
        /^git\s+tag\s+-a\s+v[\d\.]+\s+-m\s+"/
      ];

      const isSafe = safePatterns.some(pattern => pattern.test(command));
      if (!isSafe) {
        throw new Error(`Unsafe shell command: ${command}`);
      }

      try {
        const result = execSync(command, { 
          encoding: 'utf8', 
          stdio: options.silent ? 'pipe' : 'inherit',
          ...options 
        });
        return result ? result.trim() : '';
      } catch (error) {
        console.error(`Error executing shell command: ${command}`);
        console.error(error.message);
        throw error; // Re-throw to allow caller to handle
      }
    } else {
      // Use spawn for better security
      const parts = command.trim().split(/\s+/);
      const program = parts[0];
      const args = parts.slice(1);

      const allowedPrograms = ['git', 'npm'];
      if (!allowedPrograms.includes(program)) {
        throw new Error(`Program not allowed: ${program}`);
      }

      try {
        const result = spawnSync(program, args, {
          encoding: 'utf8',
          stdio: options.silent ? 'pipe' : 'inherit',
          ...options
        });

        if (result.error) {
          throw result.error;
        }

        if (result.status !== 0) {
          const errorMessage = result.stderr ? result.stderr.trim() : `Command failed with exit code ${result.status}`;
          throw new Error(errorMessage);
        }

        return result.stdout ? result.stdout.trim() : '';
      } catch (error) {
        console.error(`Error executing command: ${command}`);
        console.error(error.message);
        throw error; // Re-throw to allow caller to handle
      }
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
      const commits = this.exec(`git log ${lastTag}..HEAD --oneline`, { silent: true })
        .split('\n')
        .filter(line => line.trim())
        .filter(line => {
          // Filter out previous release commits and merge commits
          return !line.includes('chore(release):') && 
                 !line.includes('Merge branch') &&
                 !line.includes('chore: run fmt') &&
                 !line.includes('Update README.md') &&
                 !line.includes('docs: add unreleased section');
        });
      return commits;
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
      
      // Skip certain types of commits that shouldn't be in changelog
      if (message.match(/^(chore\(release\)|Merge pull request|Merge branch)/)) {
        return;
      }
      
      if (message.match(/^feat(\(.+\))?:/)) {
        features.push(message.replace(/^feat(\(.+\))?:\s*/, ''));
      } else if (message.match(/^fix(\(.+\))?:/)) {
        fixes.push(message.replace(/^fix(\(.+\))?:\s*/, ''));
      } else if (message.match(/^(refactor|perf|style)(\(.+\))?:/)) {
        improvements.push(message.replace(/^(refactor|perf|style)(\(.+\))?:\s*/, ''));
      } else if (message.match(/^docs(\(.+\))?:/)) {
        docs.push(message.replace(/^docs(\(.+\))?:\s*/, ''));
      } else if (message.match(/^chore(\(.+\))?:/)) {
        // Only include meaningful chore commits
        const cleanMessage = message.replace(/^chore(\(.+\))?:\s*/, '');
        if (!cleanMessage.match(/^(run fmt|bump|update dependencies|release)/)) {
          improvements.push(cleanMessage);
        }
      } else {
        // For non-conventional commits, try to categorize by keywords
        if (message.match(/^(add|implement|introduce)/i)) {
          features.push(message);
        } else if (message.match(/^(fix|resolve|patch)/i)) {
          fixes.push(message);
        } else if (message.match(/^(update|improve|enhance|optimize)/i)) {
          improvements.push(message);
        } else {
          other.push(message);
        }
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
    try {
      this.exec('npm run lint');
      console.log('  ✅ Linting passed');
    } catch (error) {
      console.error('  ❌ Linting failed:', error.message);
      process.exit(1);
    }
    
    try {
      this.exec('npm run build');
      console.log('  ✅ Build completed');
    } catch (error) {
      console.error('  ❌ Build failed:', error.message);
      process.exit(1);
    }

    // Commit changes
    console.log('📝 Committing release changes...');
    try {
      this.exec('git add .');
      console.log('  ✅ Files staged');
    } catch (error) {
      console.error('  ❌ Failed to stage files:', error.message);
      process.exit(1);
    }

    try {
      this.exec(`git commit -m "chore(release): ${nextVersion}"`);
      console.log('  ✅ Release commit created');
    } catch (error) {
      console.error('  ❌ Failed to create commit:', error.message);
      process.exit(1);
    }

    // Format code after commit
    console.log('🎨 Formatting code...');
    try {
      this.exec('npm run format');
      console.log('  ✅ Code formatting completed');
    } catch (error) {
      console.error('  ❌ Code formatting failed:', error.message);
      process.exit(1);
    }

    // Create git tag
    console.log('🏷️  Creating git tag...');
    try {
      this.exec(`git tag -a v${nextVersion} -m "Release v${nextVersion}"`);
      console.log(`  ✅ Tag v${nextVersion} created successfully`);
    } catch (error) {
      console.error(`  ❌ Failed to create tag v${nextVersion}:`, error.message);
      process.exit(1);
    }

    console.log(`\n✅ Release v${nextVersion} created successfully!`);
    
    // Verify the tag was created
    try {
      const tagExists = this.exec(`git tag -l v${nextVersion}`, { silent: true });
      if (tagExists.trim() === `v${nextVersion}`) {
        console.log(`  ✅ Tag v${nextVersion} verified`);
      } else {
        console.error(`  ❌ Tag verification failed - tag v${nextVersion} not found`);
      }
    } catch (error) {
      console.error(`  ❌ Tag verification failed:`, error.message);
    }
    
    console.log('\n📋 Next steps:');
    console.log('  1. Review the changes:');
    console.log(`     git show v${nextVersion}`);
    console.log('  2. Push to remote:');
    console.log('     git push origin main && git push origin --tags');
    console.log('  3. GitHub release will be created automatically when tag is pushed');
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
