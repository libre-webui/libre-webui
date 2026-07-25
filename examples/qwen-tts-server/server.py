#!/usr/bin/env python3
"""
Qwen3-TTS OpenAI-Compatible API Server

This server provides an OpenAI-compatible TTS endpoint for Qwen3-TTS models.
It allows Libre WebUI to use Qwen3-TTS through the standard plugin system.

Requirements:
    pip install qwen-tts fastapi uvicorn python-multipart

Usage:
    python server.py [--host 0.0.0.0] [--port 8100] [--model customvoice-1.7b]

Models available:
    - customvoice-1.7b: Pre-defined voices with instruction control
    - customvoice-0.6b: Lightweight variant
    - voicedesign-1.7b: Natural language voice design
    - base-1.7b: Voice cloning (3-second reference)
    - base-0.6b: Lightweight voice cloning
"""

import argparse
import asyncio
import io
import os
import re
import tempfile
from typing import Optional

import torch
from fastapi import FastAPI, HTTPException, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

# Qwen TTS imports
try:
    from qwen_tts import Qwen3TTSModel
except ImportError:
    print("Error: qwen-tts package not installed. Install with: pip install qwen-tts")
    exit(1)

app = FastAPI(
    title="Qwen3-TTS OpenAI-Compatible API",
    description="OpenAI-compatible TTS API powered by Qwen3-TTS",
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
model: Optional[Qwen3TTSModel] = None
model_type: str = "customvoice-1.7b"

# Pre-defined voices for CustomVoice model (from Qwen3-TTS docs)
# https://github.com/QwenLM/Qwen3-TTS
CUSTOM_VOICES = {
    "ryan": {"name": "Ryan", "language": "English"},
    "aiden": {"name": "Aiden", "language": "English"},
    "vivian": {"name": "Vivian", "language": "Chinese"},
    "serena": {"name": "Serena", "language": "Chinese"},
    "uncle_fu": {"name": "Uncle_Fu", "language": "Chinese"},
    "dylan": {"name": "Dylan", "language": "Chinese"},
    "eric": {"name": "Eric", "language": "Chinese"},
    "ono_anna": {"name": "Ono_Anna", "language": "Japanese"},
    "sohee": {"name": "Sohee", "language": "Korean"},
}

# Map OpenAI-style voice names to Qwen voices
VOICE_ALIASES = {
    "alloy": "ryan",
    "echo": "aiden",
    "fable": "vivian",
    "onyx": "uncle_fu",
    "nova": "serena",
    "shimmer": "ono_anna",
}


class TTSRequest(BaseModel):
    """OpenAI TTS API compatible request"""
    model: str = "qwen3-tts"
    input: str
    voice: str = "ryan"
    response_format: str = "wav"
    speed: float = 1.0
    # Qwen3-TTS specific
    instruct: Optional[str] = None  # Emotion/prosody instruction
    language: Optional[str] = None  # Override language detection


class VoiceDesignRequest(BaseModel):
    """Voice design request (natural language voice description)"""
    model: str = "qwen3-tts-voicedesign"
    input: str
    voice_description: str  # e.g., "a warm, friendly female voice with slight British accent"
    response_format: str = "wav"
    language: Optional[str] = None


def get_device():
    """Get the best available device (CUDA > MPS > CPU)"""
    if torch.cuda.is_available():
        return "cuda"
    elif torch.backends.mps.is_available():
        return "mps"
    else:
        return "cpu"


def load_model(model_name: str):
    """Load Qwen3-TTS model"""
    global model, model_type

    model_map = {
        "customvoice-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
        "customvoice-0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice",
        "voicedesign-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign",
        "base-1.7b": "Qwen/Qwen3-TTS-12Hz-1.7B-Base",
        "base-0.6b": "Qwen/Qwen3-TTS-12Hz-0.6B-Base",
    }

    if model_name not in model_map:
        raise ValueError(f"Unknown model: {model_name}. Available: {list(model_map.keys())}")

    device = get_device()
    print(f"Loading Qwen3-TTS model: {model_map[model_name]}")
    print(f"Using device: {device}")

    # Use float32 for MPS/CPU compatibility, bfloat16 for CUDA
    if device == "cuda":
        dtype = torch.bfloat16
        device_map = {"": "cuda:0"}  # Force single GPU (model is small enough)
    elif device == "mps":
        dtype = torch.float32  # MPS doesn't support bfloat16
        device_map = {"": device}
    else:
        dtype = torch.float32
        device_map = {"": device}

    model = Qwen3TTSModel.from_pretrained(
        model_map[model_name],
        dtype=dtype,
        device_map=device_map,
    )
    model_type = model_name
    print(f"Model loaded successfully on {device}")


def detect_language(text: str) -> str:
    """Simple language detection based on character ranges"""
    for char in text:
        if '\u4e00' <= char <= '\u9fff':
            return "Chinese"
        if '\u3040' <= char <= '\u309f' or '\u30a0' <= char <= '\u30ff':
            return "Japanese"
        if '\uac00' <= char <= '\ud7af':
            return "Korean"
    return "English"


def chunk_text(text: str, max_chunk_size: int = 500) -> list[str]:
    """Split text into speakable chunks at sentence boundaries"""
    # Split on sentence endings
    sentences = re.split(r'(?<=[.!?])\s+', text)

    chunks = []
    current_chunk = ""

    for sentence in sentences:
        if len(current_chunk) + len(sentence) + 1 <= max_chunk_size:
            current_chunk = (current_chunk + " " + sentence).strip()
        else:
            if current_chunk:
                chunks.append(current_chunk)
            # If single sentence is too long, split on commas or just force split
            if len(sentence) > max_chunk_size:
                # Split on commas
                parts = re.split(r',\s*', sentence)
                sub_chunk = ""
                for part in parts:
                    if len(sub_chunk) + len(part) + 2 <= max_chunk_size:
                        sub_chunk = (sub_chunk + ", " + part).strip(", ")
                    else:
                        if sub_chunk:
                            chunks.append(sub_chunk)
                        # Force split if still too long
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


_EMOJI_CODEPOINTS = frozenset({0x24C2})
_EMOJI_CODEPOINT_RANGES = (
    (0x2600, 0x27BF),  # Miscellaneous symbols and dingbats
    (0xFE0E, 0xFE0F),  # Text and emoji variation selectors
    (0x1F1E0, 0x1F1FF),  # Regional indicator symbols
    (0x1F201, 0x1F251),  # Enclosed ideographic supplement
    (0x1F300, 0x1F6FF),  # Pictographs, emoticons, transport, and maps
    (0x1F900, 0x1FAFF),  # Supplemental and extended symbols
)


def _is_emoji_character(character: str) -> bool:
    """Return whether a character belongs to an explicitly supported emoji block."""
    codepoint = ord(character)
    return codepoint in _EMOJI_CODEPOINTS or any(
        start <= codepoint <= end for start, end in _EMOJI_CODEPOINT_RANGES
    )


def _remove_emoji(text: str) -> str:
    """Remove emoji using numeric intervals instead of permissive regex ranges."""
    return ''.join(
        character for character in text if not _is_emoji_character(character)
    )


def _strip_markdown_links(text: str) -> str:
    """Replace inline Markdown links with labels in a single pass."""
    output = []
    cursor = 0
    text_length = len(text)

    while cursor < text_length:
        if text[cursor] != '[':
            output.append(text[cursor])
            cursor += 1
            continue

        label_end = cursor + 1
        while label_end < text_length and text[label_end] != ']':
            label_end += 1

        if label_end == text_length:
            output.append(text[cursor:])
            break

        if label_end + 1 == text_length or text[label_end + 1] != '(':
            output.append(text[cursor:label_end + 1])
            cursor = label_end + 1
            continue

        url_cursor = label_end + 2
        parenthesis_depth = 1
        while url_cursor < text_length and parenthesis_depth:
            char = text[url_cursor]
            if char == '\\' and url_cursor + 1 < text_length:
                url_cursor += 2
                continue
            if char == '(':
                parenthesis_depth += 1
            elif char == ')':
                parenthesis_depth -= 1
            url_cursor += 1

        if parenthesis_depth:
            output.append(text[cursor:])
            break

        output.append(text[cursor + 1:label_end])
        cursor = url_cursor

    return ''.join(output)


def _strip_parenthetical_directions(text: str) -> str:
    """Remove balanced parenthetical directions without regex backtracking."""
    output = []
    pending = []
    parenthesis_depth = 0
    leading_asterisk = False
    cursor = 0

    while cursor < len(text):
        char = text[cursor]

        if parenthesis_depth == 0:
            if char != '(':
                output.append(char)
                cursor += 1
                continue

            leading_asterisk = bool(output and output[-1] == '*')
            if leading_asterisk:
                output.pop()
            pending = ['(']
            parenthesis_depth = 1
            cursor += 1
            continue

        pending.append(char)
        if char == '(':
            parenthesis_depth += 1
        elif char == ')':
            parenthesis_depth -= 1
            if parenthesis_depth == 0:
                pending = []
                if cursor + 1 < len(text) and text[cursor + 1] == '*':
                    cursor += 1
                leading_asterisk = False
        cursor += 1

    if pending:
        if leading_asterisk:
            output.append('*')
        output.extend(pending)

    return ''.join(output)


def sanitize_text(text: str) -> str:
    """Sanitize text to prevent model hangs on problematic input."""
    # Numeric code-point checks make every accepted interval explicit and avoid
    # regex ranges that static analysis cannot distinguish from accidental spans.
    text = _remove_emoji(text)

    # Parse user-controlled Markdown constructs in linear time. Malformed,
    # unclosed constructs are preserved instead of repeatedly rescanning them.
    text = _strip_markdown_links(text)
    text = _strip_parenthetical_directions(text)

    # Remove markdown formatting
    text = re.sub(r'\*+', '', text)  # asterisks (bold/italic)
    text = re.sub(r'_+', ' ', text)  # underscores
    text = re.sub(r'~+', '', text)  # strikethrough
    text = re.sub(r'`+', '', text)  # code
    text = re.sub(r'^#{1,6}\s*', '', text, flags=re.MULTILINE)  # headers
    text = re.sub(r'^-{3,}$', '', text, flags=re.MULTILINE)  # horizontal rules
    # Collapse repeated characters (more than 3 of the same char)
    text = re.sub(r'(.)\1{3,}', r'\1\1\1', text)

    # Remove zero-width characters and other invisible chars
    text = re.sub(r'[\u200b-\u200f\u2028-\u202f\u2060-\u206f\ufeff]', '', text)

    # Normalize whitespace
    text = re.sub(r'\s+', ' ', text).strip()

    # Remove any remaining control characters except newlines
    text = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]').sub('', text)

    return text


