---
sidebar_position: 2
title: "Demo Mode"
description: "Try Libre WebUI without installation. Experience the full interface with simulated AI responses in your browser."
slug: /DEMO_MODE
keywords: [demo mode, try online, no installation, preview, test interface]
---

# 🎭 Demo Mode: Try Before You Install

Want to explore Libre WebUI without setting up Ollama? Demo Mode lets you experience the interface with simulated AI responses.

:::tip Zero Setup Required
**Try immediately** in your browser - no downloads, installations, or technical setup needed!
:::

## 🌟 What is Demo Mode?

Demo Mode is a special version of Libre WebUI that runs without requiring Ollama or any AI models to be installed. 

<div className="container">
  <div className="row">
    <div className="col col--6">
      <div className="card">
        <div className="card__header">
          <h4>🚀 Perfect For</h4>
        </div>
        <div className="card__body">
          <ul>
            <li><strong>Trying out the interface</strong> before committing to a full setup</li>
            <li><strong>Showcasing features</strong> on devices without AI capabilities</li>
            <li><strong>Testing the UI</strong> during development</li>
            <li><strong>Learning</strong> how the interface works</li>
          </ul>
        </div>
      </div>
    </div>
    <div className="col col--6">
      <div className="card">
        <div className="card__header">
          <h4>⚡ Instant Access</h4>
        </div>
        <div className="card__body">
          <ul>
            <li><strong>No Ollama installation</strong> required</li>
            <li><strong>No model downloads</strong> needed</li>
            <li><strong>Works immediately</strong> in any browser</li>
            <li><strong>Full UI experience</strong> with simulated responses</li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</div>

---

## ✨ Demo Mode Features

When demo mode is active, you'll see:

### 📢 **Demo Banner**
A clear banner at the top indicating this is a demonstration version with a link to the full setup.

### 🤖 **Sample Models**
Pre-configured sample models to explore:
- **gemma3:4b** - Current best single-GPU model simulation
- **deepseek-r1:32b** - Advanced reasoning model demonstration
- **qwen2.5vl:32b** - Flagship vision-language model for image analysis demos

### 💬 **Mock Conversations**
Realistic chat responses that demonstrate:
- Streaming text generation
- Conversation history
- Different response styles
- Error handling

### 🎮 **Full UI Experience**
All interface features work exactly like the real version:
- Model switching
- Settings configuration
- Keyboard shortcuts
- Theme toggling
- Responsive design

## 🌐 Try Demo Mode Online

Demo mode automatically activates when Libre WebUI is deployed to popular hosting platforms:

### **Vercel** (Recommended)
Demo mode automatically detects Vercel deployments and activates seamlessly.

### **Other Platforms**
Demo mode also works on:
- Netlify (`*.netlify.app`)
- GitHub Pages (`*.github.io`)
- Any domain starting with `demo.` or `preview.`

## 🧪 Test Demo Mode Locally

Want to try demo mode on your local machine?

### **Quick Setup**
1. **Navigate to the frontend directory:**
   ```bash
   cd frontend
   ```

2. **Create a demo environment file:**
   ```bash
   echo "VITE_DEMO_MODE=true" > .env.local
   ```

3. **Start the development server:**
   ```bash
   npm run dev
   ```

4. **Visit the app:**
   Open http://localhost:5173 and you'll see the demo banner!

### **Reset to Normal Mode**
Simply delete the `.env.local` file:
```bash
rm .env.local
```

## 🎯 What You Can Test in Demo Mode

### **Interface Exploration**
- ✅ Navigate between Chat, Models, and Settings pages
- ✅ Try all keyboard shortcuts (⌘B, ⌘D, ⌘,, ?)
- ✅ Test light/dark theme switching
- ✅ Explore responsive design on different screen sizes

### **Chat Simulation**
- ✅ Send messages and see streaming responses
- ✅ Try different "models" to see varied responses
- ✅ Test conversation history and context
- ✅ Experiment with advanced settings

### **Model Management**
- ✅ Browse the model library interface
- ✅ See how model information is displayed
- ✅ Test model switching functionality
- ✅ Explore model management tools

### **Settings & Customization**
- ✅ Adjust interface preferences
- ✅ Test import/export functionality
- ✅ Configure keyboard shortcuts
- ✅ Customize appearance settings

## 🚀 Ready for the Real Thing?

After exploring demo mode, setting up the full version is straightforward:

1. **Install Ollama:** Visit [ollama.ai](https://ollama.ai) for your platform
2. **Download a model:** `ollama pull gemma3:4b`
3. **Start Libre WebUI:** Follow the [Quick Start Guide](./01-QUICK_START.md)
4. **Enjoy unlimited AI conversations!**

## 🛠️ For Developers

### **Demo Mode Detection**
Demo mode automatically activates when:

```javascript
// Environment variable
process.env.VITE_DEMO_MODE === 'true'

// Or specific hostnames
hostname.includes('vercel.app') || 
hostname.includes('netlify.app') || 
hostname.includes('github.io') ||
hostname.startsWith('demo.') ||
hostname.startsWith('preview.')
```

### **Mock Data Configuration**
Demo responses are configured in `src/utils/demoMode.ts` and can be customized for different demo scenarios.

### **Deployment Tips**
- Demo mode requires no backend - perfect for static hosting
- All features are client-side simulated
- No API keys or external services needed
- Instant deployment to any static hosting platform

---

**🎭 Demo Mode gives you the full Libre WebUI experience without any setup!**

*Ready to experience the power of local AI? Try demo mode first, then follow our [Quick Start Guide](./01-QUICK_START.md) for the complete setup.*
