---
sidebar_position: 3
title: 'Working with AI Models'
description: 'Model selection, Ollama management, cloud provider plugins, and performance guidance for Libre WebUI.'
slug: /WORKING_WITH_MODELS
keywords:
  [
    libre webui ai models,
    ollama models,
    ai model management,
    gemma,
    llama,
    deepseek,
    qwen,
    local ai models,
    hardware requirements,
  ]
image: /img/social/02.png
---

# Working with AI Models

Libre WebUI can use local Ollama models and plugin-backed cloud models in the same workspace. The Model Manager shows installed Ollama models, running models, live Ollama Library results, Hugging Face GGUF entries, and Ollama Cloud entries where available.

## Choosing a First Model

Use these as starting points, then switch based on your hardware and task:

| Model              | Good for                               | Typical fit                 |
| ------------------ | -------------------------------------- | --------------------------- |
| `gemma3:4b`        | Fast general chat                      | 8 GB RAM or entry GPU       |
| `qwen3:8b`         | General chat, coding, multilingual use | 16 GB RAM or 6-8 GB VRAM    |
| `deepseek-r1:8b`   | Reasoning-heavy prompts                | 16 GB RAM or 6-8 GB VRAM    |
| `mistral`          | Balanced general assistant work        | 8-16 GB RAM                 |
| `nomic-embed-text` | Document embeddings                    | Small local embedding model |

Large models such as 30B, 70B, and MoE models can be excellent, but they need much more memory. If you are not sure, start small and move up after the model is working smoothly.

## Model Manager

Open **Models** from the sidebar to:

- Pull models from Ollama by name.
- Search the live Ollama Library instead of relying on a static list.
- View installed and running models.
- Stop or unload running models.
- Delete models you no longer need.
- Pull Hugging Face GGUF models through Ollama when compatible.
- Pull Ollama Cloud models from the cloud filter.

For Ollama Cloud results, the UI normalizes cloud model names before pulling. If a cloud model requires the `:cloud` or `-cloud` suffix, Libre WebUI applies that for you from the cloud model flow.

## Model Catalog and Visibility

The **Model Catalog** at the top of the Models page lists every chat model you can pick, local and provider-backed alike, with a provider badge and a search box. Use **Make default** on any row to set the model new chats start with.

Administrators get one more control per row: an eye toggle that hides a model from everyone else's model pickers. Hiding trims long catalogs down to the models a server actually wants people using — it is a listing refinement, not an authorization gate, so treat it as curation rather than a security boundary. Administrators always see the full list, with hidden models marked.

## Local vs Cloud Models

| Mode             | Strengths                                              | Tradeoffs                                                     |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Local Ollama     | Private, offline after download, predictable cost      | Depends on your CPU/GPU/RAM                                   |
| Ollama Cloud     | Familiar Ollama workflow without local hardware limits | Requires cloud access and network                             |
| Provider plugins | Access to managed models from multiple providers       | API keys, provider pricing, and provider privacy policy apply |

You can keep local models for private work and enable provider plugins for tasks that need larger hosted models.

## Default Vision Model

You can chat with a fast text model and still send images. Pick a vision model
under **Settings → Model → Specialized Models → Vision Model**; whenever the
outgoing chat context contains images — a new attachment, an image earlier in
the session, or history in an incognito chat — that turn is routed to the
configured vision model instead of the session model. Text-only turns keep the
session model.

The setting is per user, and the routing is automatic and silent. Leaving the
selection on **Use the current chat model** disables it. Note that the check is
for images, not for the session model's abilities: when a vision model is
configured, every image-bearing turn uses it, even if the session model could
handle images itself.

The selection stores the exact provider identity (Ollama or a specific plugin)
together with the model name, so a provider cannot capture an identically named
model. If the saved selection loses that identity — for example the model or
provider is no longer available — an image-bearing turn fails with:

> The configured vision model has no provider identity. Re-select it in
> Settings > Model > Vision Model.