def audio_to_bytes(audio_data, sample_rate: int, format: str) -> bytes:
    """Convert audio tensor or list of tensors to bytes in specified format"""
    import scipy.io.wavfile as wavfile
    import numpy as np

    # Handle list of audio tensors (concatenate them)
    if isinstance(audio_data, list):
        if len(audio_data) == 0:
            raise ValueError("Empty audio list")
        # Move all tensors to CPU first, then concatenate
        cpu_tensors = []
        for t in audio_data:
            if hasattr(t, 'cpu'):
                cpu_tensors.append(t.cpu())
            else:
                cpu_tensors.append(torch.tensor(t))
        audio = torch.cat(cpu_tensors, dim=-1)
    else:
        audio = audio_data.cpu() if hasattr(audio_data, 'cpu') else torch.tensor(audio_data)

    if audio.dim() == 2:
        audio = audio.squeeze(0)

    # Convert to numpy
    audio_np = audio.numpy()

    # Normalize to int16 range
    audio_np = np.clip(audio_np, -1.0, 1.0)
    audio_int16 = (audio_np * 32767).astype(np.int16)

    buffer = io.BytesIO()

    # Always save as wav (most compatible, no extra codecs needed)
    wavfile.write(buffer, sample_rate, audio_int16)

    buffer.seek(0)
    return buffer.read()


