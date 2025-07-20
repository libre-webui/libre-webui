#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

/**
 * Comprehensive development analysis using local Ollama
 * Provides insights about project evolution, code quality, and technical direction
 */

class DevelopmentAnalyzer {
  constructor() {
    this.projectRoot = path.join(__dirname, '..');
    this.ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
    this.defaultModel = process.env.ANALYSIS_AI_MODEL || 'llama3.2:3b';
  }

  /**
   * Execute command safely
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
      return options.allowFailure ? '' : process.exit(1);
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
   * Gather comprehensive project metrics
   */
  gatherProjectMetrics() {
    const metrics = {
      git: this.getGitMetrics(),
      codebase: this.getCodebaseMetrics(),
      dependencies: this.getDependencyMetrics(),
      architecture: this.getArchitectureMetrics(),
      recent: this.getRecentActivity()
    };

    return metrics;
  }

  /**
   * Git repository metrics
   */
  getGitMetrics() {
    const totalCommits = parseInt(this.exec('git rev-list --count HEAD', { allowFailure: true })) || 0;
    const contributors = this.exec('git shortlog -sn', { silent: true, allowFailure: true })
      .split('\n').filter(line => line.trim()).length;
    
    const branches = this.exec('git branch -r', { silent: true, allowFailure: true })
      .split('\n').filter(line => line.trim() && !line.includes('HEAD')).length;

    const lastCommit = this.exec('git log -1 --format="%H %s %an %ar"', { silent: true, allowFailure: true });
    
    const weeklyCommits = parseInt(this.exec('git rev-list --count --since="1 week ago" HEAD', { silent: true, allowFailure: true })) || 0;
    const monthlyCommits = parseInt(this.exec('git rev-list --count --since="1 month ago" HEAD', { silent: true, allowFailure: true })) || 0;

    return {
      totalCommits,
      contributors,
      branches,
      lastCommit,
      activity: {
        weeklyCommits,
        monthlyCommits
      }
    };
  }

  /**
   * Codebase metrics
   */
  getCodebaseMetrics() {
    const languages = {
      typescript: this.countFiles('*.ts') + this.countFiles('*/*.ts') + this.countFiles('*/*/*.ts'),
      tsx: this.countFiles('*.tsx') + this.countFiles('*/*.tsx') + this.countFiles('*/*/*.tsx'),
      javascript: this.countFiles('*.js') + this.countFiles('*/*.js') + this.countFiles('*/*/*.js'),
      jsx: this.countFiles('*.jsx') + this.countFiles('*/*.jsx') + this.countFiles('*/*/*.jsx'),
      json: this.countFiles('*.json') + this.countFiles('*/*.json') + this.countFiles('*/*/*.json'),
      markdown: this.countFiles('*.md') + this.countFiles('*/*.md') + this.countFiles('*/*/*.md'),
      css: this.countFiles('*.css') + this.countFiles('*/*.css') + this.countFiles('*/*/*.css'),
      docker: this.countFiles('Dockerfile*') + this.countFiles('*.yml') + this.countFiles('*.yaml')
    };

    const totalFiles = Object.values(languages).reduce((sum, count) => sum + count, 0);
    
    // Lines of code (approximation)
    const frontendLoc = this.getLinesOfCode('frontend/src');
    const backendLoc = this.getLinesOfCode('backend/src');
    const totalLoc = frontendLoc + backendLoc;

    // Calculate TypeScript percentage
    const tsFiles = languages.typescript + languages.tsx;
    const jsFiles = languages.javascript + languages.jsx;
    const totalCodeFiles = tsFiles + jsFiles;
    const typescriptPercentage = totalCodeFiles > 0 ? Math.round((tsFiles / totalCodeFiles) * 100) : 0;

    return {
      languages,
      totalFiles,
      typescriptPercentage,
      linesOfCode: {
        frontend: frontendLoc,
        backend: backendLoc,
        total: totalLoc
      }
    };
  }

