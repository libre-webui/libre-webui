---
sidebar_position: 26
title: 'Environment Variables'
description: 'Supported backend and frontend environment variables in Libre WebUI.'
slug: /ENVIRONMENT_VARIABLES
keywords:
  [
    libre webui environment variables,
    configuration,
    env,
    docker env,
    kubernetes config,
    api keys,
  ]
---

# Environment Variables

This page lists the environment variables read by the current Libre WebUI backend, frontend, and maintenance scripts.

## Backend Server

| Variable         | Default                                   | Purpose                                             |
| ---------------- | ----------------------------------------- | --------------------------------------------------- |
| `NODE_ENV`       | `development`                             | Runtime mode                                        |
| `PORT`           | `3001` in dev, `8080` in production       | Backend HTTP port                                   |
| `TRUST_PROXY`    | unset                                     | Express trust proxy setting                         |
| `CORS_ORIGIN`    | local dev origins                         | Comma-separated allowed browser origins             |
| `SERVE_FRONTEND` | unset                                     | Serve built frontend from backend when `true`       |
| `DOCKER_ENV`     | unset                                     | Enables Docker-oriented behavior when `true`        |
| `DATA_DIR`       | `backend/data`                            | Persistent data directory                           |
| `PLUGINS_DIR`    | `$DATA_DIR/plugins`, otherwise `plugins/` | Writable directory for installed/customized plugins |
| `BASE_URL`       | `http://localhost:3001`                   | Base URL used for OAuth callback defaults           |
| `LOG_LEVEL`      | `info` (`warn` in tests)                  | Backend log level                                   |

## Authentication and Security

| Variable               | Default                           | Purpose                                                  |
| ---------------------- | --------------------------------- | -------------------------------------------------------- |
| `JWT_SECRET`           | generated/fallback in development | JWT signing secret; set explicitly in production         |
| `JWT_EXPIRES_IN`       | `7d`                              | Session-token lifetime                                   |
| `ENCRYPTION_KEY`       | auto-generated                    | 64-character hex key for encrypted values                |
| `DEBUG_ENCRYPTION`     | unset                             | Logs encryption debug output when set                    |
| `TURNSTILE_SITE_KEY`   | unset                             | Cloudflare Turnstile site key for signup                 |
| `TURNSTILE_SECRET_KEY` | unset                             | Cloudflare Turnstile secret key for backend verification |

Turnstile is enabled only when both Turnstile keys are present.

## OAuth

| Variable                    | Purpose                            |
| --------------------------- | ---------------------------------- |
| `GITHUB_CLIENT_ID`          | GitHub OAuth client ID             |
| `GITHUB_CLIENT_SECRET`      | GitHub OAuth client secret         |
| `GITHUB_CALLBACK_URL`       | GitHub callback URL override       |
| `HUGGINGFACE_CLIENT_ID`     | Hugging Face OAuth client ID       |
| `HUGGINGFACE_CLIENT_SECRET` | Hugging Face OAuth client secret   |
| `HUGGINGFACE_CALLBACK_URL`  | Hugging Face callback URL override |

If callback URLs are not set, Libre WebUI builds defaults from `BASE_URL`.

## Ollama

| Variable                        | Default                  | Purpose                                             |
| ------------------------------- | ------------------------ | --------------------------------------------------- |
| `OLLAMA_BASE_URL`               | `http://localhost:11434` | Ollama API base URL                                 |
| `OLLAMA_TIMEOUT`                | `300000`                 | Standard Ollama request timeout in milliseconds     |
| `OLLAMA_LONG_OPERATION_TIMEOUT` | `900000`                 | Long operation timeout for pulls and large requests |

## Libre Claw

| Variable                | Default                 | Purpose                         |
| ----------------------- | ----------------------- | ------------------------------- |
| `LIBRE_CLAW_BASE_URL`   | `http://127.0.0.1:8766` | Optional Libre Claw daemon URL  |
| `LIBRE_CLAW_TIMEOUT_MS` | `30000`                 | Libre Claw HTTP request timeout |

## Work Runtime

These variables configure native Work execution on the machine running the
Libre WebUI backend:

