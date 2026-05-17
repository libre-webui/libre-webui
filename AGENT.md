# Libre WebUI — Agent Reference

> **Project:** Libre WebUI — Privacy-first, open-source AI chat interface
> **Version:** 0.9.0
> **License:** Apache 2.0
> **Maintainer:** Kroonen AI, Inc. + open-source community
> **Repository:** https://github.com/libre-webui/libre-webui

---

## 1. Project Overview

Libre WebUI is a **self-hosted AI chat interface** that connects to Ollama (local) and 10+ cloud providers (OpenAI, Anthropic, Google, etc.) via a plugin system. It runs as:

- A web app (React + Express)
- An Electron desktop app (macOS, Windows, Linux)
- A Docker container (with or without bundled Ollama)
- A Homebrew package
- A Kubernetes deployment (Helm chart)

**Core philosophy:** Zero telemetry. No tracking. Apache 2.0 forever. Local-first.

---

## 2. Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    Libre WebUI                           │
├──────────────────────┬───────────────────────────────────┤
│   Frontend           │   Backend                         │
│   React 18 + TS      │   Express 5 + TS                  │
│   Vite 8             │   better-sqlite3                  │
│   Zustand (state)    │   AES-256-GCM encryption          │
│   TanStack Query     │   WebSocket streaming             │
│   i18next (25 langs) │   JWT auth                        │
│   Tailwind CSS       │   Helmet + rate limiting          │
│   Framer Motion      │                                   │
│   Lucide icons       │                                   │
│   React Markdown     │                                   │
│   KaTeX (math)       │                                   │
├──────────────────────┴───────────────────────────────────┤
│              Plugin Layer (JSON config files)            │
│   Ollama │ OpenAI │ Anthropic │ Google │ Groq │ …       │
├──────────────────────────────────────────────────────────┤
│   Electron (Desktop) │ Docker │ Kubernetes │ npx CLI     │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Monorepo Structure

