---
sidebar_position: 3
title: "Working with AI Models"
description: "Complete guide to 207+ AI models in Libre WebUI. Advanced model management with Ollama, OpenAI, Claude, Gemini, and more. Superior features for AI enthusiasts."
slug: /WORKING_WITH_MODELS
keywords: [libre webui ai models, 207+ ai models, ollama models, ai model management, gemma, llama, phi4, deepseek, qwen, claude models, openai models, local ai models, open webui alternative]
image: /img/social/02.png
---

# 🤖 Working with AI Models in Libre WebUI

This guide explains how to use AI models in Libre WebUI. Whether you're new to AI or an experienced user, this guide will help you get the most out of your local AI assistant.

:::tip Reading Time
**~8 minutes** - Complete guide from basics to advanced model management
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
  <TabItem value="starter" label="🌱 Starter Models" default>
    
**Perfect for newcomers and everyday use:**

| Model | Size | Memory | Best For |
|-------|------|--------|----------|
| **gemma3:4b** | ~4GB | 8GB RAM | **Most users** - Best balance |
| **llama3.2:1b** | ~1GB | 4GB RAM | **Fast responses** - Ultra-quick |
| **phi4:14b** | ~14GB | 16GB RAM | **Power users** - Microsoft's best |

:::tip Recommended Starting Point
**gemma3:4b** is currently the best single-GPU model for most users. Great balance of speed and intelligence.
:::

  </TabItem>
  <TabItem value="advanced" label="🚀 Advanced Models">
    
**For users with powerful hardware:**

| Model | Size | Memory | Best For |
|-------|------|--------|----------|
| **llama3.3:70b** | ~40GB | 64GB RAM | **State-of-the-art** performance |
| **deepseek-r1:32b** | ~16GB | 32GB RAM | **Advanced reasoning** |
| **devstral:24b** | ~12GB | 24GB RAM | **Best for coding** |
| **qwen2.5vl:32b** | ~16GB | 32GB RAM | **Image understanding** |

:::warning Hardware Requirements
These models require significant RAM and processing power. Check your system specifications first.
:::

  </TabItem>
  <TabItem value="specialized" label="🎯 Specialized Models">
    
**For specific use cases:**

| Model | Size | Specialty | Use Case |
|-------|------|-----------|----------|
| **qwen2.5vl:3b** | ~3GB | **Vision** | Analyze images and photos |
| **devstral:24b** | ~12GB | **Coding** | Programming assistance |
| **deepseek-r1:32b** | ~16GB | **Reasoning** | Complex problem solving |
| **llama4:16x17b** | ~16GB | **Multimodal** | Text, images, and more |

:::info Model Selection Tips
- **Vision tasks** → qwen2.5vl models
- **Programming** → devstral models  
- **Reasoning** → deepseek-r1 models
- **General use** → gemma3 or llama3 models
:::

  </TabItem>
</Tabs>

### **Advanced Models**
- **llama3.3:70b** - State-of-the-art performance (40GB+)
- **deepseek-r1:32b** - Advanced reasoning (16GB)
- **devstral:24b** - Best for coding (12GB)
- **qwen2.5vl:32b** - Image understanding (16GB)

### **Model Sizes**
- **1B** = ~1GB memory, ultra-fast
- **4B** = ~3GB memory, great balance
- **14B** = ~8GB memory, powerful
- **32B+** = 16GB+ memory, professional use

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

## 🔍 Model Capabilities Reference

| Model Type | Best For | Memory Needed | Speed |
|------------|----------|---------------|-------|
| **Compact Efficiency** | Quick tasks, edge devices | 1-3GB | Ultra-Fast |
| **Single-GPU Champions** | Balanced performance, daily use | 3-8GB | Fast |
| **Reasoning Specialists** | Complex thinking, problem-solving | 12-16GB | Medium |
| **Vision-Language** | Image analysis, multimodal tasks | 8-32GB | Medium |
| **Coding Agents** | Advanced programming, debugging | 12-24GB | Medium |
| **State-of-the-Art** | Maximum capability, research | 32GB+ | Slower |

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

## 🆘 Troubleshooting

**Model won't download?**
- Check your internet connection
- Make sure you have enough disk space
- Try a smaller model first

**Responses are slow?**
- Try a smaller model (1B or 3B parameters)
- Close other applications to free up memory
- Check if multiple models are loaded

**AI gives strange responses?**
- Adjust the temperature setting
- Try rephrasing your question
- Use a different model for your task

## 📚 Related Documentation

import DocCard from '@theme/DocCard';

<div className="row">
  <div className="col col--12">
    <DocCard
      item={{
        type: 'link',
        href: './AI_DEVELOPMENT_ANALYSIS',
        label: '🤖 AI Development Analysis',
        description: 'Use your local models for development insights and smart changelogs'
      }}
    />
  </div>
</div>

---

**Ready to explore?** Head to the [Quick Start Guide](./01-QUICK_START.md) to get your first conversation going!
