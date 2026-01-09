---
sidebar_position: 2
title: "Release Automation"
description: "Automated release system with conventional commits, changelog generation, and deployment workflows."
slug: /RELEASE_AUTOMATION
keywords: [release automation, conventional commits, changelog, deployment, ci cd, versioning]
image: /img/social/14.png
---

# Release Automation Guide

This guide explains how to use the automated release system for Libre WebUI, which automatically generates changelogs based on conventional commits.

## Quick Start

### 1. Initial Setup

Run the setup script to configure your development environment:

```bash
npm run setup:release
```

This will:
- Install required dependencies
- Configure git commit message template
- Set up git hooks for commit validation
- Configure conventional commits standards

### 2. Create Your First Release (v0.1.1)

```bash
# For a patch release (0.1.0 → 0.1.1)
npm run release

# For a minor release (0.1.0 → 0.2.0)
npm run release:minor

# For a major release (0.1.0 → 1.0.0)
npm run release:major
```

### 3. Push to GitHub

```bash
git push origin main && git push origin --tags
```

## Conventional Commits

This project uses [Conventional Commits](https://www.conventionalcommits.org/) for automatic changelog generation.

### Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

### Types

- `feat`: A new feature → appears in "✨ Added" section
- `fix`: A bug fix → appears in "🐛 Bug Fixes" section
- `docs`: Documentation changes → appears in "📚 Documentation" section
- `chore`: Build process or auxiliary tools → appears in "🔧 Technical Improvements" section
- `refactor`: Code refactoring → appears in "🔧 Technical Improvements" section
- `perf`: Performance improvements → appears in "🔧 Technical Improvements" section
- `test`: Adding or updating tests → appears in "🔧 Technical Improvements" section
- `style`: Code style changes → appears in "🔧 Technical Improvements" section

### Examples

```bash
# Add a new feature
git commit -m "feat: add automated changelog generation"

# Fix a bug
git commit -m "fix: resolve version update issue in release script"

# Update documentation
git commit -m "docs: add conventional commits guide"

# Technical improvements
git commit -m "chore: setup release automation workflow"

# Breaking changes
git commit -m "feat!: remove deprecated API endpoints"
git commit -m "feat(api)!: change user authentication flow"
```

### Scoped Commits

You can add scope to provide more context:

```bash
git commit -m "feat(auth): add JWT token refresh functionality"
git commit -m "fix(ui): resolve mobile navigation menu issue"
git commit -m "docs(api): update endpoint documentation"
```

## Release Commands

### Automatic Release

```bash
# Patch release (0.1.0 → 0.1.1) - for bug fixes
npm run release

# Minor release (0.1.0 → 0.2.0) - for new features
npm run release:minor

# Major release (0.1.0 → 1.0.0) - for breaking changes
npm run release:major
```

### Manual Changelog Generation

```bash
# Preview changelog for unreleased changes
npm run changelog

# Update unreleased section in CHANGELOG.md
npm run changelog update
```

## Release Process Details

The automated release process performs the following steps:

1. **Validation**: Checks that the working directory is clean
2. **Analysis**: Gets commits since the last tag and analyzes them
3. **Version Calculation**: Determines the next version based on commit types:
   - Breaking changes (`!` or `BREAKING CHANGE`) → major version
   - Features (`feat:`) → minor version
   - Everything else → patch version
4. **Updates**: Updates `package.json` version and `CHANGELOG.md`
5. **Quality Checks**: Runs linting and builds the project
6. **Git Operations**: Commits changes and creates a git tag
7. **Instructions**: Provides next steps for pushing and creating GitHub releases

## GitHub Actions

The project includes automated GitHub Actions workflows:

### Release Workflow

Triggered by:
- Pushing a version tag (`v*`)
- Manual workflow dispatch

Features:
- Automatically creates GitHub releases
- Generates release notes from changelog
- Builds Docker images
- Runs tests and quality checks

### Manual Release via GitHub

1. Go to Actions tab in your GitHub repository
2. Select "Release" workflow
3. Click "Run workflow"
4. Choose release type (patch/minor/major)
5. The workflow will create the release and push changes

## Versioning Strategy

This project follows [Semantic Versioning](https://semver.org/):

- **MAJOR** version for incompatible API changes
- **MINOR** version for backwards-compatible functionality additions
- **PATCH** version for backwards-compatible bug fixes

### Version Determination

The release script automatically determines the next version based on commits:

```javascript
// Breaking changes → major version bump
feat!: remove deprecated endpoints
fix!: change authentication flow

// New features → minor version bump
feat: add new dashboard widget
feat(ui): implement dark mode toggle

// Bug fixes and other changes → patch version bump
fix: resolve login redirect issue
docs: update installation guide
chore: update dependencies
```

## Best Practices

### Commit Messages

1. **Keep the first line under 50 characters**
2. **Use the imperative mood** ("add feature" not "added feature")
3. **Include scope when relevant** (`feat(auth): add 2FA support`)
4. **Reference issues when applicable** (`fix: resolve login issue (#123)`)
5. **Use breaking change notation** (`feat!: remove legacy API`)

### Release Workflow

1. **Make commits following conventional format**
2. **Run `npm run changelog` to preview changes**
3. **Run `npm run release` when ready**
4. **Review the generated changelog and version**
5. **Push changes: `git push origin main && git push origin --tags`**
6. **Create GitHub release from the tag**

### Pre-release Checklist

Before creating a release:

- [ ] All tests pass
- [ ] Code is formatted and linted
- [ ] Documentation is updated
- [ ] Breaking changes are documented
- [ ] Version bump is appropriate for changes

## Troubleshooting

### Common Issues

**"Working directory is not clean"**
```bash
# Commit or stash your changes
git add .
git commit -m "fix: resolve pending changes"
# or
git stash
```

**"No commits since last release"**
- Make sure you have new commits since the last tag
- Check with: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`

**"Invalid commit message format"**
- Use conventional commit format
- Check the git hook error message for guidance
- Example: `feat: add new feature description`

### Manual Changelog Update

If you need to manually edit the changelog:

1. Edit `CHANGELOG.md` directly
2. Follow the existing format and emoji conventions
3. Commit changes: `git commit -m "docs: update changelog"`

### Rollback a Release

If you need to rollback a release:

```bash
# Delete local tag
git tag -d v0.1.1

# Delete remote tag (if already pushed)
git push origin :refs/tags/v0.1.1

# Reset to previous commit
git reset --hard HEAD~1
```

## Configuration Files

The release system uses several configuration files:

- `.conventional-changelog.json` - Changelog generation configuration
- `.gitmessage` - Git commit message template
- `.githooks/commit-msg` - Commit message validation hook
- `scripts/release.js` - Main release script
- `scripts/generate-changelog.js` - Changelog generator
- `.github/workflows/release.yml` - GitHub Actions workflow

## Examples

### Creating v0.1.1 Release

```bash
# 1. Make some commits following conventional format
git commit -m "feat: add user profile settings"
git commit -m "fix: resolve navigation menu bug"
git commit -m "docs: update API documentation"

# 2. Create the release
npm run release

# 3. Review and push
git push origin main && git push origin --tags
```

This will:
- Bump version from 0.1.0 to 0.1.1
- Update CHANGELOG.md with new features, fixes, and documentation
- Create a git tag v0.1.1
- Provide instructions for the next steps

## 📚 Related Documentation

import DocCard from '@theme/DocCard';

<div className="row">
  <div className="col col--12">
    <DocCard
      item={{
        type: 'link',
        href: './AI_DEVELOPMENT_ANALYSIS',
        label: '🤖 AI Development Analysis',
        description: 'Enhance releases with AI-powered changelogs and project insights'
      }}
    />
  </div>
</div>

---

For more information about conventional commits, visit: https://www.conventionalcommits.org/
