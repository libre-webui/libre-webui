#!/usr/bin/env python3
"""
Kyutai TTS OpenAI-Compatible API Server

This server provides an OpenAI-compatible TTS endpoint for Kyutai Pocket TTS.
It allows Libre WebUI to use Kyutai TTS through the standard plugin system.

Requirements:
    pip install pocket-tts fastapi uvicorn python-multipart

Usage:
    python server.py [--host 0.0.0.0] [--port 8200]

Features:
    - CPU-based (no GPU required)
    - Voice cloning from audio files
    - Streaming audio generation
    - 8 built-in voices
"""

import argparse
import asyncio
import io
import os
import re
import tempfile
from typing import Optional
from urllib.parse import urlsplit

import torch
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel

# Kyutai TTS imports
try:
    from pocket_tts import TTSModel
except ImportError:
    print("Error: pocket-tts package not installed. Install with: pip install pocket-tts")
    exit(1)

app = FastAPI(
    title="Kyutai TTS OpenAI-Compatible API",
    description="OpenAI-compatible TTS API powered by Kyutai Pocket TTS",
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

# Voice states cache
voice_states: dict = {}

# Built-in voices from Kyutai
BUILTIN_VOICES = {
    "alba": {"name": "Alba", "description": "Female, clear and natural"},
    "marius": {"name": "Marius", "description": "Male, warm tone"},
    "javert": {"name": "Javert", "description": "Male, authoritative"},
    "jean": {"name": "Jean", "description": "Male, gentle"},
    "fantine": {"name": "Fantine", "description": "Female, soft"},
    "cosette": {"name": "Cosette", "description": "Female, young"},
    "eponine": {"name": "Eponine", "description": "Female, expressive"},
    "azelma": {"name": "Azelma", "description": "Female, bright"},
}

# Map OpenAI-style voice names to Kyutai voices
VOICE_ALIASES = {
    "alloy": "alba",
    "echo": "marius",
    "fable": "cosette",
    "onyx": "javert",
    "nova": "fantine",
    "shimmer": "eponine",
}

# Additional voices from HuggingFace kyutai/tts-voices
HUGGINGFACE_VOICE_PREFIXES = {
    "alba-mackenna": "hf://kyutai/tts-voices/alba-mackenna/{style}.wav",
    "vctk": "hf://kyutai/tts-voices/vctk/{speaker}.wav",
    "expresso": "hf://kyutai/tts-voices/expresso/{speaker}.wav",
}

# Explicit emoji blocks avoid the overly broad U+24C2-U+1F251 range that
# removes unrelated scripts and symbols.
EMOJI_CODEPOINT_RANGES = (
    (0x2600, 0x26FF),
    (0x2700, 0x27BF),
    (0x1F170, 0x1F251),
    (0x1F300, 0x1F5FF),
    (0x1F600, 0x1F64F),
    (0x1F680, 0x1F6FF),
    (0x1F900, 0x1F9FF),
    (0x1FA00, 0x1FA6F),
    (0x1FA70, 0x1FAFF),
)
EMOJI_CODEPOINTS = frozenset((0x20E3, 0x24C2, 0xFE0F))


class TTSRequest(BaseModel):
    """OpenAI TTS API compatible request"""
    model: str = "kyutai-tts"
    input: str
    voice: str = "alba"
    response_format: str = "wav"
    speed: float = 1.0
    # Kyutai TTS specific
    stream: bool = False


class VoiceCloneRequest(BaseModel):
    """Voice cloning request"""
    model: str = "kyutai-tts-clone"
    input: str
    voice_url: str  # HuggingFace or HTTP(S) URL
    response_format: str = "wav"


def is_remote_voice_reference(voice: str) -> bool:
    """Return whether a voice reference uses an approved remote URL scheme."""
    parsed = urlsplit(voice)
    return parsed.scheme in {"hf", "http", "https"} and bool(parsed.netloc)


def load_model():
    """Load Kyutai Pocket TTS model"""
    global model

    print("Loading Kyutai Pocket TTS model...")
    model = TTSModel.load_model()
    print(f"Model loaded successfully (sample rate: {model.sample_rate}Hz)")

    # Preload built-in voice states
    print("Preloading built-in voices...")
    for voice_key in BUILTIN_VOICES.keys():
        try:
            voice_states[voice_key] = model.get_state_for_audio_prompt(voice_key)
            print(f"  Loaded voice: {voice_key}")
        except Exception as e:
            print(f"  Warning: Could not load voice {voice_key}: {e}")

    print(f"Loaded {len(voice_states)} voices")


def get_voice_state(voice: str):
    """Get or create voice state for a given voice identifier"""
    global voice_states

    voice_lower = voice.lower()

    # Check aliases first
    if voice_lower in VOICE_ALIASES:
        voice_lower = VOICE_ALIASES[voice_lower]

    # Check cache
    if voice_lower in voice_states:
        return voice_states[voice_lower]

    # Check if it's a built-in voice we haven't loaded yet
    if voice_lower in BUILTIN_VOICES:
        voice_states[voice_lower] = model.get_state_for_audio_prompt(voice_lower)
        return voice_states[voice_lower]

    # Remote references are supported. Local paths are deliberately rejected;
    # callers can use the upload-based voice-clone endpoint instead.
    if is_remote_voice_reference(voice):
        voice_states[voice] = model.get_state_for_audio_prompt(voice)
        return voice_states[voice]

    # Default to alba
    return voice_states.get("alba")


def is_emoji_character(character: str) -> bool:
    """Return whether a character belongs to a known emoji codepoint block."""
    codepoint = ord(character)
    return codepoint in EMOJI_CODEPOINTS or any(
        start <= codepoint <= end for start, end in EMOJI_CODEPOINT_RANGES
    )


def strip_markdown_links(text: str) -> str:
    """Replace Markdown links with their labels in linear time."""
    parts = []
    cursor = 0

    while cursor < len(text):
        label_start = text.find("[", cursor)
        if label_start == -1:
            parts.append(text[cursor:])
            break

        parts.append(text[cursor:label_start])
        label_end = text.find("]", label_start + 1)
        if label_end == -1:
            parts.append(text[label_start:])
            break

        if label_end + 1 >= len(text) or text[label_end + 1] != "(":
            parts.append(text[label_start:label_end + 1])
            cursor = label_end + 1
            continue

        target_end = text.find(")", label_end + 2)
        if target_end == -1:
            parts.append(text[label_start:])
            break

        parts.append(text[label_start + 1 : label_end])
        cursor = target_end + 1

    return "".join(parts)


def strip_parenthetical_stage_directions(text: str) -> str:
    """Remove parenthetical stage directions without backtracking regexes."""
    parts = []
    cursor = 0

    while cursor < len(text):
        opening = text.find("(", cursor)
        if opening == -1:
            parts.append(text[cursor:])
            break

        closing = text.find(")", opening + 1)
        if closing == -1:
            parts.append(text[cursor:])
            break

        removal_start = opening
        if opening > cursor and text[opening - 1] == "*":
            removal_start -= 1

        parts.append(text[cursor:removal_start])
        cursor = closing + 1
        if cursor < len(text) and text[cursor] == "*":
            cursor += 1

    return "".join(parts)


def sanitize_text(text: str) -> str:
    """Sanitize text to prevent model issues"""
    text = "".join(
        character for character in text if not is_emoji_character(character)
    )

    # Remove markdown formatting
    text = text.replace("*", "")
    text = text.replace("_", " ")
    text = text.replace("~", "")
    text = text.replace("`", "")
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)
    text = re.sub(r'^-{3,}$', '', text, flags=re.MULTILINE)
    text = strip_markdown_links(text)

    # Remove parenthetical stage directions
    text = strip_parenthetical_stage_directions(text)

    # Remove zero-width characters
    text = re.sub(r'[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]', '', text)

    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    return text


