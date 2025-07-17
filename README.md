<div align="center">

# Libre WebUI

**Open-source AI chat interface** - A clean, privacy-first web UI for local AI models via Ollama, with flexible routing to OpenAI, Anthropic, Groq, and other external AI services. Self-hosted AI assistant with complete data privacy.

[🌐 **Visit Website**](https://librewebui.org) • [📖 **Documentation**](https://docs.librewebui.org)

![Libre WebUI - Privacy-first AI chat interface for local and external AI models](./screenshot.png)

![version](https://img.shields.io/github/package-json/v/libre-webui/libre-webui)
![license](https://img.shields.io/github/license/libre-webui/libre-webui)
![commits](https://img.shields.io/github/commit-activity/w/libre-webui/libre-webui)
![last commit](https://img.shields.io/github/last-commit/libre-webui/libre-webui)
![open prs](https://img.shields.io/github/issues-pr/libre-webui/libre-webui?label=open%20PRs)
![closed prs](https://img.shields.io/github/issues-pr-closed/libre-webui/libre-webui?label=merged%20PRs&color=purple)
![repo size](https://img.shields.io/github/repo-size/libre-webui/libre-webui)
![top language](https://img.shields.io/github/languages/top/libre-webui/libre-webui)

</div>

---

## ✨ Key Features

- 🔒 **Privacy-First**: Complete offline operation, no data tracking or telemetry
- 🛡️ **Enterprise-Grade Security**: AES-256-GCM database encryption for all sensitive data
- 🤖 **Multi-AI Support**: Ollama, OpenAI, Anthropic Claude, Groq, Gemini, Mistral
- 🏠 **Self-Hosted**: Run entirely on your own hardware
- 🔌 **Plugin Architecture**: Extensible system for custom AI integrations
- 💬 **Modern Chat UI**: Clean, responsive interface for AI conversations
- 📚 **RAG (Retrieval-Augmented Generation)**: Chat with your documents
- 🎨 **Artifacts**: Interactive code execution and content generation
- ⚡ **Fast Setup**: Get running in under 5 minutes

---

## Free & Open Source

100% free and open source software. No telemetry, no tracking. Your data stays on your hardware by default.

## 🛡️ Enterprise-Grade Security

**Military-Grade Encryption**: All sensitive data is protected with AES-256-GCM encryption before being stored in your local database. Your conversations, documents, and preferences are encrypted at rest with zero performance impact.

- 🔐 **End-to-End Data Protection**: Chat messages, document content, and user preferences automatically encrypted
- 🔑 **Your Keys, Your Control**: Encryption keys never leave your environment
- 🏛️ **Compliance Ready**: Meets GDPR, HIPAA, SOC 2, and PCI DSS requirements
- ⚡ **Zero Performance Impact**: Hardware-accelerated encryption with minimal overhead
- 🔄 **Future-Proof**: Built-in key rotation and migration capabilities

**Perfect for sensitive use cases**: Healthcare, legal, finance, research, and any scenario requiring data protection.

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
GEMINI_API_KEY=your_gemini_key
MISTRAL_API_KEY=your_mistral_key
GITHUB_API_KEY=your_github_token

# Database Encryption (Highly Recommended)
ENCRYPTION_KEY=your_64_character_encryption_key_here
```

**[📖 Complete Plugin Setup Guide →](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)**
**[🔒 Database Encryption Guide →](https://docs.librewebui.org/DATABASE_ENCRYPTION)**

### Keep Models Updated

Automatically update your AI provider plugins with the latest available models:

```bash
# Update all configured providers (207+ models across 6 providers)
./scripts/update-all-models.sh

# Or update individual providers
./scripts/update-openai-models.sh      # 67 models
./scripts/update-anthropic-models.sh   # 13 models
./scripts/update-groq-models.sh        # 14 models
./scripts/update-gemini-models.sh      # 45 models
./scripts/update-mistral-models.sh     # 48 models
./scripts/update-github-models.sh      # 20 models
```

**[🤖 Model Updater Guide →](https://docs.librewebui.org/MODEL_UPDATER)**

## Docker Deployment

### Quick Start with Docker

```bash
# Standard setup (with bundled Ollama)
docker-compose up -d

# External Ollama setup (if you already have Ollama running)
docker-compose -f docker-compose.external-ollama.yml up -d
```

### Docker Configurations

**`docker-compose.yml` (Default)**

- **Best for:** New users, testing, development
- **Includes:** Complete setup with bundled Ollama
- **Access:** http://localhost:8080

**`docker-compose.external-ollama.yml`**

- **Best for:** Power users with existing Ollama setup
- **Requires:** Ollama running on host machine
- **Access:** http://localhost:8080

### Port Configuration

- **Frontend:** http://localhost:8080 (mapped from internal port 5173)
- **Backend:** http://localhost:3001
- **Ollama:** http://localhost:11434 (bundled) or external

**[🐳 Complete Docker Guide →](https://docs.librewebui.org/DOCKER_EXTERNAL_OLLAMA)**

## First-Time Setup

When you first launch Libre WebUI, you'll be greeted with a beautiful welcome screen that guides you through the initial setup:

### 🎉 Welcome Experience

- **App-style interface** - Clean, modern design that matches the main application
- **Feature highlights** - Introduction to key capabilities (Security, Performance, Open Source)
- **Guided setup** - Step-by-step process for creating your admin account

### 🔐 Admin Account Creation

- **Secure form** - Password validation and confirmation
- **Automatic admin role** - First user automatically becomes administrator
- **Instant access** - Seamless transition into the main application

The setup experience ensures you're up and running quickly while maintaining security best practices. Once complete, you'll have full access to all features including user management, plugin configuration, and system settings.

**[📖 Complete Authentication Guide →](https://docs.librewebui.org/AUTHENTICATION)**

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
- `./scripts/update-all-models.sh` - Update all AI provider plugins with latest available models
- `./scripts/update-openai-models.sh` - Update OpenAI plugin (67 models)
- `./scripts/update-anthropic-models.sh` - Update Anthropic plugin (13 models)
- `./scripts/update-groq-models.sh` - Update Groq plugin (14 models)
- `./scripts/update-gemini-models.sh` - Update Google Gemini plugin (45 models)
- `./scripts/update-mistral-models.sh` - Update Mistral plugin (48 models)
- `./scripts/update-github-models.sh` - Update GitHub Models plugin (20 models)

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
- **Enterprise security** - AES-256-GCM encryption for all sensitive data at rest
- **First-time setup** - Beautiful welcome experience with guided admin account creation
- **User management** - Secure authentication with role-based access control
- **Light/Dark mode** - Comfortable viewing with improved accessibility
- **Responsive design** - Works on desktop, tablet, and mobile devices
- **Real-time chat** - Streaming responses with WebSocket integration
- **Document chat** - Upload documents (PDF, TXT, DOCX) and chat with their content using semantic search
- **Persona Development Framework** - Create custom AI personalities with memory systems, adaptive learning, and dynamic embedding model selection from your Ollama installation
- **Plugin system** - Connect external AI services (OpenAI, Anthropic, Groq, Gemini, Mistral, GitHub Models) - 207+ models across 6 providers
- **Artifacts** - Interactive content rendering for HTML, SVG, code, and more
- **Privacy-focused** - Local processing with optional external connections
- **Zero telemetry** - No tracking or data collection
- **Keyboard shortcuts** - VS Code-inspired shortcuts for power users (⌘B, ⌘D, ⌘,, ?)
- **Performance optimized** - Code splitting and lazy loading for faster page loads

### 🎨 Artifacts - Interactive Content Rendering

Create and interact with dynamic content directly within chat conversations:

#### Supported Artifact Types

- ✅ **HTML Pages** - Interactive web pages with JavaScript functionality
- ✅ **SVG Graphics** - Scalable vector graphics with animations
- ✅ **React Components** - Interactive UI components (future enhancement)
- ✅ **Code Snippets** - Syntax-highlighted code with copy functionality
- ✅ **JSON Data** - Formatted data structures with validation
- ✅ **Charts & Visualizations** - Data visualization components (future enhancement)

#### How Artifacts Work

1. **Automatic Detection** - Code blocks with specific languages (HTML, SVG, Python, etc.) are automatically converted to artifacts
2. **Interactive Rendering** - Content is rendered in sandboxed environments for security
3. **Full-Screen Mode** - Expand artifacts to full screen for better viewing
4. **Copy & Download** - Easily copy content or download as files
5. **Safe Execution** - All artifacts run in isolated contexts to prevent security issues

#### Usage Examples

Ask the AI to create:

- "Create an interactive HTML page with a color picker"
- "Generate an SVG logo with animations"
- "Build a Python script for data analysis"
- "Create a JSON configuration file for this project"

The AI's response will automatically render as an interactive artifact alongside the explanation.

**[🎨 Complete Artifacts Guide →](https://docs.librewebui.org/ARTIFACTS_FEATURE)**
**[⚙️ Technical Implementation →](https://docs.librewebui.org/RELEASE_AUTOMATION)**

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

### 🎭 Persona Development Framework

Create sophisticated AI personalities with advanced memory systems and adaptive learning capabilities:

#### Dynamic Embedding Model Selection

- ✅ **Ollama Integration** - Automatically detects all embedding models from your Ollama installation
- ✅ **Smart Discovery** - Intelligent pattern matching identifies embedding-capable models
- ✅ **Real-time Updates** - Available models refresh when you install new embeddings via `ollama pull`
- ✅ **User Choice** - Select from any detected model: `nomic-embed-text`, `bge-large`, `gte-base`, and more
- ✅ **Installation Guidance** - Helpful prompts with `ollama pull` commands when no models are found

#### Advanced Memory Systems

- 🧠 **Per-User Memory Isolation** - Each user gets dedicated memory context for personalized experiences
- 🔍 **Semantic Memory Storage** - Conversations stored as vector embeddings for intelligent retrieval
- 📊 **Memory Importance Scoring** - Automatic ranking based on emotional significance and relevance
- ⚙️ **Configurable Retention** - Set memory limits, cleanup policies, and retention periods per persona

#### Adaptive Learning Engine

- 🎯 **Top-K Semantic Retrieval** - Vector similarity-based memory search with contextual ranking
- 🔄 **Dynamic State Updates** - Real-time personality adjustments based on conversation patterns
- 📈 **Sentiment Analysis** - Automatic detection of user preferences and emotional responses
- 🧬 **Persona DNA Export/Import** - Complete persona packages with memories and learned behaviors

#### Example Embedding Models

```bash
# Install popular embedding models
ollama pull nomic-embed-text    # Default, balanced performance
ollama pull bge-large          # High accuracy, larger memory footprint
ollama pull gte-base           # Lightweight, fast processing
ollama pull multilingual-e5    # Multi-language support
```

### 🔌 Plugin System

Connect to external AI services while maintaining local fallback:

#### Supported Services

- ✅ **OpenAI** - o3, o3-mini, o4, o4-mini, GPT-4o, GPT-4.1, ChatGPT-4o-latest (67 models)
- ✅ **Anthropic** - Claude 4 Sonnet, Claude 4 Opus, Claude 3.7 Sonnet, Claude 3.5 Sonnet (13 models)
- ✅ **Groq** - Llama 4 Maverick, Llama 3.3 70B, DeepSeek R1 Distill, Qwen QwQ 32B (14 models)
- ✅ **Google Gemini** - Gemini 2.0 Flash, Gemini 1.5 Pro, Gemini 1.5 Flash (45 models)
- ✅ **Mistral** - Mistral Large, Mistral Small, Codestral, Pixtral (48 models)
- ✅ **GitHub Models** - Llama 3.2, Phi-3.5, Cohere Command R+ (20 models)
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

**[📖 Complete Plugin Guide →](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)**

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
libre-webui/
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

**[📖 Complete Documentation →](https://docs.librewebui.org)**

| Guide                                                                                             | Description                                                                         |
| ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **[🚀 Quick Start](https://docs.librewebui.org/QUICK_START)**                                     | Get up and running in 5 minutes                                                     |
| **[🤖 Working with Models](https://docs.librewebui.org/WORKING_WITH_MODELS)**                     | Complete AI models guide                                                            |
| **[🎯 Pro Tips](https://docs.librewebui.org/PRO_TIPS)**                                           | Advanced workflows and techniques                                                   |
| **[⌨️ Keyboard Shortcuts](https://docs.librewebui.org/KEYBOARD_SHORTCUTS)**                       | Productivity hotkeys                                                                |
| **[🎭 Demo Mode](https://docs.librewebui.org/DEMO_MODE)**                                         | Try without installation                                                            |
| **[🔧 Troubleshooting](https://docs.librewebui.org/TROUBLESHOOTING)**                             | Problem solving guide                                                               |
| **[🔌 Plugin Architecture](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)**                     | Connect multiple AI services                                                        |
| **[📚 RAG Feature](https://docs.librewebui.org/RAG_FEATURE)**                                     | Chat with your documents                                                            |
| **[🗄️ SQLite Migration](https://docs.librewebui.org/SQLITE_MIGRATION)**                           | Upgrade from JSON to SQLite storage                                                 |
| **[🤖 Model Updater](https://docs.librewebui.org/MODEL_UPDATER)**                                 | Auto-update AI provider models                                                      |
| **[🔐 Authentication](https://docs.librewebui.org/AUTHENTICATION)**                               | User management and security                                                        |
| **[🔒 Database Encryption](https://docs.librewebui.org/DATABASE_ENCRYPTION)**                     | Enterprise-grade data protection with AES-256-GCM encryption                        |
| **[🎨 Artifacts Feature](https://docs.librewebui.org/ARTIFACTS_FEATURE)**                         | Interactive content and code execution                                              |
| **[⚙️ Artifacts Implementation](https://docs.librewebui.org/RELEASE_AUTOMATION)**                 | Technical implementation details                                                    |
| **[🐳 Docker External Ollama](https://docs.librewebui.org/DOCKER_EXTERNAL_OLLAMA)**               | Run Docker with external Ollama instance                                            |
| **[🎭 Persona Development Framework](https://docs.librewebui.org/PERSONA_DEVELOPMENT_FRAMEWORK)** | Advanced AI personalities with memory systems and dynamic embedding model selection |

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

## Community

<div align="center">

🐘 **Follow us on Mastodon:** [@librewebui@fosstodon.org](https://fosstodon.org/@librewebui)

</div>

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](http://www.apache.org/licenses/LICENSE-2.0) for details.
_Copyright (C) 2025 Libre WebUI_

---

<small>Powered by [Kroonen AI](https://kroonen.ai)</small>
