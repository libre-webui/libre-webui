---
sidebar_position: 62
title: 'Open WebUI vs Libre WebUI: A Factual Comparison'
sidebar_label: 'Open WebUI vs Libre WebUI'
description: 'A neutral, sourced comparison of Open WebUI and Libre WebUI: licenses, branding rules, data portability, telemetry defaults, deployment, and production features.'
slug: /OPEN_WEBUI_VS_LIBRE_WEBUI
keywords:
  [
    open webui vs libre webui,
    open webui alternative,
    libre webui,
    comparison,
    license,
    apache 2.0,
    self-hosted ai,
    ollama,
  ]
---

# Open WebUI vs Libre WebUI: A Factual Comparison

Open WebUI and Libre WebUI are both self-hosted web interfaces for working with large language models. Each can connect to local runtimes such as Ollama as well as OpenAI-compatible and other hosted APIs, and each is designed to keep user data on the operator's own infrastructure. This page compares the two projects strictly on publicly documented differences, drawing on each project's official documentation, license text, and public repositories. It does not evaluate code quality, performance, or community sentiment, and it does not recommend one project over the other.

All statements below are sourced from the official documentation of [Open WebUI](https://docs.openwebui.com) and [Libre WebUI](https://docs.librewebui.org), the projects' license files, and their public GitHub repositories, as of August 2026. Both projects evolve quickly; verify details against the primary sources before making decisions.

## At a glance

| Dimension | Open WebUI | Libre WebUI |
|---|---|---|
| **License** | "Open WebUI License": BSD-3-based with an added branding-protection clause (v0.6.6+, April 2025). Maintainers state it is not an OSI-approved open-source license. Code through v0.6.5 remains BSD-3-Clause. | Apache License 2.0. Project charter commits to never relicensing to more restrictive terms. |
| **Branding / white-labeling** | Removing or altering "Open WebUI" branding is prohibited except for deployments with ≤50 users in any rolling 30-day period, contributors with written permission, or holders of an enterprise license. | No branding or white-labeling restriction documented; Apache 2.0 default terms apply. White-labeling is offered as an optional paid service. |
| **Data ownership & portability** | Data stored locally (SQLite or PostgreSQL). Chat export/import as JSON; individual chats as JSON, PDF, or Markdown. Full-database export/import and backup procedures documented. | Data stored locally (SQLite or PostgreSQL). Versioned per-user JSON archive with SHA-256 integrity digest and transactional import; signed (Ed25519) and encrypted (AES-256-GCM) backup/restore CLI; pre-backup `recovery-check` gate. |
| **Telemetry / analytics defaults** | FAQ states no data is sent to external services by default; data goes to a model provider only when one is connected. OpenTelemetry integration available for self-managed observability. | Charter states zero telemetry ("no analytics, no tracking, no phone-home code"). OpenTelemetry export is off unless an operator configures a collector endpoint. Local admin-only usage metering is always on but never leaves the deployment. |
| **Authentication & multi-user** | RBAC with roles, groups, and per-resource permissions; SSO via OIDC and LDAP; SCIM 2.0 provisioning; API keys. | Local accounts with JWT bound to revocable server-side sessions; two roles (admin/user) plus groups and per-resource grants; generic OIDC (plus GitHub and Hugging Face OAuth); scoped personal API tokens. No SAML, SCIM, or LDAP (documented limitation). |
| **Extensibility** | Pipelines plugin framework; Python Tools/Functions with built-in code editor; MCP (Streamable HTTP); OpenAPI tool servers; 13 supported vector databases; 8 document-extraction engines. | JSON-defined provider plugins (chat, embeddings, image, TTS, STT, audio, video); 13 built-in tools; OpenAPI 3.x and MCP (Streamable HTTP) tool servers, off by default with per-call approval for side effects; assistant profiles, skills, prompt library, artifacts, sandboxed "Work" coding workspaces. |
| **Deployment** | `pip install open-webui`; Docker (incl. `:cuda`, `:ollama` images); Docker Compose; Kubernetes via kustomize and Helm; S3/GCS/Azure storage backends; Redis-backed horizontal scaling. | One command (`npx libre-webui@latest`); npm and Homebrew; Docker Compose variants (bundled/external Ollama, GPU, team); Helm chart (OCI registry); documented private deployment via Cloudflare Tunnel; Electron desktop client (client only). |
| **Production features** | Usage dashboards (messages, tokens); model arena with Elo leaderboards; OpenTelemetry; horizontal scaling; enterprise plan with SLA support and LTS versions. | Cost governance: effective-dated tariffs and budgets with observe/alert/block modes; evaluation sets and blind arena with Elo; opt-in OTLP export; liveness/readiness/deep health probes; team profile certified for 3+ replicas with an external durable worker; no zero-downtime schema upgrades (documented caveat). |
| **Team / collaboration** | Channels where users and models share conversations; direct messages; user groups; per-model access controls; Notes workspace; folders, tags, pins. | Channels, DMs, and one-level threads with `@model` replies; owner-to-user/group sharing (read/write/admin) for chats, notes, knowledge, personas, prompts, skills, calendars, and tool servers; no anonymous public links; notifications, shared calendars, scheduled automations. |
| **Voice & media** | Speech-to-text, text-to-speech, hands-free voice and video calls; image generation via GPT-Image, Gemini, ComfyUI; RAG over 8 extraction engines with hybrid BM25 + vector search and reranking. | Turn-based voice mode with barge-in (documented as not full-duplex); STT/TTS via provider plugins; consent-aware voice cloning; image, audio, and video generation via capability-declaring plugins with a per-user gallery; RAG with hybrid BM25 + vector retrieval and per-page/slide/sheet citations; scanned documents and images read through the user's configured vision model, and audio files transcribed through the STT provider (no bundled OCR/ASR engine — provider-routed by design). |
| **Documentation** | Extensive official docs including feature guides, a database schema reference, backup/migration tutorials, and a license FAQ. | Official docs including per-feature guides that state limits and non-goals, published `openapi.json` and `llms.txt`, and generated capability contracts mapping every route to an owner and a named test. |

## License

**Open WebUI** is distributed under the "Open WebUI License," introduced in v0.6.6 (April 2025). It is based on BSD-3-Clause with an added clause protecting the "Open WebUI" branding. The project's own [license FAQ](https://docs.openwebui.com/license/) states that the license is "not an OSI-approved 'open source' license," while emphasizing that the code remains public and developed in the open. All code merged through v0.6.5 remains under the original BSD-3-Clause license. Copyright is held by Open WebUI Inc.

**Libre WebUI** is distributed under the [Apache License 2.0](https://github.com/libre-webui/libre-webui/blob/main/LICENSE), an OSI-approved license, with copyright held by Kroonen AI, Inc. The project's [charter](https://docs.librewebui.org/charter) states that the source code "will remain licensed under the Apache License 2.0 in perpetuity" and that the project "shall never be relicensed to more restrictive terms," including for enterprise offerings.

## Branding and white-labeling

**Open WebUI**'s license prohibits altering, removing, obscuring, or replacing "Open WebUI" branding, with three documented exceptions: deployments serving 50 or fewer users in any rolling 30-day period, contributors granted specific written permission, and organizations holding an enterprise license. Outside these exceptions, branding removal is described in the license as a material breach. The project offers an enterprise plan that includes custom theming and branding.

**Libre WebUI** documents no branding, trademark, or attribution requirement beyond the standard terms of Apache 2.0 (which requires preserving license and notice files in source distributions but imposes no user-facing branding rules). White-labeling appears in the charter only as an optional commercial service, not as a license condition.

## Data ownership, portability, and recovery

Both projects store all data on the operator's infrastructure, using SQLite by default with PostgreSQL as a documented option.

**Open WebUI** documents [chat export and import](https://docs.openwebui.com/features/chat-conversations/data-controls/import-export/) (all conversations as JSON; individual chats as JSON, PDF, or Markdown), [full-database export/import](https://docs.openwebui.com/tutorials/maintenance/database/) for migration between servers, [backup guidance](https://docs.openwebui.com/tutorials/maintenance/backups/), a public [database schema reference](https://docs.openwebui.com/reference/database-schema/), and Alembic-based [manual migration](https://docs.openwebui.com/troubleshooting/manual-database-migration/) procedures.

**Libre WebUI** documents a [per-user data archive](https://docs.librewebui.org/data-portability): a versioned JSON format (`libre-webui-user-data`, version 3) with a SHA-256 integrity digest, covering chats, notes, knowledge collections, and preferences, with explicitly listed exclusions (credentials, biometric voice data, generated media, and instance-level state). Import is preflighted and transactional on both SQLite and PostgreSQL. For operators, [recovery readiness](https://docs.librewebui.org/recovery-readiness) documents a read-only `recovery-check` CLI gate and a backup CLI producing Ed25519-signed, AES-256-GCM-encrypted archives with verify and restore-preflight steps, plus team-mode (PostgreSQL/S3) variants. Data at rest uses application-level AES-256-GCM encryption; the docs state this is not full-disk or end-to-end encryption.

## Telemetry and analytics defaults

Both projects state that no data leaves the deployment by default.

**Open WebUI**'s [FAQ](https://docs.openwebui.com/faq/) states: "Open WebUI does not send your data to external services by default" and "When you sign up, all information is stored locally on your server and is not sent to Open WebUI or any third party by default." Prompts and responses are sent to a model provider only when the operator connects one. OpenTelemetry integration is available for operator-managed observability.

**Libre WebUI**'s [charter](https://docs.librewebui.org/charter) commits to "zero telemetry — no analytics, no tracking, no phone-home code," and its [observability documentation](https://docs.librewebui.org/observability) states that "neither path sends telemetry to the Libre WebUI project"; OpenTelemetry export is disabled unless an operator sets a collector endpoint. The docs also disclose that local, admin-only usage metering is always on and cannot be disabled, with data retained inside the deployment database only, and that prompts, responses, and credentials are never written to the usage table.

## Authentication and multi-user support

**Open WebUI** documents role-based access control with roles, groups, and per-resource permissions; single sign-on via OIDC and LDAP; SCIM 2.0 for automated user and group provisioning; and API keys for programmatic access.

**Libre WebUI** documents [local accounts](https://docs.librewebui.org/authentication) with bcrypt-hashed passwords and JWTs bound to revocable server-side sessions; exactly two roles (admin and user) supplemented by groups and per-resource grants (read/write/admin), with the stated default that resources are private and the global admin role does not grant access to other users' content; [SSO](https://docs.librewebui.org/single-sign-on) via generic OIDC (with PKCE, domain allowlists, and group-to-role mapping) plus GitHub and Hugging Face OAuth; and scoped, revocable personal API tokens. The documentation states explicitly that SAML and SCIM provisioning are not currently exposed; LDAP is not documented.

In summary: Open WebUI documents broader enterprise identity integration (LDAP, SCIM); Libre WebUI documents OIDC-centric SSO with per-resource grants and states its identity-protocol limits in its own docs.

## Architecture and extensibility

**Open WebUI** uses a Python backend and Svelte frontend. Extensibility centers on the Pipelines plugin framework, Python-based Tools and Functions editable in a built-in code editor, native MCP support over Streamable HTTP, and tool auto-discovery from OpenAPI-compatible endpoints. Its RAG stack documents 13 supported vector databases (ChromaDB and PGVector officially maintained) and 8 document-extraction engines, with hybrid BM25 + vector search and cross-encoder reranking.

**Libre WebUI** uses a TypeScript/Node.js (Express) backend and React frontend. Extensibility centers on JSON-defined provider plugins covering chat, embeddings, image, TTS, STT, audio, and video (bundled families include OpenAI-compatible, Anthropic, Google Gemini, Groq, Mistral, OpenRouter, Hugging Face, MLX, ComfyUI, and ElevenLabs, alongside local Ollama); [governed tools](https://docs.librewebui.org/chat-tools) with 13 built-in tools and external tool servers over OpenAPI 3.x (hash-pinned specs) and MCP Streamable HTTP — tools are off by default, side-effecting calls require user approval, and egress is SSRF-hardened; stdio MCP servers are deliberately unsupported. Higher-level constructs include [assistant profiles](https://docs.librewebui.org/assistant-profiles) (binding prompts, tools, skills, knowledge, and voice), versioned skills and prompts, sandboxed artifacts (HTML, React, Mermaid, SVG), and "Work" — isolated Docker/Kubernetes coding workspaces. The [platform foundation](https://docs.librewebui.org/platform-foundation) defines two validated profiles: `solo` (SQLite, embedded vectors, local blobs) and `team` (PostgreSQL, PGVector, S3-compatible storage, Redis), with mixed configurations rejected at startup.

## Deployment options

**Open WebUI** documents installation via `pip install open-webui`, Docker (including CUDA and bundled-Ollama image variants), Docker Compose, and Kubernetes via kustomize and Helm, with S3/GCS/Azure Blob storage backends and Redis-backed sessions for horizontal scaling.

**Libre WebUI** documents a [one-command start](https://docs.librewebui.org/quick-start) (`npx libre-webui@latest`), global npm and Homebrew installation, Docker Compose variants (bundled Ollama, external Ollama, GPU, socket-proxy, and team), a [Helm chart](https://docs.librewebui.org/kubernetes) published to an OCI registry with pod-security defaults and optional NetworkPolicies, a documented private-deployment pattern using Cloudflare Tunnel with no published ports, and an Electron [desktop app](https://docs.librewebui.org/electron-desktop-app) for macOS, Windows, and Linux — documented as a client only, without a bundled backend or auto-updates.

## Production features

**Open WebUI** documents usage dashboards tracking message volume and token consumption, a model arena with A/B testing and Elo-based leaderboards, OpenTelemetry integration, webhooks and system banners, and horizontal scaling. A commercial enterprise plan adds SLA-backed support and long-term-support versions.

**Libre WebUI** documents [cost governance](https://docs.librewebui.org/cost-governance) — versioned, effective-dated price tariffs and budgets scoped to instance, user, or group, with observe, alert, and hard-block enforcement modes and CSV export; [evaluations](https://docs.librewebui.org/evaluations) — feedback tagging, a blind arena with deterministic Elo, and durable evaluation-set runs; [observability](https://docs.librewebui.org/observability) — structured JSON logs with request-ID correlation and a redaction boundary, plus opt-in OTLP export; liveness, readiness, and admin-only deep health probes; and layered rate limits that are Redis-backed and shared across replicas in team mode. The team profile is documented as certified for three or more application replicas plus an external durable worker, validated by a release-gating three-replica failure drill. The Kubernetes docs also state a caveat plainly: schema upgrades are not zero-downtime and require an intentional service interruption.

## Team and collaboration features

**Open WebUI** documents shared channels in which users and AI models participate in the same conversation, direct messaging, user groups with role-based permissions, per-model access restrictions, a Notes workspace with AI assistance, and conversation organization via folders, tags, and pins.

**Libre WebUI** documents [channels](https://docs.librewebui.org/channels) (public, private, and DMs) with one-level threads, reactions, pins, and `@model` replies that run under the invoking member's identity; a uniform [sharing model](https://docs.librewebui.org/sharing) (owner grants read/write/admin to users or groups) covering chats, notes, knowledge collections, personas, prompts, skills, calendars, and tool servers, with no anonymous public links; encrypted per-user notifications; shareable calendars; and scheduled [automations](https://docs.librewebui.org/automations) that deliver AI runs as chat sessions. Documented gaps include the absence of presence/typing indicators and per-channel export.

## Voice and media capabilities

**Open WebUI** documents speech-to-text, text-to-speech, hands-free voice and video calls, and image generation and editing through engines including GPT-Image, Gemini, and ComfyUI, alongside file and image upload.

**Libre WebUI** documents a turn-based [voice mode](https://docs.librewebui.org/voice-mode) (listen → transcribe → think → speak) with barge-in; the docs state explicitly that it is not full-duplex. STT and TTS run through provider plugins (browser speech recognition, OpenAI-compatible transcription, Hugging Face ASR, ElevenLabs, and others), with consent-aware voice cloning behind an access-mode gate. [Media generation](https://docs.librewebui.org/media-generation) plugins declare image, TTS, audio, and video capabilities, feeding a per-user gallery. Document processing covers PDF, Office formats, Markdown, HTML, and source code with per-page/slide/sheet citation provenance and hybrid BM25 + vector retrieval; Scanned PDFs and images are read through the user's configured vision model, and audio uploads are transcribed through the provider STT pipeline; no local OCR or ASR engine is bundled, keeping extraction on providers the user already chose.

## Documentation quality and transparency

Both projects maintain substantial official documentation.

**Open WebUI**'s documentation includes feature guides, deployment and maintenance tutorials (backups, database export, manual migration), a public database schema reference, and a license FAQ that directly addresses the non-OSI status of its license.

**Libre WebUI**'s documentation includes per-feature guides that enumerate limits and non-goals in-line (for example, "no SAML or SCIM," "not full-duplex," "no zero-downtime schema rollout"), a published OpenAPI specification and `llms.txt`, and generated [capability contracts](https://docs.librewebui.org/global-capability-contracts) that map every UI route, API route, and WebSocket path to an owner, documentation, and a named test enforced in CI.

## Which one to choose

Neither project is categorically better; the right choice depends on your constraints. Objective criteria to weigh:

- **License requirements.** If your organization requires an OSI-approved license or plans to rebrand the interface for more than 50 users without an enterprise agreement, the licenses differ materially: Libre WebUI is Apache 2.0 with no branding clause; Open WebUI's license restricts branding changes above the 50-user threshold unless an enterprise license is in place.
- **Identity infrastructure.** Organizations standardized on LDAP or SCIM provisioning will find those documented in Open WebUI; organizations standardized on OIDC are covered by both.
- **Ecosystem and integrations.** Open WebUI has a very large community (about 150k GitHub stars) and documents a broad integration surface, including 13 vector databases and 8 document-extraction engines. Libre WebUI's ecosystem is smaller and centers on its bundled provider plugins and OpenAPI/MCP tool servers.
- **Extensibility model.** Open WebUI extends primarily through Python code (Pipelines, Tools, Functions); Libre WebUI extends primarily through declarative JSON plugin definitions and governed external tool servers. Which fits better depends on your team's skills and change-control requirements.
- **Operations posture.** Compare each project's documented backup/restore procedures, health probes, rate limiting, and scaling model against your recovery-time and availability targets, including Libre WebUI's documented lack of zero-downtime schema upgrades and Open WebUI's Redis-backed horizontal scaling.
- **Governance and cost controls.** If per-user or per-group spending budgets with hard enforcement are a requirement, check Libre WebUI's cost-governance docs; if usage dashboards and enterprise SLA/LTS options matter, check Open WebUI's admin analytics and enterprise plan.
- **Media requirements.** Real-time voice and video calling is documented in Open WebUI; Libre WebUI's voice mode is turn-based. Both document STT, TTS, and image generation through configurable providers.

Evaluate both against your own requirements using the primary sources below.

## Sources

- Open WebUI documentation: [docs.openwebui.com](https://docs.openwebui.com) — including [Features](https://docs.openwebui.com/features/), [License & FAQ](https://docs.openwebui.com/license/), [FAQ](https://docs.openwebui.com/faq/), [Chat Import & Export](https://docs.openwebui.com/features/chat-conversations/data-controls/import-export/), [Database Export](https://docs.openwebui.com/tutorials/maintenance/database/), and [Backups](https://docs.openwebui.com/tutorials/maintenance/backups/)
- Open WebUI repository and license: [github.com/open-webui/open-webui](https://github.com/open-webui/open-webui)
- Libre WebUI documentation: [docs.librewebui.org](https://docs.librewebui.org) — including [Charter](https://docs.librewebui.org/charter), [Data Portability](https://docs.librewebui.org/data-portability), [Recovery Readiness](https://docs.librewebui.org/recovery-readiness), [Authentication](https://docs.librewebui.org/authentication), [Single Sign-On](https://docs.librewebui.org/single-sign-on), [Chat Tools](https://docs.librewebui.org/chat-tools), [Assistant Profiles](https://docs.librewebui.org/assistant-profiles), [Platform Foundation](https://docs.librewebui.org/platform-foundation), [Cost Governance](https://docs.librewebui.org/cost-governance), [Evaluations](https://docs.librewebui.org/evaluations), [Observability](https://docs.librewebui.org/observability), [Kubernetes](https://docs.librewebui.org/kubernetes), and [Voice Mode](https://docs.librewebui.org/voice-mode)
- Libre WebUI repository and license: [github.com/libre-webui/libre-webui](https://github.com/libre-webui/libre-webui)

*Last reviewed: August 2026. Both projects release frequently; consult the linked primary sources for current details.*
