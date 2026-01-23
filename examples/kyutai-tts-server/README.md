# Kyutai TTS Integration for Libre WebUI

OpenAI-compatible API server for Kyutai Pocket TTS.

## Features

- CPU-based (no GPU required, but GPU works too)
- 8 built-in voices
- Voice cloning from audio files or HuggingFace URLs
- Streaming audio generation
- ~6x real-time on MacBook Air M4

## Requirements

- Python 3.10, 3.11, 3.12, 3.13, or 3.14
- PyTorch 2.5+

## Setup

```bash
# Create venv
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run server
python server.py
```

Or with uv:

```bash
uv run server.py
```

## Usage

Server runs at `http://localhost:8200`

```bash
curl http://localhost:8200/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kyutai-tts", "input": "Hello world!", "voice": "alba"}' \
  --output speech.wav
```

## Voices

**Built-in voices:** Alba, Marius, Javert, Jean, Fantine, Cosette, Eponine, Azelma

**OpenAI aliases:** alloy, echo, fable, onyx, nova, shimmer (mapped to Kyutai voices)

## Voice Cloning

Clone any voice from a WAV file:

```bash
curl http://localhost:8200/v1/audio/voice-clone \
  -F "input=Hello from a cloned voice" \
  -F "reference_audio=@my_voice.wav" \
  --output cloned.wav
```

Or use a HuggingFace voice:

```bash
curl http://localhost:8200/v1/audio/voice-clone-url \
  -H "Content-Type: application/json" \
  -d '{
    "input": "Hello world!",
    "voice_url": "hf://kyutai/tts-voices/alba-mackenna/casual.wav"
  }' \
  --output speech.wav
```

## Resources

- [Kyutai TTS](https://kyutai.org/tts)
- [Pocket TTS GitHub](https://github.com/kyutai-labs/pocket-tts)
- [Voice Collection](https://huggingface.co/kyutai/tts-voices)
