# MLX LM Server for Libre WebUI

This example launches the official `mlx_lm.server` with safe defaults for a
native Libre WebUI development environment on Apple Silicon.

## Quick Start with uv

From this directory:

```bash
uv run server.py
```

The PEP 723 metadata in `server.py` installs `mlx-lm` in uv's isolated
environment. The default model is
`prism-ml/Ternary-Bonsai-27B-mlx-2bit`.

To use another MLX model:

```bash
uv run server.py --model mlx-community/Llama-3.2-3B-Instruct-4bit
```

## Quick Start with venv

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

The server listens only on `127.0.0.1:8081`. Libre WebUI's bundled MLX plugin
uses:

```text
http://127.0.0.1:8081/v1/chat/completions
```

## Verify the API

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/v1/models
```

```bash
curl http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prism-ml/Ternary-Bonsai-27B-mlx-2bit",
    "messages": [{"role": "user", "content": "Reply with: MLX is ready."}],
    "temperature": 0.7,
    "top_p": 0.95,
    "max_tokens": 64
  }'
```

## Libre WebUI

Start Libre WebUI from the repository root with `npm run dev`, open
`http://localhost:5173`, then activate **MLX LM (Apple Silicon)** in
**Settings > Plugins**. No API key is required.

See [the complete MLX guide](../../docs/34-MLX_APPLE_SILICON.md) for custom
models, Docker networking, memory guidance, and troubleshooting.
