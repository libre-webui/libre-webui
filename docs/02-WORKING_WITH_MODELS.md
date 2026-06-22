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

## Local vs Cloud Models

| Mode             | Strengths                                              | Tradeoffs                                                     |
| ---------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| Local Ollama     | Private, offline after download, predictable cost      | Depends on your CPU/GPU/RAM                                   |
| Ollama Cloud     | Familiar Ollama workflow without local hardware limits | Requires cloud access and network                             |
| Provider plugins | Access to managed models from multiple providers       | API keys, provider pricing, and provider privacy policy apply |

You can keep local models for private work and enable provider plugins for tasks that need larger hosted models.

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

- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Plugin Architecture](./PLUGIN_ARCHITECTURE)
- [Hugging Face Hub](./HUGGINGFACE_HUB)
- [Troubleshooting](./TROUBLESHOOTING)
