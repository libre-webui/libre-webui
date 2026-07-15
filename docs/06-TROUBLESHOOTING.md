---
sidebar_position: 7
title: 'Troubleshooting'
description: 'Common Libre WebUI issues and fixes.'
slug: /TROUBLESHOOTING
keywords:
  [
    libre webui troubleshooting,
    ollama errors,
    docker errors,
    model pull,
    authentication,
  ]
---

# Troubleshooting

Start with the layer that is failing: browser, frontend, backend, Ollama, provider plugin, or deployment networking.

## Quick Checks

```bash
# App branch and local changes
git status

# Backend health
curl http://localhost:3001/api/health

# Ollama health
curl http://localhost:11434/api/tags

# Installed Ollama models
ollama list
```

In development, the frontend usually runs on `http://localhost:5173` and the backend on `http://localhost:3001`. The packaged `npx libre-webui` flow serves the app on `http://localhost:8080`.

## Libre WebUI Does Not Start

**Check Node and dependencies**

```bash
node --version
npm install
npm run dev
```

Node.js 22.12 or newer is required.

**Port already in use**

```bash
lsof -i :3001
lsof -i :5173
lsof -i :8080
```

Stop the old process or configure another port.

**Backend cannot write data**

The backend stores data under `DATA_DIR` when set, otherwise under `backend/data` from the project root. Make sure that directory is writable.

## Browser Cannot Reach the Backend

For local development, the frontend uses `VITE_API_BASE_URL` when set and otherwise falls back to the development backend.

Frontend `.env` example:

```env
VITE_API_BASE_URL=http://localhost:3001/api
VITE_WS_BASE_URL=ws://localhost:3001
```

Backend `.env` example:

```env
CORS_ORIGIN=http://localhost:5173,http://127.0.0.1:5173
```

For phone, LAN, or Tailscale access, do not point the phone browser at `localhost`; use the laptop’s LAN or Tailscale IP and run the dev server with host binding:

```bash
npm run dev:host
```

## Ollama Is Not Detected

**Confirm Ollama is running**

```bash
curl http://localhost:11434/api/tags
```

**Configure a custom Ollama URL**

Backend `.env`:

```env
OLLAMA_BASE_URL=http://localhost:11434
```

If Libre WebUI runs in Docker and Ollama runs on the host, use the external Ollama compose file or point `OLLAMA_BASE_URL` at the host address reachable from the container.

## Model Pull Problems

**Pull from terminal first**

```bash
ollama pull gemma3:4b
```

If the terminal pull fails, the problem is outside Libre WebUI.

**Cloud models**

Use the cloud filter in the Model Manager for Ollama Cloud models. Libre WebUI normalizes required cloud suffixes from that flow, so users should not need to manually add `:cloud` for supported cloud entries.

**User cannot pull models**

Administrators can disable model pulls for normal users. Check admin settings if a non-admin user can browse models but cannot install them.

## Chat Is Slow or Fails

- Use a smaller model.
- Check loaded models with `ollama ps`.
- Reduce context length.
- Reduce max tokens for very long responses.
- Confirm the model fits in RAM/VRAM.
- For provider plugins, confirm the API key and provider quota.

## Login and Signup Problems

**First user is not admin**

Only the first account created in a fresh database becomes admin. Existing databases keep their current users and roles.

**JWT errors**

Set a stable secret in production:

```env
JWT_SECRET=replace-with-a-long-random-secret
```

Changing `JWT_SECRET` invalidates existing sessions.

**Turnstile blocks signup**

Turnstile is enabled only when both keys are present:

```env
TURNSTILE_SITE_KEY=...
TURNSTILE_SECRET_KEY=...
```

If signup suddenly fails, confirm the site key matches the domain and the secret key is valid.

**OAuth redirects fail**

Set callback URLs in both the provider dashboard and backend `.env`:

```env
BASE_URL=https://your-domain.example
GITHUB_CALLBACK_URL=https://your-domain.example/api/auth/oauth/github/callback
HUGGINGFACE_CALLBACK_URL=https://your-domain.example/api/auth/oauth/huggingface/callback
```

## Document Chat Problems

Libre WebUI currently accepts PDF and plain-text files up to 10 MB.

If search works but semantic retrieval does not:

1. Install an embedding model such as `nomic-embed-text`.
2. Enable embeddings in Settings.
3. Regenerate embeddings from the document settings or API.

```bash
ollama pull nomic-embed-text
```

Keyword search continues to work when embeddings are disabled.

## Artifact Preview Problems

For games or interactive HTML, ask the model for one complete self-contained HTML file with inline CSS and JavaScript.

If the artifact needs keyboard input:

- Click inside the preview first.
- Use the Open button to run it in its own browser tab.
- Avoid relying on local files that were not included in the response.

Libre WebUI can bundle common `index.html` + CSS + JavaScript code blocks, but self-contained HTML is still the most reliable output.

## Docker Problems

**Container cannot reach Ollama**

Use the external Ollama compose file when Ollama is not in the same compose stack:

```bash
docker compose -f docker-compose.external-ollama.yml up -d
```

**Data does not persist**

Mount a persistent data volume and set `DATA_DIR` if needed. The encryption key is stored in persistent storage when `DATA_DIR` or Docker mode is used.

## Resetting Local Data

Stop the app first. Then back up and remove the data directory you are using. By default, development data lives under `backend/data`.

```bash
cp -R backend/data backend/data.backup
rm -rf backend/data
```

Restart the backend and create a fresh account.

## Still Stuck

Open an issue with:

- Libre WebUI version and commit
- Install method
- Operating system
- Node.js version
- Ollama version
- Backend logs around the failure
- Browser console errors
- The exact model or provider being used
