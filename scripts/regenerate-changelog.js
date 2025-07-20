#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * AI-powered changelog regeneration for all releases
 * Analyzes commits between tags and generates comprehensive release notes
 */

class ChangelogRegeneration {
  constructor() {
    this.projectRoot = path.join(__dirname, '..');
    this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.defaultModel = process.env.CHANGELOG_AI_MODEL || 'gemma3:27b';
    this.changelogPath = path.join(this.projectRoot, 'CHANGELOG.md');
  }

  /**
   * Execute git command safely
   */
  exec(command, options = {}) {
    try {
      return execSync(command, { 
        encoding: 'utf8', 
        stdio: options.silent ? 'pipe' : 'inherit',
        cwd: this.projectRoot,
        ...options 
      }).trim();
    } catch (error) {
      if (!options.allowFailure) {
        console.error(`Error executing command: ${command}`);
        console.error(error.message);
      }
      return options.allowFailure ? '' : '';
    }
  }

  /**
   * Check if Ollama is available
   */
  async checkOllamaHealth() {
    try {
      const response = await axios.get(`${this.ollamaBaseUrl}/api/version`, { timeout: 5000 });
      return response.status === 200;
    } catch (error) {
      return false;
    }
  }

  /**
   * Get all release tags in chronological order
   */
  getTags() {
    const tags = this.exec('git tag --sort=version:refname', { silent: true })
      .split('\n')
      .filter(tag => tag.trim() && tag.match(/^v\d+\.\d+\.\d+$/));
    return tags;
  }

  /**
   * Get commits between two tags (or from tag to HEAD)
   */
  getCommitsBetween(fromTag, toTag = 'HEAD') {
    const range = toTag === 'HEAD' ? `${fromTag}..HEAD` : `${fromTag}..${toTag}`;
    const commits = this.exec(`git log ${range} --oneline --no-merges`, { silent: true, allowFailure: true })
      .split('\n')
      .filter(line => line.trim())
      .filter(line => {
        // Filter out release commits and trivial changes
        return !line.includes('chore(release):') && 
               !line.includes('Merge branch') &&
               !line.includes('chore: run fmt') &&
               line.trim().length > 0;
      });
    return commits;
  }

