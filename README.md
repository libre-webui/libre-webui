# Libre WebUI

![version](https://img.shields.io/github/package-json/v/libre-webui/libre-webui)

A minimalist, privacy-first interface for local LLMs via Ollama.

<img src="./rr.jpg" alt="Rick Rubin Coding Wisdom" width="300">

_Like Rick Rubin strips music to its essence, Libre WebUI strips away UI complexity. Simple. Minimal. Effective._

---

## Free & Open Source

100% free and open source software. No telemetry. No tracking. Your data stays on your hardware.

## Privacy First

Complete offline inference on your own hardware. No data leaves your machine unless you configure it to.

---

## Setup

```bash
# Option 1: Quick start
./start.sh

# Option 2: Manual
npm install
npm run dev
```

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

---

## Features

### 🚀 Core Features

- **Clean, minimal interface** - Rick Rubin-inspired simplicity
- **Light/Dark mode** - Comfortable viewing in any environment with improved accessibility
- **Responsive design** - Works seamlessly on desktop, tablet, and mobile
- **Real-time chat** - Streaming responses with WebSocket integration
- **Fully private** - Offline inference on your own hardware
- **Zero telemetry** - No tracking, no data collection
- **Keyboard shortcuts** - VS Code-like shortcuts for power users (⌘B, ⌘D, ⌘,, ?)
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

### 🎯 UI Components

- **Model Manager** - Comprehensive model management interface
- **Chat Interface** - Intuitive conversation experience with syntax highlighting
- **Settings Panel** - Customizable preferences and options
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
