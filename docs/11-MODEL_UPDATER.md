---
sidebar_position: 3
title: 'Model Updater'
description: 'Refresh provider model maps used by Libre WebUI plugins.'
slug: /MODEL_UPDATER
keywords:
  [
    libre webui model updater,
    ai model updates,
    provider model discovery,
    plugin models,
  ]
image: /img/social/11.png
---

# Model Updater

Libre WebUI can refresh plugin model maps from provider APIs where the provider exposes a model-list endpoint. This keeps fallback model lists useful without hardcoding every provider catalog by hand, and the updater preserves the rest of each plugin definition so endpoint, capability, and variable settings are not lost.

## When to Use It

Run the updater when:

- A provider releases models that do not appear in the UI.
- You changed provider credentials.
- You are preparing a release and want plugin maps refreshed.
- You are adding a new provider plugin.

The app can also discover models at runtime for supported plugins, so the updater is mainly a maintenance tool for repository model maps and fallback lists.

## Run All Updaters

From the repository root:

```bash
./scripts/update-all-models.sh
```

The script loads `backend/.env`, uses provider API keys when available, and also refreshes public catalogs for providers that expose them without credentials, including OpenRouter, Hugging Face Router, and GitHub Models. Providers that require credentials fall back to a small documented model set when no key is configured.

## Provider Keys

Export the keys you want to use before running the updater:

```bash
export OPENAI_API_KEY="..."
export ANTHROPIC_API_KEY="..."
export GEMINI_API_KEY="..."
export GROQ_API_KEY="..."
export MISTRAL_API_KEY="..."
```

OpenRouter, Hugging Face Router, and GitHub Models can refresh their catalog fallbacks without local credentials. Runtime use of a paid/provider-backed model can still require the corresponding user credential in Libre WebUI.

## Review Changes

After updating:

```bash
git diff
npm run lint
```

Check that model IDs are valid, names are readable, and no provider-specific preview/billing-only model was added in a misleading way.

## Documentation Rule

Do not copy a large provider catalog into the docs. Use examples for common workflows and let the UI/provider discovery show the current catalog.

## Related Docs

- [Plugins](./PLUGIN_ARCHITECTURE)
- [Working with Models](./WORKING_WITH_MODELS)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
