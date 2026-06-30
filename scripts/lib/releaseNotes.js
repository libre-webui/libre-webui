const fs = require('fs');
const path = require('path');
const { git, projectRoot } = require('./command');

const CHANGELOG_TEMPLATE = `## [Unreleased]

### ✨ New Features

### 🔧 Improvements

### 🐛 Bug Fixes

### 📚 Documentation

`;

const DEFAULT_OLLAMA_BASE_URL =
  process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = process.env.CHANGELOG_AI_MODEL || 'glm-5.2:cloud';
const DEFAULT_TIMEOUT_MS = Number(
  process.env.CHANGELOG_AI_TIMEOUT_MS || 180000
);

function getPreviousTag() {
  return git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], {
    silent: true,
    allowFailure: true,
  });
}

function collectReleaseEvidence({ fromRef, toRef = 'HEAD', changelogPath }) {
  const range = fromRef ? `${fromRef}..${toRef}` : toRef;
  const commits = parseGitLog(
    git(
      [
        'log',
        range,
        '--no-merges',
        '--date=short',
        '--format=%H%x1f%h%x1f%ad%x1f%s%x1f%b%x1e',
      ],
      { silent: true, allowFailure: true }
    )
  ).filter(commit => !isReleaseNoise(commit.subject));

  const nameStatus = git(['diff', '--name-status', range], {
    silent: true,
    allowFailure: true,
  });
  const changedFiles = parseNameStatus(nameStatus);
  const diffStat = git(['diff', '--stat', range], {
    silent: true,
    allowFailure: true,
  });

  return {
    changedFiles,
    commits,
    date: new Date().toISOString().split('T')[0],
    dependencyUpdates: parseDependencyUpdates(commits),
    diffStat,
    fromRef,
    localeFileCount: countLocaleFiles(),
    localeFilesChanged: changedFiles.filter(file =>
      (file.to || file.file).startsWith('frontend/src/i18n/locales/')
    ).length,
    range,
    toRef,
    unreleasedNotes: changelogPath ? extractUnreleasedNotes(changelogPath) : '',
  };
}

async function createReleaseSection(version, evidence, options = {}) {
  const useAI = options.useAI !== false && process.env.CHANGELOG_AI !== '0';
  const aiNotes = useAI
    ? await generateAIReleaseNotes(version, evidence, options)
    : null;
  const notes = aiNotes || buildDeterministicReleaseNotes(version, evidence);

  return `## [${version}] - ${evidence.date}\n\n${notes.trim()}\n\n`;
}

function updateChangelogWithSection(changelogPath, releaseSection) {
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const unreleasedRegex = /## \[Unreleased\][\s\S]*?(?=\n## \[|$)/;

  if (!unreleasedRegex.test(changelog)) {
    throw new Error('CHANGELOG.md is missing an [Unreleased] section');
  }

  const updated = changelog.replace(
    unreleasedRegex,
    `${CHANGELOG_TEMPLATE}\n${releaseSection.trim()}\n`
  );
  fs.writeFileSync(changelogPath, updated);
}

async function generateAIReleaseNotes(version, evidence, options = {}) {
  const baseUrl = options.ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL;
  const model = options.model || DEFAULT_OLLAMA_MODEL;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const evidenceText = buildEvidenceText(version, evidence);
  const baselineNotes = buildDeterministicReleaseNotes(version, evidence);

  try {
    const response = await postJsonWithTimeout(
      `${baseUrl}/api/chat`,
      {
        model,
        stream: false,
        think: false,
        messages: [
          {
            role: 'system',
            content:
              'You write factual release notes for Libre WebUI. Use only the provided git evidence. Do not invent features, dates, fixes, or breaking changes.',
          },
          {
            role: 'user',
            content: buildAIPrompt(version, evidenceText, baselineNotes),
          },
        ],
        options: {
          temperature: 0.2,
          top_p: 0.9,
          num_predict: 1800,
        },
      },
      timeoutMs
    );

    const text = response?.message?.content || response?.response || '';
    const cleaned = cleanAIResponse(text);
    if (isUsableReleaseNotes(cleaned, evidence)) {
      console.log(`  ✅ Generated release notes with Ollama model ${model}`);
      return cleaned;
    }

    console.log(`  ⚠️  Ollama model ${model} returned unusable release notes`);
  } catch (error) {
    console.log(
      `  ⚠️  Ollama release notes unavailable (${model}): ${error.message}`
    );
  }

  console.log('  ℹ️  Falling back to deterministic git-based release notes');
  return null;
}

