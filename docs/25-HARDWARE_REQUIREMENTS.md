---
sidebar_position: 25
title: 'Hardware Requirements'
description: 'Hardware guidance for Libre WebUI, local Ollama models, and container-backed Work tasks.'
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

Libre WebUI's normal Chat interface is lightweight. Most resource demand comes
from local Ollama models; container-backed Work tasks add a separate CPU, memory,
process, image, and project-storage budget.

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
ollama pull gemma4:12b
ollama pull qwen3.8:27b
ollama pull gemma4:26b
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

## Work Runtime Capacity

Work adds container resources beyond the WebUI and model process. Each active
task container defaults to:

- 2 GB of memory;
- 2 CPUs; and
- 256 processes.

The backend allows two active container-backed tasks across the instance and one
per administrator by default. These are limits, not reservations, but operators
should budget for the WebUI backend, browser, Docker, Ollama, and task container
at the same time. On Apple Silicon, they all ultimately compete for the same
unified-memory pool.

Using Ollama Cloud or a configured remote model plugin can avoid loading a large
model into local RAM or VRAM. It does not remove the Docker requirement or the
resources needed by the Work container.

Every Work task also owns a Docker named volume for generated files and local
dependencies. Volumes do not currently have per-task disk quotas, so package
installs or generated projects can exhaust Docker storage. Monitor the Docker
data root, set host-level limits where available, and back up task volumes
separately from the Libre WebUI database.

Tune the `WORK_MEMORY_LIMIT`, `WORK_CPU_LIMIT`, `WORK_PIDS_LIMIT`, and
`WORK_MAX_ACTIVE_RUNTIMES_*` settings only after measuring the backend host. See
the [environment variable reference](./ENVIRONMENT_VARIABLES) for defaults.

## Related Docs

- [Working with Models](./WORKING_WITH_MODELS)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
- [Kubernetes](./KUBERNETES)
- [Troubleshooting](./TROUBLESHOOTING)
