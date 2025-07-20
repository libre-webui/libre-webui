#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║                        LIBRE WEBUI                               ║
 * ║             AI-Powered Changelog Generator                       ║
 * ║                                                                  ║
 * ║  ██      ██ ██████  ██████  ███████     ██     ██ ███████ ██████  ║
 * ║  ██      ██ ██   ██ ██   ██ ██          ██     ██ ██      ██   ██ ║
 * ║  ██      ██ ██████  ██████  █████       ██  █  ██ █████   ██████  ║
 * ║  ██      ██ ██   ██ ██   ██ ██          ██ ███ ██ ██      ██   ██ ║
 * ║  ███████ ██ ██████  ██   ██ ███████      ███ ███  ███████ ██████  ║
 * ║                                                                  ║
 * ║              ██    ██ ██                                         ║
 * ║              ██    ██ ██                                         ║
 * ║              ██    ██ ██                                         ║
 * ║              ██    ██ ██                                         ║
 * ║               ██████  ██                                         ║
 * ║                                                                  ║
 * ║         🤖 AI-powered changelog generator using local Ollama     ║
 * ║         📝 Analyzes commits and generates intelligent summaries  ║
 * ║                                                                  ║
 * ║         🔒 100% Privacy-First • 🚀 Ollama Powered              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

class AIChangelogGenerator {
  constructor() {
    this.changelogPath = path.join(__dirname, '..', 'CHANGELOG.md');
    this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.defaultModel = process.env.CHANGELOG_AI_MODEL || 'llama3.2:3b'; // Fast model for summaries
  }