```
libre-webui/
├── package.json              # Root workspace manifest
├── package-lock.json
├── .npmrc                    # legacy-peer-deps=true
│
├── frontend/                 # npm workspace: libre-webui-frontend
│   ├── package.json
│   ├── vite.config.ts
│   ├── tailwind.config.js
│   ├── postcss.config.js
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx           # App entry point
│       ├── App.tsx            # Root component with routing
│       ├── index.css          # Global styles + Tailwind
│       ├── layouts/
│       │   └── ChatLayout.tsx # Main chat layout wrapper
│       ├── pages/
│       │   ├── ChatPage.tsx   # Main chat page
│       │   ├── LoginPage.tsx  # Auth login page
│       │   ├── PersonasPage.tsx
│       │   ├── ModelsPage.tsx
│       │   ├── GalleryPage.tsx
│       │   └── UserManagementPage.tsx
│       ├── components/        # ~59 components
│       │   ├── ChatInput.tsx
│       │   ├── ChatMessage.tsx
│       │   ├── ChatMessages.tsx
│       │   ├── Sidebar.tsx
│       │   ├── SettingsModal.tsx
│       │   ├── ModelSelector.tsx
│       │   ├── PersonaCard.tsx / PersonaForm.tsx / PersonaManager.tsx
│       │   ├── PluginManager.tsx
│       │   ├── ImageGenerationPanel.tsx
│       │   ├── TTSButton.tsx
│       │   ├── ArtifactRenderer.tsx / ArtifactContainer.tsx
│       │   ├── LoginForm.tsx / SignupForm.tsx / FirstTimeSetup.tsx
│       │   ├── UserMenu.tsx / UserManager.tsx
│       │   ├── ProtectedRoute.tsx
│       │   ├── HuggingFaceModelBrowser.tsx
│       │   ├── ThemeToggle.tsx
│       │   ├── LanguageSwitcher.tsx
│       │   └── ui/            # Reusable UI primitives
│       ├── store/
│       │   ├── appStore.ts    # Global app state (Zustand)
│       │   ├── chatStore.ts   # Chat sessions & messages
│       │   ├── authStore.ts   # Auth state & JWT
│       │   └── pluginStore.ts # Plugin state
│       ├── hooks/
│       │   ├── useChat.ts           # Chat streaming logic
│       │   ├── useInitializeApp.ts  # App init logic
│       │   └── useKeyboardShortcuts.ts
│       ├── services/
│       │   └── userService.ts
│       ├── utils/
│       │   ├── api.ts               # API client (Axios)
│       │   ├── websocket.ts         # WebSocket client
│       │   ├── artifactParser.ts    # Artifact HTML/SVG parsing
│       │   ├── config.ts            # App config
│       │   └── oauthCallback.ts     # OAuth flow handling
│       ├── types/
│       │   └── index.ts             # Shared TS types
│       ├── i18n/
│       │   ├── index.ts
│       │   └── locales/             # 25+ language JSON files
│       │       ├── en.json, fr.json, de.json, es.json, …
│       └── assets/
│
├── backend/                  # npm workspace: libre-webui-backend
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts           # Express app entry (4400+ lines)
│       ├── env.ts             # Environment variable loading
│       ├── db.ts              # SQLite initialization & schema
│       ├── storage.ts         # Storage abstraction (SQLite/JSON)
│       ├── middleware/
│       │   ├── index.ts       # Error handlers, request logger
│       │   └── auth.ts        # JWT auth, role checks
│       ├── routes/
│       │   ├── auth.ts        # Login, register, logout, change-password
│       │   ├── users.ts       # User CRUD (admin)
│       │   ├── chat.ts        # Session CRUD, message operations
│       │   ├── ollama.ts      # Ollama model management
│       │   ├── plugins.ts     # Plugin CRUD, activation, variables
│       │   ├── preferences.ts # User preferences
│       │   ├── documents.ts   # Document upload, list, delete
│       │   ├── embeddings.ts  # Embedding generation & search
│       │   ├── personas.ts    # Persona CRUD
│       │   ├── tts.ts         # Text-to-speech routes
│       │   ├── imageGen.ts    # Image generation routes
│       │   └── huggingfaceHub.ts  # HF Hub model browsing
│       ├── services/
│       │   ├── authService.ts
│       │   ├── chatService.ts
│       │   ├── documentService.ts
│       │   ├── embeddingService.ts
│       │   ├── encryptionService.ts   # AES-256-GCM encrypt/decrypt
│       │   ├── ollamaService.ts
│       │   ├── personaService.ts
│       │   ├── pluginService.ts       # Plugin loading & execution
│       │   ├── pluginCredentialsService.ts
│       │   ├── pluginVariablesService.ts
│       │   ├── preferencesService.ts
│       │   ├── userService.ts
│       │   ├── systemSettingsService.ts
│       │   ├── galleryService.ts
│       │   ├── memoryService.ts
│       │   ├── mutationEngineService.ts
│       │   ├── openclawSessionService.ts
│       │   ├── simpleGitHubOAuth.ts
│       │   └── simpleHuggingFaceOAuth.ts
│       ├── models/
│       │   ├── personaModel.ts
│       │   └── userModel.ts
│       ├── utils/
│       │   ├── generationUtils.ts
│       │   ├── hash.ts
│       │   ├── jwt.ts
│       │   └── packagePaths.ts
│       └── types/
│           ├── index.ts
│           └── express.d.ts
│
├── electron/                 # Electron desktop app
│   ├── main.js              # Main process (window management, backend spawn)
│   ├── preload.js           # Preload script (context isolation)
│   ├── splash.html          # Splash screen
│   ├── entitlements.mac.plist
│   └── assets/
│
├── plugins/                  # AI provider plugin configs (JSON)
│   ├── openai.json
│   ├── anthropic.json
│   ├── gemini.json
│   ├── groq.json
│   ├── mistral.json
│   ├── openrouter.json
│   ├── huggingface.json
│   ├── comfyui.json         # Image generation
│   ├── elevenlabs.json      # TTS
│   ├── openai-tts.json
│   ├── qwen-tts.json        # Local TTS
│   ├── kyutai-tts.json
│   ├── kyutai-tts-1.6b.json
│   ├── github.json
│   └── .status.json
│
├── docs/                     # 31 documentation files
│   ├── 00-README.md
│   ├── 01-QUICK_START.md
│   ├── 08-PLUGIN_ARCHITECTURE.md
│   ├── 09-RAG_FEATURE.md
│   ├── 12-AUTHENTICATION.md
│   ├── 19-DATABASE_ENCRYPTION.md
│   ├── 21-SINGLE_SIGN_ON.md
│   ├── 23-DOCKER.md
│   ├── 26-ENVIRONMENT_VARIABLES.md
│   ├── 27-QWEN3_TTS.md
│   ├── 29-HUGGINGFACE_HUB.md
│   └── tutorials/
│
├── scripts/                  # Build, release, and utility scripts
│   ├── release.js           # Version bump + changelog
│   ├── generate-changelog.js
│   ├── ai-changelog-generator.js
│   ├── build-docker.sh
│   ├── deploy.sh
│   ├── validate-docker.sh
│   ├── generate-icons.js
│   ├── add-headers.js
│   └── update-*-models.sh   # Model list refreshers per provider
│
├── examples/                 # TTS server implementations
│   ├── qwen-tts-server/
│   ├── kyutai-tts-server/
│   └── kyutai-tts-1.6b-server/
│
├── helm/libre-webui/         # Kubernetes Helm chart
│
├── homebrew/                 # Homebrew tap files
│
├── Dockerfile                # Multi-stage Docker build
├── docker-compose.yml        # With bundled Ollama
├── docker-compose.gpu.yml    # With NVIDIA GPU
├── docker-compose.external-ollama.yml
├── nginx.conf                # Production reverse proxy config
├── electron-builder.yml      # Electron build config
│
├── bin/cli.js                # npx libre-webui entry point
├── start.sh                  # Local dev startup script
│
├── DESIGN.md                 # Design system reference
├── CHARTER.md                # Community & ethical charter
└── CHANGELOG.md
```

