# Code Formatting & Linting

This project uses automated code formatting and linting to maintain consistent code quality.

## Tools Used

- **Prettier** - Code formatting
- **ESLint** - Code linting and error detection
- **TypeScript** - Type checking

## Available Scripts

```bash
# Format all code
npm run format

# Check formatting without making changes
npm run format:check

# Run linting
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Type checking
npm run type-check
```

## Automated Workflows

### GitHub Actions

The repository includes a GitHub Actions workflow (`.github/workflows/format.yml`) that:

1. **On every push/PR**: Runs formatting checks, linting, and type checking
2. **On main branch pushes**: Automatically formats code and commits changes
3. **Smart detection**: Only runs checks on changed files for faster execution

### Pre-commit Hooks

Pre-commit hooks are automatically set up when you run `npm install`. They will:

- Check code formatting
- Run ESLint on changed files
- Perform TypeScript type checking
- Prevent commits if any checks fail

### Manual Setup

If the pre-commit hooks aren't working, you can manually set them up:

```bash
npm run setup-hooks
```

## Configuration Files

- `.prettierrc.json` - Prettier configuration
- `.prettierignore` - Files to ignore for formatting
- `frontend/.eslintrc.json` - Frontend ESLint configuration
- `backend/.eslintrc.json` - Backend ESLint configuration
- `.githooks/pre-commit` - Pre-commit hook script

## IDE Integration

### VS Code

Install the following extensions for the best development experience:

- Prettier - Code formatter
- ESLint
- TypeScript and JavaScript Language Features

Configure VS Code to format on save by adding to your settings:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```
