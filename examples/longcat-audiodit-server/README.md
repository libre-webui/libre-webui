# LongCat AudioDiT adapter for Libre WebUI

This directory supplies the HTTP layer that the official
[LongCat AudioDiT](https://github.com/meituan-longcat/LongCat-AudioDiT)
project does not provide. It loads the official `audiodit` implementation and
the official `meituan-longcat/LongCat-AudioDiT-1B` or
`meituan-longcat/LongCat-AudioDiT-3.5B` checkpoint, then exposes:

- `POST /v1/audio/speech` — OpenAI-style JSON text-to-speech
- `POST /v1/audio/voice-clone` — multipart voice cloning with a required
  reference transcript
- `GET /v1/models` — the single checkpoint loaded by this server process
- `GET /health` — loaded model, device, and output sample rate

Every successful synthesis response is a mono, 24 kHz PCM-16 WAV. AudioDiT is
non-streaming, and one checkpoint is loaded per server process. GPU inference
is serialized to prevent concurrent requests from racing global RNG state or
overcommitting VRAM.

## Hardware and language guidance

An NVIDIA CUDA GPU is the practical target. The 1B checkpoint is the sensible
starting point; the 3.5B checkpoint requires substantially more GPU memory and
takes longer to load and synthesize. `--device cpu` is available for
experimentation, but diffusion inference on CPU is generally not interactive.

The official project reports and demonstrates its strongest coverage in
English and Mandarin Chinese. Keep punctuation natural, and prefer short,
complete sentences. The 1B checkpoint has a 30-second total-duration context;
the official 3.5B checkpoint extends that context to 60 seconds. The plugin and
adapter nevertheless enforce a conservative 140-character generated-text cap
for both checkpoints. Under LongCat's official duration heuristic, roughly 143
Chinese characters can already fill the 1B window. Keeping one cross-model cap
lets Libre WebUI create safe, natural batches before inference rather than
silently clipping a dense Chinese chunk. The 3.5B model retains its longer
context for reference-audio conditioning and duration estimation.

## Voice-cloning safety

Only clone a voice when the speaker has explicitly consented to that use. Do
not impersonate a person, bypass authentication, mislead listeners, or use
private recordings without permission. You are responsible for disclosure and
for complying with applicable biometric, privacy, publicity, and recording
laws.

The `reference_text` field is mandatory and must accurately match the words
spoken in `reference_audio`. A clean 3–10 second clip with one speaker and
little background noise is recommended. The adapter rejects references over 15
seconds or 10 MiB. It accepts WAV, FLAC, MP3, and Ogg uploads with a matching
audio MIME type. Uploaded files are deleted after each request, including on
decode or inference failure.

AudioDiT has no published named preset voices. The JSON endpoint accepts an
empty or provider-supplied `voice` field for OpenAI request compatibility, but
does not use it. Use the explicit voice-cloning endpoint for a consented voice
reference.

## Local setup

Use a dedicated Python environment and clone the official source next to (or
elsewhere than) this repository:

```bash
git clone https://github.com/meituan-longcat/LongCat-AudioDiT.git
python3 -m venv .venv
source .venv/bin/activate
pip install -r examples/longcat-audiodit-server/requirements.txt

export PYTHONPATH="$PWD/LongCat-AudioDiT"
python examples/longcat-audiodit-server/server.py \
  --model meituan-longcat/LongCat-AudioDiT-1B \
  --device cuda:0
```

The first start downloads the selected Hugging Face checkpoint. The server
binds to `127.0.0.1:8300` by default and intentionally has no authentication;
do not expose it directly to an untrusted network. Start the server with the
same checkpoint selected in Libre WebUI. To use the 3.5B checkpoint, restart it
with `--model meituan-longcat/LongCat-AudioDiT-3.5B`.

### Docker with NVIDIA Container Toolkit

From this example directory:

```bash
docker build -t libre-longcat-audiodit .
docker run --rm --gpus all \
  -p 127.0.0.1:8300:8300 \
  -v longcat-hf-cache:/root/.cache/huggingface \
  libre-longcat-audiodit
```

Select the larger checkpoint by overriding both the model and command:

```bash
docker run --rm --gpus all \
  -p 127.0.0.1:8300:8300 \
  -v longcat-hf-cache:/root/.cache/huggingface \
  -e LONGCAT_MODEL_ID=meituan-longcat/LongCat-AudioDiT-3.5B \
  libre-longcat-audiodit \
  python /app/server.py --host 0.0.0.0 --port 8300 \
    --model meituan-longcat/LongCat-AudioDiT-3.5B --device cuda:0
```

The Docker image pins a reviewed official source commit through the
`LONGCAT_SOURCE_COMMIT` build argument. Override that argument deliberately to
test a newer official revision.

## Requests

Text-to-speech accepts only `wav`. The adapter accepts `speed` values from
`0.25` through `4.0` for OpenAI request compatibility, but deliberately ignores
them because AudioDiT does not expose time scaling. Speech timing therefore
comes from the model rather than the requested multiplier:

```bash
curl http://localhost:8300/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "meituan-longcat/LongCat-AudioDiT-1B",
    "input": "The next batch should begin on a natural sentence boundary.",
    "voice": "",
    "response_format": "wav",
    "speed": 1.5,
    "steps": 16,
    "cfg_strength": 4.0,
    "guidance_method": "cfg",
    "seed": 1024
  }' \
  --output speech.wav
```

Voice cloning is multipart, and `reference_text` is required:

```bash
curl http://localhost:8300/v1/audio/voice-clone \
  -F 'model=meituan-longcat/LongCat-AudioDiT-1B' \
  -F 'input=This sentence uses the consented reference voice.' \
  -F 'reference_text=This transcript exactly matches the reference recording.' \
  -F 'reference_audio=@reference.wav;type=audio/wav' \
  -F 'response_format=wav' \
  -F 'steps=16' \
  -F 'cfg_strength=4.0' \
  -F 'guidance_method=apg' \
  -F 'seed=1024' \
  --output cloned.wav
```

Generated `input` is limited to 140 characters per request so Libre WebUI can
batch longer passages without silent duration clipping. `steps` is bounded to
2–64, `cfg_strength` to 0–20, and `seed` to 0–2,147,483,647. Libre WebUI
forwards those four controls from the plugin's declared request variables to
both JSON synthesis and multipart cloning. Both endpoints reject
empty/control-only text and oversized input before inference. Voice cloning
also rejects generated text whose estimated speech would not fit beside the
decoded reference in the resident checkpoint's duration window; shorten the
reference or generate a shorter passage when that dynamic limit is reached.

## Verification

The unit tests exercise the adapter's pure validation helpers and the bundled
manifest without downloading either checkpoint:

```bash
python -m unittest discover -s examples/longcat-audiodit-server -p 'test_*.py'
python -m py_compile examples/longcat-audiodit-server/server.py
python -m json.tool plugins/longcat-audiodit.json >/dev/null
```