def chunk_text(text: str, max_chunk_size: int = 500) -> list[str]:
    """Split text into speakable chunks at sentence boundaries"""
    sentences = re.split(r'(?<=[.!?])\s+', text)

    chunks = []
    current_chunk = ""

    for sentence in sentences:
        if len(current_chunk) + len(sentence) + 1 <= max_chunk_size:
            current_chunk = (current_chunk + " " + sentence).strip()
        else:
            if current_chunk:
                chunks.append(current_chunk)
            if len(sentence) > max_chunk_size:
                parts = re.split(r',\s*', sentence)
                sub_chunk = ""
                for part in parts:
                    if len(sub_chunk) + len(part) + 2 <= max_chunk_size:
                        sub_chunk = (sub_chunk + ", " + part).strip(", ")
                    else:
                        if sub_chunk:
                            chunks.append(sub_chunk)
                        while len(part) > max_chunk_size:
                            chunks.append(part[:max_chunk_size])
                            part = part[max_chunk_size:]
                        sub_chunk = part
                if sub_chunk:
                    chunks.append(sub_chunk)
                current_chunk = ""
            else:
                current_chunk = sentence

    if current_chunk:
        chunks.append(current_chunk)

    return chunks if chunks else [text[:max_chunk_size]]


def audio_to_bytes(audio_tensor: torch.Tensor, sample_rate: int) -> bytes:
    """Convert audio tensor to WAV bytes"""
    import scipy.io.wavfile as wavfile
    import numpy as np

    if audio_tensor.dim() == 2:
        audio_tensor = audio_tensor.squeeze(0)

    audio_np = audio_tensor.numpy()
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
        "model": "kyutai-pocket-tts",
        "sample_rate": model.sample_rate if model else None,
        "voices_loaded": len(voice_states),
    }


@app.get("/health")
async def health():
    """Health check"""
    return {"status": "healthy", "model_loaded": model is not None}


