---
sidebar_position: 3
title: "Plugins"
description: "Plugin system for AI providers, image generation, and text-to-speech"
slug: /PLUGIN_ARCHITECTURE
keywords: [plugins, openai, anthropic, tts, image generation, comfyui]
---

# Plugins

Libre WebUI supports several types of plugins:

- **Chat** - AI language models (OpenAI, Anthropic, Groq, etc.)
- **Image Generation** - Create images from text (ComfyUI, Flux)
- **Text-to-Speech** - Convert text to audio (OpenAI TTS, ElevenLabs)
- **Speech-to-Text** - Transcribe audio to text
- **Embeddings** - Generate vector embeddings for RAG

## Chat Plugins

Connect to cloud AI providers alongside local Ollama models.

### Supported Providers

| Provider | Models | API Key Variable | Notes |
|----------|--------|------------------|-------|
| **OpenAI** | GPT-4o, GPT-4, o1, o3, o4 (110+ models) | `OPENAI_API_KEY` | Also provides TTS |
| **Anthropic** | Claude Opus 4.5, Claude 4 Sonnet/Opus | `ANTHROPIC_API_KEY` | Best for reasoning |
| **Google Gemini** | Gemini 2.0/2.5 Flash/Pro (55+ models) | `GEMINI_API_KEY` | Includes Imagen |
| **Groq** | Llama 3.1, Gemma, Qwen3 | `GROQ_API_KEY` | Fastest inference |
| **Mistral** | Large, Medium, Codestral (71+ models) | `MISTRAL_API_KEY` | EU-based |
| **OpenRouter** | 300+ models from all providers | `OPENROUTER_API_KEY` | Pay-per-token |
| **HuggingFace** | Llama, Qwen, Mistral, Phi, and more (220+ models) | `HUGGINGFACE_API_KEY` | Free tier available |
| **GitHub Models** | Llama, Mistral, Phi, Jamba, and more | `GITHUB_API_KEY` | Free with GitHub account |

### Setup

**Option 1: Environment variables** (recommended for self-hosting)

Add API keys to `backend/.env`:

```env
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...
MISTRAL_API_KEY=...
OPENROUTER_API_KEY=sk-or-...
```

**Option 2: Per-user API keys** (multi-user deployments)

Users can add their own API keys in Settings → Plugins → Configure. Keys are encrypted and stored per-user.

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

High-quality multilingual voices with 7 TTS models.

```env
ELEVENLABS_API_KEY=...
```

**Models:** eleven_multilingual_v2, eleven_turbo_v2_5, eleven_flash_v2_5, and more

**Voices (16 available):** Rachel, Domi, Bella, Antoni, Josh, Adam, Arnold, Sam, and more

**Formats:** MP3, PCM, ulaw (5000 character limit per request)

### Qwen3 TTS (Local)

High-quality local TTS with voice cloning and voice design. Runs on your own hardware, no API key needed.

**Models:** qwen3-tts, qwen3-tts-customvoice, qwen3-tts-voicedesign, qwen3-tts-clone

See [Qwen3 TTS guide](./27-QWEN3_TTS.md) for setup instructions.

### Kyutai TTS (Local)

Local TTS with voice cloning support. No API key needed.

**Models:** kyutai-tts, kyutai-tts-clone

See [Kyutai TTS guide](./28-KYUTAI_TTS.md) for setup instructions.

### Usage

1. Click the speaker icon on any message to hear it spoken
2. Configure voice and model in Settings → Text-to-Speech
3. Select between OpenAI TTS, ElevenLabs, Qwen3, or Kyutai as your provider

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
| `stt` | Speech-to-text | Whisper |
| `embedding` | Vector embeddings | OpenAI Embeddings |

## Managing Plugins

### Via UI

Settings → Plugins → Plugin Manager

