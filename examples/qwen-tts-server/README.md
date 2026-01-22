# Qwen3-TTS Integration for Libre WebUI

OpenAI-compatible API server for Qwen3-TTS.

## Requirements

- Python 3.12 (not 3.14)
- GPU: NVIDIA CUDA, Apple Silicon MPS, or CPU (slower)

## Setup

```bash
# Install Python 3.12 on macOS
brew install python@3.12

# Create venv
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run server (use 0.6b model on Mac for less memory)
python server.py --model customvoice-0.6b
```

## Usage

Server runs at `http://localhost:8100`

```bash
curl http://localhost:8100/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"model": "qwen3-tts", "input": "Hello!", "voice": "Ryan"}' \
  --output speech.wav
```

## Voices

**English:** Ryan, Aiden
**Chinese:** Vivian, Serena, Uncle_Fu, Dylan, Eric
**Japanese:** Ono_Anna
**Korean:** Sohee

## Platform Notes

- **NVIDIA GPU**: Best performance with CUDA
- **Apple Silicon**: Uses MPS backend, use 0.6b models for memory
- **CPU**: Works but slow, use 0.6b models
