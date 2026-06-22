---
sidebar_position: 28
title: 'Kyutai TTS Integration'
description: 'Run Kyutai TTS locally for high-quality text-to-speech with voice cloning'
slug: /KYUTAI_TTS
keywords:
  [
    kyutai-tts,
    tts,
    text-to-speech,
    local tts,
    voice synthesis,
    voice cloning,
    pocket-tts,
  ]
---

# Kyutai TTS Integration

Run Kyutai's TTS models locally for high-quality text-to-speech. This guide covers both Pocket TTS (CPU) and TTS 1.6B (GPU) with OpenAI-compatible servers included in Libre WebUI.

## Overview

Kyutai offers two TTS models:

| Model          | Parameters | Device      | Best For                           |
| -------------- | ---------- | ----------- | ---------------------------------- |
| **Pocket TTS** | 100M       | CPU only    | Laptops, low-resource environments |
| **TTS 1.6B**   | 1.6B       | GPU/MPS/CPU | Servers, high-quality synthesis    |

Both use the CALM (Continuous Audio Language Models) framework and support voice cloning from audio samples.

## Pocket TTS (CPU)

Lightweight TTS that runs in real-time on CPU. No GPU required.

### Requirements

| Component   | Minimum     |
| ----------- | ----------- |
| **Python**  | 3.10 - 3.14 |
| **PyTorch** | 2.5+        |
| **RAM**     | 4GB         |
| **Disk**    | 500MB       |

### Quick Start

```bash
cd examples/kyutai-tts-server

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start server
python server.py
```

Server runs at `http://localhost:8200`.

### Test It

```bash
curl http://localhost:8200/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kyutai-tts", "input": "Hello, welcome to Libre WebUI!", "voice": "alba"}' \
  --output speech.wav
```

### Voices

| Voice       | Description               |
| ----------- | ------------------------- |
| **Alba**    | Female, clear and natural |
| **Marius**  | Male, warm tone           |
| **Javert**  | Male, authoritative       |
| **Jean**    | Male, gentle              |
| **Fantine** | Female, soft              |
| **Cosette** | Female, young             |
| **Eponine** | Female, expressive        |
| **Azelma**  | Female, bright            |

### Performance

- ~6x real-time on MacBook Air M4
- ~200ms latency for first audio chunk
- Uses only 2 CPU cores

---

## TTS 1.6B (GPU)

High-quality TTS with GPU acceleration. Automatic device selection: CUDA > MPS > CPU.

### Requirements

| Component    | Minimum | Recommended |
| ------------ | ------- | ----------- |
| **Python**   | 3.10+   | 3.12        |
| **GPU VRAM** | 6GB     | 8GB+        |
| **RAM**      | 8GB     | 16GB+       |
| **Disk**     | 4GB     | 8GB         |

### Platform Support

| Platform          | Backend | Notes                              |
| ----------------- | ------- | ---------------------------------- |
| **NVIDIA GPU**    | CUDA    | Best performance, bfloat16 support |
| **Apple Silicon** | MPS     | Uses float16                       |
| **CPU**           | PyTorch | Slower, float32                    |

### Quick Start

```bash
cd examples/kyutai-tts-1.6b-server

# Create virtual environment
python3 -m venv venv
source venv/bin/activate

# Install PyTorch with CUDA (for NVIDIA GPUs)
pip install torch --index-url https://download.pytorch.org/whl/cu121

# Install dependencies
pip install -r requirements.txt

# Start server (auto-detects GPU)
python server.py
```

Server runs at `http://localhost:8201`.

### Device Selection

```bash
# Auto-detect (CUDA > MPS > CPU)
python server.py

# Force specific device
python server.py --device cuda
python server.py --device mps
python server.py --device cpu
```

### Test It

```bash
curl http://localhost:8201/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kyutai-tts-1.6b", "input": "Hello from the GPU!", "voice": "alba"}' \
  --output speech.wav
```

### Voices

**Alba MacKenna (CC BY 4.0):**
| Voice | Style |
|-------|-------|
| `alba` / `alba-casual` | Casual conversation |
| `alba-merchant` | Merchant character |
| `alba-announcer` | Announcer style |

**Expresso (CC BY-NC 4.0 - non-commercial):**
| Voice | Emotion |
|-------|---------|
| `expresso-happy` | Happy |
| `expresso-sad` | Sad |
| `expresso-angry` | Angry |

**VCTK (CC BY 4.0):**

- `vctk-p225`, `vctk-p226`, `vctk-p227`, `vctk-p228`

---

## Voice Cloning

Both servers support cloning voices from audio files.

### Pocket TTS

```bash
# From local file
curl http://localhost:8200/v1/audio/voice-clone \
  -F "input=Hello from a cloned voice" \
  -F "reference_audio=@my_voice.wav" \
  --output cloned.wav

# From HuggingFace URL
curl http://localhost:8200/v1/audio/voice-clone-url \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello world!",
    "voice_url": "hf://kyutai/tts-voices/alba-mackenna/casual.wav"
  }' \
  --output speech.wav
```

### TTS 1.6B

Pass any HuggingFace voice path as the `voice` parameter:

```bash
curl http://localhost:8201/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{
    "model": "kyutai-tts-1.6b",
    "input": "Custom voice synthesis",
    "voice": "hf://kyutai/tts-voices/vctk/p230.wav"
  }' \
  --output speech.wav
```

