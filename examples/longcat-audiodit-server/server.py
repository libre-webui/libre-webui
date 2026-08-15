#!/usr/bin/env python3
"""Local OpenAI-style HTTP adapter for the official LongCat AudioDiT models."""

from __future__ import annotations

import argparse
import asyncio
import io
import logging
import math
import os
import re
import tempfile
import unicodedata
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field


OFFICIAL_MODEL_IDS = (
    "meituan-longcat/LongCat-AudioDiT-1B",
    "meituan-longcat/LongCat-AudioDiT-3.5B",
)
DEFAULT_MODEL_ID = OFFICIAL_MODEL_IDS[0]
SAMPLE_RATE = 24_000
# The official duration heuristic reaches the 1B checkpoint's 30-second cap at
# roughly 143 Chinese characters. Keep a conservative common bound so clients
# batch before inference instead of receiving silently clipped speech.
MAX_INPUT_CHARACTERS = 140
MAX_REFERENCE_TEXT_CHARACTERS = 2_000
MAX_REFERENCE_AUDIO_BYTES = 10 * 1024 * 1024
MAX_REFERENCE_AUDIO_SECONDS = 15.0
MIN_STEPS = 2
MAX_STEPS = 64
MIN_CFG_STRENGTH = 0.0
MAX_CFG_STRENGTH = 20.0
MAX_SEED = 2_147_483_647
MIN_OPENAI_SPEED = 0.25
MAX_OPENAI_SPEED = 4.0
DEFAULT_STEPS = 16
DEFAULT_CFG_STRENGTH = 4.0
DEFAULT_GUIDANCE_METHOD = "cfg"
DEFAULT_SEED = 1024
UPLOAD_CHUNK_BYTES = 1024 * 1024
MIME_TYPE_SUFFIXES = {
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/flac": ".flac",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
}

logger = logging.getLogger("longcat-audiodit-server")


def sanitize_text(text: str) -> str:
    """Normalize model text while preserving ordinary multilingual characters."""
    normalized = unicodedata.normalize("NFKC", text)
    cleaned = []
    for character in normalized:
        if character in "\r\n\t":
            cleaned.append(" ")
        elif not unicodedata.category(character).startswith("C"):
            cleaned.append(character)

    # Match the official AudioDiT inference normalization for quotation marks,
    # whitespace, and case after removing invisible/control characters.
    result = re.sub(r'["“”‘’]', " ", "".join(cleaned))
    return re.sub(r"\s+", " ", result).strip().lower()


def prepare_text(text: str, field_name: str, maximum_characters: int) -> str:
    """Validate and sanitize a user-supplied synthesis or transcript field."""
    if not isinstance(text, str):
        raise ValueError(f"{field_name} must be a string")
    if len(text) > maximum_characters:
        raise ValueError(
            f"{field_name} exceeds the {maximum_characters}-character limit"
        )

    clean_text = sanitize_text(text)
    if len(clean_text) > maximum_characters:
        raise ValueError(
            f"{field_name} exceeds the {maximum_characters}-character limit "
            "after normalization"
        )
    if not clean_text or not any(character.isalnum() for character in clean_text):
        raise ValueError(f"{field_name} must contain spoken text")
    return clean_text


def approximate_duration_from_text(text: str, maximum_seconds: float) -> float:
    """Use the duration heuristic published in LongCat's official inference code."""
    compact = re.sub(r"\s+", "", text)
    chinese = english = other = 0
    for character in compact:
        if "\u4e00" <= character <= "\u9fff":
            chinese += 1
        elif character.isalpha():
            english += 1
        else:
            other += 1

    if chinese > english:
        chinese += other
    else:
        english += other
    return min(maximum_seconds, chinese * 0.21 + english * 0.082)


