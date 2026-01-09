---
sidebar_position: 1
title: "Documentation"
description: "Libre WebUI documentation - self-hosted, privacy-first AI chat interface"
slug: /
keywords: [libre webui, ollama, local ai, privacy ai, self-hosted ai, chatgpt alternative]
---

# Libre WebUI Documentation

Self-hosted AI chat that works with Ollama, OpenAI, Anthropic, and 9+ providers.

## Quick Start

The fastest way to get started:

```bash
npx libre-webui
```

Opens at `http://localhost:8080`. That's it.

**Requirements:** [Ollama](https://ollama.ai) for local AI, or API keys for cloud providers.

## Installation Options

| Method | Command | Best For |
|--------|---------|----------|
| **npx** | `npx libre-webui` | Quick start, testing |
| **Docker** | `docker-compose up -d` | Production, includes Ollama |
| **Docker (external Ollama)** | `docker-compose -f docker-compose.external-ollama.yml up -d` | When Ollama is already running |
| **Kubernetes** | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui` | Enterprise, scaling |
| **From source** | `npm install && npm run dev` | Development |

## Core Features

- **Real-time streaming chat** with dark/light themes
- **Document Chat (RAG)** - Upload PDFs and chat with your docs
- **Custom Personas** - AI personalities with memory
- **Interactive Artifacts** - Live HTML, SVG, code preview
- **Text-to-Speech** - Multiple voices and providers

## AI Providers

**Local:**
- Ollama (full integration)

**Cloud (via plugins):**
- OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, and more

## Documentation

### Getting Started
- [Quick Start](./QUICK_START) - 5 minute setup
- [Working with Models](./WORKING_WITH_MODELS) - Model management
- [Keyboard Shortcuts](./KEYBOARD_SHORTCUTS) - Productivity tips

### Deployment
- [Docker](./DOCKER) - Docker and Docker Compose
- [Kubernetes](./KUBERNETES) - Helm chart deployment
- [Desktop App](./ELECTRON_DESKTOP_APP) - Native macOS app

### Features
- [Plugin Architecture](./PLUGIN_ARCHITECTURE) - External AI providers
- [Document Chat (RAG)](./RAG_FEATURE) - Upload and chat with documents
- [Artifacts](./ARTIFACTS_FEATURE) - Interactive content
- [Personas](./PERSONA_DEVELOPMENT_FRAMEWORK) - Custom AI personalities

### Administration
- [Authentication](./AUTHENTICATION) - User management and SSO
- [Single Sign-On](./SINGLE_SIGN_ON) - GitHub, Hugging Face OAuth

## Configuration

Edit `backend/.env`:

```env
# Local AI
OLLAMA_BASE_URL=http://localhost:11434

# Cloud providers (optional)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Enterprise

[Kroonen AI](https://kroonen.ai) provides professional services:

- On-premise & cloud deployment
- SSO integration (Okta, Azure AD, SAML)
- Custom development
- SLA-backed support

Contact: enterprise@kroonen.ai

## Links

- [Website](https://librewebui.org)
- [GitHub](https://github.com/libre-webui/libre-webui)
- [Issues](https://github.com/libre-webui/libre-webui/issues)
