---
sidebar_position: 13
title: 'MLX LM on Apple Silicon'
description: 'Run a local OpenAI-compatible MLX server on macOS and connect it to Libre WebUI.'
slug: /MLX_APPLE_SILICON
keywords:
  [mlx, mlx-lm, apple silicon, macos, local ai, openai compatible, metal]
---

# MLX LM on Apple Silicon

Libre WebUI includes an **MLX LM (Apple Silicon)** plugin for running
MLX-formatted language models directly on an M-series Mac. The plugin connects
to the OpenAI-compatible HTTP API built into
[MLX LM](https://github.com/ml-explore/mlx-lm).

This path is useful when you want native Metal inference without converting an
MLX checkpoint to an Ollama or GGUF model.

## Architecture

```text
Libre WebUI in native development mode
  frontend http://localhost:5173
  backend  http://localhost:3001
                  |
                  | OpenAI-compatible chat request
                  v
mlx_lm.server http://127.0.0.1:8081
                  |
                  v
MLX model on Apple Silicon unified memory
```

Port `8081` is intentional. MLX LM normally defaults to `8080`, which conflicts
with the packaged `npx libre-webui` server.

## Requirements

- An Apple Silicon Mac (M1 or newer).
- macOS with the Xcode command-line tools available.
- Python 3.10 or newer.
- Enough unified memory for the selected model, its KV cache, and macOS.
- Libre WebUI running natively. The source development workflow is the simplest
  setup because both backends can use the Mac loopback interface.

The default Ternary Bonsai model is about 8.5 GB on disk and needs more memory
while running. A Mac with 16 GB unified memory can handle shorter contexts, but
24 GB or more leaves more practical headroom. Use a smaller MLX checkpoint and
add its repository ID to a copied plugin definition if memory is tight.

## Install MLX LM

Using uv keeps the command isolated from Homebrew Python packages:

```bash
brew install uv
uv tool install --upgrade mlx-lm
rehash
mlx_lm.server --help
```

If the tool already exists:

```bash
uv tool upgrade mlx-lm
rehash
```

Qwen 3.5 models require `mlx-lm` 0.30.7 or newer. The repository example
requires 0.31.3 or newer.

## Start the Server

For the Ternary Bonsai model:

```bash
mlx_lm.server \
  --model "prism-ml/Ternary-Bonsai-27B-mlx-2bit" \
  --host 127.0.0.1 \
  --port 8081 \
  --max-tokens 262144 \
  --allowed-origins "http://localhost:5173,http://127.0.0.1:5173"
```

The first run downloads the model from Hugging Face. Later runs use the local
cache. Ternary Bonsai declares `262144` maximum positions. The prompt and
generated output share that context window, so a long prompt reduces the number
of tokens that can be generated even though the server allowance is set to the
[model maximum](https://huggingface.co/prism-ml/Ternary-Bonsai-27B-mlx-2bit/blob/main/config.json).

For a smaller starter model:

```bash
mlx_lm.server \
  --model "mlx-community/Llama-3.2-3B-Instruct-4bit" \
  --host 127.0.0.1 \
  --port 8081 \
  --max-tokens 2048
```

The repository also contains a reusable launcher:

```bash
cd examples/mlx-lm-server
uv run server.py
```

Inspect the resolved command without loading a model:

```bash
uv run server.py --dry-run
```

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
    "model": "prism-ml/Ternary-Bonsai-27B-mlx-2bit",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Reply with: MLX is ready."}
    ],
    "temperature": 0.7,
    "top_p": 0.95,
    "max_tokens": 64,
    "stream": false
  }'
```

The server also supports streaming Server-Sent Events when `"stream": true`.

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

- `prism-ml/Ternary-Bonsai-27B-mlx-2bit`

The model selected in Libre WebUI must match a model available to the MLX
server. To use another checkpoint, export or copy `plugins/mlx-lm.json`, add the
repository ID to `model_map`, and import the edited definition from
**Settings > Plugins**.

## Generation Settings

Ternary Bonsai's published recommendations are:

| Setting     | Value  |
| ----------- | ------ |
| Temperature | `0.7`  |
| Top P       | `0.95` |
| Top K       | `20`   |

Libre WebUI sends temperature and Top P through the plugin. Start the server
with `--top-k 20` when you want its Top K recommendation:

```bash
mlx_lm.server \
  --model "prism-ml/Ternary-Bonsai-27B-mlx-2bit" \
  --host 127.0.0.1 \
  --port 8081 \
  --top-k 20 \
  --max-tokens 262144
```

## Work and Tool Calling

The MLX plugin can appear in Work because it uses the OpenAI-compatible chat
format. Choose it for Work only when the model and its chat template reliably
support OpenAI-style tool calls. Ordinary text generation working in Chat does
not prove that a checkpoint supports tools.

Tool parsers and model templates change quickly. If a Work run returns malformed
tool calls, update `mlx-lm`, test the same tool request directly against the
server, and try a model whose MLX card explicitly documents tool use.

## Docker Networking

Native Libre WebUI development is recommended. A container cannot reach the
Mac's `127.0.0.1`.

If Libre WebUI runs in Docker:

1. Start MLX LM with `--host 0.0.0.0`.
2. Use a private Mac LAN address such as
   `http://192.168.1.20:8081/v1/chat/completions` as the plugin endpoint.
3. Allow port `8081` only on trusted local networks.

Do not expose `mlx_lm.server` directly to the public internet. Its maintainers
describe it as a local server with only basic security checks. Put an
authenticated HTTPS reverse proxy in front of it for any non-local deployment.

## Troubleshooting

**`Model type qwen3_5 not supported`**

An older launcher is still being used:

```bash
rehash
which -a mlx_lm.server
uv tool upgrade mlx-lm
```

**Libre WebUI shows the model but requests fail**

Verify the same model ID works directly:

```bash
curl http://127.0.0.1:8081/v1/models
```

Then confirm the plugin endpoint includes `/v1/chat/completions`.

**Address already in use**

Keep Libre WebUI on its normal port and move MLX:

```bash
mlx_lm.server --model "owner/model" --port 8082
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
