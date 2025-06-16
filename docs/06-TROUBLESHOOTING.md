# 🔧 Troubleshooting: Quick Fixes for Common Issues

Having trouble with Libre WebUI? Don't worry! Most issues have simple solutions. Let's get you back to chatting with AI quickly.

## 🚨 Most Common Issue: "Can't Create New Chat"

**This usually means one of three things is missing. Let's check them in order:**

### ✅ **Quick Fix: The One-Command Solution**
If you have the start script, try this first:
```bash
cd /home/rob/Documents/libre-webui-dev
./start.sh
```

**This should start everything automatically!** If it works, you're done! 🎉

---

## � **Step-by-Step Diagnosis**

If the quick fix didn't work, let's figure out what's wrong:

### **1️⃣ Is Ollama Running?**

**The Problem:** Ollama is the AI engine. Without it, there's no AI to chat with.

**How to Check:**
```bash
ollama --version
```

**If you see an error like "command not found":**
- 📥 **Install Ollama**: Go to [ollama.ai](https://ollama.ai) and download for your system
- 💻 **Restart your terminal** after installation

**If you see a version number:**
```bash
ollama serve
```
This starts the Ollama service. **Keep this terminal open!**

### **2️⃣ Do You Have AI Models?**

**The Problem:** Ollama is running but has no AI "brains" to use.

**How to Check:**
```bash
ollama list
```

**If the list is empty or shows an error:**
```bash
# Download the current best single-GPU model (recommended)
ollama pull gemma3:4b

# Or download an ultra-fast one for slower computers
ollama pull llama3.2:1b

# For advanced users with good hardware
ollama pull llama3.3:70b
```

**Wait for the download to finish** (1-32GB depending on the model).

### **3️⃣ Is the Backend Running?**

**The Problem:** The backend connects your browser to Ollama.

**How to Start It:**
```bash
cd backend
npm install    # Only needed the first time
npm run dev
```

**You should see:** `Server running on port 3001` or similar.
**Keep this terminal open!**

### **4️⃣ Is the Frontend Running?**

**The Problem:** The frontend is the beautiful interface you see in your browser.

**How to Start It:**
```bash
cd frontend  
npm install    # Only needed the first time
npm run dev
```

**You should see:** A message with a local URL like `http://localhost:5173`
**Keep this terminal open!**

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
**Solution:** Download a model: `ollama pull gemma3:4b`

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

## � **Performance Issues**

### **AI Responses Are Very Slow**
**Solutions:**
1. **Try a more efficient model:** `ollama pull phi4:14b` (compact powerhouse)
2. **Use ultra-fast models:** `ollama pull llama3.2:1b` or `ollama pull gemma3:1b`
3. **Close other applications** to free up memory
4. **Check your RAM:** You need at least 4GB free for most models

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
- **Minimum:** 4GB RAM, 15GB free disk space (for compact models)
- **Recommended:** 8GB+ RAM, 50GB+ free disk space (for mid-size models)  
- **Power User:** 16GB+ RAM, 100GB+ free disk space (for large models)
- **Enthusiast:** 32GB+ RAM, 200GB+ SSD storage (for state-of-the-art models)

---

**🎉 Most issues are solved by ensuring all three services are running!**

*Remember: Ollama (AI engine) + Backend (API) + Frontend (interface) = Working Libre WebUI*

**Still having trouble?** The [Quick Start Guide](./01-QUICK_START.md) has step-by-step setup instructions.