Re-selecting the model in Settings repairs it. Failing loudly is deliberate;
Libre WebUI does not silently substitute another provider.

## Models for Work

Work needs a chat model that can call tools. It can use:

- An installed Ollama model that advertises the `tools` capability.
- An Ollama Cloud model available through the configured Ollama endpoint.
- A model listed by an active chat or completion plugin with credentials
  configured for the current administrator.

Plugin-backed Work runs use the provider adapter appropriate to the configured
plugin: OpenAI-compatible, Anthropic, or Gemini. Libre WebUI persists the exact
provider type and plugin identifier with the task and each run, so a plugin
cannot capture an identically named Ollama model. If the selected model or
provider rejects tool calling, the run fails instead of silently switching to
another provider.

Local Ollama keeps model requests on the configured Ollama infrastructure.
With a remote model, the configured provider receives the Work system prompt,
conversation, tool definitions, and tool results. Tool results can include
source text, command output, or directory listings requested by the model.
Workspace volumes and provider credentials remain on the backend host, but a
file's contents can leave that host when they are included in a tool result.

One autonomous Work run can make multiple model calls. Check the remote
provider's pricing, retention, and training policies before using sensitive
projects. Libre WebUI shows a remote-provider notice in Work with a per-user
dismiss control.

## Hardware Guide

| System                              | Practical model range | Notes                           |
| ----------------------------------- | --------------------- | ------------------------------- |
| CPU only, 8-16 GB RAM               | 1B-4B                 | Good for light chat and testing |
| 8 GB VRAM                           | 4B-8B quantized       | Comfortable starting point      |
| 12-16 GB VRAM                       | 8B-14B quantized      | Good daily driver range         |
| 24 GB VRAM                          | 14B-32B quantized     | Strong local workstation        |
| 48 GB+ VRAM or large unified memory | 32B-70B quantized     | Large model experimentation     |

Quantized models use less memory. Q4 quantizations are usually the practical default; Q8 uses more memory for better quality.

## Task-Based Recommendations

| Task            | Model direction                                                     |
| --------------- | ------------------------------------------------------------------- |
| Fast chat       | `gemma3:4b`, `mistral`, small Qwen models                           |
| Coding          | Qwen Coder, DeepSeek Coder, Codestral, provider coding models       |
| Reasoning       | DeepSeek-R1 family, larger Qwen models, provider reasoning models   |
| Vision          | Multimodal models such as LLaVA, Qwen VL, or provider vision models |
| Document search | `nomic-embed-text` or another embedding model                       |
| Text-to-speech  | TTS plugins such as Qwen3-TTS or Kyutai TTS                         |

Provider model names change frequently. In Libre WebUI, use the provider’s model discovery where available, or paste the exact model ID from the provider dashboard.

## Prompting and Settings

- Generation controls such as temperature, token limits, context length, and
  penalties are grouped under **Advanced generation settings** and remain
  closed by default.
- Lower temperature (`0.1-0.3`) for factual, repeatable answers.
- Medium temperature (`0.5-0.7`) for normal assistant work.
- Higher temperature (`0.8+`) for brainstorming and creative writing.
- Keep context length reasonable when you are close to memory limits.
- Use personas when you want persistent model parameters and a reusable system prompt.

## Troubleshooting

**Pull fails**

- Confirm Ollama is running: `ollama list`.
- Try the same pull in a terminal to see Ollama’s raw error.
- Check disk space before pulling large models.
- If you are using the Model Manager cloud filter, let Libre WebUI handle cloud suffixes.

**Responses are slow**

- Try a smaller model or a lower quantization.
- Check `ollama ps` to see what is loaded.
- Close other GPU-heavy apps.
- Reduce context length.

**Out of memory**

- Move from Q8 to Q4.
- Use an 8B model instead of a 14B model.
- Keep only the model you need loaded.
- On Docker, confirm the container can reach the GPU or the host Ollama instance.

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Hugging Face Hub](./HUGGINGFACE_HUB)
- [Troubleshooting](./TROUBLESHOOTING)
