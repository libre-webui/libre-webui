---
sidebar_position: 26
title: "Environment Variables"
description: "Complete reference for all environment variables in Libre WebUI. Configure backend, frontend, authentication, Ollama, plugins, and Docker/Kubernetes deployments."
slug: /ENVIRONMENT_VARIABLES
keywords: [libre webui environment variables, configuration, env, docker env, kubernetes config, api keys]
---

# Environment Variables Reference

Complete reference for all environment variables used in Libre WebUI.

## Quick Reference

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `JWT_SECRET` | - | **Yes (prod)** | JWT signing key |
| `ENCRYPTION_KEY` | auto | No | Data encryption key |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | No | Ollama API URL |
| `PORT` | `3001` | No | Server port |
| `SINGLE_USER_MODE` | `false` | No | Disable multi-user |

## Backend Variables

### Server Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | `development` | Environment mode (`development`, `production`, `test`) |
| `PORT` | `3001` (dev), `8080` (prod) | HTTP server port |
| `CORS_ORIGIN` | `http://localhost:5173,http://localhost:3000,http://localhost:8080` | Allowed CORS origins (comma-separated) |
| `SERVE_FRONTEND` | `false` | Serve frontend static files from backend |
| `DOCKER_ENV` | - | Set to `true` when running in Docker |

### Authentication & Security

| Variable | Default | Description |
|----------|---------|-------------|
| `JWT_SECRET` | - | **Required in production.** 64-character hex string for JWT signing. Generate with: `openssl rand -hex 64` |
| `JWT_EXPIRES_IN` | `7d` | JWT token expiration (e.g., `7d`, `24h`, `1w`) |
| `ENCRYPTION_KEY` | auto-generated | 64-character hex key for encrypting data at rest. Auto-generated if not set. |
| `SESSION_SECRET` | auto-generated | Session encryption secret |
| `SINGLE_USER_MODE` | `false` | When `true`, disables multi-user authentication |

### Ollama Integration

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint URL |
| `OLLAMA_TIMEOUT` | `300000` | Standard API timeout in ms (5 minutes) |
| `OLLAMA_LONG_OPERATION_TIMEOUT` | `900000` | Extended timeout for model loading (15 minutes) |

**For large models (70B+)**, increase timeouts:
```env
OLLAMA_TIMEOUT=600000
OLLAMA_LONG_OPERATION_TIMEOUT=1800000
```

### Database & Storage

| Variable | Default | Description |
|----------|---------|-------------|
| `DATA_DIR` | `./backend/data` | Directory for SQLite database and uploads |

In Docker, this is typically set to `/app/backend/data`.

### OAuth2 - GitHub

| Variable | Default | Description |
|----------|---------|-------------|
| `GITHUB_CLIENT_ID` | - | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | - | GitHub OAuth app client secret |
| `GITHUB_CALLBACK_URL` | `http://localhost:3001/api/auth/oauth/github/callback` | OAuth callback URL |

### OAuth2 - Hugging Face

| Variable | Default | Description |
|----------|---------|-------------|
| `HUGGINGFACE_CLIENT_ID` | - | Hugging Face OAuth app client ID |
| `HUGGINGFACE_CLIENT_SECRET` | - | Hugging Face OAuth app client secret |
| `HUGGINGFACE_CALLBACK_URL` | `http://localhost:3001/api/auth/oauth/huggingface/callback` | OAuth callback URL |

### Plugin API Keys

These are optional fallback keys. Users can also configure per-user API keys in Settings.

| Variable | Provider | Description |
|----------|----------|-------------|
| `OPENAI_API_KEY` | OpenAI | GPT-4, GPT-4o, o1, o3 models + TTS |
| `ANTHROPIC_API_KEY` | Anthropic | Claude Opus, Sonnet models |
| `GROQ_API_KEY` | Groq | Fast inference (Llama, Gemma) |
| `GEMINI_API_KEY` | Google | Gemini 2.0/2.5 models |
| `MISTRAL_API_KEY` | Mistral | Mistral Large, Codestral |
| `OPENROUTER_API_KEY` | OpenRouter | 300+ models aggregator |
| `GITHUB_API_KEY` | GitHub Models | GitHub-hosted models |
| `ELEVENLABS_API_KEY` | ElevenLabs | Text-to-speech |

### Debug

| Variable | Default | Description |
|----------|---------|-------------|
| `DEBUG_ENCRYPTION` | - | Enable encryption service debug logging |

---

## Frontend Variables

All frontend variables must be prefixed with `VITE_`.

### API Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_API_BASE_URL` | auto-detected | Override API base URL |
| `VITE_BACKEND_URL` | `http://localhost:3001` | Backend URL for OAuth flows |
| `VITE_WS_BASE_URL` | `ws://localhost:3001` | WebSocket base URL |
| `VITE_API_TIMEOUT` | `300000` | API request timeout (5 minutes) |

### Features

| Variable | Default | Description |
|----------|---------|-------------|
| `VITE_DEMO_MODE` | `false` | Enable demo mode for presentations |
| `VITE_APP_VERSION` | auto-detected | Application version string |

