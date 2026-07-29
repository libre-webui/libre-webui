<div align="center">

<br>

# Libre WebUI

### Your AI stack should answer to you.

**A local-first workspace for chat, private knowledge, artifacts, and isolated model-driven work.**<br>
Self-hosted. Provider-flexible. Apache 2.0.

**Run local. Bring the providers you choose. Keep control of the interface around them.**

<br>

<p>
  <a href="https://github.com/libre-webui/libre-webui/releases"><img src="https://img.shields.io/github/v/release/libre-webui/libre-webui?style=flat-square&label=release&color=2563eb" alt="Latest release"></a>
  <a href="https://www.npmjs.com/package/libre-webui"><img src="https://img.shields.io/npm/v/libre-webui?style=flat-square&label=npm&color=cb3837" alt="npm version"></a>
  <a href="https://github.com/libre-webui/libre-webui/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-15803d?style=flat-square" alt="Apache 2.0 License"></a>
  <a href="https://github.com/libre-webui/libre-webui/actions/workflows/format.yml"><img src="https://img.shields.io/github/actions/workflow/status/libre-webui/libre-webui/format.yml?branch=main&style=flat-square&label=main%20checks" alt="Main branch checks"></a>
  <a href="https://github.com/libre-webui/libre-webui"><img src="https://img.shields.io/github/stars/libre-webui/libre-webui?style=flat-square&label=stars&color=ff7b52" alt="GitHub stars"></a>
</p>

<p>
  <a href="https://librewebui.org"><strong>Website</strong></a> ·
  <a href="https://docs.librewebui.org"><strong>Documentation</strong></a> ·
  <a href="https://github.com/libre-webui/libre-webui/releases"><strong>Download</strong></a> ·
  <a href="#start-in-one-command"><strong>Quick start</strong></a>
</p>

<br>

<img src="https://raw.githubusercontent.com/libre-webui/libre-webui/main/screenshot.png" width="100%" alt="Libre WebUI local-first AI workspace">

</div>

---

## Freedom should survive success

An AI interface can be self-hosted today and still become a gatekeeper tomorrow. Libre WebUI is built so your freedom does not depend on a company remaining benevolent.

Run it. Inspect it. Change it. Fork it. Connect it to something else. Or leave it behind. The code is Apache 2.0, local inference is the default path, remote providers are opt-in, and the project charter puts independence and inclusive participation into writing.

> **Open source is a license. Libre is an operating principle.**

