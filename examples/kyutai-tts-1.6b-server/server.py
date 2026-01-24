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

# Available voices from kyutai/tts-voices
# These are paths relative to the voice repository
AVAILABLE_VOICES = {
    # Alba MacKenna voice collection (CC BY 4.0)
    "alba": "alba-mackenna/casual.wav",
    "alba-casual": "alba-mackenna/casual.wav",
    "alba-merchant": "alba-mackenna/merchant.wav",
    "alba-announcer": "alba-mackenna/announcer.wav",
    "alba-moment": "alba-mackenna/a-moment-by.wav",
    # EARS dataset - Emotion voices from p003 (female) and p031 (male)
    # Female emotion voices (p003)
    "angry-f": "ears/p003/emo_anger_freeform.wav",
    "calm-f": "ears/p003/emo_serenity_freeform.wav",
    "confused-f": "ears/p003/emo_confusion_freeform.wav",
    "desire-f": "ears/p003/emo_desire_freeform.wav",
    "fear-f": "ears/p003/emo_fear_freeform.wav",
    "happy-f": "ears/p003/emo_amusement_freeform.wav",
    "sad-f": "ears/p003/emo_sadness_freeform.wav",
    "neutral-f": "ears/p003/emo_neutral_freeform.wav",
    "disgust-f": "ears/p003/emo_disgust_freeform.wav",
    "pride-f": "ears/p003/emo_pride_freeform.wav",
    "relief-f": "ears/p003/emo_relief_freeform.wav",
    "interest-f": "ears/p003/emo_interest_freeform.wav",
    # Male emotion voices (p031)
    "angry-m": "ears/p031/emo_anger_freeform.wav",
    "calm-m": "ears/p031/emo_serenity_freeform.wav",
    "confused-m": "ears/p031/emo_confusion_freeform.wav",
    "desire-m": "ears/p031/emo_desire_freeform.wav",
    "fear-m": "ears/p031/emo_fear_freeform.wav",
    "happy-m": "ears/p031/emo_amusement_freeform.wav",
    "sad-m": "ears/p031/emo_sadness_freeform.wav",
    "neutral-m": "ears/p031/emo_neutral_freeform.wav",
    "disgust-m": "ears/p031/emo_disgust_freeform.wav",
    "pride-m": "ears/p031/emo_pride_freeform.wav",
    "relief-m": "ears/p031/emo_relief_freeform.wav",
    "interest-m": "ears/p031/emo_interest_freeform.wav",
    # EARS neutral voices (using freeform_speech_01.wav)
    "ears-p001": "ears/p001/freeform_speech_01.wav",
    "ears-p002": "ears/p002/freeform_speech_01.wav",
    "ears-p004": "ears/p004/freeform_speech_01.wav",
    "ears-p005": "ears/p005/freeform_speech_01.wav",
    # CML-TTS French voices
    "cml-12977-fr-f": "cml-tts/fr/12977.wav",
    "cml-1406-fr-m": "cml-tts/fr/1406.wav",
    "cml-2154-fr-f": "cml-tts/fr/2154.wav",
    "cml-4724-fr-m": "cml-tts/fr/4724.wav",
    # VCTK voices - UK accents (CC BY 4.0)
    "vctk-p225": "vctk/p225_023.wav",
    "vctk-p226": "vctk/p226_023.wav",
    "vctk-p227": "vctk/p227_023.wav",
    "vctk-p228": "vctk/p228_023.wav",
    "vctk-p229": "vctk/p229_023.wav",
    "vctk-p230": "vctk/p230_023.wav",
    "vctk-p231": "vctk/p231_023.wav",
    "vctk-p232": "vctk/p232_023.wav",
    "vctk-p233": "vctk/p233_023.wav",
    "vctk-p234": "vctk/p234_023.wav",
    "vctk-p236": "vctk/p236_023.wav",
    "vctk-p237": "vctk/p237_023.wav",
    "vctk-p238": "vctk/p238_023.wav",
    "vctk-p239": "vctk/p239_023.wav",
    "vctk-p240": "vctk/p240_023.wav",
    "vctk-p241": "vctk/p241_023.wav",
    "vctk-p243": "vctk/p243_023.wav",
    "vctk-p244": "vctk/p244_023.wav",
    "vctk-p245": "vctk/p245_023.wav",
    "vctk-p246": "vctk/p246_023.wav",
    "vctk-p247": "vctk/p247_023.wav",
    "vctk-p248": "vctk/p248_023.wav",
    "vctk-p249": "vctk/p249_023.wav",
    "vctk-p250": "vctk/p250_023.wav",
    "vctk-p251": "vctk/p251_023.wav",
    "vctk-p252": "vctk/p252_023.wav",
    "vctk-p253": "vctk/p253_023.wav",
    "vctk-p254": "vctk/p254_023.wav",
    "vctk-p255": "vctk/p255_023.wav",
    "vctk-p256": "vctk/p256_023.wav",
    "vctk-p257": "vctk/p257_023.wav",
    "vctk-p258": "vctk/p258_023.wav",
    "vctk-p259": "vctk/p259_023.wav",
    "vctk-p260": "vctk/p260_023.wav",
    "vctk-p261": "vctk/p261_023.wav",
    "vctk-p262": "vctk/p262_023.wav",
    "vctk-p263": "vctk/p263_023.wav",
    "vctk-p264": "vctk/p264_023.wav",
    "vctk-p265": "vctk/p265_023.wav",
    "vctk-p266": "vctk/p266_023.wav",
    "vctk-p267": "vctk/p267_023.wav",
    "vctk-p268": "vctk/p268_023.wav",
    "vctk-p269": "vctk/p269_023.wav",
    "vctk-p270": "vctk/p270_023.wav",
    "vctk-p271": "vctk/p271_023.wav",
    "vctk-p272": "vctk/p272_023.wav",
    "vctk-p273": "vctk/p273_023.wav",
    "vctk-p274": "vctk/p274_023.wav",
    "vctk-p275": "vctk/p275_023.wav",
    "vctk-p276": "vctk/p276_023.wav",
    "vctk-p277": "vctk/p277_023.wav",
    "vctk-p278": "vctk/p278_023.wav",
    "vctk-p279": "vctk/p279_023.wav",
    "vctk-p280": "vctk/p280_023.wav",
    "vctk-p281": "vctk/p281_023.wav",
    "vctk-p282": "vctk/p282_023.wav",
    "vctk-p283": "vctk/p283_023.wav",
    "vctk-p284": "vctk/p284_023.wav",
    "vctk-p285": "vctk/p285_023.wav",
    "vctk-p286": "vctk/p286_023.wav",
    "vctk-p287": "vctk/p287_023.wav",
    "vctk-p288": "vctk/p288_023.wav",
    "vctk-p292": "vctk/p292_023.wav",
    "vctk-p293": "vctk/p293_023.wav",
    "vctk-p294": "vctk/p294_023.wav",
    "vctk-p295": "vctk/p295_023.wav",
    "vctk-p297": "vctk/p297_023.wav",
    "vctk-p298": "vctk/p298_023.wav",
    "vctk-p299": "vctk/p299_023.wav",
    "vctk-p300": "vctk/p300_023.wav",
    "vctk-p301": "vctk/p301_023.wav",
    "vctk-p302": "vctk/p302_023.wav",
    "vctk-p303": "vctk/p303_023.wav",
    "vctk-p304": "vctk/p304_023.wav",
    "vctk-p305": "vctk/p305_023.wav",
    "vctk-p306": "vctk/p306_023.wav",
    "vctk-p307": "vctk/p307_023.wav",
    "vctk-p308": "vctk/p308_023.wav",
    "vctk-p310": "vctk/p310_023.wav",
    "vctk-p311": "vctk/p311_023.wav",
    "vctk-p312": "vctk/p312_023.wav",
    "vctk-p313": "vctk/p313_023.wav",
    "vctk-p314": "vctk/p314_023.wav",
    "vctk-p316": "vctk/p316_023.wav",
    "vctk-p317": "vctk/p317_023.wav",
    "vctk-p318": "vctk/p318_023.wav",
    "vctk-p323": "vctk/p323_023.wav",
    "vctk-p326": "vctk/p326_023.wav",
    "vctk-p329": "vctk/p329_023.wav",
    "vctk-p330": "vctk/p330_023.wav",
    "vctk-p333": "vctk/p333_023.wav",
    "vctk-p334": "vctk/p334_023.wav",
    "vctk-p335": "vctk/p335_023.wav",
    "vctk-p336": "vctk/p336_023.wav",
    "vctk-p339": "vctk/p339_023.wav",
    "vctk-p340": "vctk/p340_023.wav",
    "vctk-p341": "vctk/p341_023.wav",
    "vctk-p343": "vctk/p343_023.wav",
    "vctk-p345": "vctk/p345_023.wav",
    "vctk-p347": "vctk/p347_023.wav",
    "vctk-p351": "vctk/p351_023.wav",
    "vctk-p360": "vctk/p360_023.wav",
    "vctk-p361": "vctk/p361_023.wav",
    "vctk-p362": "vctk/p362_023.wav",
    "vctk-p363": "vctk/p363_023.wav",
    "vctk-p364": "vctk/p364_023.wav",
    "vctk-p374": "vctk/p374_023.wav",
    "vctk-p376": "vctk/p376_023.wav",
    # Expresso dataset voices (CC BY-NC 4.0 - non-commercial)
    "expresso-happy": "expresso/ex03-ex01_happy_001_channel1_334s.wav",
    "expresso-sad": "expresso/ex03-ex02_sad-sympathetic_001_channel1_454s.wav",
    "expresso-angry": "expresso/ex03-ex01_angry_001_channel1_201s.wav",
    "expresso-calm": "expresso/ex03-ex01_calm_001_channel1_1143s.wav",
    "expresso-confused": "expresso/ex03-ex01_confused_001_channel1_909s.wav",
    "expresso-sarcastic": "expresso/ex03-ex01_sarcastic_001_channel1_435s.wav",
    "expresso-sleepy": "expresso/ex03-ex01_sleepy_001_channel1_619s.wav",
    "expresso-laughing": "expresso/ex03-ex01_laughing_001_channel1_188s.wav",
    "expresso-awe": "expresso/ex03-ex01_awe_001_channel1_1323s.wav",
    "expresso-desire": "expresso/ex03-ex01_desire_004_channel1_545s.wav",
    "expresso-whisper": "expresso/ex01-ex02_whisper_001_channel1_579s.wav",
    "expresso-fast": "expresso/ex01-ex02_fast_001_channel1_104s.wav",
    "expresso-narration": "expresso/ex03-ex02_narration_001_channel1_674s.wav",
    # Unmute voices
    "unmute-degaulle": "unmute-prod-website/degaulle-2.wav",
    "unmute-developer": "unmute-prod-website/developer-1.mp3",
    "unmute-developpeuse": "unmute-prod-website/developpeuse-3.wav",
    "unmute-narration": "unmute-prod-website/ex04_narration_longform_00001.wav",
    "unmute-default": "unmute-prod-website/default_voice.wav",
    "unmute-fabien": "unmute-prod-website/fabieng-enhanced-v2.wav",
    # Voice donations (CC0)
    "voice-donation-dwp": "voice-donations/dwp.wav",
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


def get_voice_path(voice: str) -> str:
    """Get the path to a voice safetensors file"""
    voice_lower = voice.lower()

    # Check aliases first
    if voice_lower in VOICE_ALIASES:
        voice_lower = VOICE_ALIASES[voice_lower]

    # Get voice file path
    if voice_lower in AVAILABLE_VOICES:
        voice_file = AVAILABLE_VOICES[voice_lower]
    elif voice.startswith("hf://") or voice.endswith(".safetensors"):
        voice_file = voice
    else:
        # Default to alba
        voice_file = AVAILABLE_VOICES["alba"]

    # Get the path from the model (this downloads if needed)
    return model.get_voice_path(voice_file)


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

    # Get voice path (safetensors file)
    try:
        voice_path = get_voice_path(request.voice)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Voice not found: {request.voice} - {e}")

    async def generate_audio():
        """Generate audio in executor"""
        loop = asyncio.get_event_loop()

        def _generate():
            # Prepare the script
            entries = model.prepare_script([clean_text], padding_between=1)

            # Prepare condition attributes using voice safetensors file
            cond_attrs = model.make_condition_attributes([voice_path], cfg_coef=request.cfg_coef)

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
        import traceback
        traceback.print_exc()
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
