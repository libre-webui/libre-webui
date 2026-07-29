---
sidebar_position: 2
title: 'Release Automation'
description: 'Release Libre WebUI with evidence-based changelogs, gated checks, immutable tags, and GitHub-to-Forgejo mirroring.'
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
release, and creates the version tag. GitHub is the build and binary publication
source; release metadata and named artifact links are mirrored to the project's
Forgejo repository.

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

1. Checks that the working tree is clean and the next local tag is available.
2. Collects commit, file, dependency, locale, and unreleased changelog evidence.
3. Generates the release notes from that evidence.
4. Updates `package.json`, workspace package files, `package-lock.json`, the
   Helm chart and app versions, and `CHANGELOG.md`.
5. Runs `npm run release:check`, including formatting, lint, builds, tests,
   security audit, and the npm publish dry-run.
6. Only after every check passes, commits the release and creates the annotated
   version tag.

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

After the release commit and annotated tag are created, publish only the exact
branch commit and tag shown by the script. The production branch is pushed to
Forgejo first, then GitHub, with followed tags disabled explicitly:

```bash
git -c push.followTags=false push \
  https://git.kroonen.ai/libre-webui/libre-webui.git \
  HEAD:refs/heads/main
git ls-remote \
  https://git.kroonen.ai/libre-webui/libre-webui.git \
  refs/heads/main

git -c push.followTags=false push \
  https://github.com/libre-webui/libre-webui.git \
  HEAD:refs/heads/main
git ls-remote \
  https://github.com/libre-webui/libre-webui.git \
  refs/heads/main
```

Both returned branch SHAs must equal the intended local release commit. Wait for
the required GitHub workflows for that exact commit to pass before publishing
the tag.

Confirm the version tag does not already exist on either service, then push that
one tag to Forgejo first and GitHub second:

```bash
git ls-remote \
  https://git.kroonen.ai/libre-webui/libre-webui.git \
  'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'
git ls-remote \
  https://github.com/libre-webui/libre-webui.git \
  'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'

git -c push.followTags=false push \
  https://git.kroonen.ai/libre-webui/libre-webui.git \
  refs/tags/vX.Y.Z:refs/tags/vX.Y.Z
git -c push.followTags=false push \
  https://github.com/libre-webui/libre-webui.git \
  refs/tags/vX.Y.Z:refs/tags/vX.Y.Z

git ls-remote \
  https://git.kroonen.ai/libre-webui/libre-webui.git \
  'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'
git ls-remote \
  https://github.com/libre-webui/libre-webui.git \
  'refs/tags/vX.Y.Z' 'refs/tags/vX.Y.Z^{}'
```

Replace `vX.Y.Z` with the release tag. For an annotated tag, verify both the tag
object SHA and its peeled commit SHA. Never use `git push --tags`, which can
publish unrelated local tags.

## CI Release Path

Pushing a `v*` tag runs the GitHub release workflow. The workflow:

- Runs `npm run release:check`
- Builds Electron artifacts for macOS, Windows, and Linux
- Creates the GitHub release from the matching `CHANGELOG.md` section
- Mirrors the release record and named artifact links to Forgejo
- Builds Docker images
- Publishes the Helm chart with the same version as the release tag
- Publishes the npm package with `NPM_TOKEN`

The same check can be run locally before tagging:

```bash
npm run release:check
```

## Forgejo Release Mirror

The mirror uses a Forgejo personal access token stored as the encrypted GitHub
Actions secret `FORGEJO_TOKEN`. Give the token only the
`write:repository` scope, ensure its owner can write to
`libre-webui/libre-webui`, and never commit or print the token.

The mirror is deliberately idempotent. It looks up releases by tag, creates
only missing release records, reconciles their GitHub release metadata, and
skips artifact links that already exist. A retry after a network or workflow
failure therefore completes the missing work without duplicating releases or
assets.

Forgejo release assets are named external links to the corresponding public
GitHub `browser_download_url`. GitHub remains the binary host, while Forgejo
shows the same downloadable filenames without duplicating tens of gigabytes of
desktop artifacts. Source archives remain generated independently from the
exact tag on each service.

### Preview or Backfill One Release

Inspect what would change without writing to Forgejo:

```bash
node scripts/mirror-forgejo-releases.mjs --tag vX.Y.Z --dry-run
```

