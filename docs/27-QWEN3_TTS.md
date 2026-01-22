---
sidebar_position: 27
title: "Qwen3-TTS Integration"
description: "Run Qwen3-TTS locally for high-quality, multilingual text-to-speech"
slug: /QWEN3_TTS
keywords: [qwen3-tts, tts, text-to-speech, local tts, voice synthesis, voice cloning, alibaba qwen]
---

# Qwen3-TTS Integration

Run Alibaba's Qwen3-TTS locally for high-quality, multilingual text-to-speech. This guide covers setting up the OpenAI-compatible TTS server included with Libre WebUI.

## Overview

Qwen3-TTS is an advanced text-to-speech system featuring:

- **9 pre-built voices** spanning English, Chinese, Japanese, and Korean
- **10 language support** including German, French, Spanish, Italian, Portuguese, and Russian
- **Voice cloning** from 3-second audio samples
- **Voice design** using natural language descriptions
- **Instruction control** for emotion and prosody

The included server wraps Qwen3-TTS in an OpenAI-compatible API, allowing Libre WebUI to use it through the standard plugin system.

## Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| **Python** | 3.12+ | 3.12 (not 3.14) |
| **GPU VRAM** | 4GB (0.6B models) | 8GB+ (1.7B models) |
| **RAM** | 8GB | 16GB+ |
| **Disk** | 5GB | 10GB |

### Platform Support

| Platform | Backend | Notes |
|----------|---------|-------|
| **NVIDIA GPU** | CUDA | Best performance, bfloat16 support |
| **Apple Silicon** | MPS | Use 0.6B models for memory efficiency |
| **CPU** | PyTorch | Slower, use 0.6B models |

:::tip Apple Silicon Users
Use the `customvoice-0.6b` model variant on Mac to avoid memory pressure. The 1.7B models may cause system instability on machines with 16GB unified memory.
:::

## Quick Start

### 1. Install the Server

```bash
cd examples/qwen-tts-server

# Create virtual environment (Python 3.12 required)
python3.12 -m venv venv
source venv/bin/activate  # Linux/macOS
# or: venv\Scripts\activate  # Windows

# Install dependencies
pip install -r requirements.txt
```

### 2. Start the Server

```bash
# NVIDIA GPU (recommended)
python server.py --model customvoice-1.7b

# Apple Silicon
python server.py --model customvoice-0.6b

# CPU (slower)
python server.py --model customvoice-0.6b
```

The server runs at `http://localhost:8100` by default.

### 3. Configure Libre WebUI

The plugin is pre-configured in `plugins/qwen-tts.json`. Enable it in **Settings → Plugins → Qwen3 TTS**.

### 4. Test It

```bash
curl http://localhost:8100/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-tts", "input": "Hello, welcome to Libre WebUI!", "voice": "Ryan"}' \
  --output speech.wav
```

## Available Models

| Model | Size | Use Case |
|-------|------|----------|
| `customvoice-1.7b` | ~3.5GB | Pre-built voices with instruction control |
| `customvoice-0.6b` | ~1.5GB | Lightweight variant for limited VRAM |
| `voicedesign-1.7b` | ~3.5GB | Create voices from text descriptions |
| `base-1.7b` | ~3.5GB | Voice cloning from 3-second samples |
| `base-0.6b` | ~1.5GB | Lightweight voice cloning |

## Voices

### Pre-Built Voices (CustomVoice Models)

| Voice | Language | Description |
|-------|----------|-------------|
| **Ryan** | English | Male, clear and natural |
| **Aiden** | English | Male, warm tone |
| **Vivian** | Chinese | Female, professional |
| **Serena** | Chinese | Female, friendly |
| **Uncle_Fu** | Chinese | Male, mature |
| **Dylan** | Chinese | Male, Beijing dialect |
| **Eric** | Chinese | Male, Sichuan dialect |
| **Ono_Anna** | Japanese | Female |
| **Sohee** | Korean | Female |

### OpenAI Voice Aliases

For compatibility with OpenAI TTS clients, the server maps OpenAI voice names:

| OpenAI Voice | Maps To |
|--------------|---------|
| `alloy` | Ryan |
| `echo` | Aiden |
| `fable` | Vivian |
| `onyx` | Uncle_Fu |
| `nova` | Serena |
| `shimmer` | Ono_Anna |

## API Reference

### Speech Generation

**Endpoint:** `POST /v1/audio/speech`

```json
{
  "model": "qwen3-tts",
  "input": "Text to convert to speech",
  "voice": "Ryan",
  "response_format": "wav",
  "instruct": "Speak with enthusiasm",
  "language": "English"
}
```

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `model` | string | `qwen3-tts` | Model identifier |
| `input` | string | required | Text to synthesize (max 10,000 chars) |
| `voice` | string | `ryan` | Voice name (see table above) |
| `response_format` | string | `wav` | Audio format (only `wav` supported) |
| `instruct` | string | `""` | Emotion/prosody instruction |
| `language` | string | auto-detect | Override language detection |

**Response:** Audio file (`audio/wav`)

### Voice Design

**Endpoint:** `POST /v1/audio/voice-design`

Create custom voices from natural language descriptions.

```json
{
  "model": "qwen3-tts-voicedesign",
  "input": "Welcome to our service.",
  "voice_description": "A warm, friendly female voice with a slight British accent",
  "language": "English"
}
```

:::note
Requires the `voicedesign-1.7b` model to be loaded.
:::

### Voice Cloning

**Endpoint:** `POST /v1/audio/voice-clone`

Clone a voice from a 3+ second audio sample.

