<div align="center">

# Libre WebUI

### Privacy-First AI Chat Interface

<p align="center">
  <strong>Self-hosted • Open Source • Extensible</strong>
</p>

<p>
  <img src="./screenshot.png" width="100%" alt="Dark Theme">
</p>

<p align="center">
  <img src="https://img.shields.io/github/package-json/v/libre-webui/libre-webui" alt="Version">
  <img src="https://img.shields.io/github/license/libre-webui/libre-webui" alt="License">
  <a href="https://github.com/libre-webui/libre-webui"><img src="https://img.shields.io/github/stars/libre-webui/libre-webui?style=social" alt="Stars"></a>
</p>

[Website](https://librewebui.org) • [Documentation](https://docs.librewebui.org) • [𝕏](https://x.com/librewebui) • [Sponsor](https://github.com/sponsors/libre-webui) • [Get Started](#quick-start)

</div>

---

## Why Libre WebUI?

A simple, self-hosted interface for AI chat. Run it locally with Ollama, connect to OpenAI, Anthropic, or 9+ providers—all from one UI.

- **Your data stays yours** — Zero telemetry, fully self-hosted
- **Extensible plugin system** — Ollama, OpenAI, Anthropic, and any OpenAI-compatible API
- **Simple & focused** — Keyboard shortcuts, dark mode, responsive design

---

## Features

<table>
<tr>
<td width="50%">

### Core Experience

- Real-time streaming chat
- Dark/light themes
- VS Code-style keyboard shortcuts
- Mobile-responsive design
- **Native Desktop App** — macOS (Windows & Linux coming soon)

### AI Providers

- **Local**: Ollama (full integration)
- **Cloud**: OpenAI, Anthropic, Google, Groq, Mistral, OpenRouter, and more
- **Plugin System** — Add any OpenAI-compatible API via JSON config

</td>
<td width="50%">

### Advanced Capabilities

- **Document Chat (RAG)** — Upload PDFs, chat with your docs
- **Custom Personas** — AI personalities with memory
- **Interactive Artifacts** — Live HTML, SVG, code preview
- **Text-to-Speech** — Multiple voices and providers
- **SSO Authentication** — GitHub, Hugging Face OAuth

### Security

- AES-256-GCM encryption
- Role-based access control
- Enterprise compliance ready

</td>
</tr>
</table>

---

## Quick Start

**Requirements:** [Ollama](https://ollama.ai) (for local AI) or API keys for cloud providers

### One Command Install

```bash
npx libre-webui
```

That's it. Opens at `http://localhost:8080`

**Options:**

```bash
npx libre-webui --port 3000      # Custom port
npx libre-webui --help           # Show all options
```

**Environment variables:**

```bash
OPENAI_API_KEY=sk-... npx libre-webui
ANTHROPIC_API_KEY=sk-ant-... npx libre-webui
```

### Development Setup

```bash
# 1. Clone the repo
git clone https://github.com/libre-webui/libre-webui
cd libre-webui

# 2. Configure environment
cp backend/.env.example backend/.env

# 3. Install and run
npm install && npm run dev
```

### Configuration

Edit `backend/.env` to add your API keys:

```env
# Local AI (Ollama)
OLLAMA_BASE_URL=http://localhost:11434

# Cloud AI Providers (add the ones you need)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GROQ_API_KEY=gsk_...
GEMINI_API_KEY=...

# Optional: Text-to-Speech
ELEVENLABS_API_KEY=...
```

**Or with Docker** (requires Ollama running on host):

```bash
docker-compose -f docker-compose.external-ollama.yml up -d
```

> A bundled `docker-compose.yml` with Ollama included exists but is untested.

Access at `http://localhost:5173` (dev) or `http://localhost:8080` (Docker)

### Desktop App

Download the native desktop app from [GitHub Releases](https://github.com/libre-webui/libre-webui/releases):

| Platform              | Download         |
| --------------------- | ---------------- |
| macOS (Apple Silicon) | `.dmg` or `.zip` |
| Windows               | Coming soon      |
| Linux                 | Coming soon      |

---

> [!NOTE]
>
> ## Enterprise Services
>
> **Need a custom deployment?** [Kroonen AI, Inc.](https://kroonen.ai) offers professional services for organizations requiring enterprise-grade AI infrastructure.
>
> | What We Offer                                       | Perfect For             |
> | --------------------------------------------------- | ----------------------- |
> | Production deployment (AWS, Azure, GCP, on-premise) | Healthcare (HIPAA)      |
> | SSO integration (Okta, Azure AD, SAML)              | Legal & Finance (SOC 2) |
> | Custom development & integrations                   | Enterprise teams        |
> | Ongoing support & maintenance                       | Research institutions   |
>
> **[Contact Kroonen AI →](https://kroonen.ai/librewebui)**

> [!TIP]
>
> ## Support Development
>
> Libre WebUI is built and maintained independently. Your support keeps it free and open source.
>
> [![Sponsor](https://img.shields.io/badge/Sponsor-❤️-red?style=for-the-badge&logo=github)](https://github.com/sponsors/libre-webui)
>
> **[Become a Sponsor](https://github.com/sponsors/libre-webui)** — Help fund active development

---

## Community

- [Ethical Charter](./CHARTER.md) — Our commitment to privacy, freedom & transparency
- [Contributing](https://github.com/libre-webui/libre-webui/contribute) — Help improve Libre WebUI
- [𝕏 @librewebui](https://x.com/librewebui) — Follow for updates
- [Mastodon](https://fosstodon.org/@librewebui) — Fediverse updates
- [GitHub Issues](https://github.com/libre-webui/libre-webui/issues) — Bug reports & feature requests
- [Documentation](https://docs.librewebui.org) — Guides & API reference

---

<div align="center">

**Apache 2.0 License** • Copyright © 2025–present Libre WebUI™

Built by [Kroonen AI](https://kroonen.ai)

</div>
