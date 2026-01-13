---
sidebar_position: 25
title: "Hardware Requirements"
description: "Complete guide to hardware requirements for running Libre WebUI with Ollama. GPU, RAM, and CPU recommendations for local LLM inference."
slug: /HARDWARE_REQUIREMENTS
keywords: [hardware requirements, gpu for llm, vram requirements, ollama hardware, local ai hardware, rtx 4090, apple silicon, amd gpu, nvidia gpu]
---

# Hardware Requirements

This guide covers the hardware you need to run AI models locally with Libre WebUI and Ollama. Understanding these requirements will help you choose the right models for your system and get the best performance.

## Quick Reference

| Your Hardware | Recommended Models | Expected Performance |
|---------------|-------------------|---------------------|
| 8GB RAM, no GPU | 1B-3B models (Q4) | 5-15 tokens/sec |
| 16GB RAM, no GPU | 7B models (Q4) | 10-20 tokens/sec |
| 8GB VRAM GPU | 7B-8B models (Q4) | 40-60 tokens/sec |
| 16GB VRAM GPU | 13B-14B models (Q4) | 30-50 tokens/sec |
| 24GB VRAM GPU | 30B+ models (Q4) | 20-40 tokens/sec |
| 48GB+ VRAM | 70B models (Q4) | 15-30 tokens/sec |

## Understanding VRAM vs RAM

**VRAM (GPU memory)** is the most important factor for LLM performance:

- Models that fit entirely in VRAM run **5-20x faster** than CPU inference
- VRAM is a hard limit - if your model doesn't fit, it spills to system RAM
- More VRAM = larger models = better quality responses

**System RAM** serves as a fallback when VRAM is insufficient:

- Minimum 16GB recommended for running 7B models
- 32GB+ recommended for larger models with GPU offloading
- Rule of thumb: RAM should be at least 2x the model size

## GPU Recommendations

### NVIDIA GPUs (Best Compatibility)

NVIDIA's CUDA platform is the industry standard for AI workloads with the best software support.

| GPU | VRAM | Best For | Price Range |
|-----|------|----------|-------------|
| **RTX 5090** | 32GB | 30B+ models, future-proof | $2,000+ |
| **RTX 4090** | 24GB | Up to 34B models, excellent speed | $1,600-2,000 |
| **RTX 4080** | 16GB | 13B-14B models | $1,000-1,200 |
| **RTX 4070 Ti Super** | 16GB | 13B-14B models, good value | $800-900 |
| **RTX 4060 Ti 16GB** | 16GB | 13B-14B models, budget option | $450-500 |
| **RTX 3090** | 24GB | Used market, great value | $700-900 used |
| **RTX 3060 12GB** | 12GB | Entry-level, 8B models | $250-300 |

:::tip Best Value Pick
The **RTX 3060 12GB** is surprisingly capable for local AI. Its 12GB VRAM beats newer cards like the RTX 4060 (8GB) for LLM inference. Great for beginners.
:::

### AMD GPUs

AMD GPUs work with Ollama through ROCm but require more setup on some systems.

| GPU | VRAM | Notes |
|-----|------|-------|
| **RX 7900 XTX** | 24GB | Competitive with RTX 4090 at lower price |
| **RX 7900 XT** | 20GB | Good mid-range option |
| **RX 7800 XT** | 16GB | Budget 13B model option |

:::warning Linux Recommended
AMD GPUs work best on Linux. Windows support is improving but may require manual configuration.
:::

### Apple Silicon

Apple's M-series chips use unified memory, which the CPU and GPU share - a significant advantage for LLMs.

| Chip | Unified Memory | Best For |
|------|----------------|----------|
| **M4 Max** | Up to 128GB | 70B+ models |
| **M4 Pro** | Up to 48GB | 30B models |
| **M4** | Up to 32GB | 13B-14B models |
| **M3 Max** | Up to 128GB | 70B+ models |
| **M3 Pro** | Up to 36GB | 30B models |
| **M2 Ultra** | Up to 192GB | Multiple 70B models |
| **M1/M2/M3** | 8-24GB | 7B-13B models |

:::info Docker Limitation
Docker on Mac does NOT support GPU passthrough. Run Ollama natively on macOS for best performance.
:::

## CPU Requirements

While GPUs dominate inference speed, your CPU still matters:

- **Recommended**: 11th Gen Intel or AMD Zen 4+ with AVX-512 support
- AVX-512 accelerates matrix operations when models run on CPU
- DDR5 memory provides better bandwidth for CPU inference
- Core count matters less than memory bandwidth and instruction set

## Model Size to Hardware Mapping

### Quantization Matters

Quantization compresses model weights, dramatically reducing memory requirements:

| Quantization | Size Reduction | Quality Impact | Use Case |
|--------------|----------------|----------------|----------|
| **Q8_0** | ~50% | Minimal | Best quality, more RAM |
| **Q6_K** | ~62% | Very slight | Quality-focused |
| **Q5_K_M** | ~65% | Slight | Balanced |
| **Q4_K_M** | ~75% | Noticeable for complex tasks | **Recommended default** |
| **Q3_K_S** | ~80% | Significant | Low-memory systems |

:::tip Q4_K_M is the Sweet Spot
Q4_K_M provides the best balance of quality and memory efficiency. An 8B model uses ~5GB instead of ~16GB (FP16) while maintaining excellent output quality.
:::

