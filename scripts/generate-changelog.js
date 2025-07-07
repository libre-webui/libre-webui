#!/usr/bin/env node

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Standalone changelog generator for Libre WebUI
 * Generates changelog content without creating a release
 */

class ChangelogGenerator {
  constructor() {
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

    // Validate command is a safe git command
    const safePatterns = [
      /^git\s+describe\s+--tags\s+--abbrev=0$/,
      /^git\s+log\s+[\w\-\.]+\.\.HEAD\s+--oneline$/,
      /^git\s+log\s+--oneline$/,
      /^git\s+log\s+[\w\-\.]+\s+--oneline$/
    ];

    const isSafe = safePatterns.some(pattern => pattern.test(command));
    if (!isSafe) {
      throw new Error(`Unsafe command: ${command}`);
    }

    try {
      return execSync(command, { 
        encoding: 'utf8', 
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options 
      }).trim();
    } catch (error) {
      console.error(`Error executing command: ${command}`);
      console.error(error.message);
      process.exit(1);
    }
  }

  /**
   * Get commits since last tag or specific range
   */
  getCommits(range = null) {
    if (range) {
      return this.exec(`git log ${range} --oneline`, { silent: true }).split('\n').filter(line => line.trim());
    }

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
    const breaking = [];
    const other = [];

    commits.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+\s+/, '');
      
      if (message.includes('BREAKING CHANGE') || message.includes('!')) {
        breaking.push(message);
      } else if (message.match(/^feat(\(.+\))?:/)) {
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

    return { features, fixes, improvements, docs, breaking, other };
  }

  /**
   * Generate changelog content
   */
  generateChangelog(commits) {
    const parsedCommits = this.parseCommits(commits);
    let changelog = '';

    if (parsedCommits.breaking.length > 0) {
      changelog += '### 💥 BREAKING CHANGES\n\n';
      parsedCommits.breaking.forEach(change => {
        changelog += `- ${change}\n`;
      });
      changelog += '\n';
    }

    if (parsedCommits.features.length > 0) {
      changelog += '### ✨ Added\n\n';
      parsedCommits.features.forEach(feature => {
        changelog += `- ${feature}\n`;
      });
      changelog += '\n';
    }

    if (parsedCommits.improvements.length > 0) {
      changelog += '### 🔧 Technical Improvements\n\n';
      parsedCommits.improvements.forEach(improvement => {
        changelog += `- ${improvement}\n`;
      });
      changelog += '\n';
    }

    if (parsedCommits.fixes.length > 0) {
      changelog += '### 🐛 Bug Fixes\n\n';
      parsedCommits.fixes.forEach(fix => {
        changelog += `- ${fix}\n`;
      });
      changelog += '\n';
    }

    if (parsedCommits.docs.length > 0) {
      changelog += '### 📚 Documentation\n\n';
      parsedCommits.docs.forEach(doc => {
        changelog += `- ${doc}\n`;
      });
      changelog += '\n';
    }

    if (parsedCommits.other.length > 0) {
      changelog += '### 🔄 Other Changes\n\n';
      parsedCommits.other.forEach(change => {
        changelog += `- ${change}\n`;
      });
      changelog += '\n';
    }

    return changelog.trim();
  }

  /**
   * Print changelog for unreleased changes
   */
  printUnreleasedChangelog() {
    console.log('📝 Generating changelog for unreleased changes...\n');
    
    const commits = this.getCommits();
    
    if (commits.length === 0) {
      console.log('ℹ️  No unreleased changes found.');
      return;
    }

    console.log(`Found ${commits.length} commits:\n`);
    const changelog = this.generateChangelog(commits);
    
    if (changelog) {
      console.log('Generated changelog:\n');
      console.log('---');
      console.log(changelog);
      console.log('---');
    } else {
      console.log('No significant changes to include in changelog.');
    }
  }

  /**
   * Update the unreleased section in CHANGELOG.md
   */
  updateUnreleasedSection() {
    console.log('📝 Updating unreleased section in CHANGELOG.md...\n');
    
    const commits = this.getCommits();
    
    if (commits.length === 0) {
      console.log('ℹ️  No unreleased changes found.');
      return;
    }

    const changelog = this.generateChangelog(commits);
    
    if (!changelog) {
      console.log('No significant changes to include in changelog.');
      return;
    }

    const changelogContent = fs.readFileSync(this.changelogPath, 'utf8');
    
    // Replace the unreleased section
    const unreleasedSectionRegex = /(## \[Unreleased\]\s*\n)([\s\S]*?)(?=\n## \[|$)/;
    const newUnreleasedSection = `## [Unreleased]\n\n${changelog}\n`;
    
    const updatedChangelog = changelogContent.replace(
      unreleasedSectionRegex,
      newUnreleasedSection
    );

    fs.writeFileSync(this.changelogPath, updatedChangelog);
    console.log('✅ Successfully updated CHANGELOG.md unreleased section.');
  }
}

// CLI interface
const command = process.argv[2];
const generator = new ChangelogGenerator();

switch (command) {
  case 'update':
    generator.updateUnreleasedSection();
    break;
  case 'show':
  default:
    generator.printUnreleasedChangelog();
    break;
}
