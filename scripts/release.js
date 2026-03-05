#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const semver = require('semver');

class ReleaseManager {
  constructor() {
    this.packageJsonPaths = [
      path.join(__dirname, '..', 'package.json'),
      path.join(__dirname, '..', 'frontend', 'package.json'),
      path.join(__dirname, '..', 'backend', 'package.json'),
    ];
    this.changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
    this.backendEnvPath = path.join(__dirname, '..', 'backend', '.env');
  }

  loadAnthropicApiKey() {
    try {
      if (fs.existsSync(this.backendEnvPath)) {
        const envContent = fs.readFileSync(this.backendEnvPath, 'utf8');
        const match = envContent.match(/^ANTHROPIC_API_KEY=(.+)$/m);
        if (match && match[1] && match[1].trim()) {
          return match[1].trim();
        }
      }
    } catch (error) {
      console.log('  ⚠️  Could not read backend .env file');
    }
    return null;
  }

  exec(command, options = {}) {
    if (typeof command !== 'string' || !command.trim()) {
      throw new Error('Invalid command: must be a non-empty string');
    }

    const shellCommands = [
      'git diff --exit-code',
      'git diff --cached --exit-code',
      'git describe --tags --abbrev=0',
      'git log',
      'npm run lint',
      'npm run build',
      'git add .',
      'git commit',
      'git tag',
      'git push',
      'git rev-parse',
      'git branch',
      'gh pr create',
      'gh pr merge',
    ];

    const needsShell = shellCommands.some(cmd => command.includes(cmd));

    if (needsShell) {
      const safePatterns = [
        /^git\s+/,
        /^npm\s+run\s+/,
        /^git\s+log\s+[\w\-\.]+\.\.HEAD\s+--oneline$/,
        /^git\s+commit\s+-m\s+"/,
        /^git\s+tag\s+-a\s+v[\d\.]+\s+-m\s+"/,
        /^git\s+push\s+/,
        /^git\s+rev-parse\s+/,
        /^git\s+branch\s+/,
        /^gh\s+pr\s+/,
      ];

      const isSafe = safePatterns.some(pattern => pattern.test(command));
      if (!isSafe) {
        throw new Error(`Unsafe shell command: ${command}`);
      }

      try {
        const result = execSync(command, {
          encoding: 'utf8',
          stdio: options.silent ? 'pipe' : 'inherit',
          ...options,
        });
        return result ? result.trim() : '';
      } catch (error) {
        if (options.allowFailure) return '';
        console.error(`Error executing shell command: ${command}`);
        console.error(error.message);
        throw error;
      }
    } else {
      const parts = command.trim().split(/\s+/);
      const program = parts[0];
      const args = parts.slice(1);

      const allowedPrograms = ['git', 'npm', 'gh'];
      if (!allowedPrograms.includes(program)) {
        throw new Error(`Program not allowed: ${program}`);
      }

      try {
        const result = spawnSync(program, args, {
          encoding: 'utf8',
          stdio: options.silent ? 'pipe' : 'inherit',
          shell: true,
          ...options,
        });

        if (result.error) throw result.error;
        if (result.status !== 0) {
          const errorMessage = result.stderr
            ? result.stderr.trim()
            : `Command failed with exit code ${result.status}`;
          throw new Error(errorMessage);
        }
        return result.stdout ? result.stdout.trim() : '';
      } catch (error) {
        if (options.allowFailure) return '';
        console.error(`Error executing command: ${command}`);
        console.error(error.message);
        throw error;
      }
    }
  }

  getCurrentVersion() {
    const packageJson = JSON.parse(fs.readFileSync(this.packageJsonPaths[0], 'utf8'));
    return packageJson.version;
  }

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