@app.get("/v1/models")
async def list_models():
    """List available models (OpenAI-compatible)"""
    return {
        "object": "list",
        "data": [
            {"id": "kyutai-tts", "object": "model", "owned_by": "kyutai"},
            {"id": "kyutai-tts-clone", "object": "model", "owned_by": "kyutai"},
            {"id": "tts-1", "object": "model", "owned_by": "kyutai"},  # OpenAI alias
        ]
    }


@app.get("/v1/voices")
async def list_voices():
    """List available voices"""
    voices = []
    for key, info in BUILTIN_VOICES.items():
        voices.append({
            "id": key,
            "name": info["name"],
            "description": info["description"],
        })
    return {"voices": voices}


@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    """OpenAI-compatible TTS endpoint"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    # Get voice state
    voice_state = get_voice_state(request.voice)
    if voice_state is None:
        raise HTTPException(status_code=400, detail=f"Voice not found: {request.voice}")

    # Sanitize input text
    clean_text = sanitize_text(request.input)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Input text is empty after sanitization")

    # Handle streaming
    if request.stream:
        return await create_streaming_speech(voice_state, clean_text)

    # Split into chunks for long text
    chunks = chunk_text(clean_text, max_chunk_size=500)

    async def generate_chunk(chunk_text: str):
        """Generate audio for a single chunk"""
        loop = asyncio.get_event_loop()

        def _generate():
            return model.generate_audio(voice_state, chunk_text, copy_state=True)

        return await loop.run_in_executor(None, _generate)

    try:
        all_audio = []

        for i, chunk in enumerate(chunks):
            try:
                audio = await asyncio.wait_for(
                    generate_chunk(chunk),
                    timeout=60.0
                )
                all_audio.append(audio)
            except asyncio.TimeoutError:
                print(f"Chunk {i} timed out, skipping: {chunk[:50]}...")
                continue

        if not all_audio:
            raise HTTPException(status_code=504, detail="All chunks timed out")

        # Concatenate all audio chunks
        combined_audio = torch.cat(all_audio, dim=-1)
        audio_bytes = audio_to_bytes(combined_audio, model.sample_rate)

        return Response(content=audio_bytes, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


async def create_streaming_speech(voice_state, text: str):
    """Generate streaming audio response"""

    async def audio_stream():
        loop = asyncio.get_event_loop()

        def _stream():
            for chunk in model.generate_audio_stream(voice_state, text, copy_state=True):
                yield chunk

        # Run streaming in executor
        def _collect_chunks():
            chunks = []
            for chunk in model.generate_audio_stream(voice_state, text, copy_state=True):
                chunks.append(chunk)
            return chunks

        chunks = await loop.run_in_executor(None, _collect_chunks)

        for chunk in chunks:
            chunk_bytes = audio_to_bytes(chunk, model.sample_rate)
            yield chunk_bytes

    return StreamingResponse(
        audio_stream(),
        media_type="audio/wav",
    )


@app.post("/v1/audio/voice-clone")
async def create_voice_clone_speech(
    input: str = Form(...),
    reference_audio: UploadFile = File(...),
    response_format: str = Form("wav"),
):
    """Clone a voice from a reference audio sample"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    try:
        audio_content = await reference_audio.read()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_content)
            tmp_path = tmp.name

        # Get voice state from reference audio
        voice_state = model.get_state_for_audio_prompt(tmp_path)

        # Generate audio
        clean_text = sanitize_text(input)
        audio = model.generate_audio(voice_state, clean_text)

        os.unlink(tmp_path)

        audio_bytes = audio_to_bytes(audio, model.sample_rate)
        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        if 'tmp_path' in locals():
            try:
                os.unlink(tmp_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/voice-clone-url")
async def create_voice_clone_from_url(request: VoiceCloneRequest):
    """Clone a voice from a HuggingFace or HTTP(S) URL"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not is_remote_voice_reference(request.voice_url):
        raise HTTPException(
            status_code=400,
            detail="voice_url must use the hf, http, or https scheme",
        )

    try:
        # Get voice state from URL
        voice_state = model.get_state_for_audio_prompt(request.voice_url)

        # Cache it for future use
        voice_states[request.voice_url] = voice_state

        # Generate audio
        clean_text = sanitize_text(request.input)
        audio = model.generate_audio(voice_state, clean_text)

        audio_bytes = audio_to_bytes(audio, model.sample_rate)
        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Kyutai TTS OpenAI-Compatible API Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8200, help="Port to bind to")
    args = parser.parse_args()

    load_model()

    print(f"\nKyutai TTS Server running at http://{args.host}:{args.port}")
    print(f"OpenAI-compatible endpoint: http://{args.host}:{args.port}/v1/audio/speech")
    print(f"Available voices: {', '.join(BUILTIN_VOICES.keys())}\n")

    uvicorn.run(app, host=args.host, port=args.port)
