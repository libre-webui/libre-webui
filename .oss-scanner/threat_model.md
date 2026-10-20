# Libre WebUI threat model

This is for Anthropic's OSS Scanner, but it's also the most honest summary I have of what I consider a real bug in this project. If a finding fits the "out of scope" section below, I'd rather not get it. If it fits anything else, I want to hear about it.

## What Libre WebUI is

Libre WebUI is a self-hosted web interface for AI models. People run it on their own machine, a home server or a VPS, usually for themselves or a small team, sometimes for a company. It talks to local models (Ollama, llama.cpp, MLX) and to hosted providers (OpenAI, Anthropic, OpenRouter, Bedrock and others) through a plugin system.

There's no hosted multi-tenant service. Every deployment is someone's own instance, but a lot of them are reachable from the internet, and a team instance has users who shouldn't be able to read each other's data. So treat it like a small multi-user web app that sits on the open internet.

The code that matters:

- `backend/src/` is the Express backend (TypeScript, Node 22). Routes live in `routes/`, auth in `middleware/auth.ts`, and most of the logic in `services/`. Storage is SQLite by default (`db.ts`, `persistence/`) and PostgreSQL plus Redis plus S3 in team mode (`platform/`).
- `backend/src/websocketServer.ts`, `workTerminalServer.ts` and `workScreenServer.ts` are the WebSocket endpoints. They authenticate with short-lived tickets from `services/websocketTicketService.ts`.
- `frontend/` is the React app. It renders model output as markdown, code, math and diagrams, and runs HTML/React "artifacts" inside a sandboxed iframe (`frontend/src/utils/artifactHtml.ts`, runtime built from `frontend/src/artifact-runtime/`).
- `plugins/` holds provider definitions (JSON). They describe endpoints and which API key to send. Installing or editing one is admin-only.
- `bin/` and `backend/src/cli/` are the `npx libre-webui` launcher.
- `deploy/`, `helm/`, the compose files and `Dockerfile` are how people run it. Misconfigurations in those that ship as defaults are in scope.

## Who the attacker is

Roughly in order of how much I care:

1. **Someone on the internet with no account.** Login, signup, password reset, OAuth and OIDC callbacks, MFA and passkey flows, the automation webhook endpoint (`/api/automations/:id/webhook`), health endpoints and static assets. Anything they can reach before authenticating.
2. **A regular signed-in user** going after other users, an admin, or the server. Users are untrusted. One user reading another user's chats, documents, notes, memories, Work tasks, API tokens or provider keys is a serious bug, and so is a user doing something only an admin should (installing plugins, changing tool or Work access, managing users).
3. **Content the app processes on someone's behalf.** Web pages fetched by web search or the fetch tool, uploaded documents (PDF, DOCX, images, audio), MCP and OpenAPI tool responses, and model output itself. Model output is untrusted: if a model can get script running in the main app origin, that's XSS, not "the model said something weird".
4. **A malicious page in the victim's browser.** CSRF, clickjacking, open redirects in login and OAuth flows, and anything that leaks a token across origins.
5. **Code running inside a Work sandbox.** Work runs agent-written code in Docker or Kubernetes containers. That code is hostile by assumption. Getting out of the container, reaching the host, the Docker socket, other tasks, the backend's internal network, or another user's workspace is in scope.

Admins are trusted. An admin can install plugins, point providers at any URL, enable agent CLIs (which run on the host by design), mount host folders into Work, and run commands. "An admin can do X" is not a finding unless X crosses a boundary an admin isn't supposed to cross, like reading a user's stored provider keys in the clear, or the admin role being reachable without the admin's credentials.

## The boundaries I rely on

**Authentication.** JWT sessions (`services/authService.ts`, `authSessionService.ts`), bcrypt passwords, optional TOTP and WebAuthn (`mfaService.ts`, `webauthnService.ts`), OIDC and GitHub/Hugging Face OAuth (`simpleOidcOAuth.ts`, `oauthSecurity.ts`), and scoped API tokens with the `lwk_` prefix (`apiTokenService.ts`). The first account becomes admin; after that, public registration is closed unless an admin opens it, and new accounts can require approval. Login and signup are rate limited.

**Authorization.** `requireAdmin` and the access services (`authorizationService.ts`, `sharedResourceAccess.ts`, `modelAccessService.ts`, `toolAccessService.ts`, `workAccessService.ts`, `voiceAccessService.ts`, groups in `routes/groups.ts`). Everything per-user is supposed to be scoped by the user id from the verified session. Sharing (`docs/56-SHARING.md`) is always to a named user or group; there are no anonymous public links.

**Outbound requests.** Server-side fetches of user-influenced URLs go through `utils/webpageFetcher.ts`, which rejects private, loopback and link-local addresses and re-checks every redirect. Provider calls go through `utils/providerFetch.ts`. A user getting the server to hit an internal address (cloud metadata, the Docker socket proxy, Redis, Postgres, Ollama on localhost) is SSRF and in scope. Admin-configured provider URLs and the admin "test connection" probe in `routes/plugins.ts` are allowed to reach private addresses on purpose, because people run Ollama on their LAN.

