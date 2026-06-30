<div align="center">

<br>

# 🕊️ Libre WebUI

### Your AI, Your Rules.

**The privacy-first, open-source chat interface for local and cloud AI.**<br>
No telemetry. No tracking. No compromises.

<br>

<p>
  <a href="https://github.com/libre-webui/libre-webui/releases"><img src="https://img.shields.io/github/v/release/libre-webui/libre-webui?style=flat-square&label=version&color=blue" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache_2.0-green?style=flat-square" alt="License"></a>
  <a href="https://github.com/libre-webui/libre-webui/actions"><img src="https://img.shields.io/github/actions/workflow/status/libre-webui/libre-webui/release.yml?style=flat-square&label=Build" alt="CI"></a>
  <a href="https://huggingface.co/libre-webui"><img src="https://img.shields.io/badge/🤗_Hugging_Face-models-yellow?style=flat-square" alt="Hugging Face"></a>
  <a href="https://github.com/libre-webui/libre-webui"><img src="https://img.shields.io/github/stars/libre-webui/libre-webui?style=flat-square&label=Stars" alt="Stars"></a>
</p>

<p>
  <a href="https://librewebui.org">Website</a> •
  <a href="https://docs.librewebui.org">Docs</a> •
  <a href="https://github.com/libre-webui/libre-webui/releases">Download</a> •
  <a href="#quick-start">Quick Start</a>
</p>

<br>

<p>
  <img src="./screenshot.png" width="100%" alt="Libre WebUI — Privacy-first AI chat interface">
</p>

</div>

---

## Why Libre WebUI?

Most AI chat tools either **lock you into a cloud**, **harvest your data**, or **pull the rug on their open-source license through restrictive relicensing or contributor agreements**. We think you deserve better.