| Variable                            | Default                                                                                       | Purpose                                                  |
| ----------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `WORK_RUNTIME_IMAGE`                | `node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3` | Pinned image used for Work task containers               |
| `WORK_DOCKER_COMMAND`               | `docker`                                                                                      | Docker CLI executable available to the backend process   |
| `WORK_COMMAND_TIMEOUT_MS`           | `120000`                                                                                      | Default timeout; a tool can request up to `600000` ms    |
| `WORK_MAX_OUTPUT_CHARS`             | `50000`                                                                                       | Captured stdout/stderr limit, applied to each stream     |
| `WORK_MAX_AGENT_ROUNDS`             | `48`                                                                                          | Maximum Ollama model/tool iterations in one run          |
| `WORK_MEMORY_LIMIT`                 | `2g`                                                                                          | Memory limit passed to each Work container               |
| `WORK_CPU_LIMIT`                    | `2`                                                                                           | CPU limit passed to each Work container                  |
| `WORK_PIDS_LIMIT`                   | `256`                                                                                         | Process limit passed to each Work container              |
| `WORK_PREVIEW_PORT`                 | `4173`                                                                                        | Port a preview server must use inside the task container |
| `WORK_MAX_ACTIVE_RUNTIMES_GLOBAL`   | `2`                                                                                           | Concurrent container-backed tasks for the whole instance |
| `WORK_MAX_ACTIVE_RUNTIMES_PER_USER` | `1`                                                                                           | Concurrent container-backed tasks for one administrator  |
| `WORK_MAX_TASKS_GLOBAL`             | `500`                                                                                         | Maximum persisted Work tasks for the whole instance      |
| `WORK_MAX_TASKS_PER_USER`           | `100`                                                                                         | Maximum persisted Work tasks for one administrator       |

Work reads these values when the backend starts. The preview port is internal to
the task container; Libre WebUI publishes it to a dynamically assigned loopback
port rather than exposing this value directly on every host interface.

Keep the runtime image pinned to a reviewed version or digest. Increasing
concurrency or resource limits raises the amount of Docker-host capacity one or
more autonomous runs can consume. Plugin-backed runs use the lower of
`WORK_MAX_AGENT_ROUNDS` and 12 rounds, with caps of 64 total tool calls and
4,096 requested output tokens per response. Persisted tool output has a
separate bound of approximately 20,000 source characters plus a truncation
marker.

These variables do not make Work available inside the standard Libre WebUI
Docker image or Helm chart. Those deployments do not include a Docker CLI,
runtime socket, or Kubernetes Work driver. The currently supported path is a
native backend process that can successfully run the configured Docker command.

## Provider Plugin Keys

Provider plugins can use environment keys as deployment-wide defaults:

| Variable              | Provider                                    |
| --------------------- | ------------------------------------------- |
| `OPENAI_API_KEY`      | OpenAI and OpenAI TTS                       |
| `ANTHROPIC_API_KEY`   | Anthropic                                   |
| `GROQ_API_KEY`        | Groq                                        |
| `GEMINI_API_KEY`      | Google Gemini                               |
| `MISTRAL_API_KEY`     | Mistral                                     |
| `OPENROUTER_API_KEY`  | OpenRouter                                  |
| `KIMI_API_KEY`        | Kimi Code by Moonshot AI                    |
| `GITHUB_API_KEY`      | GitHub Models                               |
| `HUGGINGFACE_API_KEY` | Hugging Face APIs where configured          |
| `ELEVENLABS_API_KEY`  | ElevenLabs TTS                              |
| `COMFYUI_API_KEY`     | ComfyUI deployments that require an API key |

Users can also store provider credentials in the UI when per-user keys are preferred.

## Frontend

| Variable             | Default                                 | Purpose                                             |
| -------------------- | --------------------------------------- | --------------------------------------------------- |
| `VITE_API_BASE_URL`  | inferred from host/dev config           | Frontend API base URL                               |
| `VITE_WS_BASE_URL`   | inferred from API URL                   | WebSocket base URL                                  |
| `VITE_APP_VERSION`   | package version injected by Vite config | Displayed app version                               |
| `VITE_DEMO_MODE`     | `false`                                 | Enables demo-mode mocks when `true`                 |
| `VITE_API_TIMEOUT`   | `300000`                                | Frontend API timeout in milliseconds                |
| `VITE_BACKEND_URL`   | `http://localhost:3001`                 | Used by some auth helper components                 |
| `VITE_DEBUG_VERBOSE` | unset                                   | Enables verbose frontend debug logs in development  |
| `VITE_LOG_LEVEL`     | unset                                   | Overrides the frontend log level                    |
| `ELECTRON_BUILD`     | unset                                   | Enables Electron-specific Vite behavior when `true` |

## Maintenance Scripts

| Variable                  | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `CHANGELOG_AI`            | Set to `0` to disable AI-assisted changelog drafts  |
| `CHANGELOG_AI_MODEL`      | Ollama model for release/changelog generation       |
| `CHANGELOG_AI_TIMEOUT_MS` | Timeout for AI changelog generation in milliseconds |

Example:

```bash
CHANGELOG_AI_MODEL=glm-5.2:cloud npm run changelog
CHANGELOG_AI=0 npm run release:minor
```

## Production Example

```env
NODE_ENV=production
PORT=3001
SERVE_FRONTEND=true
DATA_DIR=/data/libre-webui
CORS_ORIGIN=https://librewebui.example
BASE_URL=https://librewebui.example

JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-64-hex-characters

OLLAMA_BASE_URL=http://ollama:11434
OLLAMA_TIMEOUT=300000
OLLAMA_LONG_OPERATION_TIMEOUT=900000

TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

## Related Docs

- [Authentication](./AUTHENTICATION)
- [Single Sign-On](./SINGLE_SIGN_ON)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