Do not trust the pitch. Inspect the [license](https://github.com/libre-webui/libre-webui/blob/main/LICENSE), [charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md), [source](https://github.com/libre-webui/libre-webui), and [CI](https://github.com/libre-webui/libre-webui/actions).

| What stays yours      | Libre WebUI's approach                                                              | Verify it                                                                  |
| --------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Data path**         | Self-hosted by default; remote inference only when you select it                    | [Deployment docs](https://docs.librewebui.org/DOCKER)                      |
| **Model choice**      | Local Ollama plus optional provider plugins and OpenAI-compatible endpoints         | [Plugin architecture](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)     |
| **Code**              | Use, modify, redistribute, and fork under Apache 2.0                                | [License](https://github.com/libre-webui/libre-webui/blob/main/LICENSE)    |
| **Project direction** | The charter rejects funding control over the roadmap, license, or community         | [Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md) |
| **Participation**     | Contributors and users are welcome regardless of background, identity, or geography | [Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md) |
| **Exit**              | Your installation and your fork do not need our permission                          | [Source](https://github.com/libre-webui/libre-webui)                       |

## Start in one command

With [Node.js 22.22 or newer](https://nodejs.org):

```bash
npx libre-webui
```

Open [http://localhost:8080](http://localhost:8080). The first account created on a fresh install becomes the administrator.

For private local inference, install [Ollama](https://ollama.com) and pull a model:

```bash
ollama pull gemma3:4b
```

That is enough to start. Cloud accounts are not required. When you do want a remote model, add only the provider you choose.

Chat works without Docker. The new **Work** mode additionally needs Docker on
the machine running the Libre WebUI backend. If Docker is missing, Libre WebUI
still starts normally and Work shows a clear **Runtime unavailable** state
instead of running commands on the host.

## One workspace. Your choices.

Libre WebUI turns a model endpoint into a complete working environment without taking ownership of the stack around it.

|                                 | What you can do                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| **Talk to the model you want**  | Stream conversations through local Ollama, Ollama Cloud, bundled providers, or compatible endpoints. Discover and manage models from the UI. |
| **Give every task a workspace** | Let a tool-capable model inspect files, edit code, run commands, and preview an app in a persistent, task-scoped Docker workspace.           |
| **Bring your own context**      | Chat with PDF and plain-text documents using keyword retrieval or optional semantic embeddings.                                              |
| **Turn answers into artifacts** | Preview sandboxed HTML, SVG, JSON, code, and multi-file artifacts beside a normal chat.                                                      |
| **Create with more than text**  | Generate images, use provider-backed speech, and build reusable personas with prompts, parameters, and memory.                               |
| **Make the interface yours**    | Keep light or dark mode across refreshes, apply an adaptive accent theme, and work in 25 languages/locales including Arabic RTL.             |
| **Operate it your way**         | Use local accounts, roles, optional OAuth, Docker, Kubernetes, npm, or the Electron desktop client.                                          |
| **Extend without lock-in**      | Configure chat, embeddings, image generation, and text-to-speech providers through the plugin layer.                                         |

## Local-first is a real boundary

Libre WebUI ships without application telemetry or analytics. When you use Ollama locally, prompts and responses stay on the infrastructure you control. If you select a remote provider, that provider receives the requests you choose to send to it; Libre WebUI does not pretend otherwise.

For shared and public deployments, the backend includes:

- Local accounts with bcrypt password hashing and JWT sessions
- Admin and user roles, login/signup rate limits, and optional Cloudflare Turnstile
- Optional GitHub and Hugging Face OAuth
- Application-layer AES-256-GCM encryption for supported sensitive values such as credentials
- Persistent SQLite storage, configurable data directories, and documented backup practices

Application-layer encryption is not full-disk or end-to-end encryption. Use HTTPS, access-controlled storage, stable secrets, and disk encryption where your threat model requires them. Start with the [authentication guide](https://docs.librewebui.org/AUTHENTICATION) and [encryption guide](https://docs.librewebui.org/DATABASE_ENCRYPTION).

## Models and providers without a single-provider worldview

Ollama is the local path, not a lock-in strategy. Libre WebUI bundles provider definitions spanning chat, images, embeddings, speech, and OpenAI-compatible services, including OpenAI, Anthropic, Google Gemini, Groq, Kimi Code by Moonshot AI, Mistral, OpenRouter, Hugging Face, GitHub Models, ComfyUI, ElevenLabs, Qwen3-TTS, and Kyutai TTS.

Credentials can come from deployment-wide environment variables or encrypted, user-scoped settings. Plugins can define static model fallbacks and use live discovery when a provider exposes a compatible model-list endpoint.

[Explore the plugin system →](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)

## Work: one persistent environment per task

Work is Libre WebUI's built-in coding-agent surface. Choose **Work** beside
**Chat**, select a tool-capable model, and describe what you want to build or
change. Each task keeps its own conversation, exact provider route, files, tool
activity, and preview state.

```text
Work task
   ├── durable conversation and run history in SQLite
   ├── dedicated Docker named volume mounted at /workspace
   ├── disposable, policy-checked container for commands
   └── Files · Activity · Preview workspace pane
```

The model can list, read, write, and search task files, run bounded shell
commands, and start or stop a browser preview. The workspace includes a
light/dark syntax-highlighted editor, supported-file formatting, browser drafts,
conflict-aware saves, and a draggable responsive split between conversation and
workspace. Tasks remain in the main sidebar so returning to an older task also
returns to its existing files and history.

Active runs stream assistant text, provider-exposed reasoning, tool calls,
results, usage, and state changes into the interface. Reasoning appears only
when the selected provider returns it; Libre WebUI cannot reveal a model's
hidden chain-of-thought. Server-owned worker skills teach the model the
workspace boundary, efficient project discovery, safe editing, verification,
and preview lifecycle without adding control files to the project.

Work can use installed Ollama models, Ollama Cloud models, or configured
completion/chat plugins through OpenAI-compatible, Anthropic, and Gemini tool
adapters. Tool support is required. Selecting a remote route shows a dismissible
per-user disclosure because an autonomous run may make multiple paid provider
calls and may send conversation context and requested tool results—including
file contents—to that service.

The same configurable round budget applies to every provider route (48 by
default). If it is exhausted, Work requests a final no-tools progress handoff
and ends in the yellow **Needs input** state instead of reporting a false
success or a raw provider-specific round-limit error. A follow-up run continues
in the same durable workspace.

Work is admin-only and never falls back to host command execution. Containers
run as a non-root user with a read-only root filesystem, dropped capabilities,
resource limits, and only the task volume mounted. Containers are still not
virtual machines, current Work tasks have Docker bridge egress, and task volumes
need their own backup and storage policy.

[Read the Work workspace guide →](https://docs.librewebui.org/WORKSPACES)

## Optional broader agents, with the runtime kept separate

[Libre Claw](https://github.com/kroonen-ai/libre-claw) is an optional, admin-controlled local agent runtime. Libre WebUI provides the authenticated control surface for durable runs, timelines, approvals, schedules, usage, and configuration; Libre Claw owns the tools, memory, permission model, and execution.

Libre Claw is separate from Work. Work is native to Libre WebUI and focused on
one isolated project workspace; Libre Claw is the optional daemon for broader
file, shell, git, browser, HTTP, web-search, MCP, memory, approval, and
automation workflows.

```text
Browser or desktop client
          │
          ▼
  Libre WebUI interface
   React + TypeScript
          │
          ▼
  Express API + WebSocket ─────► SQLite
          │
          ├────────► Ollama (local models)
          ├────────► selected provider plugins
          ├────────► Docker (native Work task containers)
          └────────► Libre Claw (optional agent runtime)
```

The WebUI backend does not execute Libre Claw's shell or browser tools itself. It proxies authenticated admin actions to the separately running daemon, where approvals and safety rules remain authoritative.

[Read the Libre Claw integration guide →](https://docs.librewebui.org/LIBRE_CLAW_INTEGRATION)

## Deploy on your terms

| Path                | Command or link                                                         | Best for                                                              |
| ------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **npm**             | `npx libre-webui`                                                       | Fast local start; Work is available when local Docker is installed    |
| **Docker + Ollama** | `docker compose up -d`                                                  | Persistent chat stack; Work is unavailable in the standard image      |
| **External Ollama** | `docker compose -f docker-compose.external-ollama.yml up -d`            | Existing Ollama; same standard-container Work limitation              |
| **NVIDIA Docker**   | `docker compose -f docker-compose.gpu.yml up -d`                        | Local GPU inference; same standard-container Work limitation          |
| **Kubernetes**      | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui` | Cluster deployment; the current chart has no Work runtime driver      |
| **Desktop client**  | [GitHub Releases](https://github.com/libre-webui/libre-webui/releases)  | Electron UI; Work runs wherever its separately managed backend runs   |
| **Source**          | `npm install && npm run dev`                                            | Development; Work uses Docker available to the native backend process |

Docker commands assume you have cloned this repository. Production deployments should set stable `JWT_SECRET` and `ENCRYPTION_KEY` values, persist the data directory, back up the database and key together, and terminate public traffic with HTTPS.

The standard Libre WebUI container deliberately does not include the Docker CLI
or mount the host Docker socket, so it reports Work as unavailable. Mounting
`/var/run/docker.sock` into a web application grants root-equivalent control of
the Docker host and is not enabled or recommended as a casual workaround. See
the Work guide before designing a separate runtime integration.

[Work](https://docs.librewebui.org/WORKSPACES) · [Docker](https://docs.librewebui.org/DOCKER) · [Kubernetes](https://docs.librewebui.org/KUBERNETES) · [Environment variables](https://docs.librewebui.org/ENVIRONMENT_VARIABLES) · [Hardware guide](https://docs.librewebui.org/HARDWARE_REQUIREMENTS)

## Built from experience, for independence

Libre WebUI is built around a hard-earned lesson: source availability alone does not guarantee shared power. Our response is constructive—compete by shipping better software and stronger commitments that anyone can inspect.

That means local-first defaults without forbidding the cloud, commercial support without changing the core license, and a community where identity, background, or geography never determines who belongs. Kroonen AI maintains Libre WebUI under the project's public charter, which accepts donations or grants only when they do not control the roadmap, license, or community.

**Freedom should not be a phase in a startup's growth plan. It should be part of the architecture.**

## Build with us

Libre WebUI is for people who want excellent AI software and the freedom to outgrow its maintainers.

1. Fork and clone the repository.
2. Create a branch from `dev`.
3. Run `npm install && npm run dev`.
4. Add tests and documentation with your change.
5. Open a pull request against `dev`.

You can also help by [reporting bugs](https://github.com/libre-webui/libre-webui/issues), improving documentation, translating the interface, or contributing provider definitions.

All participation follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/) and the [Libre WebUI Community & Ethical Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md). Report security issues privately to **security@kroonen.ai**.

## Release mirrors

Every release tag is pushed explicitly to both
[GitHub](https://github.com/libre-webui/libre-webui/releases) and the
[Forgejo mirror](https://git.kroonen.ai/libre-webui/libre-webui/releases).
After GitHub CI publishes a release, an idempotent mirror copies its release
notes to Forgejo and adds named links to the GitHub-hosted desktop artifacts.
This keeps both release indexes aligned without storing a second copy of every
large binary. Maintainers can find the gated publication and backfill procedure
in the [release automation guide](https://docs.librewebui.org/RELEASE_AUTOMATION).

## Stewardship and support

[Kroonen AI](https://kroonen.ai) funds development and provides professional deployment, integration, security review, training, customization, and SLA-backed support. Commercial services do not change the Apache 2.0 license of the core project.

For enterprise work, contact **enterprise@kroonen.ai**. To support independent development directly, [sponsor Libre WebUI](https://github.com/sponsors/libre-webui).

## Project links

|                    |                                                                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Website**        | [librewebui.org](https://librewebui.org)                                                                                           |
| **Documentation**  | [docs.librewebui.org](https://docs.librewebui.org)                                                                                 |
| **Releases**       | [GitHub](https://github.com/libre-webui/libre-webui/releases) · [Forgejo](https://git.kroonen.ai/libre-webui/libre-webui/releases) |
| **GitHub**         | [github.com/libre-webui/libre-webui](https://github.com/libre-webui/libre-webui)                                                   |
| **Forgejo mirror** | [git.kroonen.ai/libre-webui/libre-webui](https://git.kroonen.ai/libre-webui/libre-webui)                                           |
| **Hugging Face**   | [huggingface.co/libre-webui](https://huggingface.co/libre-webui)                                                                   |
| **Sponsor**        | [github.com/sponsors/libre-webui](https://github.com/sponsors/libre-webui)                                                         |

---

<div align="center">

### If Libre WebUI gives you more control, give it a star.

Stars help independent software get discovered without buying attention.

<a href="https://github.com/libre-webui/libre-webui"><img src="https://img.shields.io/github/stars/libre-webui/libre-webui?style=for-the-badge&label=Star%20Libre%20WebUI&color=ff7b52" alt="Star Libre WebUI on GitHub"></a>

<br><br>

**Apache 2.0** · Copyright © 2025–present Kroonen AI, Inc. and Libre WebUI contributors<br>
Built by [Kroonen AI](https://kroonen.ai) and the open-source community

</div>
