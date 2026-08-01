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
  <a href="#quick-start"><strong>Quick start</strong></a>
</p>

<br>

<img src="https://raw.githubusercontent.com/libre-webui/libre-webui/main/screenshot.png" width="100%" alt="Libre WebUI local-first AI workspace">

</div>

---

## What Libre WebUI is

A complete AI workspace you run yourself. Chat with local models through
[Ollama](https://ollama.com) or with any provider you choose to connect, give a
model a sandboxed workspace where it can actually build something, search your
own documents, generate images and speech, and keep every conversation on
hardware you control.

The interface works like a browser. **Home** is your launcher; chats, Work
sessions, and pages open as tabs beside it; `⌘K` searches everything you have.
Nothing is buried three menus deep.

It is Apache 2.0, ships without telemetry, and is built so you can leave. If
this project ever stops serving you, your installation and your fork do not need
anyone's permission.

## Quick start

You need [Node.js 22.22 or newer](https://nodejs.org). Docker is optional — only
[Work](#work-one-persistent-environment-per-task) requires it.

```bash
npx libre-webui
```

Open [http://localhost:8080](http://localhost:8080). The first account created
on a fresh install becomes the administrator.

For private local inference, install [Ollama](https://ollama.com) and pull a
model:

```bash
ollama pull gemma4:12b
```

That is enough to start. No cloud account is required. When you do want a remote
model, add only the provider you choose.

If Docker is missing, Libre WebUI starts normally and Work reports a clear
**Runtime unavailable** state rather than running commands on your host.

## What you can do

|                                    |                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------- |
| **Work the way you browse**        | Home launcher, tabs for chats and Work sessions, `⌘K` to jump anywhere     |
| **Talk to the model you want**     | Local Ollama, Ollama Cloud, bundled providers, or any compatible endpoint  |
| **Use the agent you subscribe to** | An installed Claude Code or Codex CLI, as a chat model, with no API key    |
| **Give every task a workspace**    | Files, a terminal, a diff, and a live preview inside an isolated container |
| **Bring your own context**         | Chat with PDF and plain-text documents by keyword or embeddings            |
| **Turn answers into artifacts**    | Sandboxed HTML, SVG, JSON, code, and multi-file previews beside the chat   |
| **Create with more than text**     | Image generation, provider-backed speech, and reusable personas            |
| **Make the interface yours**       | Light and dark themes, adaptive accents, 25 locales including Arabic RTL   |
| **Operate it your way**            | Local accounts and roles, optional OAuth, Docker, Kubernetes, npm, desktop |
| **Extend without lock-in**         | Chat, embedding, image, and speech providers through the plugin layer      |

## Freedom should survive success

An AI interface can be self-hosted today and still become a gatekeeper
tomorrow. Libre WebUI is built so your freedom does not depend on a company
remaining benevolent.

Run it. Inspect it. Change it. Fork it. Connect it to something else. Or leave
it behind. The code is Apache 2.0, local inference is the default path, remote
providers are opt-in, and the project charter puts independence and inclusive
participation into writing.

> **Open source is a license. Libre is an operating principle.**

Do not trust the pitch. Inspect the
[license](https://github.com/libre-webui/libre-webui/blob/main/LICENSE),
[charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md),
[source](https://github.com/libre-webui/libre-webui), and
[CI](https://github.com/libre-webui/libre-webui/actions).

| What stays yours      | Libre WebUI's approach                                                  | Verify it                                                                  |
| --------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **Data path**         | Self-hosted by default; remote inference only when you select it        | [Deployment docs](https://docs.librewebui.org/DOCKER)                      |
| **Model choice**      | Local Ollama plus optional provider plugins and compatible endpoints    | [Plugin architecture](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)     |
| **Code**              | Use, modify, redistribute, and fork under Apache 2.0                    | [License](https://github.com/libre-webui/libre-webui/blob/main/LICENSE)    |
| **Project direction** | The charter rejects funding control over roadmap, license, or community | [Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md) |
| **Participation**     | Everyone is welcome regardless of background, identity, or geography    | [Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md) |
| **Exit**              | Your installation and your fork do not need our permission              | [Source](https://github.com/libre-webui/libre-webui)                       |

## Local-first is a real boundary

Libre WebUI ships without application telemetry or analytics. When you use
Ollama locally, prompts and responses stay on infrastructure you control. If you
select a remote provider, that provider receives the requests you choose to send
it; Libre WebUI does not pretend otherwise.

For shared and public deployments, the backend includes local accounts with
bcrypt hashing and JWT sessions, admin and user roles, login and signup rate
limits, optional Cloudflare Turnstile, optional GitHub and Hugging Face OAuth,
application-layer AES-256-GCM encryption for sensitive values such as
credentials, and persistent SQLite storage with configurable data directories.

Application-layer encryption is not full-disk or end-to-end encryption. Use
HTTPS, access-controlled storage, stable secrets, and disk encryption where your
threat model requires them. Start with the
[authentication guide](https://docs.librewebui.org/AUTHENTICATION) and
[encryption guide](https://docs.librewebui.org/DATABASE_ENCRYPTION).

## Models, providers, and agents

Ollama is the default local path, not a lock-in strategy. Libre WebUI bundles an
MLX LM plugin for native Apple Silicon inference plus provider definitions
spanning chat, images, embeddings, and speech — OpenAI, Anthropic, Google
Gemini, Groq, Kimi Code by Moonshot AI, Mistral, OpenRouter, Hugging Face,
GitHub Models, ComfyUI, ElevenLabs, Qwen3-TTS, Kyutai TTS, and any
OpenAI-compatible service.

Credentials come from deployment-wide environment variables or encrypted,
user-scoped settings. Plugins can declare static model lists and use live
discovery when a provider exposes a compatible model-list endpoint.

A coding agent you already pay for can answer in chat directly. If `claude` or
`codex` is installed on the server, administrators see an **Agents** group in
the model selector and can hold a normal conversation using the subscription
that CLI is already signed in with — no API key. The CLI runs as the Libre WebUI
server user and inherits that user's agent credentials, so treat it as
equivalent to granting those agents shell access, and set
`AGENT_CLI_MODELS_ENABLED=false` to turn it off.

[Connect a provider →](https://docs.librewebui.org/PROVIDER_CONNECTIONS) ·
[Use an installed agent →](https://docs.librewebui.org/AGENT_CLI_MODELS)

## Work: one persistent environment per task

Work gives a tool-capable model a real place to build. Describe what you want,
and the task keeps its own conversation, provider route, files, tool activity,
and preview — so returning to it a week later returns to exactly where it was.

```text
Work task
   ├── durable conversation and run history in SQLite
   ├── dedicated Docker named volume mounted at /workspace
   ├── disposable, policy-checked container for commands
   └── Files · Activity · Terminal · Preview workspace pane
```

The model can read, write, move, delete, and search files, run bounded shell
commands, and start or stop a browser preview. You get a syntax-highlighted
editor, a red/green diff of what changed in the last turn, conflict-aware saves,
and a real interactive terminal attached to the same container — under the same
policy as the model's own tools, so it is a window into the sandbox rather than
a way around it.

Runs stream assistant text, tool calls, results, usage, and state changes live.
Reasoning appears only when the provider returns it; Libre WebUI cannot reveal a
model's hidden chain-of-thought. When a run exhausts its round budget it asks
for a final progress handoff and ends in a yellow **Needs input** state instead
of reporting false success — a follow-up run continues in the same workspace.

Choosing a remote route shows a one-time disclosure, because an autonomous run
can make many paid calls and can send conversation context and tool results,
including file contents, to that provider. You should know that before a run
starts, not after the bill.

**On the sandbox.** Work is admin-only and never falls back to host execution.
Containers run as a non-root user with a read-only root filesystem, dropped
capabilities, `no-new-privileges`, resource limits with swap pinned to the
memory cap, and only the task volume mounted. Networked tasks join a managed
bridge with inter-container communication disabled. The whole policy is hashed
into a container label and re-verified before reuse, so a container predating a
hardening change is recreated rather than reused.

Two honest limits: containers are not virtual machines, and Work tasks have
outbound internet egress by design.

A task can instead be bound to a real folder on your machine, when a deployment
opts in with `WORK_HOST_WORKSPACES_ENABLED`. Requested paths are resolved
through symlinks, checked against an allowlist of roots, and credential
directories are refused — but it ships off, because pointing an agent at your
real files is a deliberate narrowing of the sandbox and should be a decision you
make on purpose.

[Read the Work guide →](https://docs.librewebui.org/WORKSPACES)

## Agents: broader automation, runtime kept separate

The **Agents** section is the control surface for
[Libre Claw](https://github.com/kroonen-ai/libre-claw), an optional
admin-controlled local agent runtime. Libre WebUI provides the authenticated
view of durable runs, timelines, approvals, schedules, usage, and configuration;
Libre Claw owns the tools, memory, permission model, and execution.

It is deliberately not Work. Work is native and focused on one isolated project
workspace; Libre Claw is the optional daemon for broader file, shell, git,
browser, HTTP, web-search, MCP, memory, and automation workflows. The WebUI
backend never executes its shell or browser tools — it proxies authenticated
admin actions to the separately running daemon, where approvals stay
authoritative.

[Read the integration guide →](https://docs.librewebui.org/LIBRE_CLAW_INTEGRATION)

## How it fits together

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

## Deploy on your terms

| Path                | Command or link                                                         | Best for                                                      |
| ------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| **npm**             | `npx libre-webui`                                                       | Fast local start; Work available when Docker is installed     |
| **Docker + Ollama** | `docker compose up -d`                                                  | Persistent stack; Work enabled through the host Docker socket |
| **External Ollama** | `docker compose -f docker-compose.external-ollama.yml up -d`            | An Ollama you already run                                     |
| **NVIDIA Docker**   | `docker compose -f docker-compose.gpu.yml up -d`                        | Local GPU inference                                           |
| **Kubernetes**      | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui` | Cluster deployment; the chart has no Work runtime driver      |
| **Desktop client**  | [GitHub Releases](https://github.com/libre-webui/libre-webui/releases)  | Electron UI over a separately managed backend                 |
| **Source**          | `npm install && npm run dev`                                            | Development                                                   |

Docker commands assume you have cloned this repository. Production deployments
should set stable `JWT_SECRET` and `ENCRYPTION_KEY` values, persist the data
directory, back up the database and key together, and terminate public traffic
with HTTPS.

> **The Docker socket is the security decision to understand.** Every Compose
> file mounts `/var/run/docker.sock` so Work can run task containers as
> siblings. That socket grants root-equivalent control of the host: treat every
> Libre WebUI administrator as a host administrator, and remove the mount if you
> do not want Work.

On Linux the socket belongs to the `docker` group rather than root, so set the
group id once in `.env`:

```bash
echo "DOCKER_GID=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  alpine stat -c '%g' /var/run/docker.sock)" >> .env
```

## Documentation

Full documentation lives at
**[docs.librewebui.org](https://docs.librewebui.org)**.

| Getting started                                                            | Going deeper                                                             | Operating it                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| [Quick start](https://docs.librewebui.org/QUICK_START)                     | [Work workspaces](https://docs.librewebui.org/WORKSPACES)                | [Docker](https://docs.librewebui.org/DOCKER)                               |
| [Working with models](https://docs.librewebui.org/WORKING_WITH_MODELS)     | [Provider connections](https://docs.librewebui.org/PROVIDER_CONNECTIONS) | [Kubernetes](https://docs.librewebui.org/KUBERNETES)                       |
| [Keyboard shortcuts](https://docs.librewebui.org/KEYBOARD_SHORTCUTS)       | [Installed agent CLIs](https://docs.librewebui.org/AGENT_CLI_MODELS)     | [Environment variables](https://docs.librewebui.org/ENVIRONMENT_VARIABLES) |
| [Hardware requirements](https://docs.librewebui.org/HARDWARE_REQUIREMENTS) | [Plugin architecture](https://docs.librewebui.org/PLUGIN_ARCHITECTURE)   | [Authentication](https://docs.librewebui.org/AUTHENTICATION)               |
| [Troubleshooting](https://docs.librewebui.org/TROUBLESHOOTING)             | [Document chat](https://docs.librewebui.org/RAG_FEATURE)                 | [Database encryption](https://docs.librewebui.org/DATABASE_ENCRYPTION)     |

## Build with us

Libre WebUI is for people who want excellent AI software and the freedom to
outgrow its maintainers.

1. Fork and clone the repository.
2. Create a branch from `dev`.
3. Run `npm install && npm run dev`.
4. Add tests and documentation with your change.
5. Open a pull request against `dev`.

You can also help by
[reporting bugs](https://github.com/libre-webui/libre-webui/issues), improving
documentation, translating the interface, or contributing provider definitions.

All participation follows the
[Contributor Covenant 2.1](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
and the
[Libre WebUI Community & Ethical Charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md).
Report security issues privately to **security@kroonen.ai**.

## Built from experience, for independence

Libre WebUI is built around a hard-earned lesson: source availability alone does
not guarantee shared power. Our response is constructive — compete by shipping
better software and stronger commitments that anyone can inspect.

That means local-first defaults without forbidding the cloud, commercial support
without changing the core license, and a community where identity, background,
or geography never determines who belongs. Kroonen AI maintains Libre WebUI
under the project's public charter, which accepts donations or grants only when
they do not control the roadmap, license, or community.

**Freedom should not be a phase in a startup's growth plan. It should be part of
the architecture.**

## Stewardship and support

[Kroonen AI](https://kroonen.ai) funds development and provides professional
deployment, integration, security review, training, customization, and
SLA-backed support. Commercial services do not change the Apache 2.0 license of
the core project.

For enterprise work, contact **enterprise@kroonen.ai**. To support independent
development directly,
[sponsor Libre WebUI](https://github.com/sponsors/libre-webui).

Every release tag is published to both
[GitHub](https://github.com/libre-webui/libre-webui/releases) and a
[Forgejo mirror](https://git.kroonen.ai/libre-webui/libre-webui/releases), so
neither index is a single point of failure. Maintainers can find the procedure
in the
[release automation guide](https://docs.librewebui.org/RELEASE_AUTOMATION).

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