  getCommitsSinceLastTag() {
    try {
      const lastTag = this.exec('git describe --tags --abbrev=0', { silent: true });
      const commits = this.exec(`git log ${lastTag}..HEAD --oneline`, { silent: true })
        .split('\n')
        .filter(line => line.trim())
        .filter(line => {
          return (
            !line.includes('chore(release):') &&
            !line.includes('Merge branch') &&
            !line.includes('chore: run fmt') &&
            !line.includes('Update README.md') &&
            !line.includes('docs: add unreleased section')
          );
        });
      return { commits, lastTag };
    } catch {
      return {
        commits: this.exec('git log --oneline -50', { silent: true }).split('\n').filter(line => line.trim()),
        lastTag: null,
      };
    }
  }

  getCodeChanges(lastTag) {
    try {
      const range = lastTag ? `${lastTag}..HEAD` : 'HEAD~10..HEAD';
      const fileStats = this.exec(`git diff --stat ${range}`, { silent: true, allowFailure: true });
      const changedFiles = this.exec(`git diff --name-only ${range}`, { silent: true, allowFailure: true });
      return { fileStats, changedFiles };
    } catch {
      return { fileStats: '', changedFiles: '' };
    }
  }

  parseCommits(commits) {
    const features = [];
    const fixes = [];
    const improvements = [];
    const docs = [];
    const other = [];

    commits.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+\s+/, '');

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
        const cleanMessage = message.replace(/^chore(\(.+\))?:\s*/, '');
        if (!cleanMessage.match(/^(run fmt|bump|update dependencies|release)/)) {
          improvements.push(cleanMessage);
        }
      } else {
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

  generateChangelogSection(version, parsedCommits, aiSummary = null) {
    const date = new Date().toISOString().split('T')[0];

    if (aiSummary) {
      return `## [${version}] - ${date}\n\n${aiSummary}\n\n`;
    }

    let section = `## [${version}] - ${date}\n\n`;

    if (parsedCommits.features.length > 0) {
      section += '### ✨ New Features\n\n';
      parsedCommits.features.forEach(feature => {
        section += `- ${feature}\n`;
      });
      section += '\n';
    }

    if (parsedCommits.improvements.length > 0) {
      section += '### 🔧 Improvements\n\n';
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

  updateChangelog(version, parsedCommits, aiSummary = null) {
    const changelogContent = fs.readFileSync(this.changelogPath, 'utf8');
    const newSection = this.generateChangelogSection(version, parsedCommits, aiSummary);

    const unreleasedSectionRegex = /## \[Unreleased\][\s\S]*?(?=## \[|$)/;
    const unreleasedSection = `## [Unreleased]

### ✨ New Features

### 🔧 Improvements

### 🐛 Bug Fixes

### 📚 Documentation

`;

    const updatedChangelog = changelogContent.replace(
      unreleasedSectionRegex,
      unreleasedSection + '\n' + newSection
    );

    fs.writeFileSync(this.changelogPath, updatedChangelog);
  }

  determineNextVersion(currentVersion, commits, releaseType = null) {
    if (releaseType) {
      return semver.inc(currentVersion, releaseType);
    }

    const hasBreaking = commits.some(commit => commit.includes('BREAKING CHANGE') || commit.includes('!'));
    const hasFeatures = commits.some(commit => commit.match(/^[a-f0-9]+\s+feat(\(.+\))?:/));

    if (hasBreaking) {
      return semver.inc(currentVersion, 'major');
    } else if (hasFeatures) {
      return semver.inc(currentVersion, 'minor');
    } else {
      return semver.inc(currentVersion, 'patch');
    }
  }

  async generateAIReleaseSummary(commits, codeChanges) {
    const apiKey = this.loadAnthropicApiKey();

    if (!apiKey) {
      console.log('  ⚠️  No ANTHROPIC_API_KEY in backend/.env, using standard changelog');
      return null;
    }

    console.log('🤖 Generating AI release summary with Claude Sonnet...');

    const commitList = commits.join('\n');
    const prompt = `You are a technical writer creating release notes for Libre WebUI, an open-source AI chat interface.

## Commits since last release:
${commitList}

## Files changed:
${codeChanges.changedFiles}

## Change statistics:
${codeChanges.fileStats}

---

Generate a professional, concise release summary. Follow this exact format:

### What's New

[2-3 sentence overview of the most important changes]

### ✨ New Features
- [List key new features]

### 🔧 Improvements
- [List improvements]

### 🐛 Bug Fixes
- [List bug fixes]

---

Rules:
- Be concise but informative
- Focus on user-facing changes
- Group related changes together
- Skip empty sections entirely (don't include headers with no items)
- Use active voice
- No generic phrases like "various improvements"
- Each bullet should be specific`;

    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        const error = await response.text();
        console.log(`  ⚠️  Claude API error: ${error}`);
        return null;
      }

      const data = await response.json();
      if (data.content && data.content[0] && data.content[0].text) {
        console.log('  ✅ AI summary generated successfully');
        return data.content[0].text;
      }
    } catch (error) {
      console.log(`  ⚠️  Failed to generate AI summary: ${error.message}`);
    }

    return null;
  }

  ensureOnDevBranch() {
    const currentBranch = this.exec('git rev-parse --abbrev-ref HEAD', { silent: true });
    if (currentBranch !== 'dev') {
      console.error(`❌ Must be on 'dev' branch to create a release. Currently on '${currentBranch}'.`);
      process.exit(1);
    }
  }

  async createRelease(releaseType = null) {
    console.log('🚀 Starting Libre WebUI release process...\n');

    // Ensure we're on dev
    this.ensureOnDevBranch();

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
    const { commits, lastTag } = this.getCommitsSinceLastTag();

    if (commits.length === 0) {
      console.log('ℹ️  No new commits since last release.');
      return;
    }

    console.log(`📝 Found ${commits.length} commits since ${lastTag || 'start'}:`);
    commits.slice(0, 10).forEach(commit => console.log(`  - ${commit}`));
    if (commits.length > 10) {
      console.log(`  ... and ${commits.length - 10} more`);
    }
    console.log();

    // Determine next version
    const nextVersion = this.determineNextVersion(currentVersion, commits, releaseType);
    console.log(`📦 Current version: ${currentVersion}`);
    console.log(`📦 Next version: ${nextVersion}\n`);

    // Get code changes for AI analysis
    const codeChanges = this.getCodeChanges(lastTag);

    // Generate AI-powered release summary
    const aiSummary = await this.generateAIReleaseSummary(commits, codeChanges);
    if (aiSummary) {
      console.log('\n🤖 AI Release Summary:');
      console.log('─'.repeat(60));
      console.log(aiSummary);
      console.log('─'.repeat(60));
      console.log();
    }

    // Parse commits for fallback changelog
    const parsedCommits = this.parseCommits(commits);

    // Update package.json version
    console.log('📝 Updating package.json files...');
    this.updatePackageVersion(nextVersion);

    // Update changelog (use AI summary if available)
    console.log('📝 Updating CHANGELOG.md...');
    this.updateChangelog(nextVersion, parsedCommits, aiSummary);

    // Run pre-release checks
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

    // Format code before committing
    console.log('🎨 Formatting code...');
    try {
      this.exec('npm run format');
      console.log('  ✅ Code formatting completed');
    } catch (error) {
      console.error('  ❌ Code formatting failed:', error.message);
      process.exit(1);
    }

    // Commit release changes on dev
    console.log('📝 Committing release changes on dev...');
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

    // Push dev branch to origin
    console.log('📤 Pushing dev branch to origin...');
    try {
      this.exec('git push origin dev');
      console.log('  ✅ Dev branch pushed');
    } catch (error) {
      console.error('  ❌ Failed to push dev branch:', error.message);
      console.error('  Please push manually: git push origin dev');
      process.exit(1);
    }

    // Build PR body
    const prBody = this.buildPRBody(nextVersion, parsedCommits, aiSummary);

    // Create PR from dev to main
    console.log('🔀 Creating pull request from dev → main...');
    let prUrl = '';
    try {
      prUrl = execSync(
        `gh pr create --base main --head dev --title "chore(release): v${nextVersion}" --body "${prBody.replace(/"/g, '\\"')}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      ).trim();
      console.log(`  ✅ Pull request created: ${prUrl}`);
    } catch (error) {
      // PR might already exist
      if (error.message && error.message.includes('already exists')) {
        console.log('  ℹ️  A PR from dev → main already exists. Updating it...');
        try {
          prUrl = execSync('gh pr view dev --json url -q .url', {
            encoding: 'utf8',
            stdio: 'pipe',
          }).trim();
          console.log(`  ✅ Existing PR: ${prUrl}`);
        } catch {
          console.error('  ❌ Could not find existing PR');
        }
      } else {
        console.error('  ❌ Failed to create PR:', error.message);
        console.log('  Create it manually:');
        console.log(`     gh pr create --base main --head dev --title "chore(release): v${nextVersion}"`);
      }
    }

    // Enable auto-merge
    if (prUrl) {
      console.log('🤖 Enabling auto-merge...');
      try {
        execSync(`gh pr merge dev --auto --merge`, {
          encoding: 'utf8',
          stdio: 'pipe',
        });
        console.log('  ✅ Auto-merge enabled (will merge when all checks pass)');
      } catch (error) {
        console.log('  ⚠️  Could not enable auto-merge (may need to be enabled in repo settings)');
        console.log('  You can merge manually after checks pass.');
      }
    }

    console.log(`\n✅ Release v${nextVersion} PR created!`);
    console.log('\n📋 Next steps:');
    console.log('  1. Wait for all CI checks to pass on the PR');
    console.log('  2. Review and merge the PR (or auto-merge will handle it)');
    console.log('  3. After merge, tag the release on main:');
    console.log('     git checkout main && git pull');
    console.log(`     git tag -a v${nextVersion} -m "Release v${nextVersion}"`);
    console.log('     git push origin --tags');
    console.log('  4. The tag push will trigger the Release workflow (Electron builds + GitHub release)');
  }

  buildPRBody(version, parsedCommits, aiSummary) {
    let body = `## Release v${version}\n\n`;

    if (aiSummary) {
      body += aiSummary + '\n\n';
    } else {
      if (parsedCommits.features.length > 0) {
        body += '### New Features\n';
        parsedCommits.features.forEach(f => (body += `- ${f}\n`));
        body += '\n';
      }
      if (parsedCommits.fixes.length > 0) {
        body += '### Bug Fixes\n';
        parsedCommits.fixes.forEach(f => (body += `- ${f}\n`));
        body += '\n';
      }
      if (parsedCommits.improvements.length > 0) {
        body += '### Improvements\n';
        parsedCommits.improvements.forEach(f => (body += `- ${f}\n`));
        body += '\n';
      }
    }

    body += '---\n';
    body += 'This PR will be auto-merged once all checks pass.\n';
    body += 'After merge, tag the release on main to trigger the full release workflow.';

    return body;
  }
}

// CLI interface
const args = process.argv.slice(2);
const releaseType = args.find(arg => ['patch', 'minor', 'major'].includes(arg));

if (releaseType && !['patch', 'minor', 'major'].includes(releaseType)) {
  console.error(`❌ Invalid release type: ${releaseType}`);
  console.error('Valid types: patch, minor, major');
  process.exit(1);
}

let finalReleaseType = releaseType;
if (args.includes('--patch')) finalReleaseType = 'patch';
if (args.includes('--minor')) finalReleaseType = 'minor';
if (args.includes('--major')) finalReleaseType = 'major';

const releaseManager = new ReleaseManager();
releaseManager.createRelease(finalReleaseType);