```bash
curl -X POST http://localhost:8100/v1/audio/voice-clone \
  -F "input=Hello, this is my cloned voice." \
  -F "reference_audio=@reference.wav" \
  -F "reference_text=This is what was said in the reference." \
  --output cloned.wav
```

| Parameter | Type | Description |
|-----------|------|-------------|
| `input` | string | Text to synthesize |
| `reference_audio` | file | 3+ second audio sample |
| `reference_text` | string | Transcript of reference audio |

:::note
Requires the `base-1.7b` or `base-0.6b` model to be loaded.
:::

### List Voices

**Endpoint:** `GET /v1/voices`

```json
{
  "voices": [
    {"id": "ryan", "name": "Ryan", "language": "English"},
    {"id": "aiden", "name": "Aiden", "language": "English"},
    ...
  ]
}
```

### Health Check

**Endpoint:** `GET /health`

```json
{"status": "healthy", "model_loaded": true}
```

## Server Configuration

```bash
python server.py [OPTIONS]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--host` | `0.0.0.0` | Host to bind to |
| `--port` | `8100` | Port to bind to |
| `--model` | `customvoice-1.7b` | Model variant to load |

### Network Access

To access the server from other machines on your network:

```bash
# Start server on all interfaces
python server.py --host 0.0.0.0 --port 8100

# Access from another machine
curl http://192.168.1.100:8100/v1/audio/speech ...
```

Update the plugin endpoint in `plugins/qwen-tts.json`:

```json
{
  "endpoint": "http://192.168.1.100:8100/v1/audio/speech",
  "capabilities": {
    "tts": {
      "endpoint": "http://192.168.1.100:8100/v1/audio/speech"
    }
  }
}
```

## Production Features

### Text Sanitization

The server automatically sanitizes input text to prevent model hangs:

- Removes emojis and symbols
- Strips markdown formatting (`*bold*`, `_italic_`, etc.)
- Collapses repeated characters (`FUUUUU` → `FUU`)
- Removes stage directions (`*(action)*`, `(whispers)`)
- Normalizes whitespace

### Text Chunking

Long text is automatically split at sentence boundaries:

- Maximum 500 characters per chunk
- 30-second timeout per chunk
- Failed chunks are skipped, remaining chunks continue
- Chunks are concatenated into single audio response

This prevents timeouts on long AI responses while maintaining natural speech flow.

## Multi-GPU Setup

For systems with multiple GPUs, the server forces single-GPU execution to avoid tensor device mismatches:

```python
device_map = {"": "cuda:0"}  # Uses first GPU only
```

To use a specific GPU:

```bash
CUDA_VISIBLE_DEVICES=1 python server.py --model customvoice-1.7b
```

## Troubleshooting

### Model Download Fails

The model downloads from Hugging Face on first run. If it fails:

```bash
# Set Hugging Face token for gated models
export HF_TOKEN=hf_...

# Or download manually
huggingface-cli download Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice
```

### Out of Memory (Apple Silicon)

```
RuntimeError: MPS backend out of memory
```

Use the smaller model variant:

```bash
python server.py --model customvoice-0.6b
```

### CUDA Out of Memory

```
torch.cuda.OutOfMemoryError: CUDA out of memory
```

1. Close other GPU applications
2. Use the 0.6B model variant
3. Reduce chunk size in server.py (`max_chunk_size=300`)

### Server Times Out

If generation times out on long text:

1. The server automatically chunks text and continues with remaining chunks
2. Check server logs for which chunks timed out
3. Consider shortening your input text

### Audio Sounds Wrong

- **Repeated syllables:** Usually caused by emojis or special characters. The sanitizer should handle this automatically.
- **Wrong language:** Set the `language` parameter explicitly in the request.
- **Unnatural pauses:** Text may be splitting at wrong boundaries. Check for unusual punctuation.

## Plugin Configuration

The included plugin (`plugins/qwen-tts.json`):

```json
{
  "id": "qwen-tts",
  "name": "Qwen3 TTS",
  "type": "tts",
  "endpoint": "http://localhost:8100/v1/audio/speech",
  "auth": {
    "header": "",
    "key_env": ""
  },
  "model_map": [
    "qwen3-tts",
    "qwen3-tts-customvoice",
    "qwen3-tts-voicedesign",
    "qwen3-tts-clone"
  ],
  "capabilities": {
    "tts": {
      "endpoint": "http://localhost:8100/v1/audio/speech",
      "model_map": [
        "qwen3-tts",
        "qwen3-tts-customvoice",
        "qwen3-tts-voicedesign",
        "qwen3-tts-clone"
      ],
      "config": {
        "voices": ["Ryan", "Aiden", "Vivian", "Serena", "Uncle_Fu", "Dylan", "Eric", "Ono_Anna", "Sohee"],
        "default_voice": "Ryan",
        "formats": ["wav"],
        "default_format": "wav",
        "max_characters": 10000,
        "supports_streaming": false,
        "no_auth_required": true
      }
    }
  },
  "description": "Qwen3-TTS local TTS server (NVIDIA CUDA, Apple MPS, or CPU)",
  "documentation_url": "https://github.com/QwenLM/Qwen3-TTS"
}
```

## Resources

- [Qwen3-TTS GitHub](https://github.com/QwenLM/Qwen3-TTS) - Official repository
- [Qwen3-TTS Demo](https://huggingface.co/spaces/Qwen/Qwen3-TTS-Demo) - Try it online
- [Alibaba Cloud TTS Docs](https://www.alibabacloud.com/help/en/model-studio/qwen-tts) - Cloud API documentation