- Enable/disable plugins
- Upload new plugin JSON files or paste JSON directly
- Browse HuggingFace Hub to discover and import models
- Configure API keys and variables
- Export plugins as JSON

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
  "model_map": ["tts-model-1"],
  "capabilities": {
    "tts": {
      "endpoint": "https://your-api.com/v1/audio/speech",
      "model_map": ["tts-model-1"],
      "config": {
        "voices": ["voice-1", "voice-2"],
        "default_voice": "voice-1",
        "formats": ["mp3", "wav"],
        "max_characters": 4096,
        "supports_streaming": true
      }
    }
  }
}
```

## Plugin Variables (Valves)

Plugins can define configurable variables that users set through the UI. Variables are persisted to the database and used at request time, similar to similar WebUI's "valves" system.

### Defining Variables

Add a `variables` array to your plugin JSON:

```json
{
  "id": "openai",
  "name": "OpenAI",
  "type": "completion",
  "endpoint": "https://api.openai.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "OPENAI_API_KEY"
  },
  "model_map": ["gpt-4o", "gpt-4o-mini"],
  "variables": [
    {
      "name": "temperature",
      "type": "number",
      "label": "Temperature",
      "description": "Controls randomness. Lower values are more deterministic.",
      "default": 0.7,
      "min": 0,
      "max": 2
    },
    {
      "name": "max_tokens",
      "type": "number",
      "label": "Max Tokens",
      "description": "Maximum number of tokens to generate.",
      "default": 4096,
      "min": 1,
      "max": 128000
    },
    {
      "name": "stream",
      "type": "boolean",
      "label": "Stream Responses",
      "description": "Stream tokens as they are generated.",
      "default": true
    }
  ]
}
```

### Variable Types

| Type | Input | Notes |
|------|-------|-------|
| `string` | Text field | Use `sensitive: true` for secrets (encrypted + masked) |
| `number` | Number field | Supports `min` and `max` constraints |
| `boolean` | Checkbox | Stored as `true`/`false` |
| `select` | Dropdown | Requires `options` array |

### Full Variable Definition

```typescript
{
  name: string;         // Unique key used in code
  type: 'string' | 'number' | 'boolean' | 'select';
  label: string;        // Display name in UI
  description?: string; // Help text shown below the input
  default?: any;        // Default value if user hasn't set one
  required?: boolean;   // Whether a value is required
  sensitive?: boolean;  // Encrypt in DB, mask in UI (for API keys, tokens)
  options?: string[];   // Choices for 'select' type
  min?: number;         // Minimum value for 'number' type
  max?: number;         // Maximum value for 'number' type
}
```

### Sensitive Variables

Mark variables as `sensitive` to encrypt them at rest and mask them in the UI:

```json
{
  "name": "custom_token",
  "type": "string",
  "label": "Custom Auth Token",
  "description": "Additional authentication token for this provider.",
  "sensitive": true
}
```

Sensitive values are encrypted using AES-256-GCM before being stored in the database and displayed as `••••••••` in the Plugin Manager.

### Select Variables

Use `select` type with an `options` array for dropdown fields:

```json
{
  "name": "response_format",
  "type": "select",
  "label": "Response Format",
  "description": "Format of the model output.",
  "default": "text",
  "options": ["text", "json"]
}
```

### How Variables Are Used

Variables are loaded at request time and applied as defaults to outbound API calls. The priority chain is:

1. **Per-request options** (from the chat UI) — highest priority
2. **Plugin variables** (user-configured values from the database)
3. **Hardcoded defaults** (built into the application)

For example, if a user sets `temperature: 0.3` in a plugin's variables and then sends a message with the default UI settings, the request to the provider will use `temperature: 0.3`. If the user overrides temperature in the chat UI for a specific message, that value takes precedence.

### Configuring Variables in the UI

1. Go to **Settings → Plugins → Plugin Manager**
2. Find the plugin and expand the **Variables** section
3. Set your desired values
4. Click **Save**

Use **Reset to Defaults** to clear all saved values and revert to the plugin's defaults.

### Variables API

```bash
# Get current variable values (sensitive values masked)
GET /api/plugins/:id/variables

# Set variable values
PUT /api/plugins/:id/variables
Content-Type: application/json
{ "variables": { "temperature": 0.5, "max_tokens": 2048 } }

# Reset all variables to defaults
DELETE /api/plugins/:id/variables
```

## Multi-Capability Plugins

A single plugin can serve multiple purposes by defining a `capabilities` object. For example, OpenAI's plugin handles both chat completions and TTS with a single API key:

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
  "model_map": ["gpt-4o", "gpt-4o-mini"],
  "capabilities": {
    "tts": {
      "endpoint": "https://api.openai.com/v1/audio/speech",
      "model_map": ["tts-1", "tts-1-hd", "gpt-4o-mini-tts"],
      "config": {
        "voices": ["alloy", "echo", "nova", "shimmer"],
        "default_voice": "alloy",
        "formats": ["mp3", "opus", "aac", "flac", "wav"],
        "supports_streaming": true
      }
    }
  }
}
```

Each capability has its own `endpoint` and `model_map`, while sharing the plugin's auth configuration. Supported capability keys: `completion`, `tts`, `stt`, `embedding`, `image`.

## Credentials

API keys are resolved in the following priority order:

1. **Per-user database key** — Set via the UI in Settings → Plugins, encrypted with AES-256-GCM
2. **Environment variable** — The `key_env` value from the plugin's auth config (e.g., `OPENAI_API_KEY`)
3. **No auth** — For local servers (e.g., Ollama, local ComfyUI) that don't require authentication

Per-user keys take precedence over environment variables, allowing multi-user deployments where each user brings their own API key.

## Security

- **Credential encryption** — API keys and sensitive variables are encrypted at rest using AES-256-GCM
- **SSRF prevention** — Plugin endpoints are validated (HTTPS required for remote URLs, HTTP allowed only for localhost and private IPs)
- **Path traversal protection** — Plugin IDs are sanitized, file paths are resolved and boundary-checked
- **Model name sanitization** — Model parameters are validated with regex patterns (no `..`, `//`, or path separators)
- **Rate limiting** — Plugin management endpoints: 100 requests/15 min per IP; upload endpoints: 10 requests/15 min per IP

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
