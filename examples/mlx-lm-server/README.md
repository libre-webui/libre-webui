# MLX Server for Libre WebUI

This example serves an MLX model to a native Libre WebUI development
environment on Apple Silicon, bound to `127.0.0.1:8081`.

The default model is
[`prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit`](https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit),
which reads text and images. Its weights need the loader that ships inside the
model repository, so stock `mlx_lm.server` cannot load it. For this pack the
script runs mlx-vlm's OpenAI-compatible server with the pack's loader
installed. Any other model goes to the official `mlx_lm.server`.

## Quick Start with uv

From this directory:

```bash
uv run server.py
```

The PEP 723 metadata in `server.py` installs the versions the pack's loader
was built against (`mlx` 0.32.0, `mlx-lm` 0.31.3, `mlx-vlm` 0.6.3,
`transformers` 5.5.0) in uv's isolated environment. The first run downloads
about 8.6 GB into the Hugging Face cache.

To use another MLX model:

```bash
uv run server.py --model mlx-community/Llama-3.2-3B-Instruct-4bit
```

To check how the server would start without loading anything:

```bash
uv run server.py --dry-run
```

## Quick Start with venv

Use Python 3.10 to 3.14; MLX 0.32.0 has no wheels for newer versions.

```bash
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

## What the Bonsai server does

- It loads the pinned revision `aa432fd0e176`, whose `runtime/` loader was
  reviewed for this example. That loader runs as Python on your Mac, so any
  other revision (`--revision`) or a local pack directory (`--model ./pack`)
  needs `--trust-remote-code`.
- It serves only that model. Requests naming another model or an adapter get
  `404`, and `/v1/models` lists the one model.
- Browsers may call it only from the origins in `--allowed-origins` (the
  Libre WebUI development server by default).
- Thinking is on by default, as in the model's chat template. Requests turn it
  off with `"enable_thinking": false`, which Libre WebUI's thinking control
  sends. `--chat-template-args '{"enable_thinking":false}'` changes the default.
- Requests that do not set their own sampling use the pack's generation config:
  temperature 1.0, Top P 0.95, Top K 20.
- The optional MTP draft head is not downloaded or used.

## Verify the API

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/v1/models
```

```bash
curl http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit",
    "messages": [{"role": "user", "content": "Reply with: MLX is ready."}],
    "enable_thinking": false,
    "max_tokens": 64
  }'
```

## Libre WebUI

Start Libre WebUI from the repository root with `npm run dev`, open
`http://localhost:5173`, then activate **MLX LM (Apple Silicon)** in
**Settings > Plugins**. No API key is required. The plugin's endpoint is:

```text
http://127.0.0.1:8081/v1/chat/completions
```

See [the complete MLX guide](../../docs/34-MLX_APPLE_SILICON.md) for custom
models, Docker networking, memory guidance, and troubleshooting.

## Tests

```bash
python3 -m unittest test_server.py
```
