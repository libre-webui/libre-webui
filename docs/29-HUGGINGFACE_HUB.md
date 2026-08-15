---
sidebar_position: 12
title: 'Hugging Face Hub'
description: 'Use Hugging Face models and Inference Providers from Libre WebUI.'
slug: /HUGGINGFACE_HUB
keywords:
  [
    huggingface,
    inference api,
    hub,
    embeddings,
    tts,
    image generation,
    speech-to-text,
  ]
---

# Hugging Face Hub

Libre WebUI integrates with Hugging Face in two ways:

- Provider plugin access through Hugging Face Inference Providers.
- In-app Hub browsing for compatible models, including GGUF models that can be pulled through Ollama.

## Configure the Provider Plugin

Create a Hugging Face access token with inference access, then add it in Settings or as an environment variable:

```env
HUGGINGFACE_API_KEY=hf_...
```

Enable the Hugging Face plugin in **Settings > Plugins**.

## Capabilities

Depending on model and provider availability, Hugging Face can provide:

- Chat/completion models
- Text-to-speech
- Image generation
- Embeddings
- Speech-to-text

Hugging Face availability, pricing, and routing can change by model. Check the model page and Hugging Face provider UI for current status.

## Model Browser

The in-app browser lets you:

- Search by model name or author.
- Filter by task.
- Sort by trending, downloads, likes, creation date, or update date.
- Inspect gated model status.
- Pull compatible GGUF files through Ollama when supported.

The browser fetches Hub metadata through the backend proxy and caches results for performance.
The backend requires an active Libre session for Hub discovery, and only a
current administrator can clear the shared model cache.

## GGUF and Ollama

For local inference, look for GGUF-format models. Libre WebUI can use Ollama-compatible `hf.co/...` model references when a repository exposes suitable GGUF files.

Example pattern:

```bash
ollama run hf.co/owner/model-repo:tag
```

Use the UI when possible; it reduces copy/paste mistakes and keeps model metadata visible.

## Inference Provider Routing

Hugging Face's OpenAI-compatible router supports model IDs from the Hub. Some routes support suffixes or provider preferences. Because this changes over time, prefer current Hugging Face docs and the in-app model browser for exact model IDs.

## Gated Models

Some models require accepting terms before use:

1. Open the model page on Hugging Face.
2. Accept the license or terms.
3. Confirm your token has access.
4. Retry from Libre WebUI.

Gated models can appear in discovery before your token is allowed to run them.

## Troubleshooting

**Unauthorized**

- Check the token value.
- Confirm the token has inference permissions.
- If using per-user credentials, confirm the key is saved for the current user.

**Model unavailable**

- Check the Hugging Face model page.
- Try another provider route if available.
- Confirm you accepted gated terms.

**GGUF pull fails**

- Confirm the repository contains GGUF files.
- Try the exact `hf.co/...` reference in a terminal with Ollama.
- Use a smaller quantization if disk or memory is limited.

## Related Docs

- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Working with Models](./WORKING_WITH_MODELS)
- [Document Chat](./RAG_FEATURE)
