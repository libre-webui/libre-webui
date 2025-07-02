# Libre WebUI

![version](https://img.shields.io/github/package-json/v/libre-webui/libre-webui)

![Libre WebUI Screenshot](./screenshot.png)

A clean, privacy-first interface for local AI models via Ollama, with flexible routing to external AI services.

---

## Free & Open Source

100% free and open source software. No telemetry, no tracking. Your data stays on your hardware by default.

## Privacy & Flexibility

Complete offline operation on your own hardware, with optional connections to external AI services when you need them.

---

## Setup

```bash
# Option 1: Quick start
./start.sh

# Option 2: Manual
npm install
npm run dev
```

### Optional: External AI Services

Connect to external AI services by adding your API keys to the `.env` file:

```bash
# Add to backend/.env
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GROQ_API_KEY=your_groq_key
```

**[📖 Complete Plugin Setup Guide →](./docs/08-PLUGIN_ARCHITECTURE.md)**

### Keep Models Updated

Automatically update your AI provider plugins with the latest available models:

```bash
# Update all configured providers
./scripts/update-all-models.sh
```

**[🤖 Model Updater Guide →](./docs/11-MODEL_UPDATER.md)**

## Development

### For New Contributors

Welcome! Getting started with Libre WebUI development is simple:

1. **Clone and install dependencies:**

   ```bash
   git clone https://github.com/libre-webui/libre-webui
   cd libre-webui
   npm install
   ```

   This automatically installs dependencies for the root, frontend, and backend using npm workspaces.

2. **Start development servers:**

   ```bash
   # Standard development (local only)
   npm run dev

   # Development with network access (accessible from other devices)
   npm run dev:host
   ```

3. **Clean reinstall (if needed):**
   ```bash
   # Use our clean install script to refresh all dependencies
   ./clean-install.sh
   ```

### Available Scripts

- `npm run dev` - Start both frontend and backend in development mode
- `npm run dev:host` - Start development servers with network access (frontend on port 8080 with `--host` flag)
- `npm run build` - Build both frontend and backend for production
- `npm run start` - Start the production backend server
- `npm run lint` - Run linting for both frontend and backend
- `npm run format` - Format code and add license headers
- `./clean-install.sh` - Clean npm cache, remove package-lock files, and reinstall all dependencies
- `./scripts/update-all-models.sh` - Update AI provider plugins with latest available models

### Development Ports

- **Frontend (dev)**: http://localhost:5173 (or http://localhost:8080 with `npm run dev:host`)
- **Backend (dev)**: http://localhost:3001
- **Ollama**: http://localhost:11434

The `dev:host` script is particularly useful when you want to:

- Test the app on mobile devices or tablets on your local network
- Share your development instance with team members
- Debug responsive design on actual devices

## Ports

- Frontend: http://localhost:5173
- Backend: http://localhost:3001
- Ollama: http://localhost:11434

## Keyboard Shortcuts

Libre WebUI includes VS Code-inspired keyboard shortcuts for enhanced productivity:

### Navigation

- **⌘B** (Cmd+B / Ctrl+B) - Toggle sidebar visibility
- **⌘D** (Cmd+D / Ctrl+D) - Toggle dark/light theme

### Settings & Help

- **⌘,** (Cmd+Comma / Ctrl+Comma) - Open settings modal
- **?** - Show keyboard shortcuts help modal
- **Esc** - Close open modals

### Chat

- **Enter** - Send message
- **Shift+Enter** - New line in message

Press **?** anywhere in the app to see the complete shortcuts reference.

## Deployment

### Vercel

The app includes Vercel configuration for seamless deployment with SPA routing support:

```bash
# Deploy to Vercel
vercel --prod
```

The configuration automatically handles client-side routing for the `/models` page and other routes.

## Configuration

The app automatically generates configuration files on first run (these are excluded from version control for privacy):

- `backend/preferences.json` - User preferences (default model, theme, system message)
- `backend/sessions.json` - Chat session data
- `plugins/*.json` - Plugin configurations for external AI services

---

## Features

### 🚀 Core Features

- **Clean interface** - Simple, focused design for productive AI interactions
- **Light/Dark mode** - Comfortable viewing with improved accessibility
- **Responsive design** - Works on desktop, tablet, and mobile devices
- **Real-time chat** - Streaming responses with WebSocket integration
- **Document chat** - Upload documents (PDF, TXT, DOCX) and chat with their content using semantic search
- **Plugin system** - Connect external AI services (OpenAI, Anthropic, Groq, etc.)
- **Privacy-focused** - Local processing with optional external connections
- **Zero telemetry** - No tracking or data collection
- **Keyboard shortcuts** - VS Code-inspired shortcuts for power users (⌘B, ⌘D, ⌘,, ?)
- **Performance optimized** - Code splitting and lazy loading for faster page loads

### 🤖 Complete Ollama Integration

All Ollama API endpoints are integrated and ready to use:

#### Chat & Generation

- ✅ **Chat Completion** - Full conversation support with history
- ✅ **Text Generation** - Single-turn completion with advanced options
- ✅ **Streaming Responses** - Real-time response generation
- ✅ **Multimodal Support** - Image input for vision models (llava, etc.)
- ✅ **Structured Outputs** - JSON schema validation and formatting
- ✅ **Tool Calling** - Function calling for enhanced capabilities

#### Model Management

- ✅ **List Models** - Browse all locally installed models
- ✅ **Pull Models** - Download from Ollama library with progress tracking
- ✅ **Delete Models** - Remove unused models to free space
- ✅ **Model Information** - Detailed specs, capabilities, and metadata
- ✅ **Create Models** - Build custom models from existing ones
- ✅ **Copy Models** - Duplicate models with different configurations
- ✅ **Push Models** - Upload custom models to share
- ✅ **Running Models** - View active models and memory usage

#### Advanced Features

- ✅ **Embeddings** - Generate text embeddings for semantic search
- ✅ **Blob Management** - Handle binary data for model creation
- ✅ **Version Detection** - Check Ollama server version
- ✅ **Health Monitoring** - Service status and connectivity checks

### 📄 Document Chat (RAG Feature)

Upload documents and have intelligent conversations with your files using advanced semantic search:

#### Supported Formats

- ✅ **PDF Files** - Extract and process text from PDF documents
- ✅ **TXT Files** - Plain text document processing
- ✅ **DOCX Files** - Microsoft Word document processing
- ✅ **Markdown Files** - Formatted text document processing
- 🧠 **Smart Chunking** - Intelligent text segmentation with overlap for better context
- 🔍 **Semantic Search** - Vector embeddings for precise content matching

#### How It Works

1. **Upload Documents** - Go to Settings and upload your documents
2. **Auto-Processing** - Documents are parsed and converted to searchable vector embeddings
3. **Semantic Search** - Ask questions and get precise answers using AI-powered content matching
4. **Context Injection** - Relevant document sections are automatically included in responses
5. **Privacy-First** - All processing happens locally using Ollama embeddings

#### Features

- 🚀 **Vector Embeddings** - Advanced semantic search using Ollama's embedding models
- 📊 **Processing Status** - Real-time feedback on document processing
- 🔒 **Local Processing** - Documents never leave your device
- 💾 **Persistent Storage** - Documents and embeddings saved locally
- ⚙️ **Configurable Settings** - Adjust chunk size, overlap, and similarity thresholds
- 🗂️ **Document Management** - Easy upload, view, and removal of documents

#### Example Use Cases

- **Research** - Upload academic papers and get detailed analysis
- **Documentation** - Query technical manuals and get instant answers
- **Legal** - Process contracts and extract key information
- **Education** - Upload textbooks and create interactive study sessions
- **Business** - Analyze reports and extract actionable insights

### 🔌 Plugin System

Connect to external AI services while maintaining local fallback:

#### Supported Services

- ✅ **OpenAI** - GPT-4, GPT-3.5 Turbo models
- ✅ **Anthropic** - Claude 3 Opus, Sonnet, Haiku
- ✅ **Groq** - High-speed Llama 3, Mixtral models
- ✅ **Custom APIs** - Any OpenAI-compatible endpoint

#### Key Features

- 🔌 **Flexible Routing** - Connect to any OpenAI-compatible API
- 🛡️ **Automatic Fallback** - Falls back to local Ollama when external services fail
- 📁 **Easy Installation** - Install plugins via JSON file upload
- 🔧 **Simple Management** - Activate, deactivate, export plugins through UI
- 🔒 **Secure** - API keys stored safely in environment variables
- 📊 **Status Monitoring** - Real-time plugin status indicators

#### Quick Plugin Setup

```bash
# Set environment variables
export OPENAI_API_KEY="your_key_here"
export ANTHROPIC_API_KEY="your_key_here"

# Install via API
curl -X POST http://localhost:3001/api/plugins/install \
  -H "Content-Type: application/json" \
  -d @plugins/openai.json

# Activate plugin
curl -X POST http://localhost:3001/api/plugins/activate/openai
```

**[📖 Complete Plugin Guide →](./docs/08-PLUGIN_ARCHITECTURE.md)**

### 🎯 UI Components

- **Model Manager** - Comprehensive model management interface
- **Chat Interface** - Intuitive conversation experience with syntax highlighting
- **Settings Panel** - Customizable preferences and options
- **Plugin Manager** - Upload, configure, and manage external AI service integrations
- **Theme Toggle** - Seamless light/dark mode switching with keyboard shortcut (⌘D)
- **Keyboard Shortcuts Modal** - Quick access help for all shortcuts (press ?)
- **Optimized Bundle** - Code splitting for faster loading and better performance

### 🔧 Developer Features

- **TypeScript** - Full type safety throughout the stack
- **REST API** - Traditional HTTP endpoints for all features
- **WebSocket** - Real-time bidirectional communication
- **Modular Architecture** - Clean separation of concerns
- **Comprehensive Documentation** - Detailed API and integration guides
- **Bundle Optimization** - Code splitting, lazy loading, and optimized dependencies
- **Vercel Ready** - SPA routing configuration for seamless deployment

## Architecture

```
libre-webui-dev/
├── frontend/           # React + TypeScript + Tailwind CSS
│   ├── src/
│   │   ├── components/ # Reusable UI components
│   │   ├── hooks/      # Custom React hooks
│   │   ├── store/      # State management (Zustand)
│   │   ├── utils/      # API clients and utilities
│   │   └── types/      # TypeScript type definitions
├── backend/            # Node.js + Express + TypeScript
│   ├── src/
│   │   ├── routes/     # API route handlers
│   │   ├── services/   # Business logic and Ollama integration
│   │   ├── types/      # Shared type definitions
│   │   └── middleware/ # Express middleware
├── plugins/            # Plugin configuration files (.json)
└── docs/              # Documentation and guides
```

## API Documentation

## Documentation

### 📚 Documentation

**[📖 Complete Documentation →](./docs/00-README.md)**

| Guide                                                          | Description                       |
| -------------------------------------------------------------- | --------------------------------- |
| **[🚀 Quick Start](./docs/01-QUICK_START.md)**                 | Get up and running in 5 minutes   |
| **[🤖 Working with Models](./docs/02-WORKING_WITH_MODELS.md)** | Complete AI models guide          |
| **[🎯 Pro Tips](./docs/03-PRO_TIPS.md)**                       | Advanced workflows and techniques |
| **[⌨️ Keyboard Shortcuts](./docs/04-KEYBOARD_SHORTCUTS.md)**   | Productivity hotkeys              |
| **[🎭 Demo Mode](./docs/05-DEMO_MODE.md)**                     | Try without installation          |
| **[🔧 Troubleshooting](./docs/06-TROUBLESHOOTING.md)**         | Problem solving guide             |
| **[🔌 Plugin Architecture](./docs/08-PLUGIN_ARCHITECTURE.md)** | Connect multiple AI services      |

## Accessibility & Performance

### Accessibility Features

- **High contrast text** - Improved readability in both light and dark modes
- **Keyboard navigation** - Full keyboard support with intuitive shortcuts
- **Screen reader friendly** - Semantic HTML and proper ARIA labels
- **Responsive design** - Accessible on all device sizes

### Performance Optimizations

- **Code splitting** - Lazy loading for ChatPage and ModelsPage
- **Optimized bundles** - Vendor chunks separated for better caching
- **Syntax highlighting** - Lightweight, optimized syntax highlighter
- **Fast loading** - Reduced bundle sizes and improved load times

Quick API examples:

```typescript
// Chat with streaming
const stream = chatApi.generateChatStreamResponse(sessionId, 'Hello!');
stream.subscribe(
  chunk => console.log('Received:', chunk),
  error => console.error('Error:', error),
  () => console.log('Complete')
);

// Model management
const models = await ollamaApi.getModels();
await ollamaApi.pullModel('llama3.2');

// Generate embeddings
const embeddings = await ollamaApi.generateEmbeddings({
  model: 'all-minilm',
  input: ['Text to embed'],
});

// Plugin management
const plugins = await pluginApi.getAllPlugins();
await pluginApi.activatePlugin('openai');
const activePlugin = await pluginApi.getActivePlugin();
```

## License

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at:

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

Copyright (C) 2025 Kroonen AI, Inc.

<sub>LIBRE WEBUI is a trademark of Kroonen AI, Inc.</sub>