After loading `FORGEJO_TOKEN` and `GITHUB_TOKEN` into the process environment
from the maintainer's secret manager, mirror that release:

```bash
node scripts/mirror-forgejo-releases.mjs --tag vX.Y.Z
```

The exact tag must already exist on GitHub and Forgejo and resolve to the same
tag object and peeled commit before a release is mirrored.

### Preview or Backfill All Releases

Audit every GitHub Release against Forgejo:

```bash
node scripts/mirror-forgejo-releases.mjs --all --dry-run
```

Backfill every missing or incomplete Forgejo Release:

```bash
node scripts/mirror-forgejo-releases.mjs --all
```

`GITHUB_TOKEN` is required for `--all`, including dry runs, because exact tag
parity and asset discovery require more requests than GitHub's anonymous API
limit permits. `FORGEJO_TOKEN` is additionally required whenever `--dry-run` is
not used.

The `--all` path paginates both APIs and considers GitHub Release objects, not
every Git tag. A tag that intentionally has no GitHub Release remains tag-only
on Forgejo. Run the dry-run again after a backfill; it should report no pending
changes.

## Immutable Tag Policy

Published version tags are immutable. After a tag exists on either remote:

- Do not delete it.
- Do not force-push it.
- Do not move it to a corrected commit.
- Do not reuse its semantic version for different contents.

If published release contents are wrong, correct the source and changelog and
publish the next patch version. If only a release page or external asset link is
missing, rerun the idempotent mirror without touching the tag.

The Forgejo `v0.8.6` tag had a one-time, explicitly approved realignment during
the introduction of dual release mirroring. It repaired two historical tag
objects that described identical source trees but followed different commit
lineages. That audited migration is not a precedent for moving published tags.

## Helm Version Policy

The Helm chart `version`, chart `appVersion`, root package version, and release
tag intentionally use the same semantic version. The release script advances
them together, and CI rejects a mismatch.

The chart is published only from an immutable `v*` release tag. Do not publish
modified chart contents under an existing chart version. A chart change must go
through the next application release so it receives a new version.

Chart version 0.14.1 carries a one-time digest override because that release
predates semantic Docker tags. The digest identifies the verified
multi-architecture 0.14.1 image. The release script clears this override when it
creates the next release, after which the default image resolves to the chart
`appVersion`.

The Docker workflow publishes that semantic-version tag to GHCR and Docker Hub
from the same `v*` release tag. Helm publication waits up to 20 minutes for the
matching public Docker Hub image and fails instead of publishing a chart with a
missing default image. The bundled Ollama image remains independently
configurable and defaults to its upstream `latest` tag.

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

Edit `CHANGELOG.md`, then commit the correction before publishing the tag:

```bash
git add CHANGELOG.md
git commit -m "docs: refine changelog"
```

### Roll Back a Local Release Commit

If neither the release commit nor tag has been pushed:

```bash
git tag -d v0.12.0
git reset --soft HEAD~1
```

If either remote already has the tag, do not delete or replace it. Fix the
problem on `main`, create the next patch release, and publish that new immutable
tag through the complete gate.

### Forgejo Mirror Is Incomplete

First verify that both remote tag object and peeled commit SHAs match. Then
preview and retry the affected release:

```bash
node scripts/mirror-forgejo-releases.mjs --tag vX.Y.Z --dry-run
node scripts/mirror-forgejo-releases.mjs --tag vX.Y.Z
```

An authorization failure means `FORGEJO_TOKEN` is missing, expired, owned by a
user without repository access, or lacks `write:repository`. A missing or
different remote tag must be investigated separately; the release mirror never
creates or moves Git tags.

## Maintainer Files

- `.gitmessage` - commit message template
- `.githooks/commit-msg` - Conventional Commit validation
- `.githooks/pre-commit` - formatting preflight
- `scripts/release.js` - release orchestration
- `scripts/mirror-forgejo-releases.mjs` - idempotent Forgejo release mirror and
  backfill
- `scripts/generate-changelog.js` - changelog preview/update command
- `scripts/lib/releaseNotes.js` - evidence collection and changelog generation
- `.github/workflows/release.yml` - tag-driven CI release workflow
- `.github/workflows/helm-publish.yml` - Helm validation and tag publication

For more information about Conventional Commits, visit
https://www.conventionalcommits.org/.