function buildAIPrompt(version, evidenceText, baselineNotes) {
  return `Create the changelog body for Libre WebUI ${version}.

Return raw Markdown only. Do not include the "## [${version}]" heading because the release script adds it.

Required style:
- Start with a short 2-3 sentence overview paragraph.
- Then use Keep a Changelog sections when they have content:
  - ### ✨ New Features
  - ### 🔧 Improvements
  - ### 🐛 Bug Fixes
  - ### 🔒 Security & Dependencies
  - ### 📚 Documentation
  - ### ⚠️ Breaking Changes
- Make it compelling but factual.
- Merge related commits into meaningful bullets.
- Prefer user-facing impact, then developer/admin details.
- Include breaking changes only when the evidence proves one.
- Do not add counts that are not in the evidence.
- Do not say dependencies were updated to "latest"; say refreshed or updated.
- Preserve the deterministic baseline facts. You may improve wording, grouping, and specificity, but do not add new claims.
- Do not mention commit hashes unless necessary.
- Do not use generic filler such as "various improvements".

Deterministic baseline notes:

${baselineNotes}

Git evidence:

${evidenceText}`;
}

function buildEvidenceText(version, evidence) {
  const commitLines = evidence.commits.map(commit => {
    const body = commit.body
      ? `\n${indent(trimForPrompt(commit.body, 1800))}`
      : '';
    return `- ${commit.shortHash} ${commit.date} ${commit.subject}${body}`;
  });

  const fileLines = evidence.changedFiles.map(file => {
    const target = file.to || file.file;
    return `- ${file.status}: ${target}${file.from ? ` (from ${file.from})` : ''}`;
  });

  return [
    `Version: ${version}`,
    `Range: ${evidence.range}`,
    `Commits: ${evidence.commits.length}`,
    `Locale files changed: ${evidence.localeFilesChanged}`,
    `Total locale files in frontend/src/i18n/locales: ${evidence.localeFileCount}`,
    `Dependency updates parsed from Dependabot metadata: ${evidence.dependencyUpdates.length}`,
    '',
    evidence.unreleasedNotes
      ? `Existing CHANGELOG [Unreleased] notes:\n${evidence.unreleasedNotes}`
      : 'Existing CHANGELOG [Unreleased] notes: none',
    '',
    `Commit history:\n${commitLines.join('\n') || '- none'}`,
    '',
    `Changed files:\n${fileLines.join('\n') || '- none'}`,
    '',
    `Diff stat:\n${evidence.diffStat || 'none'}`,
  ]
    .join('\n')
    .slice(0, 24000);
}

