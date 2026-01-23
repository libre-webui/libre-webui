#!/usr/bin/env python3
"""
Kyutai TTS 1.6B OpenAI-Compatible API Server

This server provides an OpenAI-compatible TTS endpoint for Kyutai TTS 1.6B.
Optimized for GPU > MPS > CPU with proper device selection.

Requirements:
    pip install moshi fastapi uvicorn python-multipart

Usage:
    python server.py [--host 0.0.0.0] [--port 8201] [--device cuda]

Features:
    - GPU-accelerated (CUDA, MPS) with CPU fallback
    - 1.6B parameter model for high quality
    - Streaming text-to-speech
    - Multiple voice support via HuggingFace embeddings
"""

import argparse
import asyncio
import io
import os
import re
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# Kyutai TTS imports
try:
    from moshi.models.loaders import CheckpointInfo
    from moshi.models.tts import DEFAULT_DSM_TTS_REPO, DEFAULT_DSM_TTS_VOICE_REPO, TTSModel
except ImportError:
    print("Error: moshi package not installed. Install with: pip install moshi")
    exit(1)

app = FastAPI(
    title="Kyutai TTS 1.6B OpenAI-Compatible API",
    description="OpenAI-compatible TTS API powered by Kyutai TTS 1.6B",
    version="1.0.0",
)

# CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global model instance
model: Optional[TTSModel] = None
current_device: str = "cpu"

# Voice prefix cache
voice_prefixes: dict = {}

# Available voices from kyutai/tts-voices
# These are paths relative to the voice repository
AVAILABLE_VOICES = {
    # Alba MacKenna voice collection (CC BY 4.0)
    "alba": "alba-mackenna/casual.wav",
    "alba-casual": "alba-mackenna/casual.wav",
    "alba-merchant": "alba-mackenna/merchant.wav",
    "alba-announcer": "alba-mackenna/announcer.wav",
    # Expresso dataset voices (CC BY-NC 4.0 - non-commercial)
    "expresso-happy": "expresso/ex03-ex01_happy_001_channel1_334s.wav",
    "expresso-sad": "expresso/ex03-ex01_sad_001_channel1_262s.wav",
    "expresso-angry": "expresso/ex03-ex01_angry_001_channel1_165s.wav",
    # VCTK voices (CC BY 4.0)
    "vctk-p225": "vctk/p225.wav",
    "vctk-p226": "vctk/p226.wav",
    "vctk-p227": "vctk/p227.wav",
    "vctk-p228": "vctk/p228.wav",
    # Voice donations (CC0)
    "donation-1": "voice-donations/voice_donation_1.wav",
}

# Map OpenAI-style voice names to Kyutai voices
VOICE_ALIASES = {
    "alloy": "alba",
    "echo": "vctk-p225",
    "fable": "expresso-happy",
    "onyx": "vctk-p226",
    "nova": "alba-announcer",
    "shimmer": "alba-merchant",
}


class TTSRequest(BaseModel):
    """OpenAI TTS API compatible request"""
    model: str = "kyutai-tts-1.6b"
    input: str
    voice: str = "alba"
    response_format: str = "wav"
    speed: float = 1.0
    # Kyutai TTS specific
    cfg_coef: float = 2.0  # Classifier-free guidance coefficient


def get_device():
    """Get the best available device (CUDA > MPS > CPU)"""
    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_available():
        return "mps"
    else:
        return "cpu"


def load_model(device: Optional[str] = None):
    """Load Kyutai TTS 1.6B model"""
    global model, current_device

    if device is None:
        device = get_device()

    current_device = device
    torch_device = torch.device(device)

    print(f"Loading Kyutai TTS 1.6B model on {device}...")

    # Select dtype based on device
    if device == "cuda":
        dtype = torch.bfloat16
    elif device == "mps":
        dtype = torch.float16  # MPS doesn't support bfloat16
    else:
        dtype = torch.float32

    try:
        checkpoint_info = CheckpointInfo.from_hf_repo(DEFAULT_DSM_TTS_REPO)
        model = TTSModel.from_checkpoint_info(
            checkpoint_info,
            n_q=32,  # Full quality
            temp=0.6,
            device=torch_device,
            dtype=dtype,
        )
        print(f"Model loaded successfully on {device}")
        print(f"Sample rate: {model.mimi.sample_rate}Hz")
    except Exception as e:
        print(f"Error loading model: {e}")
        raise


def get_voice_prefix(voice: str):
    """Get or create voice prefix for a given voice identifier"""
    global voice_prefixes

    voice_lower = voice.lower()

    # Check aliases first
    if voice_lower in VOICE_ALIASES:
        voice_lower = VOICE_ALIASES[voice_lower]

    # Check cache
    if voice_lower in voice_prefixes:
        return voice_prefixes[voice_lower]

    # Get voice path
    if voice_lower in AVAILABLE_VOICES:
        voice_path = model.get_voice_path(AVAILABLE_VOICES[voice_lower])
    elif voice.startswith("hf://") or voice.endswith(".safetensors"):
        voice_path = voice if voice.endswith(".safetensors") else model.get_voice_path(voice)
    else:
        # Default to alba
        voice_path = model.get_voice_path(AVAILABLE_VOICES["alba"])

    # Get prefix from voice path
    prefix = model.get_prefix(voice_path)
    voice_prefixes[voice_lower] = prefix

    return prefix