  /**
   * Execute git command safely
   */
  exec(command, options = {}) {
    try {
      return execSync(command, { 
        encoding: 'utf8', 
        stdio: options.silent ? 'pipe' : 'inherit',
        ...options 
      }).trim();
    } catch (error) {
      console.error(`Error executing command: ${command}`);
      console.error(error.message);
      if (!options.allowFailure) {
        process.exit(1);
      }
      return '';
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
   * Generate AI summary using local Ollama
   */
  async generateAISummary(commits, changeType = 'release') {
    if (!await this.checkOllamaHealth()) {
      console.warn('⚠️  Ollama not available, falling back to standard changelog generation');
      return null;
    }

    const commitText = commits.join('\n');
    
    const prompts = {
      release: `You are an expert technical writer creating release notes for a WebUI project called "Libre WebUI" - an AI chat interface with Ollama integration.

Analyze these commits and create a concise, professional changelog section:

COMMITS:
${commitText}

Generate a summary following this structure:
1. Brief overview of the release (1-2 sentences)
2. Key highlights organized by category:
   - ✨ New Features
   - 🔧 Improvements  
   - 🐛 Bug Fixes
   - 📚 Documentation

Keep it professional, concise, and user-focused. Avoid technical jargon where possible.
Group related changes together and highlight the most impactful changes.`,

      summary: `Analyze these development commits for the Libre WebUI project and provide:
1. A brief executive summary (2-3 sentences)
2. Key themes and patterns in the changes
3. Overall development direction
4. Any notable technical achievements

COMMITS:
${commitText}

Be insightful and focus on the bigger picture of development progress.`,

      impact: `As a senior developer, analyze these commits and assess:
1. Impact level (Major/Minor/Patch) with reasoning
2. Breaking changes or compatibility concerns
3. Performance implications
4. User experience improvements
5. Technical debt addressed

COMMITS:
${commitText}

Provide a technical perspective suitable for developers and maintainers.`
    };

    try {
      console.log(`🤖 Generating AI summary using ${this.defaultModel}...`);
      
      const response = await axios.post(`${this.ollamaBaseUrl}/api/generate`, {
        model: this.defaultModel,
        prompt: prompts[changeType] || prompts.release,
        stream: false,
        options: {
          temperature: 0.3,  // Lower temperature for more consistent technical writing
          top_p: 0.9,
          max_tokens: 800
        }
      }, { timeout: 30000 });

      if (response.data && response.data.response) {
        return response.data.response.trim();
      }
    } catch (error) {
      console.error('Failed to generate AI summary:', error.message);
    }

    return null;
  }

  /**
   * Get commits since last tag with enhanced metadata
   */
  getCommitsWithMetadata() {
    try {
      const lastTag = this.exec('git describe --tags --abbrev=0', { silent: true, allowFailure: true });
      const range = lastTag ? `${lastTag}..HEAD` : '';
      
      // Get detailed commit info
      const commits = this.exec(`git log ${range} --oneline --no-merges`, { silent: true })
        .split('\n')
        .filter(line => line.trim())
        .filter(line => {
          // Filter out release commits and trivial changes
          return !line.includes('chore(release):') && 
                 !line.includes('Merge branch') &&
                 !line.includes('chore: run fmt') &&
                 !line.includes('docs: update README');
        });

      // Get file change statistics
      const stats = this.exec(`git diff --stat ${lastTag || 'HEAD~10'}..HEAD`, { silent: true, allowFailure: true });
      
      // Get changed files
      const changedFiles = this.exec(`git diff --name-only ${lastTag || 'HEAD~10'}..HEAD`, { silent: true, allowFailure: true })
        .split('\n')
        .filter(file => file.trim());

      return {
        commits,
        stats,
        changedFiles,
        commitCount: commits.length,
        lastTag: lastTag || 'initial'
      };
    } catch (error) {
      console.error('Failed to get commit metadata:', error);
      return { commits: [], stats: '', changedFiles: [], commitCount: 0, lastTag: 'unknown' };
    }
  }

  /**
   * Parse conventional commits with enhanced categorization
   */
  parseCommitsEnhanced(commits) {
    const categories = {
      features: { emoji: '✨', items: [], keywords: ['feat', 'add', 'implement', 'introduce'] },
      fixes: { emoji: '🐛', items: [], keywords: ['fix', 'resolve', 'patch', 'correct'] },
      improvements: { emoji: '🔧', items: [], keywords: ['refactor', 'perf', 'style', 'enhance', 'optimize', 'improve'] },
      docs: { emoji: '📚', items: [], keywords: ['docs', 'documentation'] },
      security: { emoji: '🔒', items: [], keywords: ['security', 'auth', 'vulnerability'] },
      breaking: { emoji: '💥', items: [], keywords: ['breaking', '!'] },
      other: { emoji: '🔄', items: [] }
    };

    commits.forEach(commit => {
      const message = commit.replace(/^[a-f0-9]+\s+/, '');
      let categorized = false;

      // Check for breaking changes first
      if (message.includes('BREAKING CHANGE') || message.includes('!')) {
        categories.breaking.items.push(message);
        categorized = true;
      }

      // Check each category
      for (const [key, category] of Object.entries(categories)) {
        if (key === 'other' || categorized) continue;
        
        const isMatch = category.keywords.some(keyword => {
          if (keyword.includes(':')) {
            return message.match(new RegExp(`^${keyword.replace(':', '\\s*\\(.*\\)?:')}`, 'i'));
          }
          return message.toLowerCase().includes(keyword);
        });

        if (isMatch) {
          // Clean up the message
          let cleanMessage = message;
          const conventionalMatch = message.match(/^(\w+)(\(.+\))?:\s*(.*)$/);
          if (conventionalMatch) {
            cleanMessage = conventionalMatch[3];
          }
          
          category.items.push(cleanMessage);
          categorized = true;
          break;
        }
      }

      if (!categorized) {
        categories.other.items.push(message);
      }
    });

    return categories;
  }

  /**
   * Generate enhanced changelog with AI insights
   */
  async generateEnhancedChangelog(aiSummaryType = 'release') {
    console.log('🔍 Analyzing commits and generating AI-enhanced changelog...\n');
    
    const metadata = this.getCommitsWithMetadata();
    
    if (metadata.commitCount === 0) {
      console.log('ℹ️  No new commits found since last release.');
      return;
    }

    console.log(`📊 Analysis Summary:`);
    console.log(`  - ${metadata.commitCount} commits since ${metadata.lastTag}`);
    console.log(`  - ${metadata.changedFiles.length} files changed`);
    console.log(`  - AI Summary Type: ${aiSummaryType}\n`);

    // Parse commits with enhanced categorization
    const categories = this.parseCommitsEnhanced(metadata.commits);

    // Generate AI summary
    const aiSummary = await this.generateAISummary(metadata.commits, aiSummaryType);

    // Output results
    console.log('='.repeat(80));
    console.log('🤖 AI-GENERATED SUMMARY');
    console.log('='.repeat(80));
    
    if (aiSummary) {
      console.log(aiSummary);
    } else {
      console.log('AI summary generation failed or unavailable.');
    }

    console.log('\n' + '='.repeat(80));
    console.log('📋 STRUCTURED CHANGELOG');
    console.log('='.repeat(80));

    let hasContent = false;
    for (const [key, category] of Object.entries(categories)) {
      if (category.items.length > 0) {
        console.log(`\n### ${category.emoji} ${key.charAt(0).toUpperCase() + key.slice(1)}\n`);
        category.items.forEach(item => {
          console.log(`- ${item}`);
        });
        hasContent = true;
      }
    }

    if (!hasContent) {
      console.log('\nNo significant changes found.');
    }

    console.log('\n' + '='.repeat(80));
    console.log('📈 DEVELOPMENT STATISTICS');
    console.log('='.repeat(80));
    if (metadata.stats) {
      console.log(metadata.stats);
    }

    console.log('\n💡 Tip: Use the AI summary above for release notes and the structured changelog for technical documentation.');
  }

  /**
   * Interactive mode for different analysis types
   */
  async interactive() {
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                        LIBRE WEBUI                               ║
║             AI-Powered Development Analysis                      ║
║                                                                  ║
║  ██      ██ ██████  ██████  ███████     ██     ██ ███████ ██████  ║
║  ██      ██ ██   ██ ██   ██ ██          ██     ██ ██      ██   ██ ║
║  ██      ██ ██████  ██████  █████       ██  █  ██ █████   ██████  ║
║  ██      ██ ██   ██ ██   ██ ██          ██ ███ ██ ██      ██   ██ ║
║  ███████ ██ ██████  ██   ██ ███████      ███ ███  ███████ ██████  ║
║                                                                  ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║               ██████  ██                                         ║
║                                                                  ║
║         🤖 Interactive AI-powered changelog generation           ║
║         🔒 100% Privacy-First • 🚀 Powered by Ollama           ║
╚══════════════════════════════════════════════════════════════════╝
`);
    
    console.log('Available analysis types:');
    console.log('  1. release  - User-focused release notes');
    console.log('  2. summary  - Development overview');
    console.log('  3. impact   - Technical impact analysis\n');

    const type = process.argv[3] || 'release';
    await this.generateEnhancedChangelog(type);
  }
}

// CLI interface
const command = process.argv[2];
const generator = new AIChangelogGenerator();

switch (command) {
  case 'interactive':
  case 'ai':
    generator.interactive();
    break;
  case 'release':
    generator.generateEnhancedChangelog('release');
    break;
  case 'summary':
    generator.generateEnhancedChangelog('summary');
    break;
  case 'impact':
    generator.generateEnhancedChangelog('impact');
    break;
  default:
    console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                        LIBRE WEBUI                               ║
║             AI-Powered Changelog Generator                       ║
║                                                                  ║
║  ██      ██ ██████  ██████  ███████     ██     ██ ███████ ██████  ║
║  ██      ██ ██   ██ ██   ██ ██          ██     ██ ██      ██   ██ ║
║  ██      ██ ██████  ██████  █████       ██  █  ██ █████   ██████  ║
║  ██      ██ ██   ██ ██   ██ ██          ██ ███ ██ ██      ██   ██ ║
║  ███████ ██ ██████  ██   ██ ███████      ███ ███  ███████ ██████  ║
║                                                                  ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║              ██    ██ ██                                         ║
║               ██████  ██                                         ║
║                                                                  ║
║         🤖 Generate intelligent changelog entries with AI        ║
║         🔒 100% Privacy-First • 🚀 Powered by Ollama           ║
╚══════════════════════════════════════════════════════════════════╝
`);
    console.log('Usage:');
    console.log('  npm run changelog:ai [type]');
    console.log('  node scripts/ai-changelog-generator.js [command]\n');
    console.log('Commands:');
    console.log('  release   - Generate user-focused release notes (default)');
    console.log('  summary   - Development overview and patterns');
    console.log('  impact    - Technical impact analysis');
    console.log('  ai        - Interactive mode\n');
    console.log('Environment variables:');
    console.log('  OLLAMA_BASE_URL       - Ollama server URL (default: http://localhost:11434)');
    console.log('  CHANGELOG_AI_MODEL    - Model to use (default: llama3.2:3b)');
    break;
}
