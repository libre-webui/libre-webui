# 🤖 Universal AI Model Updater

Keep your AI provider plugins up-to-date with the latest available models automatically.

## Overview

The Universal AI Model Updater (`scripts/update-all-models.sh`) is a convenience script that automatically updates your plugin configurations with the latest available models from each AI provider's API.

**Key Features:**
- 🔍 **Smart Detection** - Automatically detects which API keys are configured
- 🔄 **Selective Updates** - Only updates providers with valid API keys
- 🎨 **Visual Feedback** - Color-coded output with clear status indicators
- 📊 **Summary Report** - Shows updated plugin files and their sizes
- ⚠️ **Safe Execution** - Skips providers without API keys rather than failing

## Quick Start

```bash
# From your Libre WebUI root directory
./scripts/update-all-models.sh
```

## Prerequisites

### Required API Keys

Set your API keys as environment variables:

```bash
export OPENAI_API_KEY="your_openai_key_here"
export ANTHROPIC_API_KEY="your_anthropic_key_here"
export GROQ_API_KEY="your_groq_key_here"
```

**💡 Pro Tip:** Add these to your shell profile (`.bashrc`, `.zshrc`, etc.) to persist them across sessions.

### Alternative: .env File

You can also set these in your backend `.env` file:

```bash
# backend/.env
OPENAI_API_KEY=your_openai_key_here
ANTHROPIC_API_KEY=your_anthropic_key_here
GROQ_API_KEY=your_groq_key_here
```

## How It Works

### 1. API Key Detection

The script first checks which API keys are available:

```
📋 Checking API keys...
✅ OpenAI: API key found
✅ Anthropic: API key found
⚠️  Groq: API key not set (GROQ_API_KEY)
```

### 2. Provider Updates

For each provider with a valid API key, the script:
- Calls the provider's API to get available models
- Updates the corresponding JSON plugin file
- Reports success or failure

```
🔄 Updating OpenAI models...
✅ OpenAI: Successfully updated

🔄 Updating Anthropic models...
✅ Anthropic: Successfully updated

⏭️  Skipping Groq (no API key)
```

### 3. Summary Report

After completion, you'll see:

```
🎉 Update process completed!

📁 Updated plugin files:
   plugins/openai.json (2.4K bytes, Dec 15 10:30)
   plugins/anthropic.json (1.8K bytes, Dec 15 10:30)
```

## Provider-Specific Behavior

### OpenAI
- ✅ **Auto-updates** - Fetches latest models via API
- 🎯 **Comprehensive** - Includes all available models
- 🔄 **Regular Updates** - OpenAI frequently adds new models

### Anthropic (Claude)
- ✅ **Auto-updates** - Fetches latest models via API
- 🎯 **Focused** - Includes production-ready models
- 📈 **Stable** - Less frequent but significant updates

### Groq
- ℹ️ **Manual maintenance** - No public models API endpoint
- 🛠️ **Community-driven** - Updated manually when new models are available
- ⚡ **High performance** - Optimized for speed

## Troubleshooting

### Common Issues

#### "API key not set" Warning
```bash
⚠️  OpenAI: API key not set (OPENAI_API_KEY)
```

**Solution:** Set your environment variable:
```bash
export OPENAI_API_KEY="your_key_here"
```

#### "Update failed" Error
```bash
❌ OpenAI: Update failed
```

**Possible causes:**
- Invalid API key
- Network connectivity issues
- API rate limiting
- Expired API key

**Debug steps:**
1. Verify your API key is correct
2. Test API access manually:
   ```bash
   curl -H "Authorization: Bearer $OPENAI_API_KEY" \
        https://api.openai.com/v1/models
   ```
3. Check network connectivity
4. Verify API key permissions

#### "Update script not found" Error
```bash
❌ OpenAI: Update script not found (scripts/update-openai-models.sh)
```

**Solution:** Currently, individual provider scripts are integrated into the main updater. This error indicates an internal issue - please report it.

## Best Practices

### When to Run

- **After initial setup** - Get the latest models for your configured providers
- **Weekly/Monthly** - Stay current with new model releases
- **Before important projects** - Ensure access to the latest capabilities
- **After provider announcements** - When providers announce new models

### Automation

You can automate updates with cron:

```bash
# Update models every Sunday at 2 AM
0 2 * * 0 /path/to/libre-webui/scripts/update-all-models.sh
```

### Version Control

The script updates `plugins/*.json` files. Consider:
- **Committing changes** - Track model updates in your repository
- **Reviewing updates** - Check what models were added/removed
- **Backing up** - Keep backups of working configurations

## Technical Details

### Plugin File Structure

Each provider plugin (`plugins/[provider].json`) contains:

```json
{
  "id": "openai",
  "name": "OpenAI GPT",
  "type": "completion",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENAI_API_KEY"
  },
  "model_map": [
    "gpt-4o",
    "gpt-4",
    "gpt-3.5-turbo",
    // ... more models
  ]
}
```

The updater specifically refreshes the `model_map` array.

### Script Internals

The updater script:
1. Uses color-coded output for readability
2. Checks environment variables for API keys
3. Calls provider-specific update functions
4. Provides detailed success/failure reporting
5. Shows file modification timestamps

## Related Documentation

- **[Plugin Architecture](./08-PLUGIN_ARCHITECTURE.md)** - Understanding the plugin system
- **[Working with Models](./02-WORKING_WITH_MODELS.md)** - Using different AI models
- **[Quick Start](./01-QUICK_START.md)** - Initial setup and configuration

---

**Need help?** Check our [Troubleshooting Guide](./06-TROUBLESHOOTING.md) or open an issue on GitHub.