def estimate_clone_generated_duration(
    text: str,
    reference_text: str,
    prompt_seconds: float,
    maximum_seconds: float,
) -> float:
    """Reject clone requests whose generated speech cannot fit after the prompt."""
    if (
        not math.isfinite(prompt_seconds)
        or not math.isfinite(maximum_seconds)
        or prompt_seconds < 0
        or maximum_seconds <= 0
    ):
        raise ValueError("voice-clone duration values must be finite and positive")

    available_seconds = maximum_seconds - prompt_seconds
    if available_seconds <= 0:
        raise ValueError("reference_audio leaves no duration for generated speech")

    generated_seconds = approximate_duration_from_text(text, maximum_seconds)
    transcript_seconds = max(
        approximate_duration_from_text(reference_text, maximum_seconds),
        0.001,
    )
    duration_ratio = min(max(prompt_seconds / transcript_seconds, 1.0), 1.5)
    generated_seconds *= duration_ratio
    if generated_seconds > available_seconds:
        raise ValueError(
            "input is too long for the remaining voice-clone duration; "
            "use a shorter reference or generated text"
        )
    return generated_seconds


def validate_model_id(model_id: str) -> str:
    """Allow only the two official AudioDiT checkpoints bundled in the manifest."""
    if model_id not in OFFICIAL_MODEL_IDS:
        raise ValueError(
            "model must be one of: " + ", ".join(OFFICIAL_MODEL_IDS)
        )
    return model_id


def validate_loaded_model_id(requested_model_id: str, loaded_model_id: str) -> str:
    """Reject valid-but-unloaded checkpoints instead of silently substituting."""
    validate_model_id(requested_model_id)
    validate_model_id(loaded_model_id)
    if requested_model_id != loaded_model_id:
        raise ValueError(
            f"This server loaded {loaded_model_id}; restart it to use "
            f"{requested_model_id}"
        )
    return requested_model_id


def models_response(loaded_model_id: str) -> dict[str, object]:
    """Build an OpenAI-style catalog containing only the resident checkpoint."""
    validate_model_id(loaded_model_id)
    return {
        "object": "list",
        "data": [
            {
                "id": loaded_model_id,
                "object": "model",
                "owned_by": "meituan-longcat",
                "loaded": True,
            }
        ],
    }


def validate_generation_parameters(
    steps: int,
    cfg_strength: float,
    guidance_method: str,
    seed: int,
) -> tuple[int, float, str, int]:
    """Validate inference controls independently of JSON or multipart parsing."""
    if isinstance(steps, bool) or not isinstance(steps, int):
        raise ValueError("steps must be an integer")
    if steps < MIN_STEPS or steps > MAX_STEPS:
        raise ValueError(f"steps must be between {MIN_STEPS} and {MAX_STEPS}")
    if not isinstance(cfg_strength, (int, float)) or not math.isfinite(
        float(cfg_strength)
    ):
        raise ValueError("cfg_strength must be a finite number")
    if cfg_strength < MIN_CFG_STRENGTH or cfg_strength > MAX_CFG_STRENGTH:
        raise ValueError(
            "cfg_strength must be between "
            f"{MIN_CFG_STRENGTH} and {MAX_CFG_STRENGTH}"
        )
    if guidance_method not in ("cfg", "apg"):
        raise ValueError("guidance_method must be 'cfg' or 'apg'")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")
    if seed < 0 or seed > MAX_SEED:
        raise ValueError(f"seed must be between 0 and {MAX_SEED}")
    return steps, float(cfg_strength), guidance_method, seed


def validate_ignored_openai_speed(speed: float) -> float:
    """Accept the OpenAI speed range while leaving AudioDiT timing unchanged."""
    if isinstance(speed, bool) or not isinstance(speed, (int, float)):
        raise ValueError("speed must be a number")
    normalized_speed = float(speed)
    if not math.isfinite(normalized_speed):
        raise ValueError("speed must be a finite number")
    if normalized_speed < MIN_OPENAI_SPEED or normalized_speed > MAX_OPENAI_SPEED:
        raise ValueError(
            f"speed must be between {MIN_OPENAI_SPEED} and {MAX_OPENAI_SPEED}"
        )
    return normalized_speed


