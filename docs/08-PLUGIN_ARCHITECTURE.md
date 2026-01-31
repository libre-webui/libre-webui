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

| Provider | Models | API Key Variable | Notes |
|----------|--------|------------------|-------|
| **OpenAI** | GPT-4o, GPT-4, o1, o3, o4 (110+ models) | `OPENAI_API_KEY` | Also provides TTS |
| **Anthropic** | Claude Opus 4.5, Claude 4 Sonnet/Opus | `ANTHROPIC_API_KEY` | Best for reasoning |
| **Google Gemini** | Gemini 2.0/2.5 Flash/Pro (55+ models) | `GEMINI_API_KEY` | Includes Imagen |
| **Groq** | Llama 3.1, Gemma, Qwen3 | `GROQ_API_KEY` | Fastest inference |
| **Mistral** | Large, Medium, Codestral (71+ models) | `MISTRAL_API_KEY` | EU-based |
| **OpenRouter** | 300+ models from all providers | `OPENROUTER_API_KEY` | Pay-per-token |

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

### Usage

1. Click the speaker icon on any message to hear it spoken
2. Configure voice and model in Settings → Text-to-Speech
3. Select between OpenAI TTS or ElevenLabs as your provider

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
