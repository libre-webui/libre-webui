---
sidebar_position: 13
title: 'MLX LM on Apple Silicon'
description: 'Run a local OpenAI-compatible MLX server on macOS and connect it to Libre WebUI.'
slug: /MLX_APPLE_SILICON
keywords:
  [
    mlx,
    mlx-lm,
    mlx-vlm,
    ternary bonsai,
    apple silicon,
    macos,
    local ai,
    openai compatible,
    metal,
  ]
---

# MLX LM on Apple Silicon

Libre WebUI includes an **MLX LM (Apple Silicon)** plugin for running
MLX-formatted language models directly on an M-series Mac. The plugin connects
to a local OpenAI-compatible HTTP server.

This path is useful when you want native Metal inference without converting an
MLX checkpoint to an Ollama or GGUF model.

The plugin's default model is
[Ternary Bonsai 2.5 27B](https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit)
from Prism ML: a 2-bit model built from Qwen3.8-27B that reads text and images,
reasons before it answers, and has a 262,144-token context. Its weights are
stored in a rotated form that only the loader shipped inside the model
repository can undo, so the stock `mlx_lm.server` cannot load it. The
repository example in `examples/mlx-lm-server` serves it for you. Any other MLX
model runs on [MLX LM](https://github.com/ml-explore/mlx-lm)'s own server.

## Architecture

```text
Libre WebUI in native development mode
  frontend http://localhost:5173
  backend  http://localhost:3001
                  |
                  | OpenAI-compatible chat request
                  v
examples/mlx-lm-server/server.py  http://127.0.0.1:8081
  Ternary Bonsai 2.5: mlx-vlm's server with the pack's loader
  any other model:    mlx_lm.server
                  |
                  v
MLX model on Apple Silicon unified memory
```

Port `8081` is intentional. MLX servers normally default to `8080`, which
conflicts with the packaged `npx libre-webui` server.

## Requirements

- An Apple Silicon Mac (M1 or newer).
- macOS with the Xcode command-line tools available.
- Python 3.10 to 3.14. MLX 0.32.0, which the Bonsai pack is built against,
  publishes no wheels for newer Python versions. `uv` picks a matching Python
  on its own.
- Enough unified memory for the selected model, its KV cache, and macOS.
- Libre WebUI running natively. The source development workflow is the simplest
  setup because both backends can use the Mac loopback interface.

Ternary Bonsai 2.5 is about 8.6 GB on disk and needs more memory while
running. A Mac with 16 GB unified memory can handle shorter contexts, but 24 GB
or more leaves more practical headroom. Use a smaller MLX checkpoint with
`mlx_lm.server` if memory is tight.

## Start Ternary Bonsai 2.5

With [uv](https://docs.astral.sh/uv/) installed (`brew install uv`):

```bash
cd examples/mlx-lm-server
uv run server.py
```

The script:

1. Installs the versions the pack's loader was built against (`mlx` 0.32.0,
   `mlx-lm` 0.31.3, `mlx-vlm` 0.6.3) in an isolated environment, with
   `transformers` 5.10.4 instead of the pack's 5.5.0 to stay clear of two
   file-write advisories in older releases.
2. Downloads the model into the Hugging Face cache at a pinned revision. The
   first run fetches about 8.6 GB; later runs use the cache. The optional MTP
   draft head is skipped because the server does not use it.
3. Loads the weights with the pack's own loader and serves them through
   [mlx-vlm](https://github.com/Blaizzy/mlx-vlm)'s OpenAI-compatible server on
   `127.0.0.1:8081`.

The server is held to this one model. A request naming any other model or an
adapter gets `404`, so nothing a client sends can make it download or run other
code. Browser access is limited to the Libre WebUI development origins, as with
`mlx_lm.server`.

Inspect the resolved launch without loading anything:

```bash
uv run server.py --dry-run
```

Without uv, use a virtual environment on Python 3.10 to 3.14:

```bash
cd examples/mlx-lm-server
python3.13 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
python server.py
```

### The loader runs as Python

The pack's loader lives in its `runtime/` directory and runs as Python on your
Mac. The example loads only the revision that was reviewed for it
(`aa432fd0e176`). Loading any other revision, or a pack you downloaded to a
local directory, needs `--trust-remote-code`:

```bash
uv run server.py --revision main --trust-remote-code
uv run server.py --model ./bonsai-25-mlx --trust-remote-code
```

When you serve a local directory, add that same path to the plugin's
`model_map` (see [Connect Libre WebUI](#connect-libre-webui)), because the
server answers only to the name it was started with.

## Other MLX Models

Any model other than the Bonsai pack starts the official `mlx_lm.server` with
the same local defaults:

```bash
cd examples/mlx-lm-server
uv run server.py --model mlx-community/Llama-3.2-3B-Instruct-4bit
```

You can also run `mlx_lm.server` yourself. Using uv keeps the command isolated
from Homebrew Python packages:

```bash
brew install uv
uv tool install --upgrade mlx-lm
rehash
mlx_lm.server \
  --model "mlx-community/Llama-3.2-3B-Instruct-4bit" \
  --host 127.0.0.1 \
  --port 8081 \
  --max-tokens 2048 \
  --allowed-origins "http://localhost:5173,http://127.0.0.1:5173"
```

The first Ternary Bonsai 27B (`prism-ml/Ternary-Bonsai-27B-mlx-2bit`) is an
ordinary MLX checkpoint and still runs this way. Qwen 3.5 models require
`mlx-lm` 0.30.7 or newer.

## Verify the OpenAI-Compatible API

Check health and model discovery:

```bash
curl http://127.0.0.1:8081/health
curl http://127.0.0.1:8081/v1/models
```

Send a non-streaming chat request:

```bash
curl http://127.0.0.1:8081/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Reply with: MLX is ready."}
    ],
    "enable_thinking": false,
    "max_tokens": 64,
    "stream": false
  }'
```

The server also supports streaming Server-Sent Events when `"stream": true`.
With thinking on, the reasoning arrives in a separate `reasoning` field ahead
of the answer.

## Connect Libre WebUI

From the Libre WebUI repository root:

```bash
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173), then:

1. Open **Settings > Plugins**.
2. Find **MLX LM (Apple Silicon)**.
3. Confirm the endpoint is
   `http://127.0.0.1:8081/v1/chat/completions`.
4. Activate the plugin. Local MLX does not require an API key.
5. Return to Chat and select the MLX model.

The built-in model list includes:

- `prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit`

The model selected in Libre WebUI must match a model available to the MLX
server. To use another checkpoint, export or copy `plugins/mlx-lm.json`, add the
repository ID to `model_map`, and import the edited definition from
**Settings > Plugins**.

Ternary Bonsai 2.5 reads images, so you can attach one to a Chat message.

## Generation Settings

Ternary Bonsai 2.5 ships these sampling settings in its
[generation config](https://huggingface.co/prism-ml/Ternary-Bonsai-2.5-27B-mlx-2bit/blob/main/generation_config.json):

| Setting     | Value  |
| ----------- | ------ |
| Temperature | `1.0`  |
| Top P       | `0.95` |
| Top K       | `20`   |

Libre WebUI sends temperature and Top P through the plugin. The example server
applies the pack's Top K to every request that does not set its own.

The model declares `262144` maximum positions. The prompt and generated output
share that context window, so a long prompt reduces the number of tokens that
can be generated even though the server allowance is set to the model maximum.

## Thinking

Ternary Bonsai 2.5 reasons before it answers unless told not to, and the example
server keeps that default. Libre WebUI's thinking control reaches the model:
turning thinking off skips the reasoning, which also keeps short side tasks
such as follow-up suggestions and titles fast. The plugin sends the switch in
the form both servers read (`enable_thinking` for mlx-vlm and
`chat_template_kwargs` for `mlx_lm.server`).

To make thinking off the server default for clients that do not choose:

```bash
uv run server.py --chat-template-args '{"enable_thinking":false}'
```

## Work and Tool Calling

The MLX plugin can appear in Work because it uses the OpenAI-compatible chat
format. Ternary Bonsai 2.5's chat template supports tool calls, and the example
server turns them into OpenAI `tool_calls`. For other models, choose them for
Work only when the model and its chat template reliably support OpenAI-style
tool calls. Ordinary text generation working in Chat does not prove that a
checkpoint supports tools.

Tool parsers and model templates change quickly. If a Work run returns malformed
tool calls, test the same tool request directly against the server, and try a
model whose MLX card explicitly documents tool use.

## Docker Networking

Native Libre WebUI development is recommended. A container cannot reach the
Mac's `127.0.0.1`.

If Libre WebUI runs in Docker:

1. Start the server with `--host 0.0.0.0`.
2. Use a private Mac LAN address such as
   `http://192.168.1.20:8081/v1/chat/completions` as the plugin endpoint.
3. Allow port `8081` only on trusted local networks.

Do not expose the MLX server directly to the public internet. Both servers are
meant for local use and have only basic security checks. Put an authenticated
HTTPS reverse proxy in front of it for any non-local deployment.

## Troubleshooting

**`Model type prism_hadamard_qwen35 not supported`**

`mlx_lm.server` was started directly on the Bonsai 2.5 pack. Start it through
`examples/mlx-lm-server/server.py` instead, which brings the pack's loader.

**`Model type qwen3_5 not supported`**

An older `mlx_lm.server` is still being used for a Qwen 3.5 model:

```bash
rehash
which -a mlx_lm.server
uv tool upgrade mlx-lm
```

**uv or pip cannot find `mlx==0.32.0`**

The Python in use is newer than 3.14. `uv run server.py` picks a supported
version by itself; for a virtual environment, create it with `python3.13` or
another version from 3.10 to 3.14.

**Libre WebUI shows the model but requests fail**

Verify the same model ID works directly:

```bash
curl http://127.0.0.1:8081/v1/models
```

Then confirm the plugin endpoint includes `/v1/chat/completions`. The Bonsai
server answers `404` for any model name other than the one it was started with.

**Address already in use**

Keep Libre WebUI on its normal port and move MLX:

```bash
uv run server.py --port 8082
```

Update the plugin endpoint to
`http://127.0.0.1:8082/v1/chat/completions`.

**The model is slow on its first request**

Initial loading and prompt prefill are more expensive than token-by-token
generation. Watch Activity Monitor's memory pressure and choose a smaller model
or shorter conversation if macOS starts swapping.

## Related Docs

- [Plugins](./PLUGIN_ARCHITECTURE)
- [Working with Models](./WORKING_WITH_MODELS)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Work: Isolated Workspaces](./WORKSPACES)