function buildDeterministicReleaseNotes(version, evidence) {
  const files = evidence.changedFiles.map(file => file.to || file.file);
  const allText = [
    evidence.unreleasedNotes,
    ...evidence.commits.map(commit => `${commit.subject}\n${commit.body}`),
    ...files,
  ].join('\n');

  const sections = {
    features: [],
    improvements: [],
    fixes: [],
    security: [],
    docs: [],
    breaking: [],
  };

  const hasLibreClaw = /libre[\s-]?claw|openclaw/i.test(allText);
  if (hasLibreClaw) {
    add(
      sections.features,
      'Added a first-class Libre Claw agent surface with daemon status, dashboard access, and a dedicated `/agents` route.'
    );
    if (files.some(file => file.includes('backend/src/routes/libreClaw.ts'))) {
      add(
        sections.features,
        'Added admin-only `/api/libre-claw` backend routes for status, model/fallback configuration, runs, events, permissions, usage, and automations.'
      );
    }
    if (
      files.some(file => file.includes('frontend/src/pages/LibreClawPage.tsx'))
    ) {
      add(
        sections.features,
        'Added WebUI run management for Libre Claw chat and goal-mode runs, including event timelines, cancellation, provider/model overrides, and tool-call approvals.'
      );
      add(
        sections.features,
        'Added automation controls for Libre Claw schedules, including create, update, run now, pause, resume, and delete actions.'
      );
    }
    if (files.some(file => file.includes('backend/.env.example'))) {
      add(
        sections.features,
        'Added `LIBRE_CLAW_BASE_URL` and `LIBRE_CLAW_TIMEOUT_MS` backend environment settings for daemon connectivity.'
      );
    }
    if (files.some(file => file.includes('frontend/src/i18n/locales'))) {
      add(
        sections.improvements,
        'Completed Libre Claw translations across all supported locales instead of falling back to English.'
      );
    }
    if (
      files.some(file => file.includes('docs/31-LIBRE_CLAW_INTEGRATION.md'))
    ) {
      add(
        sections.docs,
        'Added Libre Claw integration documentation covering setup, route mapping, run modes, approvals, automations, and troubleshooting.'
      );
    }
    if (
      /docs\/31-OPENCLAW_INTEGRATION\.md|plugins\/openclaw-agent\.json/i.test(
        allText
      )
    ) {
      add(
        sections.breaking,
        'Removed the old OpenClaw integration path and replaced it with Libre Claw. Run the Libre Claw daemon and configure `LIBRE_CLAW_BASE_URL` when it is not on `http://127.0.0.1:8766`.'
      );
    }
  }

  if (
    files.some(file => file.includes('frontend/src/utils/artifactParser.ts'))
  ) {
    add(
      sections.fixes,
      'Hardened artifact title sanitization so malformed or quoted HTML tags cannot corrupt safe plain-text titles.'
    );
  }

  if (files.some(file => file.includes('frontend/src/utils/api/authApi.ts'))) {
    add(
      sections.fixes,
      'Fixed demo-mode system info so the UI reports the current built application version instead of a stale hardcoded value.'
    );
  }

  if (evidence.dependencyUpdates.length > 0) {
    add(
      sections.security,
      `Refreshed ${evidence.dependencyUpdates.length} dependencies, including ${formatList(evidence.dependencyUpdates.slice(0, 12))}.`
    );
  } else if (files.some(file => /package(-lock)?\.json$/.test(file))) {
    add(
      sections.security,
      'Updated package metadata and dependency lockfiles for the release.'
    );
  }

  applyCommitFallbacks(evidence.commits, sections, {
    artifactParser: files.some(file =>
      file.includes('frontend/src/utils/artifactParser.ts')
    ),
    demoVersion: files.some(file =>
      file.includes('frontend/src/utils/api/authApi.ts')
    ),
    libreClaw: hasLibreClaw,
  });
  applyUnreleasedNotes(evidence.unreleasedNotes, sections);

  const overview = inferOverview(version, evidence, sections);
  return renderReleaseNotes(overview, sections);
}

function applyCommitFallbacks(commits, sections, coveredThemes = {}) {
  for (const commit of commits) {
    const subject = cleanConventionalSubject(commit.subject);
    if (
      !subject ||
      isReleaseNoise(commit.subject) ||
      isDependabotCommit(commit) ||
      isCoveredByPathHeuristics(commit.subject, coveredThemes)
    ) {
      continue;
    }

    if (/^feat(?:\(.+\))?:/i.test(commit.subject)) {
      add(sections.features, sentence(subject));
    } else if (/^fix(?:\(.+\))?:/i.test(commit.subject)) {
      add(sections.fixes, sentence(subject));
    } else if (/^docs(?:\(.+\))?:/i.test(commit.subject)) {
      add(sections.docs, sentence(subject));
    } else if (/^(refactor|perf|style)(?:\(.+\))?:/i.test(commit.subject)) {
      add(sections.improvements, sentence(subject));
    } else if (/security|vulnerab|codeql|cve|audit/i.test(commit.subject)) {
      add(sections.security, sentence(subject));
    } else if (/^add|^implement|^introduce/i.test(subject)) {
      add(sections.features, sentence(subject));
    } else if (/^fix|^resolve|^harden/i.test(subject)) {
      add(sections.fixes, sentence(subject));
    } else if (/^update|^improve|^polish|^complete|^sync/i.test(subject)) {
      add(sections.improvements, sentence(subject));
    }
  }
}