@app.get("/")
async def root():
    """Health check endpoint"""
    return {
        "status": "ok",
        "model": model_type,
        "models_available": [
            "qwen3-tts",
            "qwen3-tts-customvoice",
            "qwen3-tts-voicedesign",
            "qwen3-tts-clone"
        ],
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
            {"id": "qwen3-tts", "object": "model", "owned_by": "qwen"},
            {"id": "qwen3-tts-customvoice", "object": "model", "owned_by": "qwen"},
            {"id": "qwen3-tts-voicedesign", "object": "model", "owned_by": "qwen"},
            {"id": "qwen3-tts-clone", "object": "model", "owned_by": "qwen"},
        ]
    }


@app.get("/v1/voices")
async def list_voices():
    """List available voices"""
    voices = []
    for key, info in CUSTOM_VOICES.items():
        voices.append({
            "id": key,
            "name": info["name"],
            "language": info["language"],
        })
    return {"voices": voices}


@app.post("/v1/audio/speech")
async def create_speech(request: TTSRequest):
    """OpenAI-compatible TTS endpoint"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    voice_key = request.voice.lower()
    if voice_key in VOICE_ALIASES:
        voice_key = VOICE_ALIASES[voice_key]

    voice_info = CUSTOM_VOICES.get(voice_key, CUSTOM_VOICES["ryan"])

    # Sanitize input text to prevent hangs
    clean_text = sanitize_text(request.input)
    if not clean_text:
        raise HTTPException(status_code=400, detail="Input text is empty after sanitization")

    # Split into chunks for reliable generation
    chunks = chunk_text(clean_text, max_chunk_size=500)

    language = request.language or voice_info.get("language") or detect_language(clean_text)

    async def generate_chunk(chunk_text: str):
        """Generate audio for a single chunk"""
        loop = asyncio.get_event_loop()

        def _generate():
            if model_type.startswith("customvoice"):
                return model.generate_custom_voice(
                    text=chunk_text,
                    language=language,
                    speaker=voice_info["name"],
                    instruct=request.instruct or "",
                )
            elif model_type.startswith("voicedesign"):
                description = request.instruct or f"A clear, natural {voice_info['name']}'s voice"
                return model.generate_voice_design(
                    text=chunk_text,
                    language=language,
                    instruct=description,
                )
            else:
                return model.generate(
                    text=chunk_text,
                    language=language,
                )

        return await loop.run_in_executor(None, _generate)

    try:
        all_audio = []
        final_sample_rate = None

        # Generate each chunk with individual timeout
        for i, chunk in enumerate(chunks):
            try:
                audio, sample_rate = await asyncio.wait_for(
                    generate_chunk(chunk),
                    timeout=30.0  # 30s per chunk
                )
                all_audio.append(audio)
                final_sample_rate = sample_rate
            except asyncio.TimeoutError:
                # Skip this chunk if it times out, continue with others
                print(f"Chunk {i} timed out, skipping: {chunk[:50]}...")
                continue

        if not all_audio:
            raise HTTPException(status_code=504, detail="All chunks timed out")

        # Concatenate all audio chunks
        audio_bytes = audio_to_bytes(all_audio, final_sample_rate, request.response_format)

        # Always return wav (other formats require additional codecs)
        return Response(content=audio_bytes, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/voice-design")
async def create_voice_design_speech(request: VoiceDesignRequest):
    """Generate speech with natural language voice description"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not model_type.startswith("voicedesign"):
        raise HTTPException(
            status_code=400,
            detail=f"Voice design requires voicedesign model, but {model_type} is loaded"
        )

    language = request.language or detect_language(request.input)

    try:
        audio, sample_rate = model.generate_voice_design(
            text=request.input,
            language=language,
            instruct=request.voice_description,
        )

        audio_bytes = audio_to_bytes(audio, sample_rate, request.response_format)
        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/voice-clone")
