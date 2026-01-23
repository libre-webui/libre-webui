---
sidebar_position: 12
title: "HuggingFace Hub"
description: "Access 1M+ AI models via HuggingFace Inference Providers - chat, TTS, image generation, embeddings, and speech-to-text"
slug: /HUGGINGFACE_HUB
keywords: [huggingface, inference api, llama, flux, whisper, embeddings, tts, stable diffusion]
---

# HuggingFace Hub Integration

Access over 1 million AI models through HuggingFace's Inference Providers, with unified billing on your HF account.

## Overview

The HuggingFace plugin provides:

- **Chat** - 30+ popular LLMs (Llama, Qwen, Mistral, Gemma, Phi)
- **Text-to-Speech** - MMS-TTS, Bark, XTTS, Parler-TTS, OuteTTS
- **Image Generation** - FLUX.1, Stable Diffusion 3.5, SDXL
- **Embeddings** - sentence-transformers, BGE, E5, Jina, GTE
- **Speech-to-Text** - Whisper, wav2vec2, Canary

All models use HuggingFace's OpenAI-compatible API at `router.huggingface.co`.

## Quick Start

### 1. Get HuggingFace Token

1. Create account at [huggingface.co](https://huggingface.co)
2. Go to Settings → Access Tokens
3. Create token with **Inference** permission

HF Pro users get $2/month in free inference credits.

### 2. Configure Libre WebUI

Add to `backend/.env`:

```env
HUGGINGFACE_API_KEY=hf_xxxxxxxxxxxxxxxxxxxxx
```

### 3. Enable Plugin

Settings → Plugins → Enable "HuggingFace"

## Chat Models

The plugin includes 30+ pre-configured LLMs:

| Family | Models |
|--------|--------|
| **Meta Llama** | Llama-3.3-70B, Llama-3.1-70B/8B, Llama-3.2-3B/1B, Llama-4 Scout/Maverick |
| **Qwen** | Qwen2.5-72B/32B/7B, Qwen3-235B/32B, QwQ-32B, Qwen2.5-Coder-32B |
| **Mistral** | Mistral-7B-v0.3, Mistral-Nemo, Mixtral-8x7B, Mistral-Small-24B |
| **Google** | Gemma-2-27B/9B, Gemma-3-27B/12B |
| **Microsoft** | Phi-4, Phi-3.5-mini |
| **DeepSeek** | DeepSeek-R1-Distill-Qwen-32B, DeepSeek-R1-Distill-Llama-70B |
| **Others** | Hermes-3-70B, Nemotron-70B, Command-R+, Yi-1.5-34B |

### Model Routing

Append suffixes to model IDs for routing preferences:

- `:fastest` - Route to highest throughput provider
- `:cheapest` - Route to lowest cost provider

Example: `meta-llama/Llama-3.3-70B-Instruct:fastest`

## Model Browser

Browse and discover models directly in Libre WebUI:

1. Go to Settings → Plugins → Plugin Manager
2. Click **"Browse HF Hub"**
3. Search, filter by task, and sort by trending/downloads/likes

The browser fetches models from the HuggingFace Hub API with 24-hour caching for performance.

### Filtering Options

- **Task**: Text Generation, Text-to-Speech, Text-to-Image, Speech Recognition
- **Sort**: Trending, Most Downloads, Most Liked
- **Search**: Filter by model name or author

## Text-to-Speech

### Available Models

| Model | Description |
|-------|-------------|
| `facebook/mms-tts-eng` | Meta's Massively Multilingual Speech TTS |
| `coqui/XTTS-v2` | Multi-lingual with voice cloning |
| `suno/bark` | High-quality, expressive speech with non-verbal sounds |
| `parler-tts/parler-tts-large-v1` | Natural, controllable speech |
| `OuteAI/OuteTTS-0.3-1B` | Latest open-source TTS |

### Language Support

MMS-TTS supports 1000+ languages:
- `facebook/mms-tts-eng` (English)
- `facebook/mms-tts-fra` (French)
- `facebook/mms-tts-deu` (German)
- `facebook/mms-tts-spa` (Spanish)

## Image Generation

### Available Models

| Model | Description |
|-------|-------------|
| `black-forest-labs/FLUX.1-dev` | State-of-the-art quality |
| `black-forest-labs/FLUX.1-schnell` | Fast generation (~4 steps) |
| `stabilityai/stable-diffusion-3.5-large` | Latest Stable Diffusion |
| `stabilityai/stable-diffusion-3.5-large-turbo` | Fast SD 3.5 |
| `stabilityai/stable-diffusion-xl-base-1.0` | Popular SDXL base |
| `runwayml/stable-diffusion-v1-5` | Classic SD 1.5 |
| `prompthero/openjourney-v4` | Midjourney-style |

### Supported Sizes

- 512x512, 768x768, 1024x1024
- 1024x768 (landscape), 768x1024 (portrait)

## Embeddings for RAG

Use HuggingFace embeddings for document retrieval and semantic search.

### Available Models

| Model | Dimensions | Use Case |
|-------|------------|----------|
| `sentence-transformers/all-MiniLM-L6-v2` | 384 | Fast, lightweight |
| `sentence-transformers/all-mpnet-base-v2` | 768 | Balanced |
| `BAAI/bge-small-en-v1.5` | 384 | High accuracy, small |
| `BAAI/bge-base-en-v1.5` | 768 | High accuracy, medium |
| `BAAI/bge-large-en-v1.5` | 1024 | Best accuracy |
| `jinaai/jina-embeddings-v2-base-en` | 768 | Long context (8K tokens) |
| `intfloat/e5-large-v2` | 1024 | Excellent retrieval |
| `thenlper/gte-large` | 1024 | General text embeddings |

## Speech-to-Text

### Available Models

| Model | Description |
|-------|-------------|
| `openai/whisper-large-v3` | Best accuracy, 99 languages |
| `openai/whisper-large-v3-turbo` | Fast + accurate balance |
| `openai/whisper-medium` | Good accuracy, faster |
| `openai/whisper-small/base/tiny` | Lightweight options |
| `facebook/wav2vec2-large-960h-lv60-self` | Facebook's speech model |
| `nvidia/canary-1b` | Multi-lingual ASR |
| `Systran/faster-whisper-large-v3` | Optimized Whisper |

### Supported Audio Formats

FLAC, MP3, WAV, WebM, OGG (up to 5 minutes)

## API Endpoints

### Chat Completion

```bash
curl https://router.huggingface.co/v1/chat/completions \
  -H "Authorization: Bearer $HF_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "meta-llama/Llama-3.3-70B-Instruct",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Text-to-Speech

```bash
curl https://router.huggingface.co/hf-inference/models/facebook/mms-tts-eng \
  -H "Authorization: Bearer $HF_TOKEN" \
  -d '{"inputs": "Hello world!"}' \
  --output speech.flac
```

### Image Generation

```bash
curl https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell \
  -H "Authorization: Bearer $HF_TOKEN" \
  -d '{"inputs": "A cat wearing a top hat"}' \
  --output image.png
```

### Embeddings

```bash
curl https://router.huggingface.co/hf-inference/models/sentence-transformers/all-MiniLM-L6-v2 \
  -H "Authorization: Bearer $HF_TOKEN" \
  -d '{"inputs": "This is a sentence to embed"}'
```

### Speech-to-Text

```bash
curl https://router.huggingface.co/hf-inference/models/openai/whisper-large-v3 \
  -H "Authorization: Bearer $HF_TOKEN" \
  -F file=@audio.mp3
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      Libre WebUI                            │
├─────────────────────────────────────────────────────────────┤
│  PluginManager.tsx  ←→  HuggingFaceModelBrowser.tsx        │
│         │                        │                          │
│         ▼                        ▼                          │
│  plugins/huggingface.json   huggingfaceHub.ts (backend)    │
│         │                        │                          │
│         └────────────┬───────────┘                          │
│                      ▼                                      │
│         router.huggingface.co/v1 (OpenAI-compatible)       │
│         router.huggingface.co/hf-inference/models          │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| `plugins/huggingface.json` | Plugin config with all models and capabilities |
| `backend/src/routes/huggingfaceHub.ts` | API proxy for Hub model discovery |
| `frontend/src/components/HuggingFaceModelBrowser.tsx` | In-app model browser UI |

## Pricing

HuggingFace Inference is billed per request/token:

- **HF Pro** ($9/month): $2/month free inference credits
- **Pay-as-you-go**: Varies by model and provider

Check [huggingface.co/pricing](https://huggingface.co/pricing) for current rates.

## Gated Models

Some models require accepting terms before use:

1. Visit the model page on HuggingFace
2. Accept the model's license/terms
3. Wait for access approval (instant for most models)

Gated models show a "Gated" badge in the Model Browser.

## Troubleshooting

**"Unauthorized" error:**
- Verify API token is valid
- Check token has Inference permission
- Ensure token is set in `.env`

**Model not available:**
- Some models may be temporarily unavailable
- Check model page for status
- Try appending `:fastest` for alternative providers

**Gated model access denied:**
- Visit model page and accept terms
- Wait for approval (usually instant)
- Check your HuggingFace profile for pending requests

**Rate limiting:**
- HF applies rate limits based on your plan
- Consider HF Pro for higher limits
- Implement caching for repeated requests

## Resources

- [HuggingFace Inference Providers](https://huggingface.co/docs/inference-providers)
- [Hub API Documentation](https://huggingface.co/docs/hub/api)
- [OpenAI Compatibility](https://huggingface.co/changelog/inference-providers-openai-compatible)
- [Model Hub](https://huggingface.co/models)
