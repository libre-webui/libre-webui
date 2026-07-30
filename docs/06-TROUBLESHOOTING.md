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

Node.js 22.22 or newer is required.

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

## Provider Endpoint Problems

If an OpenAI-compatible provider receives requests at the wrong path, check its
settings under **Settings → Plugins**:

- Choose **Chat Completions** for `/chat/completions` payloads or **Responses**
  for `/responses` payloads.
- Enter the API root, such as `https://provider.example/v1`, as the base URL.
- Leave API path empty for the mode's default, or enter a leading-slash path
  supplied by the provider.
- A genuinely custom legacy full endpoint intentionally has highest
  precedence, so clear it when switching back to Base URL and API Path. Stored
  values that merely equal the bundled manifest's old default are ignored
  automatically after an upgrade. When a custom endpoint ends in
  `/chat/completions` or `/responses`, that suffix also determines the request
  format so an override cannot receive the wrong payload.

Imported plugin JSON supports providers that use an OpenAI Chat Completions,
OpenAI Responses, Anthropic, or Gemini-compatible wire format. If the provider
uses a proprietary payload, streaming event, tool-call, or response format, it
needs a backend adapter; changing only the endpoint cannot translate it.

Remote provider URLs must use HTTPS. HTTP is accepted only for localhost and
private-network addresses. Base URLs cannot contain query strings or fragments,
and relative API paths cannot contain literal or repeatedly encoded traversal
segments, query strings, or fragments. Excessive encoding is rejected when it
does not stabilize within the validation bound.

Model refresh replaces known operation suffixes, including `/responses`, with
`/models`. Activation, explicit refresh, and saved connection overrides use the
current user's endpoint and API key. Saving or removing that user's API key and
resetting connection overrides also refresh the list; unrelated generation
parameters do not. Discovered IDs are stored per user and never overwrite the
shared plugin JSON. If the derived route is not supported by the provider,
configure model IDs manually in the plugin's `model_map`.

Provider requests intentionally do not follow HTTP redirects, including model
discovery, Chat, Work, image generation, embeddings, and text-to-speech.
Configure the final destination URL rather than a redirecting URL. This
fail-closed behavior keeps an authorization header from hopping to a destination
that was not validated.

HTTP is accepted only for exact loopback hosts or private IPv4 literals.
Hostnames such as `host.docker.internal` and `10.example.com` are not private
IP literals and therefore require HTTPS. Requests originate from the backend,
so `localhost` refers to the Libre WebUI container when the backend runs in a
container, not automatically to the host machine.

Image model availability, endpoint overrides, and API keys are resolved for
the current user too. If an image request appears to use another account's
provider settings, verify that the request is authenticated as the expected
user.

### Chat Uses the Wrong Provider or Shows a Provider as Unavailable

The same model ID can exist in Ollama and in more than one plugin. Current Chat
sessions and default-model preferences save the selected provider as well as
the raw model ID, so similarly named entries are independent choices.

- If the selector says a provider is unavailable, reactivate or reinstall that
  exact plugin and confirm its model map still contains the saved model ID.
- If the provider or model was intentionally removed, explicitly select a
  replacement. Libre WebUI will not redirect an exact saved selection to a
  same-named model from another provider.
- Older sessions and preferences may have no provider metadata. Those records
  continue to use legacy name-only routing because Libre WebUI cannot infer
  which provider was originally intended. They appear as "provider not
  recorded" in model selectors. Reselect the desired Ollama or plugin entry to
  pin future requests to it.
- Persona entries remain labeled `persona:<id>`. Newly selected personas record
  Ollama as their backing provider; historical persona sessions without
  provider metadata remain compatible with legacy routing.

## Work Problems

### Work Is Missing or Reports Runtime Unavailable

Work requires a currently authenticated administrator. Its container runtime
must be available to the Libre WebUI backend:

```bash
docker info
docker version
```

Confirm Docker is running and that the operating-system user running the
backend can invoke the configured `WORK_DOCKER_COMMAND`. Installing Libre WebUI
with `npx` does not install Docker. If Docker is missing, Libre WebUI keeps the
rest of the application available and does not fall back to executing model
commands on the host.

The standard Compose image and current Helm chart do not provide a Work runtime
by default. The application container has neither the Docker CLI nor the host
Docker socket. Mounting `/var/run/docker.sock` into a web application grants
root-equivalent control of the Docker host; review
[Work: Isolated Workspaces](./WORKSPACES) before designing a custom deployment.

### The Model Lacks Tool Support

Work requires a tool-capable chat model. For Ollama, choose an installed model
whose reported capabilities include `tools`. For a plugin-backed model:

- Confirm the chat or completion plugin is active.
- Confirm the selected model is in that plugin's configured model list.
- Confirm an API key is available for the current administrator.
- Confirm the provider supports tool calls for that exact model.

Libre WebUI does not silently route a failed Work run to a different provider.

### A Work Request Returns HTTP 429

The instance has reached a task or active-runtime admission limit. By default,
Libre WebUI allows two active container-backed tasks across the instance and
one per user. A running preview also occupies runtime capacity. Wait for the
other operation to finish, stop an unused preview, or have the operator review
the `WORK_MAX_ACTIVE_RUNTIMES_*` and `WORK_MAX_TASKS_*` settings.

### Package Installation or Network Access Fails

New Work tasks use Docker bridge networking so generated projects can download
packages and start previews. Check Docker DNS, proxy configuration, registry
availability, and the command output in **Activity**. Libre WebUI does not mount
host SSH keys, cloud credentials, browser profiles, or the Docker socket into
the task container.

### A Work Preview Does Not Start

- Make sure the server binds to `0.0.0.0` on `WORK_PREVIEW_PORT` (`4173` by
  default).
- Leave the optional command empty to auto-detect a `package.json` `dev` script
  or a plain `index.html`, including a single nested app.
- If Work reports multiple apps or no supported entry point, enter the
  project's explicit development command in the optional command field. The
  command starts in `/workspace`, so use `cd <app-directory> && ...` for a
  nested app.
- Expand the returned error details to inspect startup output.
- Stop an existing preview before starting another command that needs the
  container.

Preview URLs use a dynamically assigned loopback port. The browser and Libre
WebUI backend therefore need to run on the same machine. A browser connected to
a remote backend cannot reach that backend's loopback preview, and an HTTPS page
may block a plain-HTTP preview as mixed content.

### A Workspace File Cannot Be Opened or Saved

The Work file API accepts UTF-8 text files up to 2 MB. If a file changed after
you opened it, reload it before saving so you do not overwrite the newer
version. Formatting is limited to supported file types under 100,000 characters
and 4,000 lines; syntax highlighting pauses for large files to keep editing
responsive.

Unsaved edits are kept as a draft in the current browser. They are not a
substitute for saving to the persistent workspace.

### A Task or Preview Was Stopped

Stopping a run, stopping a preview, or restarting Libre WebUI stops disposable
container processes but preserves the task's named workspace volume. Reopen the
task and restart its preview. Deleting the task is different: after
confirmation, it permanently removes the task and its workspace.

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
- Docker version and `docker info` result for Work problems
- Backend logs around the failure
- Browser console errors
- The exact model or provider being used
- Work Activity output when a task or preview fails
