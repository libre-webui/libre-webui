# 🤖 Working with AI Models in Libre WebUI

This guide explains how to use AI models in Libre WebUI. Whether you're new to AI or an experienced user, this guide will help you get the most out of your local AI assistant.

## 🎯 What You Can Do

Libre WebUI supports **all the features** that modern AI assistants offer:

### 💬 **Chat & Conversations**
- Have natural conversations with AI models
- Get streaming responses (words appear as they're generated)
- Use advanced settings like temperature and creativity controls
- Create custom system prompts to change the AI's personality

### 🖼️ **Vision & Images**
- Upload images and ask questions about them
- Analyze charts, diagrams, and photographs
- Get help with visual tasks like describing scenes or reading text in images

### 📝 **Structured Responses**
- Request responses in specific formats (JSON, lists, etc.)
- Get organized summaries and analysis
- Use predefined templates for common tasks

### 🛠️ **Model Management**
- Download and manage AI models locally
- Switch between different models for different tasks
- Monitor model performance and memory usage

## 🧠 Understanding AI Models

### Popular Models to Try

**For Beginners:**
- **gemma3:4b** - Current best single-GPU model, fast and capable
- **llama3.2:1b** - Ultra-lightweight for simple tasks
- **phi4:14b** - Microsoft's compact powerhouse

**For Advanced Users:**
- **llama3.3:70b** - State-of-the-art performance (similar to llama3.1:405b)
- **deepseek-r1:32b** - Advanced reasoning approaching O3 performance
- **devstral:24b** - Best open source model for coding agents
- **qwen2.5vl:32b** - Flagship vision-language model
- **llama4:16x17b** - Meta's latest multimodal collection

### Model Sizes Explained
- **1B parameters** = ~1GB memory, ultra-fast, good for simple tasks
- **4B parameters** = ~3GB memory, current single-GPU champion
- **14B parameters** = ~8GB memory, compact powerhouse performance
- **24B parameters** = ~12GB memory, specialized excellence
- **32B parameters** = ~16GB memory, advanced reasoning capabilities
- **70B+ parameters** = 32GB+ memory, state-of-the-art performance

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

---

**Ready to explore?** Head to the [Quick Start Guide](./01-QUICK_START.md) to get your first conversation going!