### VRAM Requirements by Model Size

| Model Size | Q4_K_M | Q8_0 | FP16 |
|------------|--------|------|------|
| **1B** | ~1GB | ~2GB | ~2GB |
| **3B** | ~2GB | ~4GB | ~6GB |
| **7B-8B** | ~5GB | ~8GB | ~16GB |
| **13B-14B** | ~8GB | ~14GB | ~28GB |
| **30B-34B** | ~20GB | ~34GB | ~68GB |
| **70B** | ~42GB | ~70GB | ~140GB |

### Recommended Configurations

#### Budget Setup (~$300-500)
- **GPU**: RTX 3060 12GB (used) or RTX 4060 Ti 16GB
- **RAM**: 16GB DDR4/DDR5
- **Models**: Up to 8B (Q4), some 13B (Q4) with offloading
- **Performance**: 30-50 tokens/sec on 7B models

#### Mid-Range Setup (~$800-1,200)
- **GPU**: RTX 4070 Ti Super 16GB or RX 7900 XT
- **RAM**: 32GB DDR5
- **Models**: Up to 14B (Q4), 7B (Q8)
- **Performance**: 40-60 tokens/sec on 13B models

#### High-End Setup (~$1,600-2,500)
- **GPU**: RTX 4090 24GB
- **RAM**: 64GB DDR5
- **Models**: Up to 34B (Q4), 14B (Q8)
- **Performance**: 50-80 tokens/sec on larger models

#### Professional Setup (~$3,000+)
- **GPU**: RTX 5090 32GB or dual RTX 4090
- **RAM**: 128GB DDR5
- **Models**: 70B (Q4) with some offloading
- **Performance**: Best consumer-grade performance

#### Apple Silicon Setup
- **Mac**: M3/M4 Pro or Max with 36GB+ unified memory
- **Models**: Up to 30B (Q4) natively
- **Performance**: 25-40 tokens/sec, excellent efficiency

## Running Large Models (70B+)

Running 70B parameter models requires significant hardware:

### Minimum for 70B
- **44GB+ VRAM** for Q4 quantization
- Options:
  - 2x RTX 3090 (48GB total, ~$1,400-1,800 used)
  - RTX 4090 + system RAM offloading (slower)
  - Mac with 64GB+ unified memory
  - Cloud GPU (A100 80GB)

### Performance Tradeoff
You *can* run 70B on a single 24GB GPU with memory offloading, but:
- Layers that don't fit in VRAM transfer over PCIe
- Expect 2-5 tokens/sec instead of 15-30 tokens/sec
- Usable for testing, not ideal for production

## Docker Considerations

When running Libre WebUI with Docker:

### CPU-Only Docker
```yaml
# docker-compose.yml - No GPU passthrough
services:
  libre-webui:
    image: librewebui/libre-webui
```
- Uses CPU inference only
- Suitable for small models (1B-7B)
- Slower but works everywhere

### NVIDIA GPU Docker
```yaml
# docker-compose.gpu.yml
services:
  ollama:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```
- Requires NVIDIA Container Toolkit
- Full GPU acceleration
- Best performance option

### External Ollama
```yaml
# docker-compose.external-ollama.yml
services:
  libre-webui:
    environment:
      - OLLAMA_BASE_URL=http://host.docker.internal:11434
```
- Run Ollama natively on host
- Docker only for Libre WebUI
- Best option for macOS and complex GPU setups

## Checking Your Hardware

### Linux/macOS
```bash
# Check NVIDIA GPU
nvidia-smi

# Check available memory
free -h

# Check CPU features
lscpu | grep -i avx
```

### Windows
```powershell
# Check GPU in PowerShell
Get-WmiObject Win32_VideoController | Select-Object Name, AdapterRAM

# Or use nvidia-smi
nvidia-smi
```

### In Ollama
```bash
# See loaded models and memory usage
ollama ps

# See available models
ollama list
```

## Tips for Limited Hardware

1. **Use Q4_K_M quantization** - Best quality-to-size ratio
2. **Start with smaller models** - 7B models are very capable
3. **Close other applications** - Free up RAM and VRAM
4. **Use context length wisely** - Longer context = more memory
5. **Consider cloud options** - For occasional 70B model use

## Further Reading

- [Quick Start](./QUICK_START) - Get running in 60 seconds
- [Working with Models](./WORKING_WITH_MODELS) - Model selection guide
- [Docker Setup](./DOCKER) - Docker deployment options
- [Troubleshooting](./TROUBLESHOOTING) - Common issues and solutions

---

**Sources:**
- [Ollama VRAM Requirements Guide](https://localllm.in/blog/ollama-vram-requirements-for-local-llms)
- [Ollama Hardware Guide](https://www.arsturn.com/blog/ollama-hardware-guide-what-you-need-to-run-llms-locally)
- [Choosing GPUs for LLMs](https://www.databasemart.com/blog/choosing-the-right-gpu-for-popluar-llms-on-ollama)
- [LLM Quantization Explained](https://medium.com/@paul.ilvez/demystifying-llm-quantization-suffixes-what-q4-k-m-q8-0-and-q6-k-really-mean-0ec2770f17d3)
- [Running Llama 70B Affordably](https://abhinand05.medium.com/self-hosting-llama-3-1-70b-or-any-70b-llm-affordably-2bd323d72f8d)