  countFiles(pattern) {
    try {
      const result = this.exec(`find . -name "${pattern}" -type f -not -path "./node_modules/*" -not -path "./.git/*" | wc -l`, { silent: true, allowFailure: true });
      return parseInt(result) || 0;
    } catch {
      return 0;
    }
  }

  getLinesOfCode(directory) {
    try {
      const result = this.exec(`find ${directory} -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.jsx" | xargs wc -l | tail -1`, { silent: true, allowFailure: true });
      return parseInt(result.split(' ').filter(s => s.trim())[0]) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Dependency analysis
   */
  getDependencyMetrics() {
    const packageJsons = ['package.json', 'frontend/package.json', 'backend/package.json'];
    const dependencies = { production: 0, development: 0, total: 0 };
    const frameworks = [];

    packageJsons.forEach(file => {
      const fullPath = path.join(this.projectRoot, file);
      if (fs.existsSync(fullPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          
          if (pkg.dependencies) {
            dependencies.production += Object.keys(pkg.dependencies).length;
            
            // Identify major frameworks
            Object.keys(pkg.dependencies).forEach(dep => {
              if (dep === 'react') frameworks.push('React');
              if (dep === 'express') frameworks.push('Express');
              if (dep === 'axios') frameworks.push('HTTP Client');
              if (dep === 'vite') frameworks.push('Vite');
              if (dep === 'tailwindcss') frameworks.push('Tailwind CSS');
              if (dep === 'zustand') frameworks.push('Zustand');
              if (dep === 'sqlite3') frameworks.push('SQLite');
              if (dep === 'better-sqlite3') frameworks.push('SQLite');
              if (dep === 'typescript') frameworks.push('TypeScript');
              if (dep === 'prettier') frameworks.push('Prettier');
              if (dep === 'eslint') frameworks.push('ESLint');
            });
          }
          
          if (pkg.devDependencies) {
            dependencies.development += Object.keys(pkg.devDependencies).length;
            
            // Also check dev dependencies for frameworks/tools
            Object.keys(pkg.devDependencies).forEach(dep => {
              if (dep === 'typescript') frameworks.push('TypeScript');
              if (dep === 'prettier') frameworks.push('Prettier');
              if (dep === 'eslint') frameworks.push('ESLint');
              if (dep === '@types/node') frameworks.push('Node Types');
              if (dep === 'vite') frameworks.push('Vite');
              if (dep === 'tailwindcss') frameworks.push('Tailwind CSS');
            });
          }
        } catch (error) {
          console.warn(`Could not parse ${file}`);
        }
      }
    });

    dependencies.total = dependencies.production + dependencies.development;

    return {
      dependencies,
      frameworks: [...new Set(frameworks)]
    };
  }

  /**
   * Architecture analysis
   */
  getArchitectureMetrics() {
    const hasDockerCompose = fs.existsSync(path.join(this.projectRoot, 'docker-compose.yml'));
    const hasDockerfile = fs.existsSync(path.join(this.projectRoot, 'Dockerfile'));
    const hasGithubActions = fs.existsSync(path.join(this.projectRoot, '.github/workflows'));
    
    // More comprehensive TypeScript detection
    const hasTypeScript = fs.existsSync(path.join(this.projectRoot, 'tsconfig.json')) ||
                         fs.existsSync(path.join(this.projectRoot, 'frontend', 'tsconfig.json')) ||
                         fs.existsSync(path.join(this.projectRoot, 'backend', 'tsconfig.json'));
    
    // Enhanced linting detection
    const hasLinting = fs.existsSync(path.join(this.projectRoot, 'eslint.config.js')) ||
                      fs.existsSync(path.join(this.projectRoot, '.eslintrc.js')) ||
                      fs.existsSync(path.join(this.projectRoot, 'frontend', 'eslint.config.js')) ||
                      fs.existsSync(path.join(this.projectRoot, 'backend', 'eslint.config.js'));
    
    // Formatting detection
    const hasFormatting = fs.existsSync(path.join(this.projectRoot, '.prettierrc')) ||
                         fs.existsSync(path.join(this.projectRoot, 'prettier.config.js')) ||
                         fs.existsSync(path.join(this.projectRoot, '.prettierrc.json')) ||
                         this.hasPackageScript('format') ||
                         this.hasPackageScript('fmt');
    
    // Database detection
    const hasSQLite = fs.existsSync(path.join(this.projectRoot, 'backend', 'data', 'data.sqlite')) ||
                     fs.existsSync(path.join(this.projectRoot, 'backend', 'backend', 'data', 'data.sqlite'));
    
    // Testing detection  
    const hasTesting = this.hasPackageScript('test') || 
                      fs.existsSync(path.join(this.projectRoot, 'jest.config.js')) ||
                      fs.existsSync(path.join(this.projectRoot, 'vitest.config.js'));
    
    // Build tools detection
    const hasVite = fs.existsSync(path.join(this.projectRoot, 'vite.config.ts')) ||
                   fs.existsSync(path.join(this.projectRoot, 'frontend', 'vite.config.ts'));
    
    const hasTailwind = fs.existsSync(path.join(this.projectRoot, 'tailwind.config.js')) ||
                       fs.existsSync(path.join(this.projectRoot, 'frontend', 'tailwind.config.js'));
    
    const directories = {
      frontend: fs.existsSync(path.join(this.projectRoot, 'frontend')),
      backend: fs.existsSync(path.join(this.projectRoot, 'backend')),
      docs: fs.existsSync(path.join(this.projectRoot, 'docs')),
      scripts: fs.existsSync(path.join(this.projectRoot, 'scripts')),
      plugins: fs.existsSync(path.join(this.projectRoot, 'plugins'))
    };

    return {
      containerized: hasDockerCompose && hasDockerfile,
      cicd: hasGithubActions,
      typescript: hasTypeScript,
      linting: hasLinting,
      formatting: hasFormatting,
      database: hasSQLite ? 'SQLite' : 'Unknown',
      testing: hasTesting,
      buildTools: {
        vite: hasVite,
        tailwind: hasTailwind
      },
      architecture: 'Full-stack TypeScript (React + Express + SQLite)',
      directories
    };
  }

  /**
   * Check if package.json has a specific script
   */
  hasPackageScript(scriptName) {
    const packageJsonPaths = ['package.json', 'frontend/package.json', 'backend/package.json'];
    
    for (const packageJsonPath of packageJsonPaths) {
      const fullPath = path.join(this.projectRoot, packageJsonPath);
      if (fs.existsSync(fullPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
          if (pkg.scripts && pkg.scripts[scriptName]) {
            return true;
          }
        } catch (error) {
          // Ignore parse errors
        }
      }
    }
    return false;
  }

  /**
   * Recent development activity
   */
  getRecentActivity() {
    const recentCommits = this.exec('git log --oneline -10', { silent: true, allowFailure: true })
      .split('\n').filter(line => line.trim());

    const recentFiles = this.exec('git diff --name-only HEAD~5..HEAD', { silent: true, allowFailure: true })
      .split('\n').filter(line => line.trim());

    const changedDirectories = [...new Set(recentFiles.map(file => {
      const parts = file.split('/');
      return parts.length > 1 ? parts[0] : 'root';
    }))];

    return {
      recentCommits: recentCommits.slice(0, 5),
      recentFiles: recentFiles.slice(0, 10),
      changedDirectories,
      commitFrequency: this.getCommitFrequency()
    };
  }

  /**
   * Analyze commit frequency patterns
   */
  getCommitFrequency() {
    try {
      const dailyCommits = {};
      const logs = this.exec('git log --format="%ad" --date=short -30', { silent: true, allowFailure: true });
      
      logs.split('\n').forEach(date => {
        if (date.trim()) {
          dailyCommits[date] = (dailyCommits[date] || 0) + 1;
        }
      });

      const avgPerDay = Object.values(dailyCommits).reduce((sum, count) => sum + count, 0) / Math.max(Object.keys(dailyCommits).length, 1);

      return {
        avgCommitsPerDay: Math.round(avgPerDay * 100) / 100,
        activeDays: Object.keys(dailyCommits).length,
        mostActiveDay: Object.entries(dailyCommits).sort((a, b) => b[1] - a[1])[0]
      };
    } catch {
      return { avgCommitsPerDay: 0, activeDays: 0, mostActiveDay: null };
    }
  }

  /**
   * Generate AI analysis of development state
   */
  async generateAIAnalysis(metrics) {
    if (!await this.checkOllamaHealth()) {
      console.warn('⚠️  Ollama not available, providing basic analysis only');
      return null;
    }

    const prompt = `You are a senior software architect analyzing a web application project called "Libre WebUI" - an AI chat interface with Ollama integration.

Based on these comprehensive project metrics, provide insights about:

PROJECT METRICS:
${JSON.stringify(metrics, null, 2)}

Please analyze:

1. **Project Health & Maturity**
   - Overall development health score (1-10)
   - Project maturity indicators
   - Code quality signals

2. **Technical Architecture**
   - Architecture strengths and potential concerns
   - Technology stack assessment
   - Scalability considerations

3. **Development Velocity**
   - Development pace and consistency
   - Team productivity indicators
   - Areas needing attention

4. **Strategic Recommendations**
   - High-priority improvements
   - Technical debt concerns
   - Future development focus areas

5. **Competitive Position**
   - How does this stack against similar projects?
   - Unique selling points
   - Market positioning

Be specific, actionable, and provide a balanced perspective. Focus on strategic insights that would be valuable to project maintainers and stakeholders.`;

    try {
      console.log(`🤖 Generating AI analysis using ${this.defaultModel}...`);
      
      const response = await axios.post(`${this.ollamaBaseUrl}/api/generate`, {
        model: this.defaultModel,
        prompt,
        stream: false,
        options: {
          temperature: 0.4,
          top_p: 0.9,
          max_tokens: 1200
        }
      }, { timeout: 60000 });

      if (response.data && response.data.response) {
        return response.data.response.trim();
      }
    } catch (error) {
      console.error('Failed to generate AI analysis:', error.message);
    }

    return null;
  }

  /**
   * Run comprehensive development analysis
   */
  async analyze() {
    console.log('🔍 Analyzing Libre WebUI Development State...\n');
    
    // Gather all metrics
    const metrics = this.gatherProjectMetrics();
    
    // Display quantitative metrics
    this.displayMetricsSummary(metrics);
    
    // Generate AI insights
    console.log('🤖 Generating AI-powered insights...\n');
    const aiAnalysis = await this.generateAIAnalysis(metrics);
    
    if (aiAnalysis) {
      console.log('='.repeat(80));
      console.log('🧠 AI DEVELOPMENT ANALYSIS');
      console.log('='.repeat(80));
      console.log(aiAnalysis);
      console.log('='.repeat(80));
    }
    
    console.log('\n💡 Run with specific flags for focused analysis:');
    console.log('  --metrics     - Show detailed metrics only');
    console.log('  --quick      - Fast analysis without AI');
    console.log('  --export     - Export data to analysis.json');
  }

  /**
   * Display formatted metrics summary
   */
  displayMetricsSummary(metrics) {
    console.log('📊 PROJECT METRICS SUMMARY');
    console.log('='.repeat(50));
    
    console.log('\n🔗 Repository:');
    console.log(`  Total Commits: ${metrics.git.totalCommits.toLocaleString()}`);
    console.log(`  Contributors: ${metrics.git.contributors}`);
    console.log(`  Branches: ${metrics.git.branches}`);
    console.log(`  Weekly Activity: ${metrics.git.activity.weeklyCommits} commits`);
    console.log(`  Monthly Activity: ${metrics.git.activity.monthlyCommits} commits`);
    
    console.log('\n💻 Codebase:');
    console.log(`  Total Files: ${metrics.codebase.totalFiles.toLocaleString()}`);
    console.log(`  Lines of Code: ${metrics.codebase.linesOfCode.total.toLocaleString()}`);
    console.log(`    Frontend: ${metrics.codebase.linesOfCode.frontend.toLocaleString()}`);
    console.log(`    Backend: ${metrics.codebase.linesOfCode.backend.toLocaleString()}`);
    console.log(`  TypeScript Coverage: ${metrics.codebase.typescriptPercentage}%`);
    
    console.log('\n📦 Dependencies:');
    console.log(`  Production: ${metrics.dependencies.dependencies.production}`);
    console.log(`  Development: ${metrics.dependencies.dependencies.development}`);
    console.log(`  Frameworks: ${metrics.dependencies.frameworks.join(', ')}`);
    
    console.log('\n🏗️ Architecture:');
    console.log(`  Type: ${metrics.architecture.architecture}`);
    console.log(`  Containerized: ${metrics.architecture.containerized ? '✅' : '❌'}`);
    console.log(`  TypeScript: ${metrics.architecture.typescript ? '✅' : '❌'}`);
    console.log(`  CI/CD: ${metrics.architecture.cicd ? '✅' : '❌'}`);
    console.log(`  Linting: ${metrics.architecture.linting ? '✅' : '❌'}`);
    console.log(`  Formatting: ${metrics.architecture.formatting ? '✅' : '❌'}`);
    console.log(`  Database: ${metrics.architecture.database}`);
    console.log(`  Testing: ${metrics.architecture.testing ? '✅' : '❌'}`);
    console.log(`  Build Tools: Vite ${metrics.architecture.buildTools.vite ? '✅' : '❌'}, Tailwind ${metrics.architecture.buildTools.tailwind ? '✅' : '❌'}`);
    
    console.log('\n⚡ Recent Activity:');
    console.log(`  Avg Commits/Day: ${metrics.recent.commitFrequency.avgCommitsPerDay}`);
    console.log(`  Active Days (30d): ${metrics.recent.commitFrequency.activeDays}`);
    console.log(`  Recent Focus Areas: ${metrics.recent.changedDirectories.join(', ')}`);
    
    console.log('\n');
  }
}

// CLI interface
const args = process.argv.slice(2);
const analyzer = new DevelopmentAnalyzer();

if (args.includes('--help')) {
  console.log('🔍 Libre WebUI Development Analyzer\n');
  console.log('Usage: node scripts/analyze-development.js [options]\n');
  console.log('Options:');
  console.log('  --quick      Fast analysis without AI insights');
  console.log('  --metrics    Show detailed metrics only');
  console.log('  --export     Export analysis data to JSON file');
  console.log('  --help       Show this help message\n');
  console.log('Environment Variables:');
  console.log('  OLLAMA_BASE_URL      Ollama server URL');
  console.log('  ANALYSIS_AI_MODEL    AI model to use for analysis');
} else if (args.includes('--quick')) {
  const metrics = analyzer.gatherProjectMetrics();
  analyzer.displayMetricsSummary(metrics);
} else if (args.includes('--metrics')) {
  const metrics = analyzer.gatherProjectMetrics();
  console.log(JSON.stringify(metrics, null, 2));
} else if (args.includes('--export')) {
  const metrics = analyzer.gatherProjectMetrics();
  const outputFile = path.join(__dirname, '..', 'analysis.json');
  fs.writeFileSync(outputFile, JSON.stringify(metrics, null, 2));
  console.log(`📁 Analysis data exported to ${outputFile}`);
} else {
  analyzer.analyze();
}