Libre WebUI is a **self-hosted AI workspace** that connects to [Ollama](https://ollama.com) for local AI and to cloud providers through plugins — all from one clean, fast UI. Your conversations stay on your device or server unless _you_ choose to use a remote provider.

> **Built by [Kroonen AI](https://kroonen.ai) and the open-source community.** Apache 2.0 forever — [we put it in our charter](./CHARTER.md).

---

## ✨ Features at a Glance

|     | Feature                  | What it does                                                              |
| --- | ------------------------ | ------------------------------------------------------------------------- |
| 💬  | **Streaming Chat**       | Real-time local and provider-backed conversations                         |
| 🧠  | **Model Manager**        | Pull, browse, unload, and manage Ollama, Ollama Cloud, and HF GGUF models |
| 🔌  | **Plugin System**        | Connect OpenAI-compatible providers with JSON config and user credentials |
| 📄  | **Document Chat (RAG)**  | Upload PDF and plain-text files, then search them from chat               |
| 🎭  | **Personas**             | Reusable assistants with prompts, parameters, memory, and import/export   |
| 🎨  | **Artifacts**            | Sandboxed HTML, SVG, JSON, and code previews beside chat                  |
| 🖼️  | **Image Generation**     | ComfyUI and provider plugins for generated images                         |
| 🔊  | **Text-to-Speech**       | Qwen3-TTS, Kyutai, OpenAI-compatible voices, and provider plugins         |
| 🤗  | **Hugging Face Hub**     | Discover Hub models and compatible GGUF files from the UI                 |
| 🔐  | **Auth & Signup Safety** | Local accounts, GitHub/Hugging Face OAuth, roles, and optional Turnstile  |
| 🌍  | **25+ Languages**        | Full i18n coverage from Arabic to Vietnamese                              |
| 🖥️  | **Desktop App**          | Electron builds for macOS, Windows, and Linux                             |
| 🤖  | **AI Agent Support**     | Libre Claw runs, approvals, tools, schedules, memory, and usage           |
| 🏢  | **Self-Hosted Ops**      | Docker, Kubernetes, SQLite storage, encrypted credentials, and backups    |

---

## 🚀 Quick Start

### One command — that's it

```bash
npx libre-webui
```

Opens at `http://localhost:8080`. Install [Ollama](https://ollama.com) for local AI, or add provider API keys in Settings.

For a first local model:

```bash
ollama pull gemma3:4b
```

The first account created on a fresh install becomes the administrator.

### 🐳 Docker

```bash
# With bundled Ollama
docker compose up -d

# With your existing Ollama
docker compose -f docker-compose.external-ollama.yml up -d

# GPU support (NVIDIA)
docker compose -f docker-compose.gpu.yml up -d
```

### 🍺 Homebrew (macOS)

```bash
brew tap libre-webui/tap && brew install libre-webui
libre-webui

# Or install the desktop app
brew install --cask libre-webui
```

### ☸️ Kubernetes

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui
```

### 🖥️ Desktop App

Download from [GitHub Releases](https://github.com/libre-webui/libre-webui/releases) — available for **macOS**, **Windows**, and **Linux**.

### 🛠️ From Source

```bash
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
cp backend/.env.example backend/.env
npm install && npm run dev
```

<details>
<summary><strong>⚙️ Configuration</strong></summary>

Edit `backend/.env`:

```env
# Local AI (default — just install Ollama)
OLLAMA_BASE_URL=http://localhost:11434
JWT_SECRET=replace-with-a-long-random-secret

# Cloud providers (optional — add what you need)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
HUGGINGFACE_API_KEY=hf_...

# Optional signup protection
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

</details>

<details>
<summary><strong>🧪 Development builds (unstable)</strong></summary>

Dev builds are auto-generated from the `dev` branch. **Not for production.**

```bash
docker compose -f docker-compose.dev.yml up -d
```

Uses separate data volumes (`libre_webui_dev_data`) so your stable install stays safe.

</details>

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────┐
│              Libre WebUI                    │
├──────────────────┬──────────────────────────┤
│   React 18 + TS  │   Express 5 + SQLite     │
│   Frontend       │   Backend                │
│   (Vite)         │   (JWT + encrypted vals) │
├──────────────────┴──────────────────────────┤
│              Plugin Layer                   │
│   Ollama │ OpenAI │ Anthropic │ Google │ …  │
├─────────────────────────────────────────────┤
│   Electron (Desktop) │ Docker │ Kubernetes  │
└─────────────────────────────────────────────┘
```

- **Frontend:** React 18 + TypeScript, Vite, Tailwind, responsive with keyboard shortcuts
- **Backend:** Express 5, SQLite, JWT auth, rate limits, SSE/WebSocket streaming
- **Plugins:** JSON config files with per-user credentials, variables, and model discovery
- **Desktop:** Electron with native macOS/Windows/Linux builds

---

## 🔌 Plugin System

Add any AI provider with a JSON file — no code changes needed:

```json
{
  "id": "my-provider",
  "name": "My Provider",
  "type": "completion",
  "endpoint": "https://api.example.com/v1/chat/completions",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "MY_API_KEY"
  },
  "model_map": ["model-a", "model-b"]
}
```

Built-in plugins: **OpenAI, Anthropic, Google Gemini, Groq, Mistral, OpenRouter, Hugging Face**, GitHub Models, ComfyUI, ElevenLabs, and more.

Plugins support **multi-capability** (chat + TTS + image gen in one config), **per-user variables**, and **encrypted credential storage**.

📖 [Full plugin docs →](./docs/08-PLUGIN_ARCHITECTURE.md)

---

## 🤖 AI Agent Support (Libre Claw)

Libre WebUI supports **AI agents** through
[Libre Claw](https://github.com/kroonen-ai/libre-claw), a local agent daemon
for durable runs, permissioned tools, memory, skills, schedules, Telegram, and
provider routing.

**What agents can do:**

- 🧠 **Persistent memory** — durable local memory, run archives, and project summaries
- 🔧 **Tool use** — file operations, shell, git, browser work, HTTP, MCP, schedules, and web search
- 🧰 **Workspace access** — run agent work in the configured local workspace
- ✅ **Approvals** — review and approve tool calls from WebUI before side effects
- 🧭 **Run timeline** — inspect assistant deltas, tool calls, tool results, errors, and artifacts
- 📅 **Automations** — create, pause, resume, run, and delete Libre Claw schedules
- 📊 **Usage** — inspect provider usage and fallback behavior

Start Libre Claw locally:

```bash
libre-claw start
```

Then open **Libre WebUI → Libre Claw**. The backend talks to
`http://127.0.0.1:8766` by default, or to `LIBRE_CLAW_BASE_URL` when configured.

> **Your agent, your workspace, your data.** Libre WebUI provides the browser
> control surface while Libre Claw keeps the local agent runtime, safety model,
> memory, tools, and schedules.

📖 [Libre Claw integration docs →](./docs/31-LIBRE_CLAW_INTEGRATION.md)

---

## 🤝 Contributing

We'd love your help! Libre WebUI is built by people who care about privacy and AI freedom.

**Getting started is easy:**

1. Fork the repo and clone it
2. `npm install && npm run dev`
3. Make your changes on a branch off `dev`
4. Open a PR — one approving review from the TSC and you're in

**Ways to contribute:**

- 🐛 **Bug reports** — [open an issue](https://github.com/libre-webui/libre-webui/issues)
- 💡 **Feature ideas** — start a discussion
- 🌍 **Translations** — help us reach more languages
- 📖 **Documentation** — every improvement helps
- 🔌 **Plugins** — share your provider configs

All contributors follow our [Code of Conduct](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) and [Community Charter](./CHARTER.md).

Security issues? Email **security@kroonen.ai** — we follow a 30-day coordinated disclosure.

---

## 📜 Our Promise

Libre WebUI has an [Ethical Charter](./CHARTER.md) that guarantees:

- 🔓 **Apache 2.0 forever** — no bait-and-switch relicensing
- 🚫 **Zero telemetry** — no analytics, no tracking, no phone-home. Ever.
- 🏛️ **Community governance** — transparent decisions, public roadmap
- 🤝 **No VC capture** — funded by the community, for the community
- ✊ **Ethical use** — we actively oppose surveillance and weapons applications

---

## 🏢 Enterprise

Need to deploy at scale? [Kroonen AI](https://kroonen.ai) provides professional services:

| Service                  | Description                                       |
| ------------------------ | ------------------------------------------------- |
| **Custom Deployment**    | On-prem, cloud, private-network, and Kubernetes   |
| **Identity & Access**    | OAuth setup, role design, and enterprise planning |
| **Custom Development**   | Integrations, white-labeling, and plugins         |
| **Security Reviews**     | Deployment hardening and control documentation    |
| **SLA-Backed Support**   | Priority response and dedicated channels          |
| **Air-Gapped Workflows** | Offline deployments and local model operations    |

📧 **enterprise@kroonen.ai** • [Learn more →](https://kroonen.ai/services)

---

## 🔗 Links

|                      |                                                                                  |
| -------------------- | -------------------------------------------------------------------------------- |
| 🌐 **Website**       | [librewebui.org](https://librewebui.org)                                         |
| 📖 **Documentation** | [docs.librewebui.org](https://docs.librewebui.org)                               |
| 🐙 **GitHub**        | [github.com/libre-webui/libre-webui](https://github.com/libre-webui/libre-webui) |
| 🦊 **GitLab**        | [git.kroonen.ai/libre-webui](https://git.kroonen.ai/libre-webui/libre-webui)     |
| 🤗 **Hugging Face**  | [huggingface.co/libre-webui](https://huggingface.co/libre-webui)                 |
| 𝕏 **Twitter**        | [@librewebui](https://x.com/librewebui)                                          |
| 🐘 **Mastodon**      | [@librewebui@fosstodon.org](https://fosstodon.org/@librewebui)                   |
| ❤️ **Sponsor**       | [github.com/sponsors/libre-webui](https://github.com/sponsors/libre-webui)       |

---

<div align="center">

### ⭐ If Libre WebUI helps you, give us a star!

It helps others discover the project and keeps us motivated.

<a href="https://github.com/libre-webui/libre-webui"><img src="https://img.shields.io/github/stars/libre-webui/libre-webui?style=for-the-badge&label=Star%20on%20GitHub&color=gold" alt="Star on GitHub"></a>

<br><br>

**Apache 2.0 License** • Copyright © 2025–present Libre WebUI™

Built with ❤️ by [Kroonen AI](https://kroonen.ai) and the open-source community

</div>
