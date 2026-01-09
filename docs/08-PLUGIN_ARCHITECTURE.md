---
sidebar_position: 3
title: "Plugins"
description: "Plugin system for AI providers, image generation, and text-to-speech"
slug: /PLUGIN_ARCHITECTURE
keywords: [plugins, openai, anthropic, tts, image generation, comfyui]
---

# Plugins

Libre WebUI supports three types of plugins:

- **Chat** - AI language models (OpenAI, Anthropic, Groq, etc.)
- **Image Generation** - Create images from text (ComfyUI, Flux)
- **Text-to-Speech** - Convert text to audio (OpenAI TTS, ElevenLabs)

## Chat Plugins

Connect to cloud AI providers alongside local Ollama models.

### Supported Providers

| Provider | Models | API Key Variable |
|----------|--------|------------------|
| OpenAI | GPT-4, GPT-4o, o3, o4 | `OPENAI_API_KEY` |
| Anthropic | Claude 4 Sonnet, Opus, Haiku | `ANTHROPIC_API_KEY` |
| Google | Gemini 2.0, 2.5 | `GEMINI_API_KEY` |
| Groq | Llama, Gemma (fast) | `GROQ_API_KEY` |
| Mistral | Mistral Large, Codestral | `MISTRAL_API_KEY` |
| GitHub Models | Free premium models | `GITHUB_API_KEY` |
| OpenRouter | 300+ models | `OPENROUTER_API_KEY` |

### Setup

Add API keys to `backend/.env`:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
```

Enable plugins in Settings → Plugins.

## Image Generation

Generate images using ComfyUI with Flux models.

### ComfyUI Plugin

```json
{
  "id": "comfyui",
  "name": "ComfyUI Flux",
  "type": "image",
  "endpoint": "http://localhost:8189/prompt",
  "capabilities": {
    "image": {
      "model_map": ["flux1-dev", "flux1-schnell"],
      "config": {
        "sizes": ["512x512", "768x768", "1024x1024", "1920x1080"],
        "default_size": "1024x1024"
      }
    }
  }
}
```

### Setup

1. Install [ComfyUI](https://github.com/comfyanonymous/ComfyUI)
2. Add Flux models to ComfyUI
3. Update the endpoint in `plugins/comfyui.json` to your ComfyUI server
4. Enable in Settings → Plugins

### Usage

Click the image icon in chat or use the Imagine page to generate images.

## Text-to-Speech

Convert AI responses to spoken audio.

### OpenAI TTS

Uses OpenAI's text-to-speech API.

```env
OPENAI_API_KEY=sk-...
```

Voices: alloy, ash, coral, echo, fable, onyx, nova, sage, shimmer

### ElevenLabs

High-quality multilingual voices.

```env
ELEVENLABS_API_KEY=...
```

Voices: Rachel, Domi, Bella, Antoni, Josh, Adam, and more.

### Usage

Click the speaker icon on any message to hear it spoken.

## Plugin Configuration

Plugins are JSON files in the `plugins/` directory.

### Plugin Structure

```json
{
  "id": "provider-name",
  "name": "Display Name",
  "type": "completion|image|tts",
  "endpoint": "https://api.example.com/v1/...",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "API_KEY_VAR"
  },
  "model_map": ["model-1", "model-2"],
  "capabilities": {}
}
```

### Plugin Types

| Type | Purpose | Example |
|------|---------|---------|
| `completion` | Chat/text generation | OpenAI, Anthropic |
| `image` | Image generation | ComfyUI |
| `tts` | Text-to-speech | OpenAI TTS, ElevenLabs |

## Managing Plugins

### Via UI

Settings → Plugins → Plugin Manager

- Enable/disable plugins
- Upload new plugins
- Configure settings

### Via API

```bash
# List plugins
GET /api/plugins

# Enable plugin
POST /api/plugins/activate/:id

# Disable plugin
POST /api/plugins/deactivate
```

## Creating Custom Plugins

### Chat Plugin Example

```json
{
  "id": "custom-llm",
  "name": "Custom LLM",
  "type": "completion",
  "endpoint": "https://your-api.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "CUSTOM_API_KEY"
  },
  "model_map": ["model-a", "model-b"]
}
```

The API must follow the OpenAI chat completions format.

### TTS Plugin Example

```json
{
  "id": "custom-tts",
  "name": "Custom TTS",
  "type": "tts",
  "endpoint": "https://your-api.com/v1/audio/speech",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "CUSTOM_TTS_KEY"
  },
  "capabilities": {
    "tts": {
      "voices": ["voice-1", "voice-2"],
      "default_voice": "voice-1",
      "formats": ["mp3", "wav"]
    }
  }
}
```

## Troubleshooting

**Plugin not working:**
- Check API key is set in `.env`
- Verify plugin is enabled in Settings
- Check server logs for errors

**Image generation fails:**
- Verify ComfyUI is running
- Check endpoint URL is correct
- Ensure Flux models are installed

**TTS not playing:**
- Check API key has credits
- Verify audio format is supported
- Check browser allows audio playback