---

## API Reference

### Speech Generation

**Endpoint:** `POST /v1/audio/speech`

```json
{
  "model": "kyutai-tts",
  "input": "Text to convert to speech",
  "voice": "alba",
  "response_format": "wav",
  "stream": false
}
```

| Parameter         | Type    | Default  | Description                           |
| ----------------- | ------- | -------- | ------------------------------------- |
| `model`           | string  | varies   | `kyutai-tts` or `kyutai-tts-1.6b`     |
| `input`           | string  | required | Text to synthesize (max 10,000 chars) |
| `voice`           | string  | `alba`   | Voice name or HuggingFace path        |
| `response_format` | string  | `wav`    | Audio format (only `wav` supported)   |
| `stream`          | boolean | `false`  | Enable streaming (Pocket TTS only)    |
| `cfg_coef`        | float   | `2.0`    | Classifier-free guidance (1.6B only)  |

**Response:** Audio file (`audio/wav`)

### OpenAI Voice Aliases

For compatibility with OpenAI TTS clients:

| OpenAI Voice | Pocket TTS | TTS 1.6B       |
| ------------ | ---------- | -------------- |
| `alloy`      | alba       | alba           |
| `echo`       | marius     | vctk-p225      |
| `fable`      | cosette    | expresso-happy |
| `onyx`       | javert     | vctk-p226      |
| `nova`       | fantine    | alba-announcer |
| `shimmer`    | eponine    | alba-merchant  |

### List Voices

**Endpoint:** `GET /v1/voices`

### Health Check

**Endpoint:** `GET /health`

---

## Plugin Configuration

### Pocket TTS

Enable in **Settings > Plugins > Kyutai TTS**

Plugin file: `plugins/kyutai-tts.json`

```json
{
  "id": "kyutai-tts",
  "name": "Kyutai TTS",
  "type": "tts",
  "endpoint": "http://localhost:8200/v1/audio/speech",
  "capabilities": {
    "tts": {
      "config": {
        "voices": [
          "Alba",
          "Marius",
          "Javert",
          "Jean",
          "Fantine",
          "Cosette",
          "Eponine",
          "Azelma"
        ],
        "default_voice": "Alba",
        "supports_streaming": true,
        "no_auth_required": true
      }
    }
  }
}
```

### TTS 1.6B

Enable in **Settings > Plugins > Kyutai TTS 1.6B**

Plugin file: `plugins/kyutai-tts-1.6b.json`

```json
{
  "id": "kyutai-tts-1.6b",
  "name": "Kyutai TTS 1.6B",
  "type": "tts",
  "endpoint": "http://localhost:8201/v1/audio/speech",
  "capabilities": {
    "tts": {
      "config": {
        "voices": [
          "Alba",
          "Alba-Casual",
          "Alba-Merchant",
          "Alba-Announcer",
          "Expresso-Happy",
          "Expresso-Sad",
          "Expresso-Angry",
          "VCTK-P225",
          "VCTK-P226"
        ],
        "default_voice": "Alba",
        "supports_streaming": true,
        "no_auth_required": true
      }
    }
  }
}
```

---

## Network Access

To access from other machines:

```bash
# Start server on all interfaces
python server.py --host 0.0.0.0

# Access from another machine
curl http://192.168.1.100:8200/v1/audio/speech ...
```

Update the plugin endpoint accordingly:

```json
{
  "endpoint": "http://192.168.1.100:8200/v1/audio/speech"
}
```

---

## Troubleshooting

### Model Download Fails

Models download from HuggingFace on first run:

```bash
# Set token for gated models
export HF_TOKEN=hf_...
```

### CUDA Out of Memory

For TTS 1.6B on limited VRAM:

1. Close other GPU applications
2. Try `cfg_coef=1.5` for lower memory usage
3. Use Pocket TTS instead (CPU-based)

### Audio Quality Issues

- **Robotic sound:** Try a different voice
- **Cut off audio:** Text may be too long, server chunks automatically
- **Wrong pronunciation:** Model is optimized for English and French

### MPS (Apple Silicon) Issues

```
RuntimeError: MPS backend error
```

The 1.6B model uses float16 on MPS. If issues persist, force CPU:

```bash
python server.py --device cpu
```

---

## Comparison with Qwen3-TTS

| Feature       | Kyutai Pocket | Kyutai 1.6B | Qwen3-TTS    |
| ------------- | ------------- | ----------- | ------------ |
| Parameters    | 100M          | 1.6B        | 0.6B-1.7B    |
| GPU Required  | No            | Optional    | Yes          |
| Languages     | English       | EN/FR       | 10 languages |
| Voice Cloning | Yes           | Yes         | Yes          |
| Voice Design  | No            | No          | Yes          |
| Port          | 8200          | 8201        | 8100         |

Choose Kyutai for English-focused use cases with simpler setup. Choose Qwen3-TTS for multilingual support and voice design features.

---

## Resources

- [Kyutai TTS](https://kyutai.org/tts) - Official project page
- [Pocket TTS GitHub](https://github.com/kyutai-labs/pocket-tts) - CPU model
- [Delayed Streams Modeling](https://github.com/kyutai-labs/delayed-streams-modeling) - 1.6B model
- [Voice Collection](https://huggingface.co/kyutai/tts-voices) - Available voices
- [Model Card](https://huggingface.co/kyutai/tts-1.6b-en_fr) - Technical details
