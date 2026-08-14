# Contributing to Libre WebUI

Thanks for wanting to help. Libre WebUI is Apache 2.0 with **no CLA** — your
contribution stays under the same license everyone else gets.

## Quick start

You need [Node.js 22.22+](https://nodejs.org). Docker is optional (only needed
for the Work sandbox and container testing).

```bash
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui
npm install
npm run dev
```

The normal development frontend runs on http://localhost:5173 and the backend
on http://localhost:3001. Both hot-reload. `npm run dev:host` instead binds the
frontend to the network on port 8080 for LAN testing.

## Where to start

- Issues labeled [`good first issue`](https://github.com/libre-webui/libre-webui/labels/good%20first%20issue)
  are scoped to be doable without knowing the whole codebase.
- Issues labeled [`help wanted`](https://github.com/libre-webui/libre-webui/labels/help%20wanted)
  are larger but up for grabs.
- Small fixes (typos, translations, docs) don't need an issue — just open a PR.

If you want to work on something bigger, open an issue first so we can agree on
the approach before you invest time.

## Project layout

| Path        | What it is                                            |
| ----------- | ----------------------------------------------------- |
| `frontend/` | React + Vite + Tailwind + zustand                     |
| `backend/`  | Express + SQLite/PostgreSQL persistence               |
| `docs/`     | User documentation (published to docs.librewebui.org) |
| `scripts/`  | Release tooling and the node test suites              |
| `deploy/`   | Docker Compose profiles and deployment examples       |
| `helm/`     | Helm chart                                            |

Target the **`dev`** branch for all PRs — `main` only moves at release time.
See [docs/17-DEV_BRANCH.md](docs/17-DEV_BRANCH.md).

## Before you open a PR

```bash
npm run format      # prettier + license headers
npm run lint        # eslint, frontend + backend
npm run test:unit --workspace=frontend
```

CI runs format check, lint, unit tests, e2e tests, and the backend test suites.
A few things that commonly trip first-time PRs:

- **Translations:** the UI ships in 25 languages with a strict key-parity test.
  Every new user-facing string needs a key in _all_ files under
  `frontend/src/i18n/locales/`. If you only speak some of the languages, add
  your best machine translation for the rest — reviewers treat those as
  provisional and native speakers refine them later.
- **License headers:** `npm run format` adds them automatically; don't write
  them by hand.
- **Commit messages:** short and plain. `fix: sidebar drag ghost offset` beats
  a paragraph.

## Reporting bugs

Open a [GitHub issue](https://github.com/libre-webui/libre-webui/issues) with
your OS, how you installed (Docker, npm, desktop app, source), the version
(shown in Settings), and steps to reproduce. Logs from the backend console help
a lot.

## Security issues

Please don't open public issues for security problems — see
[SECURITY.md](SECURITY.md) if present, or email the maintainer privately.

## Community

- [GitHub Discussions](https://github.com/libre-webui/libre-webui/discussions)
  for questions and ideas
- [Documentation](https://docs.librewebui.org) for how things work
