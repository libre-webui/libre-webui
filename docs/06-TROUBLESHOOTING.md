---
sidebar_position: 1
title: "Troubleshooting Guide"
description: "Complete troubleshooting guide for Libre WebUI. Fast problem resolution with detailed solutions for Docker, Ollama, models, and performance issues."
slug: /TROUBLESHOOTING
keywords: [libre webui troubleshooting, libre webui problems, ollama connection problems, docker ai issues, ai model problems, libre webui debugging, local ai troubleshooting, open webui alternative support]
image: /img/social/06.png
---

# 🔧 Troubleshooting: Quick Fixes for Common Issues

Having trouble with Libre WebUI? Don't worry! Most issues have simple solutions. Let's get you back to chatting with AI quickly.

:::tip Quick Help
**90% of issues** are solved by checking these three things: Ollama running, models downloaded, and backend/frontend started.
:::

## 🚨 Most Common Issue: "Can't Create New Chat"

**This usually means one of three things is missing. Let's check them in order:**

### ✅ **Quick Fix: The One-Command Solution**

If you have the start script, try this first:

```bash
cd /home/rob/Documents/libre-webui-dev
./start.sh
```

:::success Success Indicator
**This should start everything automatically!** If it works, you're done! 🎉
:::

---

## 🔍 **Step-by-Step Diagnosis**

If the quick fix didn't work, let's figure out what's wrong:

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

<Tabs>
  <TabItem value="ollama" label="1️⃣ Ollama Running?" default>
    
**The Problem:** Ollama is the AI engine. Without it, there's no AI to chat with.

**Check if installed:**
```bash
ollama --version
```

