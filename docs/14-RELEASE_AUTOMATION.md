---
sidebar_position: 2
title: 'Release Automation'
description: 'Release Libre WebUI with evidence-based changelog generation, checks, tags, and CI publishing.'
slug: /RELEASE_AUTOMATION
keywords:
  [
    release automation,
    conventional commits,
    changelog,
    deployment,
    ci cd,
    versioning,
  ]
image: /img/social/14.png
---

# Release Automation

Libre WebUI releases are created from the repository root with the release
script. The script reads real git history since the previous version tag,
updates package versions, writes the changelog, runs release checks, commits the
release, and creates the version tag.

## One-Time Local Setup

Install dependencies and enable the repository hooks:

```bash
npm install
npm run setup-hooks
```

The hook setup configures:

- `.githooks/commit-msg` for Conventional Commit validation
- `.githooks/pre-commit` for formatting checks
- `.gitmessage` as the local commit message template

## Create a Release

Run the release script from a clean worktree on the branch you intend to tag:

```bash
# Patch release
npm run release

# Minor release
npm run release:minor

# Major release
npm run release:major
```

The script automatically:

1. Checks that the working tree is clean.
2. Collects commit, file, dependency, locale, and unreleased changelog evidence.
3. Generates the release notes from that evidence.
4. Updates `package.json`, workspace package files, `package-lock.json`, and
   `CHANGELOG.md`.
5. Runs formatting, lint, build, tests, security audit, and npm dry-run checks.
6. Commits the release and creates the annotated version tag.

## Changelog Generation

Preview the next changelog section without changing files:

```bash
npm run changelog
```

Update `CHANGELOG.md` manually from the generated section:

```bash
npm run changelog -- update
```

By default, changelog generation can ask a local Ollama-compatible model for a
polished draft, then validates the result against the collected git evidence.
If AI is unavailable or the output looks unsafe, the script falls back to a
deterministic generator.

Useful overrides:

```bash
CHANGELOG_AI=0 npm run release:minor
CHANGELOG_AI_MODEL=glm-5.2:cloud npm run changelog
OLLAMA_BASE_URL=http://127.0.0.1:11434 npm run release
```

## Push a Release

After the release commit and tag are created, push the branch and the exact tag
shown by the script:

```bash
git push origin main
git push origin v0.12.0
```

Push the specific tag for the release you just created. Avoid `git push
origin --tags` because it can publish unrelated local tags.

## CI Release Path

Pushing a `v*` tag runs the GitHub release workflow. The workflow:

- Runs `npm run release:check`
- Builds Electron artifacts for macOS, Windows, and Linux
- Creates the GitHub release from the matching `CHANGELOG.md` section
- Builds Docker images
- Publishes the npm package with `NPM_TOKEN`

The same check can be run locally before tagging:

```bash
npm run release:check
```

## Conventional Commits

Commit messages should use Conventional Commit format:

```text
<type>[optional scope]: <description>
```

Common types:

- `feat`: user-facing feature
- `fix`: bug fix
- `docs`: documentation update
- `refactor`: internal code restructuring
- `perf`: performance improvement
- `test`: test coverage
- `chore`: maintenance, release, or build work

Breaking changes use `!`:

```bash
git commit -m "feat!: remove deprecated endpoint"
git commit -m "fix(auth)!: change token validation"
```

## Troubleshooting

### Working Directory Is Not Clean

Commit or stash the local changes before releasing:

```bash
git status --short
git add .
git commit -m "fix: resolve pending changes"
```

### No Releasable Changes

Check the commits since the previous tag:

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```

### Changelog Needs Manual Editing

Edit `CHANGELOG.md`, then commit the correction before tagging:

```bash
git add CHANGELOG.md
git commit -m "docs: refine changelog"
```

### Roll Back a Local Release Commit

If the tag has not been pushed yet:

```bash
git tag -d v0.12.0
git reset --soft HEAD~1
```

If the tag was already pushed, delete the remote tag deliberately:

```bash
git push origin :refs/tags/v0.12.0
```

## Maintainer Files

- `.gitmessage` - commit message template
- `.githooks/commit-msg` - Conventional Commit validation
- `.githooks/pre-commit` - formatting preflight
- `scripts/release.js` - release orchestration
- `scripts/generate-changelog.js` - changelog preview/update command
- `scripts/lib/releaseNotes.js` - evidence collection and changelog generation
- `.github/workflows/release.yml` - tag-driven CI release workflow

For more information about Conventional Commits, visit
https://www.conventionalcommits.org/.