def sanitize_text(text: str) -> str:
    """Sanitize text to prevent model issues"""
    # Remove emojis
    emoji_pattern = re.compile(
        "["
        "\U0001F600-\U0001F64F"
        "\U0001F300-\U0001F5FF"
        "\U0001F680-\U0001F6FF"
        "\U0001F1E0-\U0001F1FF"
        "\U00002702-\U000027B0"
        "\U000024C2-\U0001F251"
        "\U0001F900-\U0001F9FF"
        "\U0001FA00-\U0001FA6F"
        "\U0001FA70-\U0001FAFF"
        "\U00002600-\U000026FF"
        "\U00002700-\U000027BF"
        "]+",
        flags=re.UNICODE
    )
    text = emoji_pattern.sub('', text)

    # Remove markdown formatting
    text = re.sub(r'\*+', '', text)
    text = re.sub(r'_+', ' ', text)
    text = re.sub(r'~+', '', text)
    text = re.sub(r'`+', '', text)
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^-{3,}$', '', text, flags=re.MULTILINE)
    text = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', text)

    # Remove parenthetical stage directions
    text = re.sub(r'\*?\([^)]*\)\*?', '', text)

    # Remove zero-width characters
    text = re.sub(r'[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]', '', text)

    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def audio_to_bytes(pcm_list: list, sample_rate: int) -> bytes:
    """Convert list of PCM tensors to WAV bytes"""
    import scipy.io.wavfile as wavfile
    import numpy as np

    if not pcm_list:
        raise ValueError("Empty audio list")

    # Concatenate all PCM chunks
    combined = torch.cat(pcm_list, dim=-1)

    # Remove batch and channel dims if present
    if combined.dim() == 3:
        combined = combined.squeeze(0).squeeze(0)
    elif combined.dim() == 2:
        combined = combined.squeeze(0)

    # Move to CPU and convert to numpy
    audio_np = combined.cpu().numpy()

    # Clip and convert to int16
    audio_np = np.clip(audio_np, -1.0, 1.0)
    audio_int16 = (audio_np * 32767).astype(np.int16)

    buffer = io.BytesIO()
    wavfile.write(buffer, sample_rate, audio_int16)
    buffer.seek(0)
    return buffer.read()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "ok",
        "model": "kyutai-tts-1.6b",
        "device": current_device,
        "sample_rate": model.mimi.sample_rate if model else None,
    }


@app.get("/health")
async def health():
    """Health check"""
    return {"status": "healthy", "model_loaded": model is not None, "device": current_device}


@app.get("/v1/models")
async def list_models():
    """List available models (OpenAI-compatible)"""
    return {
        "object": "list",
        "data": [
            {"id": "kyutai-tts-1.6b", "object": "model", "owned_by": "kyutai"},
            {"id": "tts-1-hd", "object": "model", "owned_by": "kyutai"},  # OpenAI alias
        ]
    }


@app.get("/v1/voices")
async def list_voices():
    """List available voices"""
    voices = []
    for key in AVAILABLE_VOICES.keys():
        voices.append({
            "id": key,
            "path": AVAILABLE_VOICES[key],
        })
    return {"voices": voices}


@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    """OpenAI-compatible TTS endpoint"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Sanitize input text
    clean_text = sanitize_text(request.input)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Input text is empty after sanitization")

    # Get voice prefix
    try:
        prefix = get_voice_prefix(request.voice)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Voice not found: {request.voice} - {e}")

    async def generate_audio():
        """Generate audio in executor"""
        loop = asyncio.get_event_loop()

        def _generate():
            # Prepare the script
            entries = model.prepare_script([clean_text], padding_between=1)

            # Prepare condition attributes with CFG
            cond_attrs = model.get_cond_attrs(prefix, cfg_coef=request.cfg_coef)

            # Generate frames and decode
            pcms = []

            def on_frame(frame):
                # Decode frame if valid
                if (frame[:, 1:] != -1).all():
                    pcm = model.mimi.decode(frame[:, 1:, :])
                    pcms.append(pcm.clip(-1, 1))

            # Run generation
            model.generate(entries, cond_attrs, on_frame=on_frame)

            return pcms

        return await loop.run_in_executor(None, _generate)

    try:
        pcms = await asyncio.wait_for(generate_audio(), timeout=120.0)

        if not pcms:
            raise HTTPException(status_code=500, detail="No audio generated")

        audio_bytes = audio_to_bytes(pcms, model.mimi.sample_rate)
        return Response(content=audio_bytes, media_type="audio/wav")

    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="Generation timed out")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Kyutai TTS 1.6B OpenAI-Compatible API Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8201, help="Port to bind to")
    parser.add_argument(
        "--device",
        default=None,
        choices=["cuda", "mps", "cpu"],
        help="Device to use (default: auto-detect GPU > MPS > CPU)"
    )
    args = parser.parse_args()

    load_model(args.device)

    print(f"\nKyutai TTS 1.6B Server running at http://{args.host}:{args.port}")
    print(f"OpenAI-compatible endpoint: http://{args.host}:{args.port}/v1/audio/speech")
    print(f"Device: {current_device}")
    print(f"Available voices: {', '.join(AVAILABLE_VOICES.keys())}\n")

    uvicorn.run(app, host=args.host, port=args.port)