def validate_upload_metadata(content_type: str | None, size: int | None) -> str:
    """Validate declared upload type/size and return a controlled file suffix."""
    normalized_type = (content_type or "").split(";", 1)[0].strip().lower()
    suffix = MIME_TYPE_SUFFIXES.get(normalized_type)
    if suffix is None:
        supported = ", ".join(MIME_TYPE_SUFFIXES)
        raise ValueError(f"reference_audio must use one of: {supported}")
    if size is not None and size > MAX_REFERENCE_AUDIO_BYTES:
        raise OverflowError(
            f"reference_audio exceeds the {MAX_REFERENCE_AUDIO_BYTES}-byte limit"
        )
    return suffix


def waveform_to_wav_bytes(waveform: object, sample_rate: int) -> bytes:
    """Encode a finite one-channel waveform as a 24 kHz PCM-16 WAV."""
    import numpy as np
    import soundfile as sf

    if sample_rate != SAMPLE_RATE:
        raise RuntimeError(
            f"Expected a {SAMPLE_RATE} Hz model, received {sample_rate} Hz"
        )
    if hasattr(waveform, "detach"):
        waveform = waveform.detach().cpu().numpy()

    audio = np.asarray(waveform, dtype=np.float32).squeeze()
    if audio.ndim != 1 or audio.size == 0:
        raise RuntimeError("AudioDiT returned an empty or non-mono waveform")
    if not np.isfinite(audio).all():
        raise RuntimeError("AudioDiT returned non-finite waveform samples")

    output = io.BytesIO()
    sf.write(
        output,
        np.clip(audio, -1.0, 1.0),
        SAMPLE_RATE,
        format="WAV",
        subtype="PCM_16",
    )
    return output.getvalue()


class SpeechRequest(BaseModel):
    """OpenAI-style JSON speech request plus AudioDiT inference controls."""

    model_config = ConfigDict(extra="forbid")

    model: str = DEFAULT_MODEL_ID
    input: str = Field(min_length=1, max_length=MAX_INPUT_CHARACTERS)
    # AudioDiT does not publish named preset voices. This field is accepted for
    # OpenAI request compatibility and intentionally does not select a voice.
    voice: str = Field(default="", max_length=128)
    response_format: Literal["wav"] = "wav"
    # Parsed and range-checked for OpenAI request compatibility. AudioDiT has
    # no speed control, so every valid value is intentionally ignored.
    speed: float = Field(
        default=1.0,
        ge=MIN_OPENAI_SPEED,
        le=MAX_OPENAI_SPEED,
        allow_inf_nan=False,
    )
    steps: int = Field(default=DEFAULT_STEPS, ge=MIN_STEPS, le=MAX_STEPS)
    cfg_strength: float = Field(
        default=DEFAULT_CFG_STRENGTH,
        ge=MIN_CFG_STRENGTH,
        le=MAX_CFG_STRENGTH,
        allow_inf_nan=False,
    )
    guidance_method: Literal["cfg", "apg"] = DEFAULT_GUIDANCE_METHOD
    seed: int = Field(default=DEFAULT_SEED, ge=0, le=MAX_SEED)