function applyUnreleasedNotes(unreleasedNotes, sections) {
  if (!unreleasedNotes) return;

  const current = { key: null };
  for (const line of unreleasedNotes.split('\n')) {
    const heading = line.match(/^###\s+(.+)$/);
    if (heading) {
      current.key = sectionKeyFromHeading(heading[1]);
      continue;
    }

    const bullet = line.match(/^-\s+(.+)$/);
    if (bullet && current.key && sections[current.key]) {
      add(sections[current.key], bullet[1]);
    }
  }
}

function inferOverview(version, evidence, sections) {
  const text = [
    ...evidence.commits.map(commit => commit.subject),
    ...evidence.changedFiles.map(file => file.to || file.file),
  ].join('\n');

  if (/libre[\s-]?claw|openclaw/i.test(text)) {
    return `Libre WebUI ${version} is the agent integration release. It replaces the previous OpenClaw bridge with a first-class Libre Claw control surface, giving admins a local agent dashboard for durable runs, approvals, automations, usage, and daemon configuration.`;
  }

  if (sections.security.length > 0 && sections.features.length === 0) {
    return `Libre WebUI ${version} is a maintenance and security release. It focuses on dependency refreshes, safer runtime behavior, and release polish grounded in the current code changes.`;
  }

  if (sections.features.length > 0) {
    return `Libre WebUI ${version} adds new user-facing capabilities while tightening the supporting backend and frontend paths. The release notes below are generated from the commit history, changed files, and existing unreleased notes.`;
  }

  return `Libre WebUI ${version} is a focused maintenance release generated from the real git history since the previous tag. It groups the shipped fixes, improvements, documentation, and dependency work into release-ready notes.`;
}

function renderReleaseNotes(overview, sections) {
  const output = [overview.trim(), ''];
  const ordered = [
    ['features', '### ✨ New Features'],
    ['improvements', '### 🔧 Improvements'],
    ['fixes', '### 🐛 Bug Fixes'],
    ['security', '### 🔒 Security & Dependencies'],
    ['docs', '### 📚 Documentation'],
    ['breaking', '### ⚠️ Breaking Changes'],
  ];

  for (const [key, heading] of ordered) {
    const items = unique(sections[key]);
    if (items.length === 0) continue;
    output.push(heading, '');
    for (const item of items) output.push(`- ${item}`);
    output.push('');
  }

  return output.join('\n').trim();
}

function insertReleasePreview(version, evidence) {
  return `## [${version}] - ${evidence.date}\n\n${buildDeterministicReleaseNotes(version, evidence)}\n`;
}

function parseGitLog(output) {
  return output
    .split('\x1e')
    .map(record => record.trim())
    .filter(Boolean)
    .map(record => {
      const [hash, shortHash, date, subject, body = ''] = record.split('\x1f');
      return { body: body.trim(), date, hash, shortHash, subject };
    });
}

function parseNameStatus(output) {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) {
        return { file: parts[2], from: parts[1], status, to: parts[2] };
      }
      return { file: parts[1], status, to: parts[1] };
    });
}

function extractUnreleasedNotes(changelogPath) {
  if (!fs.existsSync(changelogPath)) return '';
  const changelog = fs.readFileSync(changelogPath, 'utf8');
  const match = changelog.match(
    /## \[Unreleased\]\s*\n([\s\S]*?)(?=\n## \[|$)/
  );
  if (!match) return '';

  const lines = match[1]
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim());
  const meaningful = lines.filter(line => !/^###\s+/.test(line));
  return meaningful.length > 0 ? lines.join('\n').trim() : '';
}