**Secrets at rest.** Provider keys, OAuth tokens and other credentials are encrypted with `ENCRYPTION_KEY` (`services/encryptionService.ts`). The full database is not encrypted, and Work files are plain files in Docker volumes (`docs/19-DATABASE_ENCRYPTION.md`). A credential stored or logged in plaintext where the code clearly meant to encrypt it is a bug.

**Artifacts and previews.** Artifacts run in an iframe sandboxed without `allow-same-origin`, served from a backend sandbox host. Work previews are proxied through `/api/work/previews` with a signed per-task capability URL, sandbox and CSP headers, and stripped cookies (`docs/33-WORKSPACES.md`, "Preview Security and Reachability"). Script from an artifact or a preview running with the main app's origin, cookies or tokens is in scope.

**Work sandboxes.** Containers run as UID 1000, with a read-only root filesystem, all capabilities dropped, `no-new-privileges`, resource limits, inter-container traffic disabled, and only the task's own volume mounted. The backend reaches Docker through a filtered socket proxy. Outbound traffic for agent CLIs inside Work goes through the egress proxy (`workEgressProxy.ts`, `workEgressRelay.ts`), which injects host credentials only for the allowed provider hosts and must never hand them to the sandbox. The full list is in `docs/33-WORKSPACES.md`, "Sandbox Security Boundary". File helpers reject traversal and symlink escapes.

**Tool calls.** Chat tools, MCP servers and OpenAPI tool servers go through the tool gateway and approval system (`toolGatewayService.ts`, `toolApprovalService.ts`). A model calling a tool the user or admin didn't allow, or skipping a required approval, is in scope.

## Out of scope

- **Anything that needs a trusted admin to deliberately do the dangerous thing.** Agent CLI models run on the host as the backend user; that's documented and admin-only. Host-folder workspaces mount host paths on purpose. Admin-configured provider URLs can point anywhere.
- **The Docker socket.** The compose files give the app (through a socket proxy) control of Docker so Work can create containers. That's root-equivalent on that host and it's documented in `SECURITY.md`. A bypass of the socket proxy's filtering from a non-admin is in scope; the mount itself is not.
- **Prompt injection by itself.** A web page or document telling the model to do something is expected. It only counts if it gets past a boundary above: running a tool without approval, reaching another user's data, leaking a credential, getting script into the main origin.
- **Things the model provider sees.** Sending chat context to a remote model discloses it to that provider. That's the product.
- **Denial of service** by a signed-in user on their own instance, resource exhaustion from huge uploads or long generations, and anything needing millions of requests. Unauthenticated DoS that takes the whole instance down cheaply is still interesting.
- **Hashing of high-entropy tokens with SHA-256.** API tokens are 256-bit random values and Redis coordination keys are hashed key names, not passwords. CodeQL flags these and I've reviewed them.
- **Dependencies.** Report the bug upstream. If we use a library in an unsafe way, that's ours.
- **`examples/`**, `scripts/` (tests and release tooling), `homebrew/`, and the demo mode at demo.librewebui.org (a static frontend with no backend).

## How I rate severity

- **Critical:** unauthenticated remote code execution, auth bypass to any account, unauthenticated access to other people's data or stored provider keys, or a non-admin user reaching the host from a Work container.
- **High:** a signed-in user taking over the admin account or another user's account, reading or changing another user's data, stored XSS in the main origin, SSRF from a non-admin to internal services, escaping the Work sandbox into another task or the backend network, or a leak of provider credentials or the egress proxy's injected credentials.
- **Medium:** CSRF with real impact, open redirects in the login or OAuth flow, reflected XSS that needs user interaction, leaks of non-secret metadata across users, approval or access checks that can be raced or skipped with limited impact.
- **Low:** missing hardening headers, timing differences without a demonstrated leak, verbose errors, issues that need an already-compromised admin.

Post-auth SQL injection is high. Pre-auth SQL injection is critical. Stored XSS that only runs inside the artifact sandbox and can't reach the main origin is low.

## How to exercise it

The image built from `.oss-scanner/Dockerfile` has everything installed and built at `/src`. To run the app offline:

```bash
cd /src
export DATA_DIR=/tmp/libre-data JWT_SECRET=scanner-test-secret \
  ENCRYPTION_KEY=$(openssl rand -hex 32) PORT=8080 SERVE_FRONTEND=true
npm start
```

Then open `http://127.0.0.1:8080`, create the first account (it becomes admin), and create a second user from Settings, User Management to test cross-user access. No model needs to be running for most auth, sharing and access bugs. Work needs a Docker daemon, which the scanner image doesn't have, so for Work findings please point at the code path and explain it.

The tests are `node --test scripts/test-*.mjs` (the full list is `npm run test:package` in `package.json`). `scripts/test-authorization.mjs`, `test-auth-sessions.mjs`, `test-api-tokens.mjs`, `test-oauth-security.mjs`, `test-webpage-fetch-security.mjs`, `test-work-egress.mjs` and `test-artifact-sandbox.mjs` are good starting points. Run `libre-services start` and source `/etc/libre-scanner/test.env` for the PostgreSQL, Redis and S3 suites.

## Reports

A short root cause, a reproducer I can run against a local instance, and a minimal patch is perfect. Please don't test against chat.lwui.org or anyone else's instance. Human-reported issues go through `SECURITY.md` (security@kroonen.ai or GitHub private reporting).

Robin