class AudioDiTEngine:
    """Thin wrapper around the official audiodit package and checkpoints."""

    def __init__(self, model_id: str, requested_device: str) -> None:
        validate_model_id(model_id)

        try:
            import audiodit  # noqa: F401 - registers AudioDiT with Transformers
            import librosa
            import numpy as np
            import torch
            import torch.nn.functional as torch_functional
            from audiodit import AudioDiTModel
            from transformers import AutoTokenizer
        except ImportError as error:
            raise RuntimeError(
                "LongCat dependencies or the official audiodit source are not "
                "importable; follow the example README setup"
            ) from error

        if requested_device == "auto":
            requested_device = "cuda:0" if torch.cuda.is_available() else "cpu"
        if requested_device.startswith("cuda") and not torch.cuda.is_available():
            raise RuntimeError(
                "CUDA was requested but torch.cuda.is_available() is false"
            )

        torch.backends.cudnn.benchmark = False
        self.model_id = model_id
        self.device = torch.device(requested_device)
        self.torch = torch
        self.torch_functional = torch_functional
        self.librosa = librosa
        self.numpy = np

        logger.info("Loading %s on %s", model_id, self.device)
        self.model = AudioDiTModel.from_pretrained(model_id).to(self.device)
        if self.device.type == "cuda":
            # This matches the VAE precision used by the official inference code.
            self.model.vae.to_half()
        self.model.eval()
        self.tokenizer = AutoTokenizer.from_pretrained(
            self.model.config.text_encoder_model
        )

        self.sample_rate = int(self.model.config.sampling_rate)
        self.full_hop = int(self.model.config.latent_hop)
        self.maximum_duration = float(self.model.config.max_wav_duration)
        if self.sample_rate != SAMPLE_RATE:
            raise RuntimeError(
                f"Unsupported checkpoint sample rate {self.sample_rate}; "
                f"expected {SAMPLE_RATE}"
            )

    def _set_seed(self, seed: int) -> None:
        self.torch.manual_seed(seed)
        if self.device.type == "cuda":
            self.torch.cuda.manual_seed_all(seed)

    def _tokenize(self, text: str) -> object:
        return self.tokenizer([text], padding="longest", return_tensors="pt")

    def _duration_frames(self, text: str) -> int:
        duration_seconds = approximate_duration_from_text(
            text, self.maximum_duration
        )
        return max(1, int(duration_seconds * self.sample_rate // self.full_hop))

    def synthesize(
        self,
        *,
        model_id: str,
        text: str,
        steps: int,
        cfg_strength: float,
        guidance_method: str,
        seed: int,
    ) -> bytes:
        validate_loaded_model_id(model_id, self.model_id)
        validate_generation_parameters(steps, cfg_strength, guidance_method, seed)
        self._set_seed(seed)

        inputs = self._tokenize(text)
        with self.torch.inference_mode():
            output = self.model(
                input_ids=inputs.input_ids,
                attention_mask=inputs.attention_mask,
                duration=self._duration_frames(text),
                steps=steps,
                cfg_strength=cfg_strength,
                guidance_method=guidance_method,
            )
        return waveform_to_wav_bytes(output.waveform, self.sample_rate)

    def _load_reference_audio(self, reference_path: Path) -> object:
        # Decode only just beyond the accepted duration, preventing a small
        # compressed upload from expanding into an unbounded in-memory waveform.
        try:
            audio, _ = self.librosa.load(
                str(reference_path),
                sr=self.sample_rate,
                mono=True,
                duration=MAX_REFERENCE_AUDIO_SECONDS + 1.0,
            )
        except Exception as error:
            raise ValueError("reference_audio could not be decoded") from error
        audio = self.numpy.asarray(audio, dtype=self.numpy.float32)
        if audio.size == 0 or not self.numpy.isfinite(audio).all():
            raise ValueError("reference_audio could not be decoded as finite audio")
        if audio.size > int(MAX_REFERENCE_AUDIO_SECONDS * self.sample_rate):
            raise ValueError(
                "reference_audio must be at most "
                f"{MAX_REFERENCE_AUDIO_SECONDS:g} seconds"
            )
        return self.torch.from_numpy(audio).unsqueeze(0)

    def clone_voice(
        self,
        *,
        model_id: str,
        text: str,
        reference_text: str,
        reference_path: Path,
        steps: int,
        cfg_strength: float,
        guidance_method: str,
        seed: int,
    ) -> bytes:
        validate_loaded_model_id(model_id, self.model_id)
        validate_generation_parameters(steps, cfg_strength, guidance_method, seed)
        self._set_seed(seed)

        prompt_base = self._load_reference_audio(reference_path)
        prompt_audio = prompt_base.unsqueeze(0)
        inputs = self._tokenize(f"{reference_text} {text}")

        # Follow the official inference calculation so the requested total
        # duration includes the encoded prompt before AudioDiT removes it from
        # the returned generated waveform.
        offset_frames = 3
        padded_prompt = prompt_base
        remainder = padded_prompt.shape[-1] % self.full_hop
        if remainder:
            padded_prompt = self.torch_functional.pad(
                padded_prompt, (0, self.full_hop - remainder)
            )
        padded_prompt = self.torch_functional.pad(
            padded_prompt, (0, self.full_hop * offset_frames)
        )

        with self.torch.inference_mode():
            prompt_latent = self.model.vae.encode(
                padded_prompt.unsqueeze(0).to(self.device)
            )
        if offset_frames:
            prompt_latent = prompt_latent[..., :-offset_frames]
        prompt_duration_frames = int(prompt_latent.shape[-1])
        prompt_seconds = (
            prompt_duration_frames * self.full_hop / self.sample_rate
        )
        generated_seconds = estimate_clone_generated_duration(
            text,
            reference_text,
            prompt_seconds,
            self.maximum_duration,
        )
        generated_frames = max(
            1, int(generated_seconds * self.sample_rate // self.full_hop)
        )
        total_frames = min(
            generated_frames + prompt_duration_frames,
            int(self.maximum_duration * self.sample_rate // self.full_hop),
        )

        with self.torch.inference_mode():
            output = self.model(
                input_ids=inputs.input_ids,
                attention_mask=inputs.attention_mask,
                prompt_audio=prompt_audio,
                duration=total_frames,
                steps=steps,
                cfg_strength=cfg_strength,
                guidance_method=guidance_method,
            )
        return waveform_to_wav_bytes(output.waveform, self.sample_rate)


async def persist_reference_upload(upload: UploadFile, suffix: str) -> Path:
    """Persist a bounded upload and remove partial files after any read failure."""
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="wb", prefix="longcat-reference-", suffix=suffix, delete=False
        ) as temporary_file:
            temporary_path = Path(temporary_file.name)
            total_bytes = 0
            while chunk := await upload.read(UPLOAD_CHUNK_BYTES):
                total_bytes += len(chunk)
                if total_bytes > MAX_REFERENCE_AUDIO_BYTES:
                    raise OverflowError(
                        "reference_audio exceeds the "
                        f"{MAX_REFERENCE_AUDIO_BYTES}-byte limit"
                    )
                temporary_file.write(chunk)

        if total_bytes == 0:
            raise ValueError("reference_audio is empty")
        return temporary_path
    except Exception:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
        raise
    finally:
        await upload.close()


engine: AudioDiTEngine | None = None
inference_lock = asyncio.Lock()


@asynccontextmanager
async def lifespan(_: FastAPI):
    """Load one checkpoint once and release its CUDA cache at shutdown."""
    global engine
    model_id = os.environ.get("LONGCAT_MODEL_ID", DEFAULT_MODEL_ID)
    requested_device = os.environ.get("LONGCAT_DEVICE", "auto")
    engine = await asyncio.to_thread(AudioDiTEngine, model_id, requested_device)
    try:
        yield
    finally:
        loaded_engine = engine
        engine = None
        if loaded_engine is not None and loaded_engine.device.type == "cuda":
            loaded_engine.torch.cuda.empty_cache()


app = FastAPI(
    title="LongCat AudioDiT local adapter",
    description="OpenAI-style TTS and multipart voice cloning for LongCat AudioDiT",
    version="1.0.0",
    lifespan=lifespan,
)


def get_engine() -> AudioDiTEngine:
    if engine is None:
        raise HTTPException(status_code=503, detail="AudioDiT is not loaded")
    return engine


def wav_response(audio: bytes) -> Response:
    return Response(
        content=audio,
        media_type="audio/wav",
        headers={"Cache-Control": "no-store", "X-Audio-Sample-Rate": str(SAMPLE_RATE)},
    )


@app.get("/")
@app.get("/health")
async def health() -> dict[str, object]:
    loaded_engine = get_engine()
    return {
        "status": "healthy",
        "model_loaded": True,
        "model": loaded_engine.model_id,
        "device": str(loaded_engine.device),
        "sample_rate": loaded_engine.sample_rate,
    }


@app.get("/v1/models")
async def list_models() -> dict[str, object]:
    loaded_engine = get_engine()
    return models_response(loaded_engine.model_id)


@app.post("/v1/audio/speech")
async def create_speech(request: SpeechRequest) -> Response:
    loaded_engine = get_engine()
    try:
        text = prepare_text(request.input, "input", MAX_INPUT_CHARACTERS)
        validate_loaded_model_id(request.model, loaded_engine.model_id)
        validate_generation_parameters(
            request.steps,
            request.cfg_strength,
            request.guidance_method,
            request.seed,
        )
        validate_ignored_openai_speed(request.speed)
        async with inference_lock:
            audio = await asyncio.to_thread(
                loaded_engine.synthesize,
                model_id=request.model,
                text=text,
                steps=request.steps,
                cfg_strength=request.cfg_strength,
                guidance_method=request.guidance_method,
                seed=request.seed,
            )
        return wav_response(audio)
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        logger.exception("AudioDiT speech generation failed")
        raise HTTPException(
            status_code=500, detail="Audio generation failed"
        ) from error


@app.post("/v1/audio/voice-clone")
async def create_voice_clone(
    input: str = Form(..., min_length=1, max_length=MAX_INPUT_CHARACTERS),
    reference_audio: UploadFile = File(...),
    reference_text: str = Form(
        ..., min_length=1, max_length=MAX_REFERENCE_TEXT_CHARACTERS
    ),
    model: str = Form(DEFAULT_MODEL_ID),
    response_format: Literal["wav"] = Form("wav"),
    steps: int = Form(DEFAULT_STEPS, ge=MIN_STEPS, le=MAX_STEPS),
    cfg_strength: float = Form(
        DEFAULT_CFG_STRENGTH,
        ge=MIN_CFG_STRENGTH,
        le=MAX_CFG_STRENGTH,
    ),
    guidance_method: Literal["cfg", "apg"] = Form(DEFAULT_GUIDANCE_METHOD),
    seed: int = Form(DEFAULT_SEED, ge=0, le=MAX_SEED),
) -> Response:
    """Clone only when a reference clip and its matching transcript are supplied."""
    del response_format  # The Literal validator guarantees the only output format.
    loaded_engine = get_engine()
    temporary_path: Path | None = None
    try:
        text = prepare_text(input, "input", MAX_INPUT_CHARACTERS)
        validate_loaded_model_id(model, loaded_engine.model_id)
        validate_generation_parameters(
            steps, cfg_strength, guidance_method, seed
        )
        transcript = prepare_text(
            reference_text,
            "reference_text",
            MAX_REFERENCE_TEXT_CHARACTERS,
        )
        suffix = validate_upload_metadata(
            reference_audio.content_type, reference_audio.size
        )
        temporary_path = await persist_reference_upload(reference_audio, suffix)

        async with inference_lock:
            audio = await asyncio.to_thread(
                loaded_engine.clone_voice,
                model_id=model,
                text=text,
                reference_text=transcript,
                reference_path=temporary_path,
                steps=steps,
                cfg_strength=cfg_strength,
                guidance_method=guidance_method,
                seed=seed,
            )
        return wav_response(audio)
    except OverflowError as error:
        raise HTTPException(status_code=413, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error
    except Exception as error:
        logger.exception("AudioDiT voice cloning failed")
        raise HTTPException(status_code=500, detail="Voice cloning failed") from error
    finally:
        await reference_audio.close()
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8300)
    parser.add_argument("--model", choices=OFFICIAL_MODEL_IDS, default=DEFAULT_MODEL_ID)
    parser.add_argument(
        "--device",
        default="auto",
        help="PyTorch device such as cuda:0, cpu, or auto (CUDA is practical)",
    )
    parser.add_argument("--log-level", default="info")
    arguments = parser.parse_args()

    os.environ["LONGCAT_MODEL_ID"] = arguments.model
    os.environ["LONGCAT_DEVICE"] = arguments.device
    logging.basicConfig(level=arguments.log_level.upper())

    import uvicorn

    uvicorn.run(
        app,
        host=arguments.host,
        port=arguments.port,
        log_level=arguments.log_level,
    )


if __name__ == "__main__":
    main()