function parseDependencyUpdates(commits) {
  const updates = [];
  const seen = new Set();
  for (const commit of commits) {
    if (!isDependabotCommit(commit)) continue;
    const tableMatches = commit.body.matchAll(
      /\|\s+\[?`?([^|`\]]+)`?(?:\]\([^)]+\))?\s+\|\s+`?([^|`]+)`?\s+\|\s+`?([^|`]+)`?\s+\|/g
    );
    for (const match of tableMatches) {
      const name = match[1].trim();
      if (!name || name === 'Package' || /^-+$/.test(name) || seen.has(name)) {
        continue;
      }
      seen.add(name);
      updates.push(name);
    }
  }
  return updates;
}

function countLocaleFiles() {
  const localeDir = path.join(projectRoot, 'frontend/src/i18n/locales');
  if (!fs.existsSync(localeDir)) return 0;
  return fs.readdirSync(localeDir).filter(file => file.endsWith('.json'))
    .length;
}

function isDependabotCommit(commit) {
  return /deps\(deps\)|dependabot|updated-dependencies/i.test(
    `${commit.subject}\n${commit.body}`
  );
}

function isCoveredByPathHeuristics(subject, coveredThemes) {
  if (coveredThemes.libreClaw && /libre\s+claw/i.test(subject)) return true;
  if (
    coveredThemes.artifactParser &&
    /artifact title sanitization/i.test(subject)
  ) {
    return true;
  }
  if (coveredThemes.demoVersion && /demo system version/i.test(subject)) {
    return true;
  }
  return false;
}

function isReleaseNoise(subject) {
  return /^(chore\(release\):|Merge branch|Merge pull request|chore: run fmt|chore: sync package-lock \+ run fmt|docs: add unreleased section)/i.test(
    subject
  );
}

function cleanConventionalSubject(subject) {
  return subject
    .replace(/^[a-f0-9]+\s+/, '')
    .replace(
      /^(feat|fix|docs|refactor|perf|style|chore|test)(\(.+\))?:\s*/i,
      ''
    )
    .trim();
}

function sectionKeyFromHeading(heading) {
  if (/feature|added|new/i.test(heading)) return 'features';
  if (/improvement|changed|technical/i.test(heading)) return 'improvements';
  if (/fix/i.test(heading)) return 'fixes';
  if (/security|dependenc/i.test(heading)) return 'security';
  if (/doc/i.test(heading)) return 'docs';
  if (/breaking/i.test(heading)) return 'breaking';
  return null;
}

function cleanAIResponse(text) {
  return text
    .trim()
    .replace(/^```(?:markdown|md)?\s*/i, '')
    .replace(/```$/i, '')
    .replace(/^## \[[^\]]+\].*?\n+/i, '')
    .trim();
}

function isUsableReleaseNotes(text, evidence) {
  if (text.length <= 120 || !/^###\s+/m.test(text)) return false;
  if (/I (can'?t|cannot)|as an ai/i.test(text)) return false;
  if (/latest versions?/i.test(text)) return false;

  const localeCountMatch = text.match(
    /\b(\d+)\s+supported\s+(?:locale|language)s?/i
  );
  if (
    localeCountMatch &&
    Number(localeCountMatch[1]) !== evidence.localeFileCount
  ) {
    return false;
  }

  return true;
}

async function postJsonWithTimeout(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${text.slice(0, 240)}`);
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function trimForPrompt(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...`;
}

function indent(text) {
  return text
    .split('\n')
    .map(line => `  ${line}`)
    .join('\n');
}

function formatList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

function sentence(text) {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?`]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function add(list, item) {
  const clean = sentence(item);
  if (clean) list.push(clean);
}

function unique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = {
  CHANGELOG_TEMPLATE,
  buildDeterministicReleaseNotes,
  collectReleaseEvidence,
  createReleaseSection,
  getPreviousTag,
  insertReleasePreview,
  updateChangelogWithSection,
  projectRoot,
};
