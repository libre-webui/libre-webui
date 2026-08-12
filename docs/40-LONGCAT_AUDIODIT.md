---
sidebar_position: 40
title: 'LongCat AudioDiT Integration'
description: 'Run LongCat AudioDiT locally for batched text-to-speech and consent-based voice cloning.'
slug: /LONGCAT_AUDIODIT
keywords:
  [
    longcat audiodit,
    tts,
    text-to-speech,
    local tts,
    voice cloning,
    meituan longcat,
  ]
---

# LongCat AudioDiT Integration

Libre WebUI bundles a JSON plugin and a local HTTP adapter for the official
`meituan-longcat/LongCat-AudioDiT-1B` and
`meituan-longcat/LongCat-AudioDiT-3.5B` checkpoints. The upstream project
provides a Python API rather than an HTTP server, so the adapter in
`examples/longcat-audiodit-server` supplies model discovery, JSON speech, and
multipart voice-cloning endpoints.

AudioDiT returns complete 24 kHz mono WAV files rather than a streaming audio
response. Libre WebUI therefore splits longer replies at sentence and phrase
boundaries, generates a bounded set of batches ahead, and schedules decoded
audio in order for continuous playback.

## Requirements

An NVIDIA CUDA GPU is the practical target. Start with the 1B checkpoint; the
3.5B checkpoint needs substantially more VRAM and takes longer to load. CPU is
available for experimentation but is unlikely to be interactive.

## Start the adapter

Clone the official implementation and create an isolated environment:

```bash
git clone https://github.com/meituan-longcat/LongCat-AudioDiT.git
python3 -m venv .venv
source .venv/bin/activate
pip install -r examples/longcat-audiodit-server/requirements.txt
export PYTHONPATH="$PWD/LongCat-AudioDiT"
```

Then start one checkpoint:

```bash
python examples/longcat-audiodit-server/server.py \
  --model meituan-longcat/LongCat-AudioDiT-1B \
  --device cuda:0
```

The server binds to `127.0.0.1:8300` by default. It is intentionally
authentication-free for local use, so do not expose it directly to an
untrusted network. Use an authenticated HTTPS gateway when Libre WebUI and the
adapter are on different hosts: reusable voices send the decrypted reference
recording to that endpoint for every Speech batch. A CUDA Docker example and
health check are documented in `examples/longcat-audiodit-server/README.md`.

## Enable the plugin

Open **Settings → Plugins → LongCat AudioDiT**, activate it, and leave the
default local endpoints unless the adapter runs elsewhere. Model discovery
advertises only the checkpoint resident in that server process. Restart the
adapter to switch between the 1B and 3.5B models.

When a gateway such as llama-swap fronts the adapter, configure the Models API
Endpoint as the adapter's `GET /v1/models` route through that gateway. Do not
point model discovery at `POST /v1/audio/speech`: failed discovery falls back
to both manifest checkpoints and can let the UI select a checkpoint that the
adapter did not load.

Use **Settings → Text-to-Speech** to select LongCat for chat playback. Natural
batched playback is enabled by default. The shared 140-character provider cap
keeps dense Chinese text inside the 1B checkpoint's shorter duration window;
Libre WebUI automatically creates multiple batches for longer responses.

## Voice cloning

Open **Imagine → Audio**, select a LongCat speech model, and enable **Clone a
reference voice**. Upload a clean recording and enter the exact words spoken
in it. A 3–10 second, single-speaker clip with little background noise works
best; the adapter rejects clips above 15 seconds or 10 MiB.

Cloning can remain a one-time generation, or you can select **Save as a reusable
voice**, give the voice a private name, and explicitly confirm that the speaker
consented to storage. Saved voices become selectable for the same LongCat model
under **Settings → Text-to-Speech**. Chat read-aloud and autoplay then reuse
that voice across Libre WebUI's sentence-aware batches.

The reference consumes part of AudioDiT's duration window. If the requested
speech would not fit in the remaining time, the adapter returns a clear client
error instead of silently clipping the audio; shorten the reference or the
generated passage and try again.

Only clone a voice with the speaker's explicit permission. For a one-time
generation, Libre WebUI keeps the reference in memory and the adapter removes
its temporary decoding file after the request. When you explicitly save a
reusable voice, Libre WebUI stores the original reference audio and exact
transcript in a user-scoped, AES-GCM-encrypted profile. It never substitutes
the generated imitation as the canonical reference. AudioDiT does not expose a
portable speaker embedding, so the original pair is decrypted and sent to the
configured provider for each generated batch. You can permanently delete the
profile from Text-to-Speech settings. A saved profile will fail closed if the
plugin's approved routing or endpoint changes; recreate it after verifying the
new destination.

Generated speech is stored separately in the user's encrypted media gallery.
Deleting a gallery result does not delete its saved voice profile, and deleting
a voice profile does not remove previously generated gallery audio.

The provider supports WAV, FLAC, MP3, and Ogg references. English and Mandarin
Chinese are the strongest documented language targets. LongCat does not
publish preset named voices, so ordinary synthesis uses the model default.

## Inference controls

The plugin exposes bounded advanced variables for ODE steps, guidance
strength, CFG/APG guidance method, and seed. Libre WebUI forwards only those
manifest-declared controls to both the speech and cloning endpoints. The
defaults match the upstream inference example and are a good starting point.

AudioDiT does not expose playback-speed control. For compatibility with the
OpenAI speech request shape, the adapter accepts `speed` values from `0.25`
through `4.0` and intentionally ignores them. The model determines the actual
speech timing; choosing another speed does not time-stretch the generated WAV.

See the example's README for direct `curl` requests, Docker commands, exact
limits, and offline validation commands.