:::danger Command Not Found?
**If you see "command not found":**
- 📥 **Install Ollama**: Go to [ollama.ai](https://ollama.ai) and download for your system
- 💻 **Restart your terminal** after installation
:::

:::success Version Number Shown?
**If you see a version number, start Ollama:**
```bash
ollama serve
```
**Keep this terminal open!**
:::

  </TabItem>
  <TabItem value="models" label="2️⃣ Models Downloaded?">
    
**The Problem:** Ollama is running but has no AI "brains" to use.

**Check available models:**
```bash
ollama list
```

:::warning Empty List?
**If the list is empty or shows an error:**

**Download a recommended model:**
```bash
# Best balance of quality and speed (recommended, ~5GB)
ollama pull llama3.1:8b

# Ultra-fast for slower computers (~2GB)
ollama pull llama3.2:3b

# For 16GB+ VRAM systems (~9GB)
ollama pull qwen2.5:14b
```

**Wait for the download to finish** (2-50GB depending on the model).
:::

  </TabItem>
  <TabItem value="backend" label="3️⃣ Backend Running?">
    
**The Problem:** The backend connects your browser to Ollama.

**Start the backend:**
```bash
cd backend
npm install    # Only needed the first time
npm run dev
```

:::success Expected Output
**You should see:** `Server running on port 3001` or similar.
**Keep this terminal open!**
:::

  </TabItem>
  <TabItem value="frontend" label="4️⃣ Frontend Running?">
    
**The Problem:** The frontend is the beautiful interface you see in your browser.

**Start the frontend:**
```bash
cd frontend  
npm install    # Only needed the first time
npm run dev
```

:::success Expected Output
**You should see:** A message with a local URL like `http://localhost:5173`
**Keep this terminal open!**
:::

  </TabItem>
</Tabs>

---

## 🎯 **Visual Troubleshooting**

### **In Your Browser (http://localhost:5173):**

**✅ Good Signs:**
- You see the Libre WebUI interface
- There's a model name shown in the header or sidebar
- The "New Chat" button is clickable
- Settings menu shows available models

**❌ Warning Signs:**
- Yellow banner saying "No models available"
- "New Chat" button is grayed out
- Error messages about connection
- Blank page or loading forever

### **Quick Browser Fixes:**
1. **Hard refresh:** Hold Shift and click refresh
2. **Clear cache:** Press F12 → Network tab → check "Disable cache"
3. **Check console:** Press F12 → Console tab (look for red errors)

---

## 🛠️ **Common Error Messages & Solutions**

### **"Cannot connect to Ollama"**
**Solution:** Start Ollama: `ollama serve`

### **"No models found"**
**Solution:** Download a model: `ollama pull llama3.1:8b`

### **"Failed to fetch" or "Network Error"**
**Solution:** Start the backend: `cd backend && npm run dev`

### **"This site can't be reached"**
**Solution:** Start the frontend: `cd frontend && npm run dev`

### **"Port already in use"**
**Solution:** Something else is using the port. Find and stop it:
```bash
# Check what's using port 3001 (backend)
lsof -i :3001

# Check what's using port 5173 (frontend)
lsof -i :5173

# Kill the process (replace XXXX with the PID number)
kill -9 XXXX
```

---

## ⚡ **Performance Issues**

### **AI Responses Are Very Slow**
**Solutions:**
1. **Check if model fits in VRAM:** Run `ollama ps` to see memory usage
2. **Use a smaller model:** `ollama pull llama3.2:3b` (~2GB VRAM)
3. **Use Q4 quantization:** Models ending in `:latest` use Q4 by default
4. **Close GPU-intensive apps** (games, video editors)
5. **CPU-only inference:** Expect 5-15 tokens/sec (this is normal without GPU)

### **"Timeout of 30000ms exceeded" Errors**
**Problem:** Large models on multiple GPUs need more time to load into memory.

**Solutions:**
1. **Quick Fix - Environment Variables:**
   ```bash
   # Backend (.env file or environment)
   OLLAMA_TIMEOUT=300000          # 5 minutes for regular operations
   OLLAMA_LONG_OPERATION_TIMEOUT=900000  # 15 minutes for model loading
   
   # Frontend (.env file or environment)
   VITE_API_TIMEOUT=300000        # 5 minutes for API calls
   ```

2. **For Large Models (like CodeLlama 70B, Llama 70B+):**
   ```bash
   # Increase to 30 minutes for very large models
   OLLAMA_LONG_OPERATION_TIMEOUT=1800000
   VITE_API_TIMEOUT=1800000
   ```

3. **Restart the services** after changing environment variables

### **Interface Is Laggy**
**Solutions:**
1. **Hard refresh** your browser (Shift + Refresh)
2. **Close other browser tabs**
3. **Try a different browser** (Chrome, Firefox, Safari)

### **Models Won't Download**
**Solutions:**
1. **Check internet connection**
2. **Free up disk space** (models can be 1-32GB each)
3. **Try a smaller model first:** `ollama pull llama3.2:1b`

---

## 🚀 **Advanced Troubleshooting**

### **Multiple Terminal Management**
You need 3 things running simultaneously:

**Terminal 1 (Ollama):**
```bash
ollama serve
# Keep this running
```

**Terminal 2 (Backend):**
```bash
cd backend
npm run dev
# Keep this running
```

**Terminal 3 (Frontend):**
```bash
cd frontend  
npm run dev
# Keep this running
```

### **Check Everything Is Working**
Run these commands to verify each part:

```bash
# Check Ollama
curl http://localhost:11434/api/tags

# Check Backend
curl http://localhost:3001/api/ollama/health

# Check Frontend
# Open http://localhost:5173 in your browser
```

**Each should return data, not errors.**

---

## 🆘 **Still Stuck?**

### **Before Asking for Help:**
1. ✅ **Try the quick fix** at the top of this guide
2. ✅ **Check all three services** are running (Ollama, backend, frontend)
3. ✅ **Download at least one model** (`ollama pull llama3.2:3b`)
4. ✅ **Restart everything** and try again

### **When Reporting Issues:**
Please include:
- **Operating system** (Windows, Mac, Linux)
- **Error messages** (exact text)
- **Browser console errors** (press F12 → Console)
- **Terminal output** from backend/frontend

### **Get Help:**
- 🐛 **Report bugs:** GitHub Issues
- 💬 **Ask questions:** GitHub Discussions  
- 📚 **Read more:** Check other guides in the [docs folder](./00-README.md)

---

## 🎯 **Prevention Tips**

### **For Smooth Operation:**
1. **Keep terminals open** while using Libre WebUI
2. **Don't close Ollama** - it needs to stay running
3. **Download models when you have good internet**
4. **Monitor disk space** - AI models are large files
5. **Restart everything occasionally** to clear memory

### **System Requirements Reminder:**
- **Minimum:** 8GB RAM, 10GB free disk space
- **Recommended:** 16GB RAM, 8GB VRAM GPU, 50GB+ disk space
- **Power User:** 32GB RAM, 16-24GB VRAM GPU, 100GB+ disk space
- **Professional:** 64GB+ RAM, 48GB+ VRAM, 200GB+ SSD

See the [Hardware Requirements Guide](./HARDWARE_REQUIREMENTS) for detailed GPU recommendations.

---

**🎉 Most issues are solved by ensuring all three services are running!**

*Remember: Ollama (AI engine) + Backend (API) + Frontend (interface) = Working Libre WebUI*

**Still having trouble?** The [Quick Start Guide](./QUICK_START) has step-by-step setup instructions.

---

## 🐳 **Docker Issues**

### **Container Won't Start**
```bash
# Check container logs
docker-compose logs libre-webui

# Check if ports are in use
lsof -i :8080
lsof -i :11434
```

### **Can't Connect to Ollama in Docker**
```bash
# For bundled Ollama, check both containers
docker-compose logs ollama

# For external Ollama, verify host connection
curl http://localhost:11434/api/version

# Make sure OLLAMA_BASE_URL is correct in docker-compose
# Bundled: http://ollama:11434
# External: http://host.docker.internal:11434 (Mac/Windows)
# External: http://172.17.0.1:11434 (Linux)
```

### **Data Not Persisting**
```bash
# Check volumes exist
docker volume ls | grep libre

# Inspect volume
docker volume inspect libre_webui_data
```

### **GPU Not Working in Docker**
```bash
# Verify NVIDIA Container Toolkit
nvidia-smi
docker run --rm --gpus all nvidia/cuda:12.0-base nvidia-smi

# Use GPU compose file
docker-compose -f docker-compose.gpu.yml up -d
```

---

## 📦 **NPX Installation Issues**

### **"Cannot find module" Errors**
```bash
# Clear npm cache and reinstall
npm cache clean --force
npx libre-webui@latest
```

### **Data Location**
When using `npx libre-webui`, data is stored in:
- **Linux/macOS:** `~/.libre-webui/`
- **Windows:** `%USERPROFILE%\.libre-webui\`

### **Port Already in Use**
```bash
# Default port is 8080, use different port
PORT=9000 npx libre-webui
```

### **First-Time Setup Not Showing Encryption Key**
This was fixed in v0.2.7. Update to latest:
```bash
npx libre-webui@latest
```

---

## 🔌 **Plugin Issues**

### **Can't Connect to External AI Services**

**The Problem:** You have API keys but external services (OpenAI, Anthropic, etc.) aren't working.

**Common Solutions:**

1. **Check API Key Format:**
   ```bash
   # Set API keys in backend/.env
   OPENAI_API_KEY=your_openai_key_here
   ANTHROPIC_API_KEY=your_anthropic_key_here
   GROQ_API_KEY=your_groq_key_here
   GEMINI_API_KEY=your_gemini_key_here
   MISTRAL_API_KEY=your_mistral_key_here
   GITHUB_API_KEY=your_github_token_here
   ```

2. **Verify API Keys Are Valid:**
   ```bash
   # Test OpenAI
   curl -H "Authorization: Bearer $OPENAI_API_KEY" \
        https://api.openai.com/v1/models
   
   # Test Anthropic
   curl -H "x-api-key: $ANTHROPIC_API_KEY" \
        https://api.anthropic.com/v1/messages
   ```

3. **Update Plugin Models:**
   ```bash
   # Update all providers
   ./scripts/update-all-models.sh
   
   # Or update specific providers
   ./scripts/update-openai-models.sh
   ./scripts/update-anthropic-models.sh
   ./scripts/update-groq-models.sh
   ./scripts/update-gemini-models.sh
   ./scripts/update-mistral-models.sh
   ./scripts/update-github-models.sh
   ```

### **Plugin Update Scripts Failing**

**The Problem:** Model update scripts are reporting errors.

**Common Solutions:**

1. **Check API Keys:**
   ```bash
   # Verify environment variables are set
   echo $OPENAI_API_KEY
   echo $ANTHROPIC_API_KEY
   echo $GROQ_API_KEY
   echo $GEMINI_API_KEY
   echo $MISTRAL_API_KEY
   echo $GITHUB_API_KEY
   ```

2. **Check Script Permissions:**
   ```bash
   # Make scripts executable
   chmod +x scripts/update-*.sh
   ```

3. **Run Individual Scripts with Debug:**
   ```bash
   # Run with verbose output
   bash -x ./scripts/update-openai-models.sh
   ```

### **Models Not Showing in UI**

**The Problem:** Plugin models aren't appearing in the model selector.

**Solutions:**

1. **Restart Backend:**
   ```bash
   # Stop backend (Ctrl+C) and restart
   cd backend
   npm run dev
   ```

2. **Check Plugin Status:**
   - Go to Settings → Plugins
   - Verify plugins are enabled
   - Check for any error messages

3. **Manual Plugin Refresh:**
   ```bash
   # Update all plugins
   ./scripts/update-all-models.sh
   
   # Restart backend to reload models
   cd backend && npm run dev
   ```
