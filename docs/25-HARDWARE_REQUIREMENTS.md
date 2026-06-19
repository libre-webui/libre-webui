---
sidebar_position: 25
title: 'Hardware Requirements'
description: 'Hardware guidance for running Libre WebUI with local Ollama models.'
slug: /HARDWARE_REQUIREMENTS
keywords:
  [
    hardware requirements,
    gpu for llm,
    vram requirements,
    ollama hardware,
    local ai hardware,
  ]
---

# Hardware Requirements

Libre WebUI itself is lightweight. Hardware requirements mainly depend on the models you run through Ollama.

## Quick Reference

| Hardware                            | Practical local models | Notes                           |
| ----------------------------------- | ---------------------- | ------------------------------- |
| 8 GB RAM, CPU only                  | 1B-4B quantized        | Good for testing and light chat |
| 16 GB RAM, CPU only                 | 4B-8B quantized        | Usable, slower than GPU         |
| 8 GB VRAM                           | 4B-8B quantized        | Good daily local setup          |
| 12-16 GB VRAM                       | 8B-14B quantized       | Strong workstation range        |
| 24 GB VRAM                          | 14B-32B quantized      | High-end local use              |
| 48 GB+ VRAM or large unified memory | 32B-70B quantized      | Large model experimentation     |

Actual speed depends on model architecture, quantization, context length, GPU drivers, and what else is running.

## Good Starting Models

```bash
ollama pull gemma3:4b
ollama pull qwen3:8b
ollama pull deepseek-r1:8b
ollama pull nomic-embed-text
```

Use `nomic-embed-text` for document embeddings, not as a chat model.

## VRAM vs RAM

VRAM is the biggest factor for local model speed. If the model fits in VRAM, responses are much faster. If it spills into system RAM, it may still work but will be slower.

System RAM matters for CPU inference, GPU offload, long context windows, and running the rest of the app.

## Apple Silicon

Apple Silicon uses unified memory, so model memory comes from the same pool as the OS and applications. Larger unified-memory machines can run larger quantized models than their GPU VRAM number would suggest on a discrete-GPU system.

Keep enough free memory for the browser, backend, and operating system.

## NVIDIA

NVIDIA GPUs generally have the best local inference compatibility through CUDA. Use current drivers and confirm Docker GPU access if running Ollama in containers.

## AMD and Intel

AMD and Intel support depends on Ollama and driver support for your platform. CPU inference remains available when GPU acceleration is not.

## Reducing Memory Use

- Use smaller models.
- Use Q4 quantization instead of Q8.
- Lower context length.
- Unload models you are not using.
- Keep document embeddings separate from chat model choice.

## Related Docs

- [Working with Models](./WORKING_WITH_MODELS)
- [Docker](./DOCKER)
- [Kubernetes](./KUBERNETES)
- [Troubleshooting](./TROUBLESHOOTING)