---

## Docker Configuration

### docker-compose.yml

```yaml
services:
  libre-webui:
    environment:
      - NODE_ENV=production
      - DOCKER_ENV=true
      - PORT=3001
      - OLLAMA_BASE_URL=http://ollama:11434
      - CORS_ORIGIN=http://localhost:8080
      - SINGLE_USER_MODE=false
      - JWT_SECRET=${JWT_SECRET:-}
      - JWT_EXPIRES_IN=7d
      - ENCRYPTION_KEY=${ENCRYPTION_KEY:-}
      - OLLAMA_TIMEOUT=${OLLAMA_TIMEOUT:-300000}
      - OLLAMA_LONG_OPERATION_TIMEOUT=${OLLAMA_LONG_OPERATION_TIMEOUT:-900000}
      - DATA_DIR=/app/backend/data
      # OAuth (optional)
      - GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID:-}
      - GITHUB_CLIENT_SECRET=${GITHUB_CLIENT_SECRET:-}
      - HUGGINGFACE_CLIENT_ID=${HUGGINGFACE_CLIENT_ID:-}
      - HUGGINGFACE_CLIENT_SECRET=${HUGGINGFACE_CLIENT_SECRET:-}
```

### External Ollama

When using Ollama outside Docker:

```yaml
# docker-compose.external-ollama.yml
environment:
  - OLLAMA_BASE_URL=http://host.docker.internal:11434  # Mac/Windows
  # - OLLAMA_BASE_URL=http://172.17.0.1:11434         # Linux
```

---

## Kubernetes Configuration

### Helm Values

```yaml
# values.yaml
env:
  NODE_ENV: production
  DOCKER_ENV: "true"
  PORT: "3001"
  CORS_ORIGIN: "http://localhost:8080"
  SINGLE_USER_MODE: "false"
  JWT_EXPIRES_IN: "7d"
  OLLAMA_TIMEOUT: "300000"
  OLLAMA_LONG_OPERATION_TIMEOUT: "900000"
  DATA_DIR: "/app/backend/data"

# Sensitive values stored as K8s Secrets
secrets:
  jwtSecret: ""
  encryptionKey: ""
  sessionSecret: ""
  githubClientId: ""
  githubClientSecret: ""
  huggingfaceClientId: ""
  huggingfaceClientSecret: ""
```

### Setting Secrets

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set secrets.jwtSecret=$(openssl rand -hex 64) \
  --set secrets.encryptionKey=$(openssl rand -hex 32)
```

Or create a Secret manually:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: libre-webui-secrets
type: Opaque
stringData:
  jwt-secret: "your-64-char-hex-string"
  encryption-key: "your-32-char-hex-string"
```

---

## Example Configurations

### Development (.env)

```env
# backend/.env
NODE_ENV=development
PORT=3001
OLLAMA_BASE_URL=http://localhost:11434

# Optional: API keys for testing plugins
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

### Production (.env)

```env
# Production - generate secure keys!
NODE_ENV=production
PORT=8080
JWT_SECRET=<generated-64-char-hex>
ENCRYPTION_KEY=<generated-32-char-hex>

# Ollama
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_TIMEOUT=600000
OLLAMA_LONG_OPERATION_TIMEOUT=1800000

# OAuth (optional)
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret

# CORS for your domain
CORS_ORIGIN=https://chat.example.com
```

### Self-Hosted Multi-User

```env
NODE_ENV=production
SINGLE_USER_MODE=false
JWT_SECRET=<generated-64-char-hex>
JWT_EXPIRES_IN=7d

# Enable SSO
GITHUB_CLIENT_ID=your_client_id
GITHUB_CLIENT_SECRET=your_client_secret
GITHUB_CALLBACK_URL=https://chat.example.com/api/auth/oauth/github/callback
```

---

## Security Best Practices

1. **Never commit secrets** - Use environment variables or secret management
2. **Generate secure keys** - Use `openssl rand -hex 64` for JWT_SECRET
3. **Rotate secrets periodically** - Especially in production
4. **Use HTTPS** - Set CORS_ORIGIN to HTTPS URLs in production
5. **Limit CORS origins** - Only allow necessary domains
6. **Encrypt API keys** - Keys stored in database are encrypted with ENCRYPTION_KEY

---

## Troubleshooting

### Variables Not Loading

```bash
# Check if .env file is being read
cat backend/.env

# Verify environment in running process
docker exec libre-webui env | grep OLLAMA
```

### OAuth Callback Errors

Ensure callback URLs match exactly:
- Development: `http://localhost:3001/api/auth/oauth/github/callback`
- Docker: `http://localhost:8080/api/auth/oauth/github/callback`
- Production: `https://your-domain.com/api/auth/oauth/github/callback`

### Timeout Errors

For large models, increase all timeouts:

```env
OLLAMA_TIMEOUT=600000
OLLAMA_LONG_OPERATION_TIMEOUT=1800000
VITE_API_TIMEOUT=600000
```