  /**
   * Get tag date
   */
  getTagDate(tag) {
    try {
      const date = this.exec(`git log -1 --format=%ai ${tag}`, { silent: true, allowFailure: true });
      return date ? new Date(date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  }

  /**
   * Get file changes between tags
   */
  getFileChanges(fromTag, toTag = 'HEAD') {
    const range = toTag === 'HEAD' ? `${fromTag}..HEAD` : `${fromTag}..${toTag}`;
    try {
      const stats = this.exec(`git diff --stat ${range}`, { silent: true, allowFailure: true });
      const changedFiles = this.exec(`git diff --name-only ${range}`, { silent: true, allowFailure: true })
        .split('\n')
        .filter(file => file.trim());
      
      return { stats, changedFiles };
    } catch {
      return { stats: '', changedFiles: [] };
    }
  }

  /**
   * Generate AI analysis for a release
   */
  async generateReleaseAnalysis(version, commits, fileChanges, releaseDate) {
    if (!await this.checkOllamaHealth()) {
      console.warn('⚠️  Ollama not available, using basic changelog generation');
      return this.generateBasicChangelog(commits);
    }

    const commitText = commits.join('\n');
    const fileContext = fileChanges.changedFiles.length > 0 ? 
      `\nFiles changed (${fileChanges.changedFiles.length}): ${fileChanges.changedFiles.slice(0, 10).join(', ')}` : '';

    const prompt = `You are an expert technical writer creating a comprehensive changelog entry for Libre WebUI version ${version}.

RELEASE CONTEXT:
- Version: ${version}
- Release Date: ${releaseDate}  
- Commits in this release: ${commits.length}
${fileContext}

COMMIT HISTORY:
${commitText}

Create a detailed changelog entry that includes:

1. **Release Overview**: 2-3 sentence summary of the main theme/focus of this release
2. **Categorized Changes**:
   - ✨ **Added** - New features and capabilities
   - 🔧 **Improved** - Enhancements to existing features
   - 🐛 **Fixed** - Bug fixes and corrections
   - 📚 **Documentation** - Documentation updates
   - 🔒 **Security** - Security-related changes
   - ⚠️ **Breaking Changes** - API or behavior changes (if any)

3. **Technical Details**: Include specific technical improvements that developers would care about
4. **User Impact**: Focus on how changes benefit end users

Guidelines:
- Use clear, user-friendly language while maintaining technical accuracy
- Group related commits together logically
- Highlight the most impactful changes
- Be specific about what was improved, not just that it was improved
- Include relevant technical context for complex changes

Format the output as clean markdown ready to insert into a changelog file.

IMPORTANT: Do not wrap your response in code blocks (\`\`\`markdown or \`\`\`). Provide the raw markdown content directly.`;

    try {
      console.log(`🤖 Generating AI changelog for ${version} using ${this.defaultModel}...`);
      
      const response = await axios.post(`${this.ollamaBaseUrl}/api/generate`, {
        model: this.defaultModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: 1000
        }
      }, { timeout: 120000 }); // 2 minute timeout for detailed analysis

      if (response.data && response.data.response) {
        return response.data.response.trim();
      }
    } catch (error) {
      console.error(`Failed to generate AI analysis for ${version}:`, error.message);
      return this.generateBasicChangelog(commits);
    }

    return this.generateBasicChangelog(commits);
  }

  /**
   * Generate basic changelog without AI
   */
  generateBasicChangelog(commits) {
    const categories = {
      features: [],
      fixes: [],
      improvements: [],
      docs: [],
      other: []
    };

    commits.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+\s+/, '');
      
      if (message.match(/^feat(\(.+\))?:/)) {
        categories.features.push(message.replace(/^feat(\(.+\))?:\s*/, ''));
      } else if (message.match(/^fix(\(.+\))?:/)) {
        categories.fixes.push(message.replace(/^fix(\(.+\))?:\s*/, ''));
      } else if (message.match(/^(refactor|perf|style|chore)(\(.+\))?:/)) {
        categories.improvements.push(message.replace(/^(refactor|perf|style|chore)(\(.+\))?:\s*/, ''));
      } else if (message.match(/^docs(\(.+\))?:/)) {
        categories.docs.push(message.replace(/^docs(\(.+\))?:\s*/, ''));
      } else {
        categories.other.push(message);
      }
    });

    let changelog = '';
    
    if (categories.features.length > 0) {
      changelog += '### ✨ Added\n\n';
      categories.features.forEach(feature => changelog += `- ${feature}\n`);
      changelog += '\n';
    }

    if (categories.improvements.length > 0) {
      changelog += '### 🔧 Improved\n\n';
      categories.improvements.forEach(improvement => changelog += `- ${improvement}\n`);
      changelog += '\n';
    }

    if (categories.fixes.length > 0) {
      changelog += '### 🐛 Fixed\n\n';
      categories.fixes.forEach(fix => changelog += `- ${fix}\n`);
      changelog += '\n';
    }

    if (categories.docs.length > 0) {
      changelog += '### 📚 Documentation\n\n';
      categories.docs.forEach(doc => changelog += `- ${doc}\n`);
      changelog += '\n';
    }

    if (categories.other.length > 0) {
      changelog += '### 🔄 Other Changes\n\n';
      categories.other.forEach(change => changelog += `- ${change}\n`);
      changelog += '\n';
    }

    return changelog.trim();
  }

  /**
   * Generate complete changelog for all releases
   */
  async regenerateAllChangelogs() {
    console.log('🔄 Regenerating all changelogs using AI analysis...\n');

    const tags = this.getTags();
    console.log(`📋 Found ${tags.length} releases: ${tags.join(', ')}\n`);

    let newChangelog = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ Added

### 🔧 Improved

### 🐛 Fixed

### 📚 Documentation

---

`;

    // Process releases from newest to oldest
    const reversedTags = [...tags].reverse();
    
    for (let i = 0; i < reversedTags.length; i++) {
      const currentTag = reversedTags[i];
      const previousTag = reversedTags[i + 1];
      
      console.log(`📝 Processing ${currentTag}...`);
      
      // Get commits for this release
      const commits = previousTag ? 
        this.getCommitsBetween(previousTag, currentTag) : 
        this.getCommitsBetween('HEAD~50', currentTag); // For the first release, look at last 50 commits
      
      if (commits.length === 0) {
        console.log(`  ⚠️  No commits found for ${currentTag}, skipping...`);
        continue;
      }

      console.log(`  📊 Found ${commits.length} commits`);

      // Get file changes
      const fileChanges = previousTag ? 
        this.getFileChanges(previousTag, currentTag) : 
        { stats: '', changedFiles: [] };

      // Get release date
      const releaseDate = this.getTagDate(currentTag);
      
      // Generate AI analysis
      const aiChangelog = await this.generateReleaseAnalysis(
        currentTag, 
        commits, 
        fileChanges, 
        releaseDate
      );

      // Add to changelog
      const versionNumber = currentTag.replace('v', '');
      newChangelog += `## [${versionNumber}] - ${releaseDate}\n\n`;
      
      // Clean up AI-generated content - remove any markdown code blocks
      let cleanChangelog = aiChangelog;
      if (cleanChangelog.includes('```markdown')) {
        // Remove opening ```markdown and closing ```
        cleanChangelog = cleanChangelog
          .replace(/^```markdown\s*\n?/gm, '')
          .replace(/\n?```\s*$/gm, '')
          .replace(/```\s*$/gm, '');
      }
      if (cleanChangelog.includes('```')) {
        // Remove any remaining code blocks
        cleanChangelog = cleanChangelog
          .replace(/```[\s\S]*?```/g, '')
          .replace(/```.*$/gm, '');
      }
      
      newChangelog += cleanChangelog.trim();
      newChangelog += '\n\n---\n\n';

      console.log(`  ✅ Generated changelog for ${currentTag}\n`);
    }

    // Write the new changelog
    fs.writeFileSync(this.changelogPath, newChangelog);
    console.log(`✅ Complete changelog written to ${this.changelogPath}`);
    
    return newChangelog;
  }

  /**
   * Preview changelog for a specific version
   */
  async previewVersion(version) {
    const tags = this.getTags();
    const targetTag = version.startsWith('v') ? version : `v${version}`;
    
    if (!tags.includes(targetTag)) {
      console.error(`❌ Version ${targetTag} not found. Available: ${tags.join(', ')}`);
      return;
    }

    const tagIndex = tags.indexOf(targetTag);
    const previousTag = tagIndex > 0 ? tags[tagIndex - 1] : null;
    
    const commits = previousTag ? 
      this.getCommitsBetween(previousTag, targetTag) : 
      this.getCommitsBetween('HEAD~50', targetTag);

    if (commits.length === 0) {
      console.log(`No commits found for ${targetTag}`);
      return;
    }

    const fileChanges = previousTag ? 
      this.getFileChanges(previousTag, targetTag) : 
      { stats: '', changedFiles: [] };

    const releaseDate = this.getTagDate(targetTag);
    
    console.log(`Preview for ${targetTag} (${commits.length} commits):`);
    console.log('='.repeat(60));
    
    const changelog = await this.generateReleaseAnalysis(
      targetTag, 
      commits, 
      fileChanges, 
      releaseDate
    );
    
    console.log(changelog);
  }
}

// CLI interface
const args = process.argv.slice(2);
const regenerator = new ChangelogRegeneration();

if (args.includes('--help')) {
  console.log('🤖 AI Changelog Regeneration Tool\n');
  console.log('Usage: node scripts/regenerate-changelog.js [command]\n');
  console.log('Commands:');
  console.log('  all              Regenerate complete changelog for all releases');
  console.log('  preview <ver>    Preview changelog for specific version (e.g., preview v0.1.6)');
  console.log('  --help           Show this help message\n');
  console.log('Environment Variables:');
  console.log('  OLLAMA_BASE_URL      Ollama server URL (default: http://localhost:11434)');
  console.log('  CHANGELOG_AI_MODEL   AI model to use (default: gemma3:27b)');
} else if (args[0] === 'preview' && args[1]) {
  regenerator.previewVersion(args[1]);
} else if (args[0] === 'all' || args.length === 0) {
  regenerator.regenerateAllChangelogs();
} else {
  console.log('❌ Unknown command. Use --help for usage information.');
}
