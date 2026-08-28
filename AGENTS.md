# AGENTS.md

## Project overview

Libre WebUI is a self-hosted, local-first AI workspace. The product must remain
provider-flexible, private by default, and free of application telemetry. Remote
providers and outbound integrations are opt-in; do not turn a local workflow
into an implicit network dependency.

This file applies to the whole repository. Read the canonical documents instead
of duplicating them here: `CONTRIBUTING.md` for contribution policy, `DESIGN.md`
for UI decisions, `SECURITY.md` for security handling, and
`docs/45-PLATFORM_FOUNDATION.md` for persistence and multi-replica invariants.

## Project structure

- `frontend/` — React 19, Vite, strict TypeScript, Zustand, and browser tests.
- `backend/` — Express 5, strict ESM TypeScript, routes, services, persistence,
  durable jobs, and workers.
- `scripts/` — Node test suites plus release, packaging, and validation tools.
- `plugins/` — bundled provider manifests.
- `docs/` — user and operator documentation.
- `deploy/`, root Compose files, and `helm/` — deployment definitions.
- `examples/` — optional Python model and speech servers.

The root is an npm workspace for `frontend` and `backend`, with one authoritative
`package-lock.json`.

## Setup and development

Use Node.js 22.22 or newer and npm. Do not use pnpm, Yarn, or Bun in this repo.

```bash
npm install
npm run dev
```

`npm run dev` starts the frontend at `http://localhost:5173` and the backend at
`http://localhost:3001`. Use `npm run dev:host` only when LAN access on port 8080
is needed. `npm run build` builds both workspaces.

Docker is optional for ordinary development, but required for Work sandboxes,
container checks, and team-platform drills. Ollama is optional unless the task
tests local-model behavior. Copy settings from `backend/.env.example` or
`frontend/.env.example`; do not inspect or overwrite a developer's real `.env`
files unless explicitly asked, and never commit them.

## Testing and validation

Start with the narrowest test that proves the change, then validate the touched
workspace. Common focused commands are:

```bash
# One frontend unit file
(cd frontend && node --import tsx --test src/utils/theme.test.ts)

# One backend regression script (most scripts import compiled backend/dist)
npm run build:backend && node --test scripts/test-title-generation.mjs

# One browser spec; install Chromium/WebKit once if Playwright asks
(cd frontend && npx playwright test e2e/version-labels.spec.ts)
```

For frontend changes, run the relevant unit test plus:

```bash
npm run lint:frontend
npm run type-check --workspace=frontend
npm run test:unit --workspace=frontend
```

For backend changes, build before regression scripts, then run:

```bash
npm run lint:backend
npm run type-check --workspace=backend
```

Always run `npm run format:check` on a finished change. Broad or PR-ready work
must pass the repository gates:

```bash
npm run format:check
npm run lint
npm run type-check --workspace=frontend
npm run type-check --workspace=backend
npm run test:package
npm run test:e2e
```

`test:package` is intentionally large. CI supplies PostgreSQL/PGVector, Redis,
and MinIO for its full integration path; report any locally unavailable or
skipped coverage. Use `npm run test:work` for Work changes and
`npm run test:team-platform` for the Docker-backed multi-replica drill. For Helm
changes, also run `helm lint helm/libre-webui` and
`bash scripts/test-helm-render.sh`.

- Add a focused regression test for behavior changes.
- Register new frontend unit files in `frontend/package.json`'s `test:unit`
  script. Register new root regression scripts in `test:package`. Playwright
  discovers `frontend/e2e/*.spec.ts` automatically.
- Never delete, weaken, skip, or rewrite a test merely to make a change pass.
- Never describe a failed, skipped, interrupted, or timed-out check as passing.

## Code and product conventions

- Follow neighboring patterns and let Prettier and ESLint enforce mechanics.
  The formatter uses two spaces, single quotes, semicolons, and an 80-column
  target. Do not reformat unrelated code.
- Backend relative ESM imports use `.js` suffixes in TypeScript source. Frontend
  code may use the `@/` alias for `frontend/src`.
- Preserve the Libre WebUI license header on TypeScript and JavaScript files.
  `npm run format` also adds missing source headers; review its complete diff.
- Comments should explain intent, invariants, or non-obvious tradeoffs, not
  restate the code.
- Every new user-visible string must use i18n and be present, non-empty, and
  interpolation-compatible in all files under `frontend/src/i18n/locales/`.
  Preserve Arabic RTL behavior and logical CSS direction.
- UI work must follow `DESIGN.md`, work in light and dark modes, retain visible
  keyboard focus, honor reduced motion, and never convey state through color
  alone.
- Update the relevant `docs/` page when user-visible behavior, configuration,
  deployment, or security expectations change.

## Architecture and security boundaries

- Preserve the startup preflight order in `backend/src/main.ts`. Configuration,
  data paths, encryption keys, and persistence must be validated before loading
  stateful application services.
- Route new persistence through repository contracts. Do not import `db.js` or
  `better-sqlite3` from new application code outside the audited adapter,
  migration, recovery, and health boundaries. Changes must preserve both solo
  SQLite and team PostgreSQL behavior.
- SQL is authoritative for durable state and authorization. Redis and live
  event streams are coordination/wakeup mechanisms, not sources of truth.
- Released migration names and checksums are immutable; append a migration
  instead of rewriting history. New durable side effects need an idempotency or
  transactional-outbox design.
- Treat authentication, resource ownership, SSRF/egress controls, artifact
  sandboxing, tool approvals, Work path containment, and Docker socket access as
  security boundaries. Do not add fail-open fallbacks or weaken checks to make
  tests pass.
- A route or capability change is cross-stack work: schema/default/manifest,
  backend handler, browser client, visible UI action, documentation, and a named
  test must agree with `scripts/global-capability-contracts.json`. Provider
  capabilities must also agree with `scripts/capability-contracts.json`.
- Never commit secrets or sensitive runtime data. Follow `SECURITY.md`; do not
  lower audit thresholds or add blanket scanner suppressions.

## Generated files and change scope

Do not edit `frontend/dist/`, `backend/dist/`, test reports, package tarballs,
runtime databases, installed backend plugins, or
`frontend/public/artifact-runtime/`. They are generated or local state.

The inventory in `docs/43-CAPABILITY_CONTRACTS.md` and all of
`docs/46-GLOBAL_CAPABILITY_CONTRACTS.md` are generated. Change their JSON source
and regenerate them with:

```bash
UPDATE_CAPABILITY_CONTRACTS=1 node --test scripts/test-capability-contracts.mjs
node scripts/test-global-capability-contracts.mjs --write-inventory
```

Do not modify unrelated files, overwrite existing user work, or widen the task
without agreement. Do not add a dependency or change the lockfile unless the
task requires it; explain the reason and validate native-module compatibility.
Do not change versions, changelogs, release artifacts, deployment defaults, or
security policy incidentally. Never run migrations, restores, publishing,
release, or live-deployment commands unless explicitly requested.

## Git and pull requests

- Branch from `dev` and target `dev`; `main` advances only for releases.
- Use Conventional Commits: `type(scope): short imperative description`.
- Keep commits focused. Do not add AI attribution, generated-by footers, or
  co-author trailers.
- Never commit, push, open a pull request, dismiss an alert, or create a release
  unless the user explicitly asks.
- Before handing off, inspect the diff, preserve unrelated working-tree changes,
  and list exactly which checks passed, failed, or were not run.