---

## 4. Technology Stack

| Layer         | Technology                                                  |
| ------------- | ----------------------------------------------------------- |
| **Frontend**  | React 18, TypeScript, Vite 8, Zustand, TanStack Query       |
| **Styling**   | Tailwind CSS 3, CSS custom properties (DESIGN.md)           |
| **Backend**   | Express 5, TypeScript, better-sqlite3, WebSocket (ws)       |
| **Auth**      | JWT (jsonwebtoken), bcrypt (12 rounds), OAuth2 (GitHub, HF) |
| **Desktop**   | Electron 41, electron-builder                               |
| **Container** | Docker (node:22-alpine), multi-stage builds                 |
| **K8s**       | Helm chart (oci://ghcr.io/libre-webui/charts/libre-webui)   |
| **i18n**      | i18next + react-i18next (25 languages)                      |
| **Markdown**  | react-markdown, rehype-katex, remark-math, lowlight         |
| **Animation** | Framer Motion                                               |
| **Icons**     | Lucide React                                                |
| **Linting**   | ESLint 10, TypeScript 6, Prettier 3                         |

---

## 5. Database Schema (SQLite)

All tables use UUID primary keys. Sensitive fields are encrypted at the application layer with AES-256-GCM.

### Tables

| Table                  | Purpose                | Key Columns                                                                                                          |
| ---------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **users**              | User accounts          | id, username, email (encrypted), password_hash, role, avatar                                                         |
| **sessions**           | Chat sessions          | id, user_id, title (encrypted), model, persona_id                                                                    |
| **session_messages**   | Chat messages          | id, session_id, role, content (encrypted), images, statistics, artifacts, parent_id, branch_index, is_active         |
| **documents**          | Uploaded docs          | id, user_id, filename, title (encrypted), content (encrypted), metadata                                              |
| **document_chunks**    | RAG chunks             | id, document_id, content (encrypted), embedding, chunk_index                                                         |
| **user_preferences**   | User settings          | id, user_id, key, value (encrypted)                                                                                  |
| **system_settings**    | Global config          | key (PK), value, updated_at                                                                                          |
| **personas**           | AI personas            | id, user_id, name, model, parameters (JSON), avatar, background, embedding_model, memory_settings, mutation_settings |
| **plugin_credentials** | Per-user API keys      | id, user_id, plugin_id, api_key (encrypted)                                                                          |
| **plugin_variables**   | Plugin config (valves) | id, user_id, plugin_id, variable_name, variable_value, is_encrypted                                                  |
| **generated_images**   | Image gallery          | id, user_id, prompt, model, image_data, size, quality                                                                |

### Indexes

- `idx_sessions_user_id`, `idx_sessions_updated_at`, `idx_sessions_persona_id`
- `idx_session_messages_session_id`, `idx_session_messages_timestamp`, `idx_session_messages_parent_id`
- `idx_documents_user_id`, `idx_documents_uploaded_at`
- `idx_document_chunks_document_id`, `idx_document_chunks_index`
- `idx_user_preferences_user_id`, `idx_user_preferences_key`
- `idx_personas_user_id`, `idx_personas_name`
- `idx_plugin_credentials_user_id`, `idx_plugin_credentials_plugin_id`
- `idx_plugin_variables_user_id`, `idx_plugin_variables_plugin_id`
- `idx_generated_images_user_id`, `idx_generated_images_created_at`

---

## 6. API Endpoints

### Authentication (`/api/auth`)

| Method | Path                          | Auth  | Description                             |
| ------ | ----------------------------- | ----- | --------------------------------------- |
| POST   | `/login`                      | No    | Login with username/password            |
| POST   | `/register`                   | No    | Register (disabled in single-user mode) |
| POST   | `/logout`                     | Yes   | Logout                                  |
| GET    | `/me`                         | Yes   | Get current user                        |
| POST   | `/change-password`            | Yes   | Change own password                     |
| POST   | `/reset-password`             | Admin | Reset user password                     |
| GET    | `/system-info`                | No    | System info (mode, version)             |
| GET    | `/oauth/github/callback`      | No    | GitHub OAuth callback                   |
| GET    | `/oauth/huggingface/callback` | No    | HuggingFace OAuth callback              |

### Users (`/api/users`)

| Method | Path     | Auth      | Description     |
| ------ | -------- | --------- | --------------- |
| GET    | `/`      | Admin     | List all users  |
| GET    | `/:id`   | Admin/Own | Get user        |
| POST   | `/`      | Admin     | Create user     |
| PUT    | `/:id`   | Admin/Own | Update user     |
| DELETE | `/:id`   | Admin     | Delete user     |
| GET    | `/stats` | Admin     | User statistics |

### Chat (`/api/chat`)

| Method | Path                                     | Auth | Description               |
| ------ | ---------------------------------------- | ---- | ------------------------- |
| GET    | `/sessions`                              | Yes  | List user sessions        |
| GET    | `/sessions/:id`                          | Yes  | Get session with messages |
| POST   | `/sessions`                              | Yes  | Create session            |
| PUT    | `/sessions/:id`                          | Yes  | Update session            |
| DELETE | `/sessions/:id`                          | Yes  | Delete session            |
| POST   | `/sessions/:id/regenerate`               | Yes  | Regenerate last message   |
| POST   | `/sessions/:id/messages/:msgId/branches` | Yes  | Create message branch     |

### Ollama (`/api/ollama`)

| Method | Path            | Auth  | Description           |
| ------ | --------------- | ----- | --------------------- |
| GET    | `/models`       | No    | List available models |
| GET    | `/health`       | No    | Ollama health check   |
| POST   | `/pull`         | Yes   | Pull a model          |
| DELETE | `/models/:name` | Admin | Delete a model        |

### Plugins (`/api/plugins`)

| Method | Path             | Auth | Description            |
| ------ | ---------------- | ---- | ---------------------- |
| GET    | `/`              | No   | List all plugins       |
| POST   | `/upload`        | Yes  | Upload plugin JSON     |
| POST   | `/activate/:id`  | Yes  | Activate plugin        |
| POST   | `/deactivate`    | Yes  | Deactivate plugin      |
| GET    | `/:id/variables` | Yes  | Get plugin variables   |
| PUT    | `/:id/variables` | Yes  | Set plugin variables   |
| DELETE | `/:id/variables` | Yes  | Reset plugin variables |

### Documents (`/api/documents`)

| Method | Path                     | Auth | Description                 |
| ------ | ------------------------ | ---- | --------------------------- |
| POST   | `/upload`                | Yes  | Upload document (multipart) |
| GET    | `/`                      | Yes  | List documents              |
| GET    | `/:id`                   | Yes  | Get document                |
| DELETE | `/:id`                   | Yes  | Delete document             |
| POST   | `/regenerate-embeddings` | Yes  | Reprocess all embeddings    |

### Other

| Method | Path                      | Auth | Description          |
| ------ | ------------------------- | ---- | -------------------- |
| GET    | `/embeddings/generate`    | Yes  | Generate embeddings  |
| GET    | `/personas`               | Yes  | List personas        |
| POST   | `/personas`               | Yes  | Create persona       |
| PUT    | `/personas/:id`           | Yes  | Update persona       |
| DELETE | `/personas/:id`           | Yes  | Delete persona       |
| POST   | `/tts/speech`             | Yes  | Generate TTS audio   |
| POST   | `/image-gen/generate`     | Yes  | Generate image       |
| GET    | `/image-gen/gallery`      | Yes  | Image gallery        |
| GET    | `/huggingface-hub/models` | No   | Browse HF Hub models |
| GET    | `/preferences`            | Yes  | Get preferences      |
| PUT    | `/preferences`            | Yes  | Update preferences   |

### WebSocket (`/ws`)

Connect with `?token=<jwt>` for authenticated sessions.

| Message Type         | Direction       | Description                   |
| -------------------- | --------------- | ----------------------------- |
| `chat_stream`        | Client → Server | Start chat streaming          |
| `user_message`       | Server → Client | User message confirmed        |
| `assistant_chunk`    | Server → Client | Streaming chunk (incremental) |
| `tool_status`        | Server → Client | Tool activity indicator       |
| `assistant_complete` | Server → Client | Response complete             |
| `error`              | Server → Client | Error occurred                |

---

## 7. Plugin System

Plugins are JSON files in `plugins/`. They define AI providers without code changes.

### Plugin Structure

```json
{
  "id": "provider-name",
  "name": "Display Name",
  "type": "completion|image|tts|stt|embedding",
  "endpoint": "https://api.example.com/v1/...",
  "auth": {
    "header": "Authorization",
    "prefix": "Bearer ",
    "key_env": "API_KEY_VAR"
  },
  "model_map": ["model-1", "model-2"],
  "capabilities": {
    "completion": { "endpoint": "...", "model_map": [...] },
    "tts": { "endpoint": "...", "model_map": [...], "config": {...} },
    "image": { "endpoint": "...", "model_map": [...], "config": {...} },
    "stt": { "endpoint": "...", "model_map": [...] },
    "embedding": { "endpoint": "...", "model_map": [...] }
  },
  "variables": [
    {
      "name": "temperature",
      "type": "number",
      "label": "Temperature",
      "default": 0.7,
      "min": 0,
      "max": 2
    }
  ]
}
```

### Variable Types

| Type      | Input        | Notes                             |
| --------- | ------------ | --------------------------------- |
| `string`  | Text field   | Use `sensitive: true` for secrets |
| `number`  | Number field | Supports `min`/`max`              |
| `boolean` | Checkbox     | true/false                        |
| `select`  | Dropdown     | Requires `options` array          |

### Credential Resolution Priority

1. Per-user database key (encrypted with AES-256-GCM)
2. Environment variable (`key_env` from plugin config)
3. No auth (for local servers like Ollama)

### Built-in Plugins

| Plugin             | Type                     | Provider                      |
| ------------------ | ------------------------ | ----------------------------- |
| `openai.json`      | completion + tts         | OpenAI (110+ models)          |
| `anthropic.json`   | completion               | Anthropic (Claude)            |
| `gemini.json`      | completion               | Google Gemini (55+ models)    |
| `groq.json`        | completion               | Groq (fast inference)         |
| `mistral.json`     | completion               | Mistral (71+ models)          |
| `openrouter.json`  | completion               | OpenRouter (300+ models)      |
| `huggingface.json` | completion + tts + image | HuggingFace Hub (220+ models) |
| `github.json`      | completion               | GitHub Models                 |
| `comfyui.json`     | image                    | ComfyUI (Flux models)         |
| `elevenlabs.json`  | tts                      | ElevenLabs                    |
| `openai-tts.json`  | tts                      | OpenAI TTS                    |
| `qwen-tts.json`    | tts                      | Qwen3-TTS (local)             |
| `kyutai-tts.json`  | tts                      | Kyutai (local)                |

---

## 8. Environment Variables

### Backend

| Variable           | Default                     | Required       | Description                     |
| ------------------ | --------------------------- | -------------- | ------------------------------- |
| `NODE_ENV`         | `development`               | No             | `development` or `production`   |
| `PORT`             | `3001` (dev), `8080` (prod) | No             | HTTP server port                |
| `CORS_ORIGIN`      | `http://localhost:5173,...` | No             | Comma-separated allowed origins |
| `SERVE_FRONTEND`   | `false`                     | No             | Serve frontend from backend     |
| `DOCKER_ENV`       | —                           | No             | Set for Docker deployments      |
| `TRUST_PROXY`      | —                           | No             | Trust reverse proxy             |
| `DATA_DIR`         | `./backend/data`            | No             | SQLite database directory       |
| `JWT_SECRET`       | —                           | **Yes (prod)** | JWT signing key (64-char hex)   |
| `JWT_EXPIRES_IN`   | `7d`                        | No             | Token expiration                |
| `ENCRYPTION_KEY`   | auto-generated              | No             | AES-256-GCM key (64-char hex)   |
| `SESSION_SECRET`   | auto-generated              | No             | Session secret                  |
| `SINGLE_USER_MODE` | `false`                     | No             | Disable multi-user auth         |

### Ollama

| Variable                        | Default                  | Description           |
| ------------------------------- | ------------------------ | --------------------- |
| `OLLAMA_BASE_URL`               | `http://localhost:11434` | Ollama API URL        |
| `OLLAMA_TIMEOUT`                | `300000`                 | Standard timeout (ms) |
| `OLLAMA_LONG_OPERATION_TIMEOUT` | `900000`                 | Extended timeout (ms) |

### OAuth2

| Variable                                              | Description                           |
| ----------------------------------------------------- | ------------------------------------- |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`           | GitHub OAuth                          |
| `GITHUB_CALLBACK_URL`                                 | OAuth callback URL                    |
| `HUGGINGFACE_CLIENT_ID` / `HUGGINGFACE_CLIENT_SECRET` | HuggingFace OAuth                     |
| `HUGGINGFACE_CALLBACK_URL`                            | OAuth callback URL                    |
| `OAUTH_AUTO_REGISTER`                                 | Auto-create accounts (`true`/`false`) |
| `OAUTH_DEFAULT_ROLE`                                  | Default role for new users            |
| `OAUTH_ALLOWED_DOMAINS`                               | Comma-separated allowed email domains |
| `OAUTH_ADMIN_USERS`                                   | Comma-separated admin usernames       |

### Plugin API Keys (optional fallbacks)

`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, `GITHUB_API_KEY`, `ELEVENLABS_API_KEY`, `HUGGINGFACE_API_KEY`

### Frontend (VITE\_ prefix)

| Variable            | Default                 | Description              |
| ------------------- | ----------------------- | ------------------------ |
| `VITE_API_BASE_URL` | auto-detected           | Override API base URL    |
| `VITE_BACKEND_URL`  | `http://localhost:3001` | Backend URL for OAuth    |
| `VITE_WS_BASE_URL`  | `ws://localhost:3001`   | WebSocket URL            |
| `VITE_API_TIMEOUT`  | `300000`                | API request timeout (ms) |
| `VITE_DEMO_MODE`    | `false`                 | Enable demo mode         |
| `VITE_APP_VERSION`  | auto-detected           | App version string       |

---

## 9. Development Workflow

### Quick Start

```bash
git clone https://github.com/libre-webui/libre-webui
cd libre-webui
cp backend/.env.example backend/.env   # if needed
npm install
npm run dev                            # starts backend + frontend concurrently
```

- **Frontend:** http://localhost:5173 (Vite dev server)
- **Backend:** http://localhost:3001 (Express)
- **Electron dev:** `npm run electron:dev`

### Key Scripts

| Command                        | Description                      |
| ------------------------------ | -------------------------------- |
| `npm run dev`                  | Start both backend + frontend    |
| `npm run dev:frontend`         | Frontend only                    |
| `npm run dev:backend`          | Backend only                     |
| `npm run build`                | Build frontend + backend         |
| `npm run build:frontend`       | Frontend only (tsc + vite build) |
| `npm run build:backend`        | Backend only (tsc)               |
| `npm run electron:dev`         | Electron dev mode                |
| `npm run electron:build`       | Build Electron macOS ARM64       |
| `npm run electron:build:win`   | Build Electron Windows           |
| `npm run electron:build:linux` | Build Electron Linux             |
| `npm run lint`                 | Lint frontend + backend          |
| `npm run lint:fix`             | Auto-fix lint issues             |
| `npm run format`               | Prettier format all files        |
| `npm run format:check`         | Check formatting                 |
| `npm run release:patch`        | Bump patch version + changelog   |
| `npm run release:minor`        | Bump minor version + changelog   |
| `npm run release:major`        | Bump major version + changelog   |
| `npm run changelog`            | Generate changelog               |
| `npm run test:package`         | Test package layout              |

### Git Workflow

- **Target branch:** `dev` (PRs go here)
- **Requires:** At least 1 TSC approving review
- **Git hooks:** `.githooks/pre-commit`, `.githooks/commit-msg` (auto-installed via postinstall)
- **CI/CD:** GitHub Actions workflows in `.github/workflows/`

---

## 10. Docker Deployment

### Bundled Ollama (with CPU)

```bash
docker-compose up -d
# Access at http://localhost:8080
```

### With NVIDIA GPU

```bash
docker-compose -f docker-compose.gpu.yml up -d
```

### External Ollama

```bash
docker-compose -f docker-compose.external-ollama.yml up -d
```

### Dev Builds

```bash
docker-compose -f docker-compose.dev.yml up -d
```

### Docker Volumes

| Volume             | Purpose                                  |
| ------------------ | ---------------------------------------- |
| `libre_webui_data` | SQLite database, encryption key, uploads |
| `libre_webui_temp` | Temporary files                          |
| `ollama_data`      | Downloaded Ollama models                 |

### Dockerfile

Multi-stage build:

1. `deps` — Install all dependencies
2. `prod-deps` — Production-only dependencies
3. `frontend-builder` — Build React frontend
4. `backend-builder` — Compile TypeScript backend
5. `runner` — Final image (non-root user `nodejs`, dumb-init)

---

## 11. Electron Desktop App

- **Main process:** `electron/main.js` — window management, single-instance lock, splash screen, menu
- **Preload:** `electron/preload.js` — context isolation bridge
- **Splash:** `electron/splash.html`
- **Build:** `electron-builder.yml` configures macOS ARM64, Windows, Linux targets
- **Icons:** `electron/assets/` (SVG source, PNG exports generated)
- **macOS entitlements:** `electron/entitlements.mac.plist`

In dev mode, Electron loads the Vite dev server at `http://localhost:5173`.
In production, it loads `frontend/dist/index.html`.

The backend is expected to be running separately (detected via health check on port 3001).

---

## 12. Design System (from DESIGN.md)

### Colors

| Token             | Dark                   | Light     | Usage                          |
| ----------------- | ---------------------- | --------- | ------------------------------ |
| Primary           | `#FFFFFF`              | `#111827` | Text, headings                 |
| Secondary         | `#9CA3AF`              | `#6B7280` | Metadata, muted text           |
| Tertiary          | `#7C3AED` (Violet 600) | `#7C3AED` | Primary buttons, active states |
| Accent            | `#A78BFA` (Violet 400) | —         | Hover states                   |
| Neutral           | `#0A0A0A`              | `#F9FAFB` | Sidebar background             |
| Neutral-secondary | `#171717`              | `#FFFFFF` | Chat area background           |
| Neutral-tertiary  | `#262626`              | `#F3F4F6` | Cards, inputs, user bubbles    |
| Neutral-surface   | `#1F1F1F`              | `#E5E7EB` | Panels, popovers               |
| Success           | `#34D399`              | —         | Confirmation states            |
| Warning           | `#FBBF24`              | —         | Rate limits, warnings          |
| Error             | `#F87171`              | —         | Errors, failures               |
| Info              | `#60A5FA`              | —         | Informational banners          |

### Typography

- **Body:** Inter, system-ui — 0.9375rem (15px), line-height 1.625
- **Headings:** Inter — h1: 1.875rem/700, h2: 1.5rem/600, h3: 1.25rem/600
- **Code:** JetBrains Mono — 0.875rem
- **Labels:** Inter — 0.75rem/500, letter-spacing 0.05em

### Spacing (4px base)

xs: 4px, sm: 8px, md: 16px, lg: 24px, xl: 32px, 2xl: 48px

### Shapes

sm: 6px, md: 12px, lg: 16px, xl: 24px, full: 9999px

### Motion

- Interactive states: 150ms ease-out
- Sidebar collapse: 200ms
- No decorative animations

---

## 13. Key Backend Files to Know

### `backend/src/index.ts` (~4400+ lines)

The single Express app file. Contains:

- Security middleware (Helmet, CORS, rate limiting)
- All route registrations
- WebSocket server for streaming chat
- Chat streaming logic (Ollama + plugin routing)
- OpenClaw agent session handling
- Plugin variable resolution and generation option merging
- Frontend static file serving in production
- SPA fallback routing

### `backend/src/db.ts`

SQLite initialization, schema creation, and migrations. Creates all tables and indexes on startup. Runs ALTER TABLE migrations for new columns.

### `backend/src/storage.ts` (~1028 lines)

Storage abstraction layer supporting both SQLite and JSON fallback. Handles:

- User CRUD with encrypted email
- Session CRUD with encrypted titles
- Message CRUD with encrypted content, images, statistics, artifacts
- Document CRUD with encrypted content
- Document chunk CRUD with encrypted content and embeddings
- Preference CRUD with encrypted values
- Branching support (parent_id, branch_index, is_active)

### `backend/src/services/pluginService.ts`

Core plugin execution:

- Loads plugins from `plugins/*.json`
- Resolves API keys (per-user DB > env var > none)
- Validates endpoints (SSRF prevention)
- Executes streaming and non-streaming requests
- Handles tool calls in plugin responses
- Merges generation options from user preferences

### `backend/src/services/encryptionService.ts`

AES-256-GCM encryption service:

- Encrypts/decrypts strings and JSON objects
- Uses unique IV per operation
- PBKDF2 key derivation
- Key from `ENCRYPTION_KEY` env var (auto-generated if not set)

---

## 14. Key Frontend Files to Know

### `frontend/src/App.tsx`

Root component with React Router. Handles:

- Auth routing (login page vs main app)
- Protected route wrapping
- Theme (dark/light) toggle
- Language switching

### `frontend/src/pages/ChatPage.tsx`

Main chat interface. Handles:

- Session management (create, switch, delete)
- Message streaming via WebSocket
- Model selection
- Persona selection
- Image attachment
- Document context display
- Artifact rendering
- TTS playback
- Message branching/regeneration

### `frontend/src/hooks/useChat.ts`

Chat hook managing:

- WebSocket connection lifecycle
- Message streaming state
- Abort handling
- Reconnection logic

### `frontend/src/store/chatStore.ts`

Zustand store for chat state:

- Sessions list
- Current session
- Messages with branching support
- Session operations (create, update, delete)

### `frontend/src/utils/api.ts`

Axios-based API client:

- Automatic JWT injection
- Request/response interceptors
- Error handling and retry logic

### `frontend/src/utils/websocket.ts`

WebSocket client:

- Connection management with reconnection
- JWT token in query params
- Message type handling
- Heartbeat/ping-pong

---

## 15. Security Considerations

### Authentication & Authorization

- JWT-based auth with configurable expiration
- bcrypt password hashing (12 salt rounds)
- Role-based access control (admin/user)
- Rate limiting on all routes (varies by endpoint)
- Login attempt rate limiting (5 attempts / 15 min)
- Single-user mode option

### Data Protection

- AES-256-GCM encryption at rest for all sensitive data
- Encrypted: session titles, messages, documents, embeddings, preferences, emails, API keys
- Encryption key auto-generated if not provided
- Per-user encrypted API keys in database

### API Security

- Helmet security headers (CSP, HSTS, X-Frame-Options, etc.)
- CORS with origin allowlist
- SSRF prevention on plugin endpoints (HTTPS required for remote URLs)
- Path traversal protection on plugin IDs
- Model name sanitization (regex validation)
- Request body size limit (10mb)

### Deployment Security

- Docker: non-root user, dumb-init for signal handling
- Health check endpoint
- Electron: context isolation, no node integration, web security enabled
- HTTPS recommended for production

---

## 16. Common Tasks for Agents

### Adding a new AI provider plugin

1. Create `plugins/<provider>.json` with the plugin config
2. Follow the plugin structure (id, name, type, endpoint, auth, model_map)
3. If it has variables, add the `variables` array
4. Users enable it in Settings → Plugins

### Adding a new API route

1. Create a new file in `backend/src/routes/<name>.ts`
2. Define Express router with typed handlers
3. Import and register in `backend/src/index.ts`
4. Add rate limiter if needed
5. Add frontend API client in `frontend/src/utils/api.ts`
6. Add frontend component/page if needed

### Adding a new database column

1. Add the column definition to `initializeTables()` in `backend/src/db.ts`
2. Add migration logic in `runMigrations()` for existing databases
3. Update the relevant interface in `backend/src/storage.ts`
4. Update the service that uses it

### Adding a new language

1. Copy `frontend/src/i18n/locales/en.json` to `frontend/src/i18n/locales/<code>.json`
2. Translate all string values
3. The language detector (i18next-browser-languageDetector) auto-detects from browser

### Building for production

```bash
npm run build                    # Build frontend + backend
cd backend && npm start          # Start production server
# Or use Docker:
docker-compose up -d
```

### Running tests

```bash
npm run test:package             # Test package layout
# Backend uses Node's built-in test runner (scripts/test-package-layout.mjs)
```

---

## 17. Known Patterns & Conventions

### Error Handling

- Backend: try/catch in route handlers, centralized error middleware
- Frontend: toast notifications via react-hot-toast, error boundary component
- All errors return consistent JSON: `{ error: "message", details?: [...] }`

### TypeScript

- Strict mode enabled
- ES modules (`"type": "module"`)
- TypeScript 6
- No `any` — use proper types from `backend/src/types/index.ts`

### Naming

- Backend routes: camelCase (`imageGen`, `huggingfaceHub`)
- Plugin IDs: kebab-case (`openai`, `comfyui`, `qwen-tts`)
- Environment variables: UPPER_SNAKE_CASE
- Database columns: snake_case
- Frontend components: PascalCase
- Frontend files: PascalCase for components, camelCase for utilities

### Code Style

- Prettier for formatting (configured in root `package.json`)
- ESLint with TypeScript plugin
- Apache 2.0 license header on all source files
- `npm run format` adds headers + formats

### State Management

- Zustand stores for client-side state
- TanStack Query for server state caching
- WebSocket for real-time updates
- No Redux

### Database Patterns

- Transactions for multi-write operations
- Prepared statements (parameterized queries)
- Foreign keys with CASCADE deletes
- Soft support for JSON fallback when SQLite unavailable

---

## 18. Deployment Targets

| Target               | Command                                                                 | Output                          |
| -------------------- | ----------------------------------------------------------------------- | ------------------------------- |
| **Web (dev)**        | `npm run dev`                                                           | Frontend: :5173, Backend: :3001 |
| **Web (prod)**       | `npm run build && cd backend && npm start`                              | Single Express server           |
| **Docker**           | `docker-compose up -d`                                                  | Containerized with Ollama       |
| **Electron macOS**   | `npm run electron:build`                                                | `.dmg` for ARM64                |
| **Electron Windows** | `npm run electron:build:win`                                            | `.exe` installer                |
| **Electron Linux**   | `npm run electron:build:linux`                                          | `.AppImage` / `.deb`            |
| **npx**              | `npx libre-webui`                                                       | Self-contained CLI              |
| **Homebrew**         | `brew install libre-webui`                                              | macOS package                   |
| **Kubernetes**       | `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui` | Helm chart                      |

---

## 19. Files to Never Commit

- `.env`, `.env.local`, `.env.*.local`
- `data.sqlite`, `*.sqlite`, `*.db`
- `sessions.json`, `preferences.json`, `documents.json`
- `document-chunks.json`
- `.status.json`
- `backend/plugins/*` (generated at runtime)
- `dist-electron/`, `electron/assets/*.icns`, `electron/assets/*.ico`
- `node_modules/`
- `venv/`, `__pycache__/`
- `*.log` (backend.log, frontend.log)

---

## 20. Quick Reference Cards

### "I need to fix the chat streaming"

→ `backend/src/index.ts` WebSocket handler (lines ~449-1420+)
→ `frontend/src/hooks/useChat.ts`
→ `frontend/src/utils/websocket.ts`

### "I need to add a new AI model"

→ Update the appropriate `plugins/<provider>.json` `model_map` array
→ Or run `scripts/update-<provider>-models.sh` to refresh from the provider's API

### "I need to change the UI colors"

→ Tailwind config in `frontend/tailwind.config.js`
→ Design tokens in `DESIGN.md`
→ CSS custom properties may be used in `frontend/src/index.css`

### "I need to fix authentication"

→ `backend/src/routes/auth.ts` — route handlers
→ `backend/src/services/authService.ts` — business logic
→ `backend/src/middleware/auth.ts` — JWT verification
→ `frontend/src/store/authStore.ts` — client state
→ `frontend/src/components/LoginForm.tsx` — UI

### "I need to add a new plugin variable (valve)"

→ Add to the plugin's `variables` array in `plugins/<provider>.json`
→ The UI auto-generates the input based on the variable definition
→ Values are stored in `plugin_variables` table, encrypted if marked `sensitive`

### "I need to debug a plugin issue"

→ Check `plugins/<provider>.json` config
→ Verify API key is set (env var or per-user in Settings → Plugins)
→ Check backend logs for plugin execution errors
→ Test the plugin endpoint directly with curl
→ Check SSRF validation (must be HTTPS for remote URLs)

---

_Last updated: May 2026 — Libre WebUI v0.9.0_
