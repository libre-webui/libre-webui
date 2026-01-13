---
sidebar_position: 3
title: "Working with AI Models"
description: "Complete guide to AI models in Libre WebUI. Model selection, hardware requirements, and best practices for Ollama, OpenAI, Claude, Gemini, and more."
slug: /WORKING_WITH_MODELS
keywords: [libre webui ai models, ollama models, ai model management, gemma, llama, phi4, deepseek, qwen, claude models, openai models, local ai models, hardware requirements]
image: /img/social/02.png
---

# Working with AI Models

This guide explains how to use AI models in Libre WebUI. Whether you're new to AI or an experienced user, this guide will help you choose the right models and get the best performance.

:::tip Reading Time
**~10 minutes** - Complete guide from model selection to optimization
:::

## 🎯 What You Can Do

Libre WebUI supports **all the features** that modern AI assistants offer:

<div className="container">
  <div className="row">
    <div className="col col--6">
      <div className="card margin--sm">
        <div className="card__header">
          <h4>💬 Chat & Conversations</h4>
        </div>
        <div className="card__body">
          <ul>
            <li>Have natural conversations with AI models</li>
            <li>Get streaming responses (words appear as they're generated)</li>
            <li>Use advanced settings like temperature and creativity controls</li>
            <li>Create custom system prompts to change the AI's personality</li>
          </ul>
        </div>
      </div>
    </div>
    <div className="col col--6">
      <div className="card margin--sm">
        <div className="card__header">
          <h4>🖼️ Vision & Images</h4>
        </div>
        <div className="card__body">
          <ul>
            <li>Upload images and ask questions about them</li>
            <li>Analyze charts, diagrams, and photographs</li>
            <li>Get help with visual tasks like describing scenes or reading text in images</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
  <div className="row">
    <div className="col col--6">
      <div className="card margin--sm">
        <div className="card__header">
          <h4>📝 Structured Responses</h4>
        </div>
        <div className="card__body">
          <ul>
            <li>Request responses in specific formats (JSON, lists, etc.)</li>
            <li>Get organized summaries and analysis</li>
            <li>Use predefined templates for common tasks</li>
          </ul>
        </div>
      </div>
    </div>
    <div className="col col--6">
      <div className="card margin--sm">
        <div className="card__header">
          <h4>🛠️ Model Management</h4>
        </div>
        <div className="card__body">
          <ul>
            <li>Download and manage AI models locally</li>
            <li>Switch between different models for different tasks</li>
            <li>Monitor model performance and memory usage</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>

---

## 🧠 AI Models Guide

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="starter" label="Starter (8GB VRAM)" default>

**For systems with 8GB VRAM or 16GB RAM:**

| Model | Download Size | VRAM (Q4_K_M) | Speed | Best For |
|-------|--------------|---------------|-------|----------|
| **llama3.2:3b** | 2GB | ~2GB | 60+ tok/s | Fast general use |
| **gemma2:2b** | 1.6GB | ~1.5GB | 70+ tok/s | Quick responses |
| **phi3:3.8b** | 2.3GB | ~2.5GB | 50+ tok/s | Reasoning tasks |
| **llama3.1:8b** | 4.7GB | ~5GB | 40+ tok/s | **Recommended** |
| **qwen2.5:7b** | 4.7GB | ~5GB | 40+ tok/s | Multilingual |

:::tip Best Starting Point
**llama3.1:8b** offers the best balance of quality and speed for most users with 8GB+ VRAM. Use Q4_K_M quantization.
:::

  </TabItem>
  <TabItem value="midrange" label="Mid-Range (16GB VRAM)">

**For systems with 16GB VRAM or 32GB RAM:**

| Model | Download Size | VRAM (Q4_K_M) | Speed | Best For |
|-------|--------------|---------------|-------|----------|
| **llama3.1:8b** | 4.7GB | ~5GB | 50+ tok/s | General use (Q8) |
| **phi4:14b** | 9GB | ~8GB | 35+ tok/s | Microsoft's best |
| **qwen2.5:14b** | 9GB | ~8GB | 35+ tok/s | Strong reasoning |
| **mistral-nemo:12b** | 7GB | ~7GB | 40+ tok/s | Efficient performer |
| **deepseek-coder:6.7b** | 4GB | ~4GB | 45+ tok/s | Code generation |

:::info 16GB Sweet Spot
With 16GB VRAM, you can run 8B models at higher quality (Q8_0) or comfortably run 13-14B models at Q4_K_M.
:::

  </TabItem>
  <TabItem value="highend" label="High-End (24GB+ VRAM)">

**For RTX 4090, Mac M3 Max, or better:**

| Model | Download Size | VRAM (Q4_K_M) | Speed | Best For |
|-------|--------------|---------------|-------|----------|
| **llama3.3:70b** | 43GB | ~42GB | 15-25 tok/s | State-of-the-art |
| **qwen2.5:32b** | 20GB | ~20GB | 25+ tok/s | Strong all-around |
| **deepseek-r1:32b** | 20GB | ~20GB | 25+ tok/s | Advanced reasoning |
| **codestral:22b** | 13GB | ~13GB | 30+ tok/s | Best for coding |
| **llava:34b** | 20GB | ~20GB | 20+ tok/s | Vision + language |

:::warning 70B Model Requirements
**llama3.3:70b** requires 42GB+ VRAM for Q4 quantization. Options: Mac with 64GB+ unified memory, dual RTX 3090, or use with memory offloading (slower).
:::

  </TabItem>
  <TabItem value="specialized" label="Specialized">

**Models optimized for specific tasks:**

| Model | VRAM | Specialty | Use Case |
|-------|------|-----------|----------|
| **llava:7b** | ~5GB | Vision | Image analysis, OCR |
| **llava:13b** | ~8GB | Vision | Better image understanding |
| **codestral:22b** | ~13GB | Code | Programming, debugging |
| **deepseek-coder:33b** | ~20GB | Code | Complex code generation |
| **deepseek-r1:7b** | ~5GB | Reasoning | Chain-of-thought |
| **deepseek-r1:32b** | ~20GB | Reasoning | Advanced problem-solving |

:::info Choosing Specialized Models
- **Vision/Images** → llava or qwen-vl models
- **Programming** → codestral or deepseek-coder
- **Reasoning** → deepseek-r1 models
- **General** → llama3 or qwen2.5 models
:::

  </TabItem>
</Tabs>

### Understanding Model Sizes and Quantization

Model sizes refer to the number of parameters. Quantization compresses these parameters to reduce memory usage:

| Parameters | Q4_K_M Size | Q8_0 Size | FP16 Size | Use Case |
|------------|-------------|-----------|-----------|----------|
| **1-3B** | 1-2GB | 2-4GB | 2-6GB | Fast tasks, mobile |
| **7-8B** | 4-5GB | 7-8GB | 14-16GB | General use |
| **13-14B** | 8-9GB | 13-14GB | 26-28GB | Power users |
| **30-34B** | 18-20GB | 30-34GB | 60-68GB | High-end |
| **70B** | 40-42GB | 70GB | 140GB | Professional |

:::tip Quantization Recommendation
**Q4_K_M** is the recommended quantization for most users. It reduces memory by ~75% with minimal quality loss. Use Q8_0 when you have extra VRAM for better quality.
:::

## 🚀 Getting Started with Models

### Step 1: Download Your First Model
1. Go to the **Models** section in the sidebar
2. Click "Pull Model" 
3. Enter a model name like `gemma3:4b`
4. Wait for the download to complete

### Step 2: Start Chatting
1. Go back to the **Chat** section
2. You'll see your model is now available
3. Type a message and press Enter
4. Watch the AI respond in real-time!

### Step 3: Try Advanced Features
- **Upload an image** (with vision models like `qwen2.5vl:32b`)
- **Adjust settings** like creativity and response length
- **Create custom prompts** to change the AI's behavior

## 🎨 Creative Use Cases

### Writing Assistant
```
"Help me write a professional email to..."
"Proofread this document and suggest improvements"
"Create a story outline about..."
```

### Learning & Research
```
"Explain quantum physics in simple terms"
"What are the pros and cons of..."
"Help me understand this concept by giving examples"
```

### Programming Helper (with devstral:24b)
```
"Create a complete web application with authentication"
"Debug this complex codebase and suggest improvements"
"Build an autonomous coding agent for this project"
```

### Image Analysis (with qwen2.5vl:32b)
```
"What's in this image and what does it mean?"
"Extract all text from this document accurately"
"Analyze this complex chart and provide insights"
```

### Advanced Reasoning (with deepseek-r1:32b)
```
"Think through this complex problem step by step"
"What are the hidden implications of this decision?"
"Solve this multi-step logical puzzle"
```

## ⚙️ Advanced Features

### Custom System Prompts
Change how the AI behaves by setting a system prompt:
```
"You are a helpful programming tutor. Always explain concepts step by step."
"You are a creative writing assistant. Help me brainstorm ideas."
"You are a professional editor. Focus on clarity and grammar."
```

### Structured Outputs
Ask for responses in specific formats:
```
"List the pros and cons in JSON format"
"Give me a summary with bullet points"
"Create a table comparing these options"
```

### Temperature & Creativity
- **Low temperature (0.1-0.3)**: Focused, consistent responses
- **Medium temperature (0.5-0.7)**: Balanced creativity and coherence  
- **High temperature (0.8-1.0)**: More creative and varied responses

## Hardware Requirements Quick Reference

| Your System | Recommended Models | Expected Speed |
|-------------|-------------------|----------------|
| **8GB VRAM** (RTX 3060, RTX 4060) | 7-8B Q4 | 40-60 tok/s |
| **12GB VRAM** (RTX 3060 12GB, RTX 4070) | 8B Q8 or 13B Q4 | 35-50 tok/s |
| **16GB VRAM** (RTX 4070 Ti, RX 7800 XT) | 13-14B Q4 | 30-45 tok/s |
| **24GB VRAM** (RTX 4090, RX 7900 XTX) | 30B Q4 | 25-40 tok/s |
| **48GB+ VRAM** (Dual GPU, Mac M3 Max) | 70B Q4 | 15-30 tok/s |
| **CPU Only** (16GB RAM) | 7B Q4 | 5-15 tok/s |

:::info Need More Details?
See the complete [Hardware Requirements Guide](./HARDWARE_REQUIREMENTS) for GPU recommendations, Apple Silicon performance, and optimization tips.
:::

## 💡 Tips for Better Results

### Writing Better Prompts
- **Be specific**: "Write a 200-word summary" vs "Summarize this"
- **Give context**: "I'm a beginner" or "I'm an expert in..."
- **Ask for examples**: "Show me examples of..."
- **Specify format**: "Give me a numbered list" or "Explain step by step"

### Managing Performance
- **Use smaller models** for simple tasks to save memory
- **Switch models** based on your current task
- **Monitor memory usage** in the Models section
- **Keep frequently used models loaded** for faster responses

### Privacy & Security
✅ **Your data never leaves your computer**
✅ **No internet connection required** (after downloading models)
✅ **Full control over your conversations**
✅ **No tracking or data collection**

## Troubleshooting

**Model won't download?**
- Check your internet connection
- Ensure you have enough disk space (models can be 2-50GB)
- Try: `ollama pull llama3.1:8b` from terminal to see detailed errors

**Responses are slow?**
- Check if model fits in VRAM: `ollama ps` shows memory usage
- Try a smaller model or lower quantization (Q4 instead of Q8)
- Close other GPU-intensive applications
- If using CPU only, expect 5-15 tokens/sec

**Out of memory errors?**
- Use Q4_K_M quantization instead of Q8 or FP16
- Try a smaller model size (8B instead of 14B)
- Check VRAM usage: `nvidia-smi` (NVIDIA) or Activity Monitor (Mac)
- Reduce context length in settings

**AI gives strange or repetitive responses?**
- Lower the temperature setting (try 0.5-0.7)
- Try a different model for your task
- Clear the conversation and start fresh
- Check if you're using the right model type (vision model for images, etc.)

## Related Documentation

- [Hardware Requirements](./HARDWARE_REQUIREMENTS) - Complete GPU and RAM guide
- [Quick Start](./QUICK_START) - Get running in 60 seconds
- [Plugin Architecture](./PLUGIN_ARCHITECTURE) - Add cloud providers (OpenAI, Anthropic, etc.)
- [Troubleshooting](./TROUBLESHOOTING) - Common issues and solutions

---

**Ready to get started?** Head to the [Quick Start Guide](./QUICK_START) to install Libre WebUI, or check [Hardware Requirements](./HARDWARE_REQUIREMENTS) to optimize your setup.
