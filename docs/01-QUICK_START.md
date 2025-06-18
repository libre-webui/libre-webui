# 🚀 Quick Start: Your First AI Chat in 5 Minutes

Welcome to Libre WebUI! This guide will get you chatting with AI in just a few minutes. No technical expertise required!

## � What You'll Need

- **A computer** with at least 4GB RAM (8GB+ recommended)
- **Internet connection** (for initial setup only)
- **5-10 minutes** of your time

## 🎯 Step 1: Install Ollama (The AI Engine)

Ollama is the engine that runs AI models on your computer. It's free and easy to install.

### **For Windows:**
1. Visit [ollama.ai](https://ollama.ai)
2. Click "Download for Windows"
3. Run the installer and follow the prompts
4. Ollama will start automatically

### **For Mac:**
1. Visit [ollama.ai](https://ollama.ai)
2. Click "Download for Mac"
3. Drag Ollama to your Applications folder
4. Open Ollama from Applications

### **For Linux:**
```bash
curl -fsSL https://ollama.ai/install.sh | sh
```

### **Verify Installation**
Open a terminal and type:
```bash
ollama --version
```
You should see a version number. If not, restart your computer and try again.

## 🤖 Step 2: Download Your First AI Model

Think of AI models as different "brains" - each with unique capabilities. Let's start with a fast, friendly one:

```bash
ollama pull gemma3:4b
```

**This will download about 4GB of data. While it downloads:**
- ☕ Grab a coffee
- 📖 Read about what you can do with AI
- 🎵 Listen to some music

**Other great starter models:**
- `llama3.2:1b` - Fastest, smallest (1GB)
- `gemma3:1b` - Efficient single-GPU model (1GB)
- `phi4:14b` - Microsoft's compact powerhouse (14GB)
- `qwen2.5vl:3b` - Can understand images (3GB)

## 🌐 Step 3: Start Libre WebUI

Now let's get the interface running:

### **For Users (Recommended):**
```bash
cd /path/to/libre-webui
./start.sh
```

### **For Developers:**
```bash
# Clone and setup
git clone <repo-url>
cd libre-webui
npm install

# Start development
npm run dev              # Local development
npm run dev:host         # Network access (port 8080)
```

## 🎉 Step 4: Start Chatting!

1. **Open your browser** and go to: http://localhost:5173
2. **You should see the Libre WebUI interface!**
3. **Click "New Chat"** or just start typing in the message box
4. **Type your first message** like "Hello! Can you introduce yourself?"
5. **Press Enter** and watch the AI respond in real-time!

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
4. See our [Troubleshooting Guide](./TROUBLESHOOTING.md)

### **AI responses are slow?**
- Try a smaller model like `llama3.2:1b`
- Close other applications to free up memory
- Make sure you have enough RAM (4GB minimum)

### **Model download failed?**
- Check your internet connection
- Make sure you have enough disk space
- Try downloading a smaller model first

## � Next Steps

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
