# Kyutai TTS 1.6B Integration for Libre WebUI

OpenAI-compatible API server for Kyutai TTS 1.6B with GPU acceleration.

## Features

- GPU-accelerated (CUDA > MPS > CPU automatic fallback)
- 1.6B parameter model for high-quality synthesis
- Multiple voices via HuggingFace embeddings
- Streaming text-to-speech

## Requirements

- Python 3.10+
- PyTorch 2.1+ with CUDA (recommended) or MPS
- ~8GB VRAM for full model

## Setup

```bash
# Create venv
python3 -m venv venv
source venv/bin/activate

# Install dependencies (with CUDA for GPU)
pip install torch --index-url https://download.pytorch.org/whl/cu121
pip install -r requirements.txt

# Run server (auto-detects GPU)
python server.py
```

Or with explicit device:

```bash
python server.py --device cuda  # NVIDIA GPU
python server.py --device mps   # Apple Silicon
python server.py --device cpu   # CPU only
```

## Usage

Server runs at `http://localhost:8201`

```bash
curl http://localhost:8201/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "kyutai-tts-1.6b", "input": "Hello world!", "voice": "alba"}' \
  --output speech.wav
```

## Voices

**Alba MacKenna (CC BY 4.0):**
- `alba` / `alba-casual` - Casual voice
- `alba-merchant` - Merchant character
- `alba-announcer` - Announcer style

**Expresso (CC BY-NC 4.0 - non-commercial):**
- `expresso-happy` - Happy emotion
- `expresso-sad` - Sad emotion
- `expresso-angry` - Angry emotion

**VCTK (CC BY 4.0):**
- `vctk-p225`, `vctk-p226`, `vctk-p227`, `vctk-p228`

**OpenAI aliases:** alloy, echo, fable, onyx, nova, shimmer

## Comparison with Pocket TTS

| Feature | Pocket TTS | TTS 1.6B |
|---------|-----------|----------|
| Port | 8200 | 8201 |
| Parameters | 100M | 1.6B |
| Device | CPU only | GPU/MPS/CPU |
| VRAM | ~1GB | ~8GB |
| Quality | Good | Higher |
| Speed | 6x real-time (CPU) | Faster on GPU |

## Resources

- [Kyutai TTS](https://kyutai.org/tts)
- [Delayed Streams Modeling](https://github.com/kyutai-labs/delayed-streams-modeling)
- [Voice Collection](https://huggingface.co/kyutai/tts-voices)
- [Model Card](https://huggingface.co/kyutai/tts-1.6b-en_fr)
