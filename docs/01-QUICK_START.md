---
sidebar_position: 2
title: "Quick Start Guide"
description: "Get your first AI chat running in 5 minutes with Libre WebUI. Complete Docker and local installation guide with step-by-step instructions for privacy-first AI."
slug: /QUICK_START
keywords: [libre webui quick start, libre webui setup, ollama installation, docker ai setup, local ai installation, ai chat setup, privacy ai tutorial, open webui alternative setup]
image: /img/social/01.png
---

# 🚀 Quick Start: Your First AI Chat in 5 Minutes

Welcome to Libre WebUI! This guide will get you chatting with AI in just a few minutes. No technical expertise required!

:::tip Complete Setup Time
**Total time: 5-10 minutes** including model download (depending on your internet speed)
:::

## 📋 What You'll Need

- **A computer** with at least 4GB RAM (8GB+ recommended)
- **Internet connection** (for initial setup only)
- **5-10 minutes** of your time

## 🎯 Step 1: Install Ollama (The AI Engine)

Ollama is the engine that runs AI models on your computer. It's free and easy to install.

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="windows" label="Windows" default>
    
**Install Steps:**
1. Visit [ollama.ai](https://ollama.ai)
2. Click **"Download for Windows"**
3. Run the installer and follow the prompts
4. Ollama will start automatically

:::tip Windows Users
The installer will automatically add Ollama to your system PATH, so you can use it from any terminal.
:::

  </TabItem>
  <TabItem value="mac" label="macOS">
    
**Install Steps:**
1. Visit [ollama.ai](https://ollama.ai)
2. Click **"Download for Mac"**
3. Drag Ollama to your Applications folder
4. Open Ollama from Applications

:::tip macOS Users
You may need to allow the app in System Preferences → Security & Privacy if prompted.
:::

  </TabItem>
  <TabItem value="linux" label="Linux">
    
**One-line install:**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

:::tip Linux Users
This works on most distributions including Ubuntu, Debian, Fedora, and CentOS.
:::

  </TabItem>
</Tabs>

### **Verify Installation**

Open a terminal and verify Ollama is installed:

```bash
ollama --version
```

:::success Expected Output
You should see a version number like `ollama version is 0.1.x`. If not, restart your computer and try again.
:::

---

## 🤖 Step 2: Download Your First AI Model

Think of AI models as different "brains" - each with unique capabilities. Let's start with a fast, friendly one:

### 🌟 Recommended Model

**Best for most users:**
```bash
ollama pull gemma3:4b
```

**Size:** ~4GB | **Speed:** Fast | **Quality:** Excellent

- Current best single-GPU model
- Great balance of speed and intelligence
- Perfect for daily use

### ⚡ Alternative Models

<details>
<summary><strong>Ultra Fast (for slower computers)</strong></summary>

```bash
ollama pull llama3.2:1b
```

**Size:** ~1GB | **Speed:** Ultra-fast | **Quality:** Good

- Smallest, fastest model
- Works on any computer
- Great for quick questions

</details>

<details>
<summary><strong>Powerhouse (for powerful hardware)</strong></summary>

```bash
ollama pull phi4:14b
```

**Size:** ~14GB | **Speed:** Good | **Quality:** Excellent

- Microsoft's compact powerhouse
- Requires 16GB+ RAM
- State-of-the-art performance

</details>

<details>
<summary><strong>With Vision (for image analysis)</strong></summary>

```bash
ollama pull qwen2.5vl:3b
```

**Size:** ~3GB | **Speed:** Fast | **Quality:** Good

- Can understand images
- Upload photos and ask questions
- Perfect for visual tasks

</details>

:::info Download Progress
This will download several gigabytes of data. While it downloads:
- ☕ Grab a coffee
- 📖 Read about what you can do with AI  
- 🎵 Listen to some music

The download typically takes 5-15 minutes depending on your internet speed.
:::

## 🌐 Step 3: Start Libre WebUI

Now let's get the interface running. Since you already have Ollama installed from Step 1, we'll use Docker with external Ollama connection:

<Tabs>
  <TabItem value="docker-external" label="🐳 Docker + External Ollama (Recommended)" default>

**Perfect for this setup since you already have Ollama installed:**

**Option A: Using pre-built image (fastest):**
```bash
# Clone the repository first
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui

# Use the external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

**Option B: Build locally from source:**
```bash
# Clone the repository
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui

# Build the local Docker image
docker build --no-cache -t libre-webui:latest .

# Run with external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

**What this does:**
- Runs Libre WebUI in Docker
- Connects to your existing Ollama installation
- Maps port 8080 for web access
- Saves your data persistently

:::tip Why External Ollama?
Since you installed Ollama in Step 1, this setup:
- ✅ Uses your existing Ollama installation
- ✅ Avoids running duplicate Ollama instances
- ✅ Better resource management
- ✅ Easier to manage models with `ollama pull`
:::

:::note When to Build Locally
Choose local build when:
- You want the latest development features
- You've made custom modifications
- The pre-built image has compatibility issues
- You prefer building from source for security
:::

  </TabItem>
  <TabItem value="docker-simple" label="🐳 Simple Docker (All-in-One)">

**If you want everything in Docker containers:**

```bash
# This includes both Libre WebUI AND Ollama in containers
docker run -d -p 3000:8080 -v libre-webui:/app/backend/data --name libre-webui --restart always ghcr.io/libre-webui/libre-webui:main
```

:::info When to Use This
Use this approach if:
- You want everything containerized
- You don't mind having Ollama in a container
- You prefer a single command setup
:::

  </TabItem>
  <TabItem value="source" label="🔨 From Source">

**For developers who want to modify the code:**

```bash
# Clone the repository
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui

# Install dependencies
npm install

# Start development server
npm run dev
```

:::note Development Only
This method is for developers contributing to the project.
:::

  </TabItem>
</Tabs>

### 🔧 Verify Ollama Connection

Before starting Libre WebUI, make sure your Ollama is running:

```bash
# Check if Ollama is running
curl http://localhost:11434/api/version

# If not running, start it
ollama serve
```

## 🎉 Step 4: Start Chatting!

1. **Open your browser** and go to:
   - **Docker External Ollama**: http://localhost:8080
   - **Simple Docker**: http://localhost:3000
   - **From Source**: http://localhost:5173
2. **You should see the Libre WebUI interface!**
3. **Click "New Chat"** or just start typing in the message box
4. **Type your first message** like "Hello! Can you introduce yourself?"
5. **Press Enter** and watch the AI respond in real-time!

:::tip Troubleshooting
If you don't see any models available, make sure:
- Ollama is running: `ollama serve`
- You have a model downloaded: `ollama pull llama3.2`
- Check the [Docker External Ollama guide](./DOCKER_EXTERNAL_OLLAMA) for detailed troubleshooting
:::

## 🎊 Congratulations! You're Now Running Local AI!

Your setup is complete! Here's what just happened:
- ✅ Ollama is running the AI model on your computer
- ✅ Libre WebUI provides the beautiful chat interface
- ✅ Everything is running locally - no data leaves your machine
- ✅ You have unlimited, private AI conversations

## 🎮 What to Try Next

### **Basic Conversations**
- "Explain quantum physics in simple terms"
- "Write a short story about a robot"
- "Help me plan a healthy meal"

### **Practical Tasks**
- "Help me write a professional email"
- "Proofread this text: [paste your text]"
- "Brainstorm names for my new project"

### **Creative Projects**
- "Help me write a poem about friendship"
- "Create a workout routine for beginners"
- "Suggest improvements for my resume"

### **Learning & Research**
- "What are the pros and cons of solar energy?"
- "Explain machine learning like I'm 12 years old"
- "Compare different programming languages"

## 📊 Download More Models

Want to try different AI personalities? Download more models:

### **For General Use:**
```bash
# Ultra-fast for simple tasks
ollama pull llama3.2:1b

# Current best single-GPU model
ollama pull gemma3:4b

# State-of-the-art performance
ollama pull llama3.3:70b
```

### **For Specific Tasks:**
```bash
# Advanced programming and coding agents
ollama pull devstral:24b

# Understanding images and documents
ollama pull qwen2.5vl:32b

# Complex reasoning and thinking
ollama pull deepseek-r1:32b

# Multimodal tasks with Meta's latest
ollama pull llama4:16x17b
```

### **Check Your Models:**
```bash
ollama list
```

## 🎨 Explore the Interface

### **🔧 Settings Menu**
- Click the gear icon (⚙️) to change models
- Adjust response creativity and length
- Customize your experience

### **⌨️ Keyboard Shortcuts**
- **⌘B** (Ctrl+B): Toggle sidebar
- **⌘,** (Ctrl+,): Open settings
- **?**: Show all shortcuts
- **⌘D** (Ctrl+D): Toggle dark/light theme

### **📱 Mobile Friendly**
Libre WebUI works great on phones and tablets too!

## 🔒 Privacy & Security

**🎉 Your data is 100% private!**
- ✅ Everything runs on your computer
- ✅ No internet required after setup
- ✅ No data sent to external servers
- ✅ Complete control over your conversations
- ✅ No tracking or analytics

## 🆘 Having Trouble?

### **Can't create a new chat?**
1. Make sure Ollama is running: `ollama list`
2. Check you have at least one model downloaded
3. Restart both backend and frontend
4. See our [Troubleshooting Guide](./06-TROUBLESHOOTING.md)

### **AI responses are slow?**
- Try a smaller model like `llama3.2:1b`
- Close other applications to free up memory
- Make sure you have enough RAM (4GB minimum)

### **Model download failed?**
- Check your internet connection
- Make sure you have enough disk space
- Try downloading a smaller model first

## 🚀 Next Steps

### **🎯 Power User Features**
- Check out [Pro Tips](./03-PRO_TIPS.md) for advanced workflows
- Learn about [image analysis with vision models](./02-WORKING_WITH_MODELS.md)
- Explore [keyboard shortcuts](./04-KEYBOARD_SHORTCUTS.md)

### **🎭 Try Demo Mode**
Want to show Libre WebUI to friends? Try [Demo Mode](./05-DEMO_MODE.md) for a no-setup demonstration.

### **📚 Learn More**
- [Working with AI Models](./02-WORKING_WITH_MODELS.md) - Complete feature guide
- [Troubleshooting](./06-TROUBLESHOOTING.md) - Fix common issues

## 🤝 Join the Community

- **🐛 Found a bug?** Report it on GitHub
- **💡 Have an idea?** Submit a feature request
- **❤️ Love Libre WebUI?** Star the repository and share with friends!

---

**🎉 Welcome to the future of private AI!**

*You now have a powerful, private AI assistant running entirely on your computer. No subscriptions, no data sharing, no limits - just pure AI power at your fingertips.*

**Happy chatting!** 🤖✨