async def create_voice_clone_speech(
    input: str = Form(...),
    reference_audio: UploadFile = File(...),
    reference_text: str = Form(None),
    response_format: str = Form("wav"),
    language: str = Form(None),
):
    """Clone a voice from a reference audio sample"""
    if model is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    if not model_type.startswith("base"):
        raise HTTPException(
            status_code=400,
            detail=f"Voice cloning requires base model, but {model_type} is loaded"
        )

    try:
        audio_content = await reference_audio.read()

        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_content)
            tmp_path = tmp.name

        audio, sample_rate = model.generate_voice_clone(
            text=input,
            ref_audio=tmp_path,
            ref_text=reference_text or "",
        )

        os.unlink(tmp_path)

        audio_bytes = audio_to_bytes(audio, sample_rate, response_format)
        return Response(content=audio_bytes, media_type="audio/wav")

    except Exception as e:
        if 'tmp_path' in locals():
            try:
                os.unlink(tmp_path)
            except:
                pass
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser(description="Qwen3-TTS OpenAI-Compatible API Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--port", type=int, default=8100, help="Port to bind to")
    parser.add_argument(
        "--model",
        default="customvoice-1.7b",
        choices=["customvoice-1.7b", "customvoice-0.6b", "voicedesign-1.7b", "base-1.7b", "base-0.6b"],
        help="Model variant to load"
    )
    args = parser.parse_args()

    load_model(args.model)

    print(f"\nQwen3-TTS Server running at http://{args.host}:{args.port}")
    print(f"OpenAI-compatible endpoint: http://{args.host}:{args.port}/v1/audio/speech")
    print(f"Model: {args.model}\n")

    uvicorn.run(app, host=args.host, port=args.port)
