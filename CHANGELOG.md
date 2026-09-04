# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ New Features

- **`ollama launch libre-webui`.** The packaged CLI takes `--model`,
  `--ollama-url`, and `--no-open`, mapped onto the `DEFAULT_MODEL`,
  `OLLAMA_BASE_URL`, and `OPEN_BROWSER` variables the server reads, so a
  launcher can hand over the model it just pulled. `DEFAULT_MODEL` fills the
  model slot of any account that has not picked one; a saved choice always
  wins.

### 🔧 Improvements

- **The web app talks to the server with `fetch`.** The axios dependency is
  gone from the frontend. A small client keeps the same request surface
  (`params`, blob responses, per-request timeouts, cancellation, and errors
  that carry the response status and body), the auth header and the
  session-expiry redirect live in two hooks, and the vendor bundle shrinks.
- **The server's outbound HTTP runs on Node's `fetch`.** axios is gone from
  the backend as well. One helper carries what the provider integrations
  relied on: a non-2xx status throws with the response attached, timeouts are
  idle timeouts as before so a long model pull or a slow download is not cut
  off, response size caps are enforced by Content-Length and then by a
  counted read, redirects are refused so credentials never follow a 3xx, and
  cancellation, timeout, and unreachable-host errors stay distinguishable.
- **Passwords hash with `bcryptjs`.** The native `bcrypt` module and its
  types are gone, one fewer binary to build or fetch on unusual platforms.
  Same cost factor, same `$2b$` format; every existing password hash keeps
  verifying.
- **`.env` files load through Node's own `process.loadEnvFile`.** The dotenv
  dependency is gone from the server, the CLI, and the Vite config. Same
  lookup order (`backend/.env`, then the root `.env`), operator variables
  still win, and a missing file is still skipped.
- **Smaller server dependency tree.** `morgan` was no longer used (the
  access log has its own format that strips query strings) and is removed,
  and the `cors` package is replaced by a forty-line middleware with the same
  behavior: allowed origins are echoed with credentials and `Vary: Origin`,
  preflights get a 204 with the configured methods and headers, and a
  foreign origin is still refused.
- **Identifiers come from `crypto.randomUUID`.** The `uuid` package is
  removed from the server; every id it minted is a version 4 UUID, exactly
  what Node's built-in produces, so stored ids and their validators are
  unaffected.
- **Manifest cleanup.** `sonner`, `lowlight`, and `@types/pdf-parse` were
  declared but never imported; four type packages for artifact-runtime
  libraries that no type-check ever reads are gone; `tar` and the
  `jsonwebtoken` and `multer` types move to development dependencies; and
  React is no longer listed at the root, where every `npx libre-webui`
  install downloaded it for a prebuilt frontend that does not need it.

### 🐛 Bug Fixes

- Settings > Appearance no longer offers the neutral-or-tinted **Interface
  palette** choice while the Celestial theme is active; the sky paints the
  whole palette, so the choice had nothing to act on.
- The **Models** tab in Settings is grayed out, with a tooltip, while an
  administrator has the Ollama provider disabled, since the model manager
  only speaks to Ollama. The provider picker stays available.
- The Work Computer screen relay rewrites a reserved WebSocket close code
  from websockify (sent when its VNC target is gone) into one browsers
  accept, so a lost screen ends as a clean close instead of "Received a
  broken close frame containing a reserved status code".
- The app no longer closes its first chat WebSocket mid-handshake when it
  re-dials with the fresh token after sign-in, which logged "WebSocket is
  closed before the connection is established" on every page load.
- KaTeX no longer warns in the console about en and em dashes inside inline
  math; it renders them as before.

## [0.33.0] - 2026-09-04

The sky comes indoors: a fourth theme follows the sun where you are, with a
live sky behind an interface that steps back while you write. Administration
moves into Settings, and the demo lands in the new theme.

### ✨ New Features

- **Celestial theme.** A fourth theme that follows the sun: the palette and a
  live sky shift minute by minute, with sunrise and sunset moving through the
  year. The sun or moon crosses on its arc (the moon shows its real phase),
  clouds drift at different depths, stars come out after dusk with the odd
  meteor, a horizon glow spreads under a low sun, and an aurora ribbons across
  the night while a reply streams. The scene parallaxes with the pointer and
  tilts as you scroll the conversation; at night a lamp follows the pointer
  over the words and brightens with each keystroke. While you type, the
  sidebar and tab strip step back so the words sit in the landscape. The
  theme toggle cycles through it, administrators can make it the instance
  default, the sign-in page renders the sky, and choosing Celestial plays the
  last six hours into the present.
- **Time of day scrubber.** Settings > Appearance previews any minute of the
  day with today's sunrise and sunset shown; **Follow the clock** returns to
  real time.
- **Your actual sky, and your weather, on your terms.** Share a location
  (browser prompt or typed coordinates) and sunrise, sunset, and solar noon
  are solved for that spot. Coordinates are rounded to about a kilometre,
  kept only in that browser, and never join the synced preference, so the
  server never learns them. With a location, an opt-in **Match the weather**
  switch fetches current conditions from Open-Meteo straight into the
  browser: cloud cover greys the sky and dims the sun and stars, rain and
  snow fall, fog washes the horizon, storms flash, and wind drives the
  clouds. Everything above respects reduced-motion settings.
- **User Management lives in Settings.** Administrators find it under a new
  **Administration** group in the Settings panel, with every access toggle,
  policy, group, audit log, and the user list. The old `/users` link, the
  avatar-menu shortcut, and the pending-approval badge still work: they open
  that tab. Translated into all 25 languages.
- **The demo lands in Celestial.** demo.librewebui.org opens in the new
  theme before the app even paints.

### 🔧 Improvements

- The celestial sky stays off the main thread: clouds drift and the sun and
  moon glide on the compositor, stars twinkle on their own layers, and colours
  ease briefly after each tick. Idle cost is about 2% of a core with no
  layout work, and the heap stays flat across theme switches and long idles.
- Muted text keeps its contrast over the sky, the frame (sidebar and tab
  strip) is one continuous surface exactly as in the flat themes, the user's
  bubbles are dark glass at night, and the composer is glass at all hours.
- The README hero shows the celestial dusk with a Three.js artifact.

### 🐛 Bug Fixes

- Imagine: gallery images no longer break after a filter change or a
  strict-mode remount. Each card's blob URL was revoked while the image still
  pointed at it; the revoke is now deferred and cancelled when the card comes
  straight back.
- Visiting Settings in a flat theme no longer mounts an invisible celestial
  sky behind the interface.

### 🔒 Security

- The compressed static-asset middleware resolves every requested file
  inside the dist root and rejects anything that normalizes elsewhere,
  closing a CodeQL path-injection finding; traversal attempts are tested.

### 📚 Documentation

- Pro tips describe the celestial theme, the scrubber, location, and
  weather; every page that pointed at the User Management page now points at
  Settings > User Management.

## [0.32.0] - 2026-09-03

A quieter, faster release: administrators pick the theme the whole instance
starts from, the theme toggle reaches Pure Black, long conversations stop
stuttering while a reply streams, and the app arrives lighter and faster
from a plain Docker install.

### ✨ New Features

- **Instance default theme.** A new **Default theme** card on the Users page
  lets administrators choose Light, Dark, or Pure Black for the whole
  install. It paints the sign-in page before anyone signs in, seeds every new
  account, and applies in any browser that has not picked a theme of its own;
  a personal choice made in Settings always wins. The default is cached
  locally, so a returning visitor gets it before the first paint instead of a
  dark flash. Translated into all 25 languages.
- **Three-way theme toggle.** The sun/moon button on the sign-in page and in
  the sidebar, `Cmd/Ctrl + D`, and the command palette now cycle Light, Dark,
  and Pure Black, and the icon shows where the next press goes.

### 🔧 Improvements

- **Long chats stay smooth while a reply streams.** Streamed text used to
  re-render every message in the conversation on every animation frame, and
  none of the message components were memoized, so each finished message
  re-parsed its markdown sixty times a second. Messages, branches, and the
  content renderers are memoized, each message reads only the store slices
  it needs, streaming state reaches only the streaming turn, and off-screen
  turns skip layout and paint. Main-thread script time during one streamed
  reply in a 250-message chat drops from 3.1 s to 0.9 s.
- **A lighter first paint.** Vite 8's Rolldown had folded React itself into
  the markdown chunk, so every page, including sign-in, preloaded a third of
  a megabyte of markdown machinery. Explicit chunk groups put React back in
  its own vendor chunk and the release-notes modal loads on demand; the
  initial payload drops from 367 KB to 269 KB gzipped.
- **Math and raw HTML load on demand.** The KaTeX pipeline and rehype-raw's
  HTML parser are now lazy modules that a message loads only when it
  contains a `$` delimiter or raw HTML is allowed (notes). The shared
  markdown chunk shrinks from 88 KB to 47 KB gzipped.
- **Compressed, cacheable assets from the built-in server.** Hashed bundles
  under `/js/` and `/assets/` are brotli- or gzip-compressed once per process
  and served with a one-year `immutable` cache lifetime, while `index.html`
  and the service worker are `no-cache` so a new release is picked up on the
  next load. Self-hosters without a compressing reverse proxy no longer
  download raw bytes on every visit, and the service worker now caches the
  `/js/` chunks it had been skipping.
- **Cleaner production build.** The frontend targets ES2022, so noVNC's
  top-level `await` is emitted as-is without a build warning.

### 🐛 Bug Fixes

- The tool picker in the composer stays inside the chat pane: it is capped to
  the space above its button, its option list scrolls, and the enable toggle
  and approval hint stay pinned. It previously ran off the top of the screen
  under the tab bar with a long tool list.
- Artifact and Work preview sandboxes no longer emit a Content Security
  Policy source browsers reject (`http://[::1]:*` has no valid CSP form),
  which had logged an error on every render in development.
- The three-replica team platform drill no longer fails when the gateway's
  round-robin cursor resets between issuing and consuming a WebSocket ticket.

### 🔒 Security

- Dependency audit: `qs` 6.16.0 (array-limit bypass via bracket-key comma
  parsing) and `@humanfs/node` 0.16.8 (recursive copy following symlinks),
  plus the earlier `postcss-selector-parser` bump.
- Ollama endpoint normalization uses a linear trailing-slash walk with URL
  length caps instead of a regular expression CodeQL flagged as polynomial.

### 📚 Documentation

- Pro tips describe the instance default theme and the three-way toggle;
  the Docker guide notes that the server already compresses and caches the
  built frontend so a reverse proxy need not.

## [0.31.0] - 2026-09-01

Getting started stops assuming Ollama, and staying current stops hurting:
a first-run screen connects whatever you already use — a local runtime, your
own OpenAI-compatible server, or a cloud key — while stale browser shells
heal themselves after updates, years-old databases upgrade instead of being
refused, and Libre WebUI lands on Debian, Ubuntu, Arch, and the Omarchy
desktop.

### ✨ New Features

- **Connect your models at first run.** Setup ends with a new step (also
  replacing the dead-end "ollama pull" card on an empty chat): an Ollama
  card with live detection, a local-server card whose presets — llama.cpp,
  vLLM, llama-swap, LM Studio, mlx-lm — share one flow with a server-side
  **Test connection** probe that lists the discovered models before
  enabling the provider, and a cloud card (OpenAI, Anthropic, Groq,
  OpenRouter, Gemini, Mistral) that takes an API key and connects.
  Skipping is a respected answer; non-admins are pointed to their
  administrator. Translated into all 25 languages.
- **Ollama is a setting, not an assumption.** Administrators can disable
  the Ollama provider entirely from the access page — no more health
  probes, reconnect polling, or "Ollama is not available" toasts on
  plugin-only installs — and point the endpoint at any Ollama-compatible
  gateway, local or remote. Disabling from the first-run screen is one
  click; everything re-enables just as easily.
- **Native Linux packages.** Every release now builds Debian/Ubuntu
  packages (amd64 and arm64) with a hardened systemd service and a
  dedicated system user, plus an Arch Linux PKGBUILD, from the new
  `linux-packages` repository — each package install-tested against the
  live health endpoint before publishing.
- **Omarchy bar plugin.** Libre WebUI ships a verified plugin on the
  Omarchy marketplace: server status, health, and latency in the bar, with
  one-click launch as a web-app window. Documented on the docs site.

### 🔧 Improvements

- **Follow-up messages just run.** Sending the next instruction to a Work
  task no longer demands stopping a preview the agent left running — the
  preview stops gracefully and the run starts, the same way the agent
  manages it mid-run.
- **A file manager in the Work computer.** Thunar sits in the sandbox dock
  between the browser and the terminal.
- **Development networking.** API and WebSocket traffic use Vite's
  same-origin proxy in development, so `npm run dev:host` works from
  another device without exposing the backend port; production origin
  policy stays strict.

### 🐛 Bug Fixes

- **Updates can no longer strand a stale browser shell.** The service
  worker cache is keyed to each release and clients recover automatically
  when a cached page requests a chunk a newer deployment removed —
  previously that failed dynamic import silently blanked part of the page.
- **Old databases upgrade again.** Ledger-less SQLite databases from
  releases that predate the `system_settings` and `personas` tables were
  refused at startup as incompatible; the bootstrap now recognizes them as
  upgradable history, creates the missing tables, and adopts the migration
  ledger — proven by a regression test that walks a pre-`system_settings`
  database end to end.
- **Unanswered takeover requests keep the screen alive.** Asking to take
  over no longer races the sandbox teardown: the screen session holds
  through the request plus a fifteen-minute grace window, so a late click
  lands on the blocked page instead of a fresh start screen.

### 🔒 Security

- The Omarchy plugin's health probe is byte-capped at the producer
  (`--max-filesize` plus a hard pipeline ceiling) with the URL passed as a
  positional argument — reviewed and verified by the marketplace's
  security process.

### 📦 Dependencies

- Routine minor and patch bumps across 15 packages, including axios,
  TanStack Query, and the AWS SDK; plotly.js moves to 4.0 for artifact
  charts.

## [0.30.0] - 2026-08-29

Hired agents become governable and connected: approve their risky actions
before they run, let them delegate work to each other with @-mentions, fire
routines from external systems through webhooks, and hand agents the same
MCP and OpenAPI tool servers chat already uses — all without giving up
per-agent sandboxes.

### ✨ New Features

- **Approve actions before they run (Auto Review).** When a Work policy
  requires review — or an agent's new Auto Review switch is on — the run
  pauses before `run_command`, `computer_act`, `delete_file`, `move_file`,
  or a delegation and shows a decision card in the conversation: **Allow
  once**, **Always allow**, or **Deny**. Always-allow persists a scoped
  rule (the command's program for shell commands, the one target for
  delegation), listed and removable in the Agent tab; denial reaches the
  model as an answer, never a silent skip; an unanswered request expires
  after five minutes and the run hands off as **Needs input**. Pending
  approvals notify (in-app and push) and every decision lands in the
  security audit log. Ships with schema migrations (SQLite v28 /
  PostgreSQL v27).
- **Agents delegate to each other.** Type `@` in the Work composer to
  mention another hired agent, and agents carry a peer roster with a new
  `message_agent` tool. Delegation is asynchronous message-passing between
  separate sandboxes: the target runs in its own task (its conversation
  shows **Delegated by** the sender) and its report is delivered back into
  the delegating conversation — mid-run if the delegator is still working,
  as a waiting message if it is idle. Delegated runs cannot delegate
  further, busy targets refuse honestly, and a report never auto-starts a
  run, so agents cannot ping-pong each other.
- **Webhook triggers for automations.** An external system — CI, a cron
  service, home automation — can now fire an automation with a POST and a
  per-automation secret. The secret is generated in the edit dialog, shown
  exactly once, stored only as a hash, compared in constant time, and
  rotatable; a paused automation refuses external fires. Webhook fires use
  the same manual-run path as Run now, so history, settling, and
  notifications behave identically. Ships with a schema migration (SQLite
  v29 / PostgreSQL v28).
- **Connected tools for Work agents.** Agents can call the MCP and OpenAPI
  tool servers configured under Settings → Tools, through the same
  hardened backend gateway as chat (SSRF-guarded egress, per-user
  credentials, size and time caps) — never from inside the sandbox.
  Offline tasks offer none, servers missing a personal credential are
  filtered out at offer time instead of failing mid-run, persona
  tool-server bindings scope what a hired agent sees, and tools the server
  classifies as side-effecting pause behind Auto Review while read-only
  tools run free.

### 🔧 Improvements

- Finished Work runs show a **run summary**: rounds, tool calls,
  screenshots, safety fences, verification verdicts, and recovery nudges,
  plus why a run handed off early — live, after reconnects, and on
  persisted handoff messages.
- The chat composer's dictation now runs on the same engine as the Work
  composer, keeping the transcription-source picker (browser speech or a
  named provider model) while removing a duplicated recorder
  implementation.

### 🐛 Bug Fixes

- Migrating a SQLite deployment to PostgreSQL no longer silently drops the
  Work policy columns for the Work Computer and screen-takeover settings —
  or any of the newer policy and task fields — during import.

### 🌍 Translations

- 35 new interface messages across all 25 shipped languages for action
  approvals, Auto Review rules, agent mentions and delegation labels, run
  summaries, and webhook management.

### 📚 Documentation

- The Workspaces guide covers action approvals, delegation between agents,
  and connected tool servers, with the API table brought current; the
  Automations guide documents webhook triggers with a copy-paste example;
  the chat tools guide notes the shared Work boundary; the notifications
  reference lists the approval notification type.

## [0.29.0] - 2026-08-28

Personas can now become persistent Work agents: hire one into a pinned sidebar
identity, revisit its screen and taught skills, schedule routines inside its
existing workspace, and receive notifications when it finishes or needs
attention. Model curation gains persistent stars, while Work gets dictation,
direct file shortcuts, and a calmer, more reliable computer sandbox.

### ✨ New Features

- **Hire personas as named Work agents.** Choose a persona when creating a Work
  task and it becomes a persistent agent with that persona's name, avatar, and
  instructions. Agents stay pinned above one-off tasks, show concise status and
  unread activity, and remain available in the compact sidebar.
- **A home for every agent.** The new Agent tab combines identity, a live
  view-only screen thumbnail, scheduled routines, and taught skills. Routines
  run inside the agent's existing conversation and workspace instead of
  creating a fresh task, while completion, attention, and takeover
  notifications link directly back to the agent. Ships with schema migrations
  (SQLite v25–v27 / PostgreSQL v24–v26).
- **Star important models.** Administrators can star models in the shared
  catalog, placing favorites first in both the catalog and default-model
  picker. Several stars follow most-recently-starred order, and removing one
  restores its manual or provider position.
- **Dictate Work instructions and open results directly.** The Work composer
  now accepts browser speech recognition or configured speech-to-text, and
  files created or moved by an agent appear as clickable chips that open
  directly in the workspace editor.
- **A living Work Computer start page.** The sandbox desktop gains an offline,
  time-aware Sunset Valley scene and built-in, checksum-verified blocking for
  ads, trackers, and cookie-consent banners.

### 🔧 Improvements

- Persona identity now carries through model selectors, header chips, and
  assistant replies in both Chat and Work, with consistent avatar presentation.
- Settings → Model is now **Defaults**, separating model defaults and catalog
  curation from the **Models** manager. The existing bulk Ollama updater now
  lives with the installed-model controls, reports per-model progress, and
  refreshes the list when it completes.
- The persona editor now uses one clear Save action, stays open after the server
  confirms a create or update, and shows an accessible saved state.
- Tool-server save and refresh failures now show the backend's specific reason
  instead of a generic error.
- Recommended starter models and hardware guidance now reflect the Gemma 4 and
  Qwen 3.8 lineups rather than the older 2024 suggestions.

### 🐛 Bug Fixes

- Persona-backed replies resolve the persona's display name instead of exposing
  its raw identifier in model-trigger UI.
- Work Computer runs no longer fail when a provider rejects screenshots: the
  run switches to text-only observations, records the degradation, and
  continues.
- The animated start scene renders as time-keyed stills so it remains
  responsive under the GPU-less SwiftShader sandbox, with improved
  initialization and the existing PNG fallback retained.
- Containerized backends now reach Docker-published Work preview, screen, and
  audio ports through the configured host address, including working Docker
  Desktop defaults.
- Work Computer audio now loads its processor from a same-origin asset, fixing
  playback under the production Content Security Policy.
- The cross-replica replay drill now seeds current event timestamps so retention
  cannot remove fixtures during its assertion.

### 🌍 Translations

- Added 89 localized interface messages across all 25 shipped languages for
  agents, routines, model starring, Work file links, startup and OAuth errors,
  chat actions, uploads, settings, model operations, and portable archive
  import/export.
- Previously hardcoded toast messages now use the translation catalog, and
  portable archive parse failures expose stable error codes for localized
  validation.

### 🔒 Security & Dependencies

- Container builds now refresh the runner stage without reusing stale
  OS-package layers, ensuring current Alpine and OpenSSL fixes reach security
  scans and published images.
- Refreshed AWS SDK, UUID, Framer Motion, i18next, Lucide, Mermaid, React
  i18next, Vite, and PostgreSQL type dependencies.
- Work Computer browser extensions are version-pinned and checksum-verified
  during image construction.

### 📚 Documentation

- Expanded the Work, Automations, and Notifications guides for hired agents,
  task-bound routines, unread state, Work notifications, content blocking,
  screenshot degradation, and Docker-published port routing.
- Updated model-management guidance for stars, the Defaults/Models split, bulk
  updates, and the current recommended model lineup.
- Refreshed the Work Computer screenshot and corrected documentation media
  metadata and demo links.

## [0.28.0] - 2026-08-23

Every Work task can now have a real computer. The Work Computer gives each sandbox a watchable virtual desktop with a browser: see the agent work live, hear its audio, take over the mouse for sign-ins, and teach it tasks by demonstrating them once on screen. Underneath, the agent's actions are verified rather than assumed — typing asserts its target field, batches stop when the screen changes under them, and outcomes are checked against declared expectations.

### ✨ New Features

- **The Work Computer.** A policy switch gives tasks a virtual desktop (window manager, dock, and Chromium on a 1280×800 display) with a live Screen tab: VNC over WebSocket behind one-use task-bound tickets, up to four concurrent viewers, and a browser profile that survives restarts. Administrators enable it with one click; the GUI sandbox image is now published ready to pull, and deployments behind a build-denying Docker proxy install it with pull + tag. Ships with schema migrations (SQLite v22–v24 / PostgreSQL v21–v23).
- **The agent drives it — with receipts.** New `computer_observe` and `computer_act` tools give the model eyes and hands, and every action earns evidence: observations carry the active window, page URL, focused element, and a screenshot hash; typing can assert its target field and fails closed when focus drifted; batches fence themselves when a window, title, or context changes mid-batch; clicks report whether pixels near them changed; `scroll_until` scrolls toward target text and reports whether it became visible; batches declare expected outcomes the runtime verifies with an adaptive deadline; and repeated no-effect actions end the run asking for help instead of burning its budget.
- **Take over the screen.** A cooperative, TTL-bounded control lease hands you the mouse and keyboard through a dual-password VNC session — watchers stay input-inert, credentials go from your keyboard to the page and never through the model, and the agent's own `request_takeover` posts a banner and waits. Policies decide whether takeover is allowed at all.
- **Teach it by demonstration.** Record a task once on the real screen: the demonstration compiles deterministically into a natural-language playbook — click targets named by an element anchor probe, secret-looking input redacted, and an allowed scope derived from the sites the demonstration actually visited. Playbooks save as ordinary skills, load into computer-enabled runs automatically, and collect a worked/failed track record from one-click reviews on finished runs.
- **Hear the computer.** Live audio passthrough from the sandbox over a second authenticated bridge — same tickets, same access re-checks as the screen.
- **Message the agent mid-run.** Send a note while a run is executing; the agent picks it up at its next step without stopping.
- **Automations can run Work tasks.** A scheduled automation can now target a Work policy and deliver its run as a Work task instead of a chat.
- **A replay benchmark for computer use.** `npm run bench:work-computer` drives the real GUI image through adversarial browser fixtures and scores the runtime guards — the regression baseline for future loop changes.

### 🔧 Improvements

- The agent's desktop is presentable: a branded start page in the product's own visual language, themed search, a dock with running apps and a clock, and wallpaper support.
- Loop telemetry: per-tool durations, rounds on every call, and a run-end summary of screenshots, fences, verdicts, and recovery nudges.
- The Work workspace pane gained the Screen view alongside Files, Activity, Changes, Terminal, and Preview.

### 🐛 Bug Fixes

- Containerized backends on Docker Desktop reach published Work ports through a dedicated dial address (`WORK_DOCKER_PUBLISHED_HOST`), fixing screens and previews on Windows and macOS container installs.
- Watching a screen no longer conflicts with the run that owns it in team deployments — and a run ending no longer stops a screen someone is watching.
- GUI containers no longer churn on every workspace refresh, and screen connections survive helper calls.
- Passkey sign-in accepts RS256 credentials, and the sign-in button hides when no accounts exist.
- The one-click Work Computer setup works in containerized installs and converges on an existing image behind filtered Docker proxies.
- Security hardening from two CodeQL passes, plus a migration-checksum false positive silenced without weakening the check.

### 📚 Documentation

- A complete Work Computer guide: screen, takeover, teach mode, audio, per-policy gating, and the agent's verified-action loop — with an embedded demo video of a real, unedited agent run.
- README, documentation landing page, environment reference, and the comparison page brought current with the release.

## [0.27.0] - 2026-08-22

Signing in gets serious — two-factor with recovery codes, passkeys, and a live password meter. The app now installs to your phone with real push notifications, knowledge ingests scans and audio, backups prove they restore on a schedule, artifacts get a proper split-screen panel, and the desktop app gets its real name.

### ✨ New Features

- **Two-factor and passkeys.** TOTP two-factor with one-time recovery codes, passkey (WebAuthn) sign-in, a per-role step-up policy administrators can require, and admin reset of a locked-out user's factors. Ships with a schema migration (SQLite v21 / PostgreSQL v20).
- **Install it like an app.** Libre WebUI is now an installable PWA with an offline shell, and notifications can reach your device through web push — riding the same durable notification inbox introduced in 0.26.
- **Knowledge reads scans and audio.** Images and scanned PDFs are OCR'd through the vision model, and uploaded audio is transcribed through speech-to-text, so screenshots, paper scans, and recordings become searchable, citable documents.
- **Backups that prove they restore.** Scheduled recovery drills restore a real backup into an isolated area on a cadence you set, verify the result, and measure actual RTO and RPO — so restore confidence is measured, not assumed.
- **A split-screen artifact panel.** On desktop, artifacts open beside the conversation instead of covering it, with a pin toggle that keeps the panel open while you chat, optional auto-open when a new artifact is generated, and compact chrome.
- **Pure-black AMOLED theme.** A true-black appearance mode alongside light and dark, with redesigned circular accent swatches.
- **Night-owl code theme.** Code blocks share one night-owl palette with line numbers across chat, thinking, and Work, rendered in a self-hosted JetBrains Mono — no external font requests.
- **Live password strength meter.** Setup, signup, and user management show strength and policy feedback as you type.

### 🔧 Improvements

- **The desktop app is now Libre WebUI Desktop.** Renamed from "Libre WebUI Frontend" across installers and Homebrew: the old cask tokens migrate automatically on upgrade, installer assets use the new name from this release on, and existing installs keep their data and sessions through the rename.
- Your chosen accent color now carries through approval cards, Work panes, the git panel, and the terminal instead of falling back to the default coral.

### 🐛 Bug Fixes

- Tool egress timeout and size caps are clamped defensively, so a malformed valve value can no longer disable the limits.
- Artifact previews stay inside the sandboxed panel; the open-in-new-window escape hatch was removed.
- Split-view polish: the artifact panel stacks below modals, inline previews collapse while the panel is open, and the composer stays compact beside it.
- The compact sidebar rail no longer renders unreadable session chips.

### 📚 Documentation

- Completed the 0.26 guide set, including new observability and notes guides, a refreshed documentation landing page, and updates across Kubernetes, SSO, web search, and monitoring docs.
- Added a factual, sourced product comparison page.

## [0.26.0] - 2026-08-20

Models that use tools under your approval, retrieval that cites its sources, channels and sharing for teams, hands-free voice conversations, image editing — and the cost controls, evaluations, observability, and high-availability certification to run all of it in production. Everything built since 0.25.0 lands here at once.

### ✨ New Features

#### Agents and tools

- **Models use tools, with your approval.** A chat can now run multiple tool rounds inside a single reply: the model calls a tool, reads the result, and continues — through Ollama and every OpenAI-style provider. Each call is shown as it happens, and side-effecting tools wait for your explicit approval before they run.
- **Bring your own tools.** Register any OpenAPI service or MCP server as a tool source; its operations become tools the model can call, with per-user credentials and an egress guard between the model and your network. A safe public demo preset is included to try the flow end to end.
- **Prompts, Skills, and Tools workspaces.** Saved prompts open from a slash menu in the composer; skills are folders of instructions and companion files the model can load on demand — write your own, or import from remote skill stores. All three live in the settings panel with starter templates, beside the model manager.
- **Knowledge tools with citations.** The model can list and read your documents mid-conversation, and its answers cite the exact source passages they came from.

#### Knowledge and chat

- **Richer document ingestion.** Word, PowerPoint, and Excel files extract with page, slide, and sheet provenance — with no new native dependencies — and re-uploading an unchanged file is detected instead of re-indexed.
- **Hybrid retrieval.** Keyword ranking (BM25) fuses with vector similarity, so exact identifiers and rare terms are found even when embeddings miss them. Because content stays encrypted at rest, ranking happens in memory over decrypted candidates the requester is allowed to see — there is deliberately no plaintext index on disk.
- **Answers cite their sources.** RAG replies carry source citations down to the page or slide, and a chat can attach a document in full-context mode when you want the model to read the whole thing.
- **Notes grow up.** Revision history with restore, file attachments, pinning, per-user sharing (view or edit), Markdown export, and an AI edit sidebar that previews every proposal as a diff — applying snapshots the previous version first, so any AI edit can be undone. The preview also renders inline SVG and basic HTML, sanitized.
- **Queue prompts while a reply streams.** Follow-up messages wait in an editable queue and send one at a time when the model finishes.
- **Ask several models at once.** A comparison fan-out sends the same message to additional models and labels each reply, so you can judge them side by side in the conversation.
- **Fork a whole chat.** Duplicate a conversation with its full history and provenance recorded, and take the copy in a different direction.
- **Search everything from the palette.** Cmd-K now searches across your chats, notes, and documents — scoped to what you can access, without a plaintext index.
- **An OpenAI-compatible API.** `/v1/chat/completions` and friends work with scoped API tokens, so existing OpenAI-style clients and SDKs can point at your instance for stateless inference.

#### Team collaboration

- **Channels.** Public, private, and direct-message channels with threads, reactions, and file attachments — and @model mentions that bring an AI reply into the conversation under the asking member's identity. Delivery rides the same durable event ledger as everything else; the database rows are the truth.
- **Share nearly anything.** Grant-based sharing for chats, personas, prompts, skills, and knowledge collections, per user, with view or edit roles. Shared knowledge answers retrieval queries for grantees immediately, and revocation is just as immediate.
- **A notification inbox.** Durable in-app notifications with live delivery, plus signed outgoing webhooks so other systems can react to events — envelopes are redacted and retried sensibly.
- **Calendars for more than one person.** Share a calendar with view or write access, color-code several of them, import and export ICS, and get single-fire reminders per occurrence. The model gains calendar tools, so an automation or chat can read and write events.

#### Voice and media

- **Hands-free voice mode.** A turn-based voice conversation: speak, the model answers aloud, and the turn returns to you — with an on-screen overlay showing exactly what state the exchange is in.
- **Voice governance.** Administrators set access modes for speech-to-text, text-to-speech, voice mode, and voice cloning independently. Saved voices carry a consent lifecycle — consent is recorded, revocable (the receipt is kept), and every transfer of voice data to a provider is receipted.
- **Edit images, not just generate them.** Inpaint with a mask, edit with an instruction, or composite multiple images — through the same approval and gallery flow as generation.
- **The gallery cleans up after itself.** An optional retention sweep removes old generated media, and long-running media jobs notify you when they finish.

#### Running it in production

- **Costs and budgets.** Versioned per-model tariffs price real usage, a cost analytics view breaks spending down, and hard budgets stop generation when a period's limit is reached — with alert notifications on the way there.
- **An evaluation platform.** Thumbs feedback on replies, blind arena battles between models with an Elo leaderboard computed from votes, and repeatable evaluation runs over saved sets — all admin-managed.
- **Observability you can plug in.** Structured JSON logs with request correlation ids and secret redaction, and an opt-in OpenTelemetry export speaking OTLP/HTTP with zero new dependencies — spans cover HTTP requests and durable jobs.
- **Certified high availability.** The Helm chart supports referencing an existing Secret instead of inlining credentials, ships optional NetworkPolicies for app and workers, and the three-replica failover drill that gates releases is now documented as the HA certification.

### 🔧 Improvements

- The Prompts, Skills, Tools, and Model Manager surfaces live inside the settings panel, reachable from the command palette.
- Every document picker shares one upload accept contract, so the accepted file types are identical everywhere and pinned by test.
- The frontend clears every react-hooks lint warning — imperative engines (like the voice controller) now live outside components by design.
- Schema migrations (SQLite v16–v20, PostgreSQL v15–v19) create the agents, notes, team, and media/enterprise tables; applied automatically on upgrade.

### 🐛 Bug Fixes

- **Lexical retrieval stops admitting junk.** A candidate must fully contain every part of at least one query word — compound identifiers no longer let two shared fragments smuggle an irrelevant chunk through rank fusion.
- **The v18 migration applies cleanly on upgraded databases.** A preflight check misread an index on a pre-existing table as missing schema and blocked the team migration.
- **Composer menus tell the truth.** Slash and skill menus work on the welcome screen, stay live while typing, and the tool picker reflects what is actually enabled.

### 🌍 Translations

- All new interface text across the agent, knowledge, team, voice, media, and operations surfaces — roughly 350 new keys — is translated in all 25 languages.

### 📚 Documentation

- New guides for tools and the tool gateway, skills, prompts, sharing, channels, notifications, team calendars, voice governance, image editing, costs and budgets, evaluations, observability, and the high-availability certification — plus worked examples for every tool, and honest boundary pages for what each system deliberately does not do yet.

## [0.25.0] - 2026-08-19

A calendar, and automations that use it: recurring events on a month or week grid, and scheduled AI tasks whose runs land in your chat list as ordinary conversations. Around them, web search that plans its queries before running them, a rebuilt command palette, and a round of persona and interface fixes.

### ✨ New Features

- **A personal calendar.** Month and week views with one-off and recurring events — hourly through yearly. A recurring event is stored once and expanded server-side, so editing it updates every future occurrence. Titles and notes are encrypted at rest with the same envelope used for chats and notes.
- **Automations: scheduled AI tasks.** An automation runs your instructions on up to five triggers and delivers each run as a normal chat session — a daily digest or a weekly review lands in your chat list, ready to be opened and continued like any other conversation. Runs go through the same durable generation pipeline as every chat — provider routing, persona defaults, and web search when it is enabled — with pause and resume, run-now, starter templates, optional in-app notifications when a run finishes, and a run history that tells failures apart from runs that stalled. The scheduler ticks once a minute behind a coordination lease, so exactly one replica advances schedules and each occurrence fires at most once; a server that was down fires the missed occurrence once when it returns. Automations project their upcoming occurrences and finished runs onto the calendar, and both pages appear in Explore on the home screen.
- **Web search plans its queries.** A chat message is rarely a good search query, so the session's own model first turns it into a few keyword queries, plus an optional freshness window and engine category. Every failure along the way degrades to the plain raw-message search this replaces, never below it. The results-per-search ceiling rises to 100.
- **A larger command palette.** Cmd-K opens centered, with fuzzy matching and the matched characters highlighted.
- **Pinnable admin shortcuts.** Administrators can pin admin pages into the sidebar footer for one-click access.
- **The About screen checks for updates.** It compares the running version against the latest published release and says which of the two is ahead, and gains links to reopen the release notes and to star the project.
- **Small comforts.** The settings modal is larger, and a new chat shows a spinner in the sidebar while its title is being written.

### 🔧 Improvements

- The sidebar and top bar share one continuous surface, text fields no longer draw a double frame when focused, the chat composer's icons align left like the new-chat composer's, and Work task rows use the same actions menu and hover preview as chats.
- A routing error now renders the branded error screen instead of a blank page.
- New schema migration on both backends (SQLite v15, PostgreSQL v14) creates the calendar and automations tables; applied automatically on upgrade.

### 🐛 Bug Fixes

- **Editing a message now rewrites the conversation on the server.** Edit-and-resend sent its truncation through a metadata update that silently ignores messages, so the server kept the entire replaced tail and the edit existed only in the browser. A dedicated truncate operation removes the cut messages for real, cancels any generation still writing into them, and keeps the prefix from the server's own copy so a stale client can never erase a newer reply.
- **Personas answer with the model they are built on.** A persona backed by a provider plugin now routes to that provider, its model default resolves to the persona's backing model, provider models are selectable as persona backends in the first place, and the home screen's continue list shows persona names.
- **A failed regenerate cleans up after itself.** The failed attempt is removed and the conversation resyncs with the server instead of drifting out of step.
- **A stray `h` no longer opens settings.** Single-letter navigation shortcuts require their modifier; the shortcuts help opens with `?`.

### 🌍 Translations

- All new interface text — the calendar, automations, the palette, the About screen, and the admin pins — is translated in all 25 languages.

### 📚 Documentation

- New guides for the calendar and automations, and the quick start, pro tips, and keyboard shortcuts pages catch up with the palette, the admin pins, and the current shortcut set.

## [0.24.1] - 2026-08-18

A correctness pass over the three systems 0.24.0 introduced. Compaction, the context meter, and the thinking levels now share one definition of what a conversation's context is — and each of them answers to the person using it: compaction can be refused or undone per conversation, the meter counts exactly what the next request sends, and a thinking setting never reaches a model that cannot honor it.

### ✨ New Features

- **A compaction can be refused, and undone.** Every summary now records exactly which messages it replaced, and an undo on the summary card restores them and removes the summary — chained compactions walk back one at a time. The chat controls panel can switch compaction off for a single conversation while the server-wide policy stays on.
- **The application knows which provider models reason.** Model discovery keeps reasoning support beside each model's context window: the listing's own answer where one exists, a maintained name-family table where it does not. The thinking control is hidden for models known not to reason, and the setting is stripped before a request reaches one — the provider-side twin of the local capability gate. Unknown models stay offered, exactly as before.
- **The meter measures the real window.** With compaction on, the "recent messages kept" count is now also the rolling window a conversation sends, so raising it genuinely widens what the model sees — and a narrow context-policy endpoint lets the meter mirror that number instead of assuming the default.

### 🔧 Improvements

- **The context meter counts the prompt that is actually sent.** It mirrors the server's message selection, so compacted history, abandoned branches, and turns outside the rolling window cost nothing — the ring no longer drifted upward without bound or rose after the very compaction that had just shrunk the prompt. The count anchors to the provider's last measured reply plus an estimate of what followed, instead of flipping between measured and estimated on every turn.
- **Token estimates price text and images honestly.** CJK characters count at roughly a token each rather than a quarter — a Japanese conversation no longer reads as a fraction of its real size — and images carry a flat per-image cost instead of counting as zero, identically on the server and in the meter. The compaction transcript notes attached images so a summary cannot silently erase that they existed.
- **The summary reads as what it is.** The compaction summary renders as a conversation-summary card at the point in the chat where the history was folded, and the summarized messages render dimmed: still readable, no longer sent. The card is not editable — its earlier edit path overwrote the global system prompt — and compacted turns no longer offer branch selection that would silently resurrect a message the summary already covers.
- **The summarizer behaves like part of the product.** Its transcript is bounded so it fits its own context window, template placeholders substitute literally, the conversation is framed as data rather than instructions, the session's provider binding travels with the call, pressing Stop reaches it, and its configuration is read from a short-lived cache instead of the database on every reply. The compaction configuration endpoint is admin-only in both directions, and a retried background generation reuses the first attempt's compaction instead of paying for another summarizer round trip.
- **Anthropic requests respect each model's output ceiling.** A thinking budget or an oversized token cap can no longer push `max_tokens` past what the model accepts; documented family ceilings bound both, and unknown families stay unclamped so a wrong guess can never truncate real replies. An explicit answer cap now shrinks the thinking budget into it rather than being silently raised.
- **Reasoning renders wherever it was paid for.** The Responses API asks for a reasoning summary so thinking is shown rather than only billed, Gemini requests thought summaries and routes them as reasoning with an output ceiling that holds the budget plus the answer, and Anthropic replies keep their thinking on the non-streaming path too.

### 🐛 Bug Fixes

- **Replaced summaries stayed in every prompt forever.** Deactivated system messages were still selected into the model context, so each compaction left one more stale summary riding along; they are now filtered exactly like deactivated conversation turns.
- **Persona conversations lost the summary entirely.** The persona prompt replaced all stored system messages, compaction summary included — pure context loss. The summary now survives beside the persona prompt, and the writers that update the leading system message can no longer overwrite a summary that happens to sit first.
- **The keep-recent boundary kept fewer messages than configured.** It extended forward to the next user turn and could summarize everything except the message just typed; it now extends backwards, so at least the configured count always survives, still starting on a user turn.
- **A conversation on an unresolved model read as full.** While the model list loaded — and for every agent conversation — the meter borrowed the 2,048-token application default and rendered a full amber ring; an unknown window now shows a dashed ring instead of a wrong one. Over budget shows red past the amber warning instead of being rounded down to exactly full, the ring is a real meter to screen readers, and token counts format in the reader's locale with bidi isolation.
- **Gemini thinking could consume the entire reply.** The thinking budget counted against an output ceiling that had not grown to hold it, so low effort on default settings returned empty replies at the token limit.
- **Reset to defaults now clears a saved thinking level** instead of leaving it behind while every other option reset.
- **A named thinking level no longer errors on models without named levels.** It degrades to plain "on", so a conversation that moves between models keeps working.
- **The thinking control tells the truth everywhere.** The composer button reflects the pinned or global default a conversation inherits, the chat controls panel shows the conversation's own choice with the inherited value named inside "Default", saving the panel no longer drops sibling session settings such as attached knowledge collections, and capability lookups stop firing for provider, persona, and still-loading models.
- **The compaction settings toggle no longer lies.** A rejected or invalid save leaves it in the server's state instead of visually flipped, and a failed configuration load says so instead of leaving the controls silently dead.

### 🌍 Translations

- All new interface text — the summary card, the restore action, and the per-conversation compaction control — is translated in all 25 languages.

## [0.24.0] - 2026-08-18

Control over how models answer, and a clearer view of what they are working with: a thinking level per chat, a context meter in the composer, an administrator model catalog, and long conversations that compact themselves.

### ✨ New Features

- **Set how hard a model thinks.** A control in the composer opens the reasoning levels (off, on, low, medium, high) for the chat you are in, on the new chat screen as well, and the same setting lives in the chat controls panel and in Settings → Generation as a default for new replies. One value travels with the chat and is translated at each provider boundary: Ollama takes it in the request body, OpenAI-style providers take a reasoning effort, the Responses API takes its own field, and Anthropic and Gemini take a token budget with room reserved for the answer. Nothing is sent when the setting is unset, so a model you never configure behaves exactly as before, and a model Ollama reports as unable to reason is never asked to. (#205, Zack Young)
- **See how full the context window is.** A ring beside the model name fills as the conversation grows; hovering it reports how full, the tokens used, and the window they run against. The count is what the provider measured for the last reply where it reported one, and an estimate at four characters per token before that, marked as an estimate. A window capped below what the model was trained for says so, which is what explains a 32k reading on a model trained for 262k.
- **Context windows for provider models.** Model discovery now keeps the context window a provider publishes with its listing, reading whichever field that provider uses, so the meter has something to measure against on hosted models and not only on Ollama. Catalogs stored before this release are refreshed once instead of waiting out their refresh interval.
- **Administrator model catalog.** Settings → Models gains a searchable catalog where administrators choose which models everyone sees, the order they appear in, and the name and picture each one carries. Hiding a model applies immediately, dragging shows where it will land, and a default model can be set for the deployment.
- **Long conversations compact themselves.** Past a token threshold, older turns are replaced by a summary that carries the goals, decisions, facts, and open questions forward, keeping a long chat inside the model's window instead of failing at it. Administrators control the threshold, the model that writes the summary, and the prompt.
- **Code blocks read like code while they stream.** Line numbers and syntax highlighting now apply to a reply as it arrives, rather than only once it has finished.
- **Model names and pictures in the chat.** The picker and each assistant message show the model's configured name and picture. A reply that is still streaming has no model stamped on it yet, so it shows the chat's own model rather than the generic word Assistant.

### 🔧 Improvements

- Titles and follow-up suggestions never spend a reasoning pass, whatever the chat is set to.
- The About screen names the mirror correctly as Forgejo and links to project sponsorship.
- The Vite configuration reads its own directory through `import.meta`, so builds no longer warn about an unsupported configuration feature.
- All new interface text is translated in all 25 languages.

### 🐛 Bug Fixes

- **Reasoning models can name a chat.** A model that thinks before answering spent its whole allowance on reasoning and returned empty content, so the chat fell back to a message preview for its title. Local models are asked not to reason for this, and providers that cannot be told that are given room to think and still answer.
- **A long reply no longer fails its durable job and regenerates.** Progress events carried the whole accumulated reply, so a long answer hit the durable event size ceiling and the interface responded by generating the same reply again. Completion events are bounded and oversized deltas are split across ordered events.
- **Token counts and timings appear for provider-backed replies.** Streams never asked for usage, so nothing was reported, and the timings llama.cpp returns beside the counts were dropped on the way through.
- **Work rounds that only reason keep their context and finish.** A round that produced reasoning and no visible text lost that context instead of completing with it.
- **The workspace file list retries quietly while a sandbox is preparing.** It used to report a failure for a sandbox that was simply not ready yet.
- Three interface render fixes: mount-time loaders no longer force a second synchronous render, a streaming code block no longer rebuilds and resets its scroll mid-stream, and the durable reload effect no longer misses a dependency.

### 🔒 Security & Dependencies

- Dependencies refreshed across the workspace: `@kubernetes/client-node` 2.0 (a major upgrade, with the Work Kubernetes driver verified against it), `framer-motion` 13.1, `katex` 0.18.4, `papaparse` 5.6, `zustand` 5.0.15, `tsx`, and `eslint-plugin-react-refresh`, along with AWS SDK and TypeScript ESLint updates resolved in the lockfile.

## [0.23.1] - 2026-08-16

Same-day fixes for 0.23.0, all found and verified on a live team deployment. Recommended for everyone, especially Work users.

### 🐛 Bug Fixes

- **The first message on a new Work task no longer fails with "This Work task is active on another replica."** Creating a task races the interface's file browser against the run itself: the file helper briefly holds the task's runtime lease while it prepares the sandbox, and the run used to give up instantly when it lost that race — killing the user's first prompt. The run now waits out transient lease holders (up to `WORK_RUN_LEASE_WAIT_MS`, default 60 seconds) before reporting a genuine replica conflict.
- **Tab menus draw above page headers.** The tab bar's right-click menu and the new-tab menu could render underneath the Work header and banners; both now render at the top of the page's stacking order.
- **A WebSocket hiccup during sign-in can no longer break app loading.** Signing in could kill a racing WebSocket connection attempt mid-handshake, and the resulting error aborted the entire post-login initialization — models and chats then failed to load. Superseded connection attempts are no longer treated as failures, sign-in re-dials atomically, and data loading proceeds even when the socket needs its own reconnect cycle.
- **Work previews can capture the mouse.** Previewed games and 3D scenes may now request pointer lock; it still requires a click and the preview keeps its isolated, opaque origin.
- **Chat reconnects no longer compete with sign-in traffic for one rate limit.** WebSocket tickets have their own rate bucket, and the general authentication bucket — which now also serves the session and API-key management screens — has room for real interactive use. Login and signup keep their strict limits.

## [0.23.0] - 2026-08-16

The trust release. Accounts get real sessions you can revoke, scoped API keys, administrator-managed groups, a sharing-grant foundation, sign-in with any OpenID Connect provider, and a security audit log — all working identically on SQLite and PostgreSQL deployments. Also fixes two Work bugs, including one that could take the whole server down.

### ✨ New Features

- **Sessions you can see and sign out.** Every sign-in now creates a server-side session bound into its token. Settings → Sessions lists each device with its sign-in method and activity; revoking one (or "Sign out other sessions") invalidates that token immediately on every replica and closes its live chat and terminal connections. Logout now really signs the token out instead of only clearing the browser.
- **Scoped API keys.** Settings → API keys mints personal tokens for scripts and integrations. Each key carries an explicit scope list (chat, models, documents, notes, personas, media, work, admin), is shown once and stored only as a hash, supports expiry, tracks last use, is rate-limited per key, and can be revoked at any time. A notes-only key cannot touch chats or administration, and session management is never reachable with a key.
- **Groups.** Administrators can create groups and manage memberships from the User Management page. Membership is evaluated live, so removing someone revokes group-granted access immediately. A new "effective access" view answers "why can this account access this?" — role, groups, feature access, and every grant that reaches the user.
- **Resource sharing grants (foundation).** One private-by-default grant model for chats, notes, documents, knowledge collections, folders, and personas: owners can grant read, write, or admin access to a user or a group through the new access API, and group-shared retrieval is plumbed all the way into vector search. Every access decision now flows through a single authorization service — the global admin role deliberately grants no access to other people's content. Sharing UI arrives in a later release; the machinery and API ship now.
- **Sign in with any OpenID Connect provider.** Keycloak, Authentik, Authelia, Okta, Entra ID, Google Workspace, and friends — configured with three environment variables. The flow uses PKCE, CSRF state, and a nonce verified inside the signature-checked ID token; identities link on the stable subject claim, so a renamed provider account keeps its Libre account. Optional policies: allowed email domains, admin-role mapping from a group claim, and per-login group membership sync.
- **Security audit log.** Sign-ins and failures, logouts, session and key revocations, and user, group, and grant changes are recorded in an append-only log that is separate from usage analytics. Details are redacted before storage — secrets and prompt content can never enter the log — and group/grant changes commit in the same database transaction as their audit event, so a change cannot exist without its trail. Administrators query it from the User Management page; retention defaults to 180 days.

### 🔧 Improvements

- Work, model download, web search, and agent access checks now flow through the same central authorization service as resource grants, with unchanged semantics.
- New schema migration on both backends (SQLite v14, PostgreSQL v13) creates the seven trust-foundation tables; applied automatically on upgrade.
- All new interface text is translated in all 25 languages.

### 🐛 Bug Fixes

- **A long Work response no longer crashes the server.** Work streamed each progress event with the full accumulated reply attached, so once a response passed 64 KiB the durable event log rejected the payload — and the unhandled rejection killed the process. Durable copies of delta events now carry only the delta, oversized payloads are bounded instead of rejected, and a durable append failure can never take a running task down — live viewers keep receiving events either way.
- **Work's Files pane works during runs on team deployments.** While the external worker was executing a task, the app replica could not acquire the task's runtime lease and answered file browsing with "This Work task is active on another replica." File helpers now attach to the running sandbox when the lease holder is the deployment's own worker.

### 📚 Documentation

- Authentication, single sign-on, and environment variable docs cover sessions, API keys, groups, grants, the audit log, and the full OIDC configuration reference.

## [0.22.1] - 2026-08-15

A same-day repair release for 0.22.0. If 0.22.0 refused to start after an upgrade with "Invalid platform storage encryption configuration", or the interface came up empty after signing in, this release fixes both — no manual steps needed.

### 🐛 Bug Fixes

- **Signing in no longer requires a page refresh.** On deployments with authentication, the app initialized once before login, marked itself done, and never loaded models, sessions, or plugins after the login landed — leaving an empty interface until a manual reload. Initialization now runs again the moment authentication completes.
- **Providers that start late appear without a reload.** If Ollama or the backend was still starting when the page loaded, the model list stayed empty forever. The app now quietly re-checks until a provider shows up, and re-checks a previously offline Ollama when the window regains focus — without polling forever on deliberately plugin-only setups.
- **Upgrades no longer fail on legacy key file permissions.** Installations whose `.encryption_key` was created by an older release carried default file permissions, and 0.22.0's hardened startup refused them outright — every such npx, npm, source, and Docker upgrade crashed on boot. Startup now tightens the key file to owner-only permissions in place when it is a regular, single-link file owned by the server user; symlinks, multi-link files, and files owned by someone else still fail closed. Startup errors also name the actual problem now instead of a generic line.
- **Brand-new provider models work as soon as the provider ships them.** Chatting with a model a provider had just released could fail with a generic error: the model picker shows the provider's live catalog, but the request resolved against the stored one. A missed lookup now refreshes a due catalog once before rejecting, which also covers team deployments where the external worker only sees the stored catalog.
- **Failed generations keep their real reason.** A crashed chat generation logged nothing anywhere — the durable job record kept only a sanitized summary. The worker now logs the underlying error before sanitizing, so a dead-lettered generation can actually be diagnosed.

### 🔧 Improvements

- **The jobs API is rate limited.** The durable jobs endpoints gained the same per-user shared rate limit as every other API surface.
- **Plugin upload cleanup hardened.** Temporary-file deletion now rebuilds its target from a validated relative path — the canonical containment pattern — instead of checking and deleting the incoming path.

## [0.22.0] - 2026-08-15

The largest release so far. Libre WebUI now scales past a single machine: a new team profile runs on PostgreSQL, Redis, and S3-compatible storage with external workers, while the solo SQLite setup stays the default and works exactly as before. Around it: speech input, voice cloning, a redesigned interface, real data portability, and integrated backup tooling. The local database schema migrates automatically on first start — back up your data directory before upgrading, as always.

### ✨ New Features

- **Team deployments.** A shared `team` profile brings PostgreSQL persistence, S3-compatible encrypted blob storage, PGVector document search, Redis coordination, and external durable job workers — with a ready-made Docker Compose stack and a Helm worker deployment. A packaged CLI migrates an existing SQLite database to PostgreSQL. Solo stays local-first on SQLite with an embedded worker; startup refuses mixed or half-configured profiles instead of silently splitting state. See the [Platform Foundation guide](https://docs.librewebui.org/PLATFORM_FOUNDATION).
- **Durable chat and media generation.** Generations now run as durable jobs with a replayable event stream: workers run concurrently, responses are recorded as they stream, Stop actually cancels the upstream provider request instead of letting it burn tokens, and accepted media jobs recover after a crash instead of vanishing. Old streams are pruned on a retention schedule.
- **Speech to text.** A microphone button in Chat transcribes voice into the composer. The browser's own speech recognition is used by default when available; otherwise recordings go to a configured provider with a speech-to-text capability, with explicit disclosure of where the audio is sent.
- **Voice cloning and natural speech playback.** LongCat AudioDiT joins as a local text-to-speech provider (a ready-to-run example server is included) with consent-based voice cloning: a reference recording plus its exact transcript, entered in Imagine → Audio. Cloned voices can be saved as encrypted, owner-bound profiles and reused for Speech playback anywhere. Playback itself got natural: phrase-aware batches generate through a look-ahead window and play in order, so speech starts before the full reply is finished.
- **Data portability.** Settings → Data Management exports a versioned per-user archive of your data and imports it into any Libre WebUI installation. Exports are verifiable and restorable — not a dump that only looks complete — and deleting a user account now sweeps every store the account touched.
- **Backup and recovery tooling.** A read-only recovery inventory reports what state exists and what would block a snapshot, and packaged maintenance commands produce signed, verifiable backups and restore them — for solo and team deployments alike. See [Recovery Readiness](https://docs.librewebui.org/RECOVERY_READINESS).

### 🔧 Improvements

- **Interface redesign.** The sidebar collapses to an icon rail with elevated New Chat and Work actions, Settings moved into a redesigned window with a searchable navigation rail, and both Chat and Work got a floating two-row composer. The whole app sits on a refreshed neutral palette with layered surfaces and an adaptive accent.
- **Security hardening.** Real-time connections authenticate with short-lived one-use tickets instead of query-string tokens, AES-GCM decryption enforces explicit authentication-tag lengths, the runtime Docker image no longer carries build-only npm tooling, replicas share coordinated rate limits, and a new Security workflow gates every push with static analysis.
- **Health probes.** Dependency-aware liveness and readiness endpoints report the actual state of the database, storage, and coordination backends, so orchestrators restart the right thing.
- **Capability contracts.** Every provider capability is now inventoried in a generated, test-enforced contract: schema, handler, client, UI action, documentation, and tests must agree before a capability counts as shipped.
- **Private deployments upgrade deliberately.** The app container is excluded from unattended replacement; upgrades are digest-pinned and manual, taken from a verified recovery point.
- **Notes are readable first.** Existing notes open in a read-only preview instead of the editor, and Markdown tables render as real tables across notes and chat instead of raw pipe-delimited text.
- **Helm grew up with the platform.** The chart validates its values against a published schema, deploys the external durable worker for team mode, and supports suspending a deployment by scaling it to zero.
- **TypeScript 7.** The whole project moved to the new toolchain.

### 🐛 Bug Fixes

- **Discovered OpenAI-compatible models failed at request time.** Model discovery accepted API roots while Chat sent them as complete operation URLs, so every discovered model 404ed unhelpfully. Standard roots are now composed with the correct path, custom operation URLs stay exact, and explicit plugin targets skip Ollama metadata probes.
- **Settings survived malformed provider data.** Image model and configuration discovery is awaited before responses serialize, and malformed model or plugin payloads are treated as empty collections instead of breaking the Settings page.
- **Speech playback no longer stalls on autoplay policies.** Audio output is unlocked before synthesis starts, so the first spoken reply plays instead of waiting for another click.

### 📚 Documentation

- **Six new guides**: [Platform Foundation](https://docs.librewebui.org/PLATFORM_FOUNDATION), [Data Portability](https://docs.librewebui.org/DATA_PORTABILITY), [Speech to Text](https://docs.librewebui.org/SPEECH_TO_TEXT), [Recovery Readiness](https://docs.librewebui.org/RECOVERY_READINESS), [LongCat AudioDiT](https://docs.librewebui.org/LONGCAT_AUDIODIT), and the generated [Capability Contracts](https://docs.librewebui.org/CAPABILITY_CONTRACTS) inventory.

## [0.21.3] - 2026-08-10

Documents attached to chats are finally manageable: see what is in a conversation's context, remove what should not be there, and delete collections with real feedback. Model pulls also stop pretending to succeed when they failed, and reasoning models no longer leak their deliberation into chat titles.

### ✨ New Features

- **Chat context documents are now visible and removable.** The docs chip above the message box opens a panel listing every document in the conversation's context — the chat's own uploads plus standing documents that join every chat — each with its size, scope, and a remove control. Settings → Documents gained the same power: an always-visible document library with per-document delete and collection assignment. All new interface strings ship in all 25 languages.

### 🔧 Improvements

- **Collection management got honest feedback.** Deleting a collection now uses an in-app confirmation instead of the browser dialog, which some environments silently suppress, and create, delete, and assignment failures surface as toasts instead of doing nothing. The assignment dropdown also reflects a document's saved collection now — the list API previously omitted it.
- **Complete social preview metadata.** The app shell now ships full Open Graph and social card tags, so shared links to a deployed instance preview richly everywhere.

### 🐛 Bug Fixes

- **Failed model pulls no longer report success.** Ollama reports pull failures as an error line inside a successful-looking stream, and the backend treated any stream end as completion — so a typo'd model name showed "pulled successfully" while installing nothing. Pull errors now surface with Ollama's real reason, and an interrupted download is reported as interrupted instead of complete.
- **Chat titles no longer leak model thinking.** Reasoning models could turn every session title into "The user wants a very short, ..." — their deliberation instead of a title. The title prompt now forbids thinking out loud, and the sanitizer strips tagged think blocks and rejects reasoning-shaped output, falling back to the message preview.

## [0.21.2] - 2026-08-09

The important fix: Work tasks on Ollama models broke with a 400 on every message after the first one that used tools; 0.21.2 repairs that, so upgrade if you use Work with local models. Alongside it, the Git tab in Work grew into a real diff manager, and this is the first Libre WebUI release carrying code from outside contributors.

### ✨ New Features

- **An IDE-grade diff manager in Work's Git tab.** Opening the tab now shows every changed file as a rendered diff: line numbers, per-file and total +/− counts, colored status letters, a filename filter, and dividers for skipped unchanged regions. Folded context in the turn diff expands in place, and untracked files display as fully added instead of hiding until staged.

### 🔧 Improvements

- **The desktop app moved to its own repository.** This repo no longer carries the Electron shell, its build tooling, or 149 packages of its dependency tree. Releases here dispatch the [desktop repository](https://github.com/libre-webui/libre-webui-desktop), which builds the installers and uploads them onto the same GitHub release, so download links and the Homebrew cask are unchanged.
- **End-to-end tests for pinned folders and chat drag-and-drop.** Sidebar foldering now has real browser coverage, including drag-and-drop moves. (#194, Rohit Babu)

### 🐛 Bug Fixes

- **Work with Ollama failed with a 400 on the second message.** Replaying the first turn's tool calls sent their arguments as JSON strings, the shape every OpenAI-compatible provider expects, but Ollama's native API requires objects and rejected the request. The Ollama transport now converts arguments at the protocol boundary. Streamed error responses are also read and parsed now, so an Ollama failure surfaces its real reason instead of "Request failed with status code 400".
- **Chat toasts now speak your language.** A batch of hardcoded English toast messages went through translations instead. (#192, Rohit Babu)
- **The app shell's social metadata caught up with the product.** Stale page description replaced and Open Graph tags added, so links to a deployed instance preview correctly.

### 📚 Documentation

- **Reverse-proxy WebSocket guidance.** Why chat streams fail behind nginx or Caddy and the exact upgrade, origin, and timeout settings that fix it, verified against the source. (#195, ColumbusLabs)
- **The desktop app guide is now user-facing.** Install per platform, approve the ad-hoc-signed macOS build, and connect to a local or remote server; build-from-source instructions left with the code.

### 🙏 Acknowledgements

First release with outside contributions. Thank you [Rohit Babu](https://github.com/BabuBahir) for the toast i18n fix and the Playwright e2e suite, and [ColumbusLabs](https://github.com/ColumbusLabs) for the reverse-proxy WebSocket documentation. Both are in [CONTRIBUTORS.md](CONTRIBUTORS.md) now.

## [0.21.1] - 2026-08-08

A small patch that matters if you start Libre WebUI with `npx`: deep links no longer fail, so the app actually loads past the home screen. Upgrading is safe in place; nothing else changed behavior.

### 🔧 Improvements

- **A one-time note on first start.** The very first backend boot prints a single line asking for a GitHub star if the project is useful. It never repeats (the flag persists in the local database), and nothing is transmitted anywhere.

### 🐛 Bug Fixes

- **`npx libre-webui` returned 500 on every page except the home screen.** npx runs the package from `~/.npm/_npx`, and the SPA fallback passed an absolute path containing that dot-directory to `sendFile`, which rejects dot-segments by design. Deep links — including the automatic redirect to `/login` — failed on every npx install. The fallback now resolves `index.html` against the frontend root, and a packaging test boots the packed tarball from a dot-directory and asserts deep links serve the app. Global (`npm i -g`), Docker, and desktop installs were never affected.
- **Search URL normalization no longer uses a backtracking regex.** The admin-supplied SearXNG URL had its trailing slashes stripped with an end-anchored regex that backtracks polynomially on a long run of slashes (flagged by CodeQL); it is now a simple character scan.

### 📚 Documentation

- **CONTRIBUTING.md.** Setup, project layout, PR expectations (25-locale key parity, license headers), and where to start — paired with a first set of `good first issue` tickets.

## [0.21.0] - 2026-08-08

Libre WebUI 0.21.0 adds self-hosted web search, repairs document retrieval (RAG) so every document in scope is actually used, and puts each dual-use capability behind an explicit administrator access control. Chat picks up long-requested quality of life: pinned chats, drag-and-drop foldering, message avatars, and a sources panel that shows exactly what fed each reply.

Upgrading notes: database migrations (the `pinned` session column and the new settings) run automatically at startup, and every new capability ships off or admins-only. Two defaults changed deliberately: **the Agents section (Libre Claw and agent CLI models) is now disabled until an administrator enables it** in User Management — or pins it with `AGENT_CLI_MODELS_ENABLED=true`, which is now tri-state (unset defers to the toggle) — and **the private deployment stack now requires `SEARXNG_SECRET` in `.env`** for its bundled search service.

### ✨ New Features

- **Self-hosted web search through SearXNG.** Administrators configure the engine in Settings > Search (URL, enable, live connection test, results per search 1-10, safe search). Chat gains a composer globe: results are injected as context before generation, so every model benefits — including small local models without tool calling — and replies show numbered source chips. Work tasks with network access gain a `web_search` tool whose result count is capped by the admin ceiling. The private deploy stack bundles an internal-only SearXNG service, and `SEARXNG_URL` pre-fills the endpoint.
- **Sources and documents panel.** Conversations show their evidence: every web source the replies drew on and every document retrieval used, plus the documents attached to the chat. A flat right rail on wide screens, a bottom sheet behind a compact trigger on smaller ones; per-message source chips persist across reloads.
- **Pinned chats and a session context menu.** Every sidebar chat gets a "..." menu — open in new tab, rename, pin, move to folder, archive, delete. Pinned chats sit in a Pinned group at the top and survive reloads.
- **Drag and drop chats into folders.** Drag a chat onto a folder header to file it, or onto a date-group label to take it back out.
- **Message avatars in Chat.** Assistant replies carry the Libre mark (or the persona's avatar); user messages show the account avatar — matching the Work conversation.
- **Welcome-screen parity.** The first-message composer gains the web search toggle and document attach (PDF/TXT/MD), so search and retrieval work from the very first message of a new chat.
- **Access controls for model downloads, web search, and agents.** User Management gains three cards beside Work access: Model downloads (open Ollama pulls and the Hugging Face browser to all users; administrators always can), Web search (same shape), and Agents (enable the Agents section, off by default). Each is a persisted mode enforced server-side on every request path and failing closed to admins-only.

### 🔧 Improvements

- Work policy editing rejects garbage numeric input instead of silently clearing limits, stores CPU limits normalized, anchors policy image references to a registry charset so nothing flag-shaped can reach the container runtime, bounds memory (6m-1024g) and workspace (up to 16Ti) magnitudes, and no longer rounds sub-minute idle timeouts in the edit form.
- Work access changes reach live sessions without a re-login: the interface re-checks on window focus and when a Work call is rejected.
- The System page Work panel shows its error with a retry instead of disappearing, reports zero terminal sessions as 0, and open clients converge after an idle-stopped preview.
- The Work task-actions menu renders above the workspace panes instead of hiding behind them.
- The Work policy picker refreshes when returning to the landing view and clears stale selections.
- Cleared every React set-state-in-effect lint warning; `npm run lint` is silent again.

### 🐛 Bug Fixes

- **Document retrieval (RAG) repaired across all chat paths.** The chat WebSocket path now honors attached knowledge collections exactly like the REST API; user-scoped uploads join every chat's searchable scope; documents whose chunks were never embedded surface through keyword scoring instead of staying permanently invisible (the "only my first document is used" failure); and keyword search takes over when nothing clears the similarity threshold.
- **Work agents keep their tool history across runs.** Chat-completions providers now persist tool calls for cross-run replay, so a follow-up run sees what was already built instead of re-reading every file; reasoning-only rounds are nudged back to work instead of silently ending the run; and the empty-response placeholder no longer re-enters model context.
- Added 68 translation keys that the interface referenced but no locale defined — command palette, tab strip, Work Git panel, model selector states, and the host workspace form — with real translations in all 25 languages.

### 🔒 Security & Dependencies

- The bundled SearXNG service is internal-only (never published to the host), runs with dropped capabilities and no-new-privileges, and search queries execute server-side with bounded result text and http(s)-only result URLs.
- Individual model pulls moved from hard-coded admin-only to a fail-closed persisted mode; every other model lifecycle operation remains strictly admin-only.

### 📚 Documentation

- New Web Search guide: setup with the bundled stack or any SearXNG instance, privacy and scope notes, troubleshooting.
- Agent CLI documentation updated for the disabled-by-default toggle and the tri-state `AGENT_CLI_MODELS_ENABLED`.
- Private deployment guide covers the SearXNG service and `SEARXNG_SECRET`; the environment reference gains `SEARXNG_URL`.

## [0.20.0] - 2026-08-08

Libre WebUI 0.20.0 introduces a major expansion of the Work sandbox system, headlined by an experimental Kubernetes runtime backend, named runtime policies, and idle-stop for unwatched sandboxes. This release also strengthens deployment security with Docker socket proxy isolation, adds an admin overview panel for monitoring all sandboxes, and allows per-user access control behind an admin setting.

Upgrading is safe in place: database migrations (the `work_policies` table, the `policy_id` task column, and the access-mode setting) run automatically at startup, every new capability is off or admins-only by default, and the per-task policy fingerprint is byte-compatible with the previous global fingerprint, so existing sandboxes are not recreated by the upgrade.

### ✨ New Features

- **Named runtime policies.** Admins can define named presets (image, memory/CPU/PID limits, workspace size, idle timeout, network default) from the User Management page and users pick one at task creation on the Work landing page. Policies are managed through `GET/POST/PUT/DELETE /api/work/policies` (reads open to Work users for the picker, mutations admin-only). Empty policy fields inherit the global runtime config, and the hardening profile (non-root, read-only rootfs, dropped capabilities, network isolation) is deliberately not a policy field, so a policy can never weaken the sandbox. Deleting a policy clears task references so those tasks fall back to global defaults on next recreation, and the per-task fingerprint means changing a policy recreates exactly the sandboxes running under it.
- **Idle-stop for unwatched sandboxes.** A new `WORK_RUNTIME_IDLE_TIMEOUT_MS` setting (default 0, off; also settable per policy) stops a running sandbox after a period of inactivity. Activity is a finished command, a terminal session ending, or an authorized request through the signed preview proxy. The sweep skips busy tasks (active command, attached terminal, running operation) while refreshing their clock, starts a first-seen sandbox's clock at the sighting, and stops idle previews through the real preview-stop path so admission leases release and task state updates. The workspace persists, so an idled preview simply restarts on next use. The private deployment stack now defaults this to 30 minutes.
- **Admin overview of every sandbox.** The System page gains a Work panel backed by `GET /api/work/admin/overview`: task inventory with owners across all users, live runtime state from one labeled listing, terminal session counts, preview state, admission headroom, pending recovery cleanups, orphaned containers, and the access mode, refreshing every 30 seconds. The endpoint is registered before the fail-closed gate so it stays readable exactly when administrators need it most, and per-task state degrades to "unknown" instead of failing when the runtime is unreachable.
- **Per-user access control.** Work remains admins-only by default, but a new persisted access mode (User Management page, `GET/PUT /api/work/access`) lets administrators open Work to all active users. Every check reads current database state, so mode flips or demotions take effect immediately across routes, terminal WebSockets, and in-flight runtime mutations. Host-folder workspaces remain admin-only in every mode because they bind-mount server paths.
- **Kubernetes runtime backend (experimental).** Setting `WORK_RUNTIME_BACKEND=kubernetes` runs Work sandboxes as Pods in a namespace with PVC-backed workspaces (a real per-task disk quota), on-demand Pods with the full hardening profile, exec transport for files/commands/git, and label-driven startup reconciliation. No Docker daemon or socket is involved. Configured through `WORK_K8S_NAMESPACE`, `WORK_K8S_STORAGE_CLASS`, `WORK_K8S_WORKSPACE_SIZE`, `WORK_K8S_POD_READY_TIMEOUT_MS`, and `WORK_K8S_POD_GONE_TIMEOUT_MS`; verified end to end on a kind cluster in CI under the exact namespace-scoped RBAC the Helm chart grants.
- **Terminal and preview on Kubernetes.** Interactive terminals ride the exec subresource as a TTY WebSocket with resize support. Preview targets the sandbox Pod IP, with the driver reporting a full endpoint (host + port) and the signed preview proxy accepting a per-task upstream host.
- **Work sandboxes via Helm.** The Helm chart supports `work.enabled=true` to switch the backend to the Kubernetes runtime, creating the sandbox namespace, a namespace-scoped Role/RoleBinding, and NetworkPolicies (default-deny, ingress from the backend on the preview port, egress for networked sandboxes minus private and cloud-metadata ranges).
- **Socket-isolated deployment.** Work no longer requires the raw Docker socket in the app container. Terminal and diagnostics speak the Engine API over a plain-HTTP `tcp:// DOCKER_HOST`, allowing a filtered socket proxy to hold the socket. Ships `docker-compose.socket-proxy.yml` with only the API sections Work uses enabled.
- **Startup container reconciliation.** Startup recovery now asks Docker once which managed containers exist and acts only on those: running containers of known tasks are stopped, exited ones are left alone, and labeled containers whose task row is gone are force-removed. Boot cost follows what is actually running instead of the task count.
- **Wider Turnstile, login footer links, npx @latest.** The verification widget takes the width of its block instead of a fixed 300px card. The login page's left panel links the website, docs, and kroonen.ai. Install commands now say `npx libre-webui@latest` so a cached older version is never started.

### 🔧 Improvements

- **Runtime driver seam for pluggable backends.** Docker CLI calls, Engine API terminal transport, and resource ownership verification move behind a `WorkRuntimeDriver` interface with `DockerWorkRuntimeDriver` as the default implementation. The runtime service retains all policy decisions (admission, leases, lifecycle locks, recovery bookkeeping, budgets) with zero behavior change.

### 🐛 Bug Fixes

- **Runtime driver split follow-ups.** Armed the Kubernetes exec timeout before WebSocket connects, gave the Kubernetes exec failure path its own `WORK_COMMAND_FAILED` code, retry the empty-inventory startup sweep for a bounded window (5 min) for late-starting socket proxies, report orphaned workspace PVCs during reconciliation, clear the preview proxy's per-task upstream host on stop/removal, accept Docker's two-letter memory suffixes in Kubernetes quantity translation, and block 100.64.0.0/10 by default in sandbox egress policy.
- **Over-long proxy bridge name.** The custom bridge name `lwui-dockerproxy` exceeded Linux's 15-character interface name limit, causing `docker compose up` to fail. The name was cosmetic and is now auto-assigned by Docker.
- **E2e probe output retrieval.** `kubectl run --rm -i` could miss the output of fast wget commands. The probe now creates the pod, polls for a terminal phase, reads `kubectl logs`, then deletes — deterministic on any runner.

### 🔒 Security & Dependencies

- Remediated npm security advisories for nanoid.
- Added `@kubernetes/client-node` for the Kubernetes runtime backend; it is loaded lazily so Docker-backed deployments never pay for it at startup.
- Sandbox egress NetworkPolicies now also block `100.64.0.0/10` by default, covering managed clusters that use the CGNAT range for pod and service networks.

### 📚 Documentation

- Documented the idle-stop default for the private stack.
- Added socket-proxy Work override guidance for the private deployment stack, including a new `docker-compose.work-proxy.yml` overlay that puts a filtered socket proxy on an internal-only network.
- Added a planning document for the Kubernetes runtime driver.

## [0.19.6] - 2026-08-07

`npx libre-webui` starts again, and the desktop app opens on a landing
page that helps you set a server up or reach the one you already run.

### ✨ New Features

- The desktop app opens on a landing page. The horizon film plays through
  once and settles on its still. Get Started asks where the server runs:
  on this machine, with a live check that hands over the Docker command
  and continues by itself as soon as the server answers — or on another
  server, reached by its address and remembered for the next launch.
  Switch Server in the app menu brings the page back, and the app's static
  pages now carry a strict content security policy.

### 🐛 Bug Fixes

- `npx libre-webui` starts again. The command installs only the package's
  own dependency list, and three packages the backend needs at runtime —
  `parse5`, `ipaddr.js` and `undici` — were declared by the backend
  workspace alone, so the server crashed the moment it booted. They ship
  with the package now, and a packaging test walks every import in the
  built backend against the published dependency list so this cannot
  happen quietly again.

## [0.19.5] - 2026-08-07

The generation settings shared by every model can be edited again. Saving them
had silently pinned whatever model the chat was on, which is why an output
limit set there came back the moment the model changed.

### 🐛 Bug Fixes

- The Generation tab in Settings reaches the shared values again. It saved to
  whichever model the chat happened to be on — and a model is always selected —
  so the values every other model falls back to could not be changed from the
  interface at all. The tab now says what it writes to: it defaults to the
  values every model shares, and pins to a single model only when that is
  chosen explicitly.
- A context size of -1 is never sent to Ollama. Settings saved while a hosted
  model was selected can carry `num_ctx: -1`, which hosted backends ignore but
  a local model would take as a real context size. There is no "unlimited"
  sentinel for the context window, so a non-positive value is dropped before
  the call.

### 📚 Documentation

- The repository landing page takes its layout from the documentation site.

## [0.19.4] - 2026-08-07

Models now run the way they ask to be run. Ollama models are started with the
parameters their modelfile recommends and the context they were trained for,
instead of one fixed profile applied to everything, and any value you change is
remembered for that model alone. The chat controls also open before a chat
exists, so a conversation can start the way you want it.

### ✨ New Features

- Ollama models run with the settings they recommend for themselves. The
  modelfile's parameters and the context length the model was trained for are
  read from the model and applied, instead of one fixed set of options used for
  every model.
- Generation settings are stored per model. Changing a value pins it for that
  model alone, and resetting returns it to what the model recommends.
- Chat controls can be opened before a chat exists. The system prompt and
  sampling chosen on the welcome screen are carried onto the session the first
  message creates.
- Keyboard shortcuts have their own tab in Settings, which `?` opens directly.
  The floating button and its dialog are gone, and the list now covers the
  command palette, new chats and Work sessions, message editing and the Work
  code editor — none of which the old dialog mentioned.

### 🔧 Improvements

- Chat controls show the value a message will actually run with, mark the ones
  that came from the model, and say so when a context window was capped to keep
  the model loadable.
- The Work landing screen sits in the same ambient glow as the chat welcome
  screen, so the two read as one surface.

### 🐛 Bug Fixes

- A value pinned for one model is no longer overridden on every request. Each
  message carried the application-wide generation options with it, and options
  sent with a request are the server's final word, so a model pinned to a longer
  output still stopped at the global limit. A message now carries only that
  chat's own overrides; the server applies the global settings, then what the
  model recommends, then what was pinned for it.
- A model no longer runs with a 2048-token context regardless of what it
  supports. The application sent that value explicitly, which overrode the
  model's own window and silently truncated anything longer — a model trained
  for 8k or 128k was capped at 2048. Adopted context is limited to 32768 by
  default so a very large window cannot stop the model loading; raise it with
  `OLLAMA_MAX_CONTEXT`.
- Stop sequences declared by a model are now sent with the request. Without
  them a model can carry on past the end of its turn.
- A model pulled from Ollama or HuggingFace can be selected straight away.
  Installing a model refreshed only the manager's own list, so the chat model
  picker kept showing the old one until the whole application was reloaded.
- Everything on the message bar sits on one centre line. The buttons, the model
  selector and the text row were three different heights, and an inline text
  area left a phantom line box under it, so the controls sat low against the
  text. On narrow screens the bar also grew before anything had been typed,
  because a wrapped placeholder counted towards the text area's height.

### 🔒 Security

- The js-yaml advisory (CVE-2026-59870) is remediated with a 4.3.1 override.

### 📚 Documentation

- The README screenshot is the current release, taken from the desktop
  application.

## [0.19.3] - 2026-08-06

Artifacts now run the way they are written. A generated React component, a
Three.js scene, a Mermaid diagram or a self-contained HTML page renders in the
chat with the libraries it expects already present, and the preview makes no
network request at all — which is what keeps artifacts working behind an
authenticating proxy. The brand mark also replaces the placeholder iconography
across the application.

### ✨ New Features

- React artifacts are compiled and mounted in the preview. JSX and TSX are
  transpiled in place, Tailwind utilities are generated from the markup, and
  the component mounts against a single shared React instance.
- Mermaid artifacts are drawn as diagrams instead of shown as source, themed
  with the application.
- Artifacts have a vendored library set: React and ReactDOM, Recharts,
  Chart.js, Plotly, D3, Three.js with its controls, loaders, environments,
  post-processing and exporters, Lucide icons, Lodash, MathJS, Papa Parse,
  Tone.js, Framer Motion and Mermaid.
- Generated HTML that loads a library from a CDN keeps working: the tag is
  replaced by the vendored build in the same document position, so inline
  scripts still find `Chart`, `d3` or `THREE` when they run.
- An artifact that asks for a library outside that set is told so in the
  preview, naming the file, rather than failing silently.
- The Li mark is used across application icons, the loading screen, the
  sidebar, the agent avatar and the login, signup and first-run screens.

### 🔧 Improvements

- The artifact sandbox makes no network request of any kind. The page loads the
  runtime with its own session and inlines it into the preview, which keeps
  artifacts working behind Cloudflare Access, Authelia or oauth2-proxy, where a
  sandboxed frame's cookie-less request comes back as a login redirect.
- The sandbox policy names no origin at all: `default-src 'none'`, script
  limited to inline and eval, and a frame without `allow-same-origin`, so an
  artifact runs on an opaque origin with no access to the application's
  cookies, storage or DOM.
- Artifacts get in-memory stand-ins for `localStorage`, `sessionStorage` and
  `document.cookie`, which throw on an opaque origin and would otherwise stop
  the artifact dead.
- Generated markup is parsed rather than pattern-matched, so documents without
  a `<head>`, end tags carrying attributes, and `<header>` elements are all
  handled correctly.
- Inter is vendored into the build and served by the application, so no page
  load contacts a font host; the font CDN is gone from the Content Security
  Policy, and artifacts linking Google Fonts get the local face instead.
- The theme script in `index.html` is allowed by hash rather than by opening
  the policy, so a saved theme applies before first paint without a dark flash.

### 🐛 Bug Fixes

- HTML artifacts render again. Previews were composed with `srcdoc`, which
  inherits the page's Content Security Policy, so every inline script an
  artifact contained was blocked in production.
- Runtime bundles are keyed to the build that produced them, so a browser
  cannot keep using a copy from an earlier release against newer application
  code.
- Three.js scenes get the addons they import, including environments, the CSS
  and SVG renderers, math helpers and exporters; a bundle is also inlined at
  most once, so Three is never loaded twice.
- Mermaid diagrams and CommonJS libraries resolve to their real exports rather
  than an empty namespace.
- Import maps and inline module scripts resolve from the local runtime, and
  TypeScript in a `text/babel` script compiles instead of failing on the first
  interface.
- The favicon is the same opaque tile as the documentation site, so it stays
  legible on a light browser tab.

### 🔒 Security & Dependencies

- Artifact code is embedded as data with every `<` escaped, so it cannot end
  the element it travels in. Reported by CodeQL as incomplete sanitization,
  along with a script end-tag pattern that missed `</script foo>`; both are
  fixed rather than dismissed.
- Removed SheetJS from the vendored set. The npm package carries a
  high-severity prototype pollution and ReDoS advisory with no fix available,
  which is a poor trade inside a sandbox that runs generated code. Papa Parse
  still covers delimited data.

### 📚 Documentation

- The artifacts guide describes the runtime, the library set, what happens to
  CDN references, and why the sandbox has no network access.

## [0.19.2] - 2026-08-05

Libre WebUI 0.19.2 sharpens the mobile experience and restores real-time
reasoning for plugin-backed models. Notes, sidebar navigation, tab menus, and
optional Android haptics now work more naturally on touch screens, while
OpenAI-compatible reasoning stays separate from answer text and is saved with
the conversation.

### ✨ New Features

- Added optional haptic feedback on supported Android browsers, with distinct
  patterns for selection, impact, success, and warning actions and a translated
  Appearance setting to turn it off.

### 🔧 Improvements

- Reworked the expanded mobile sidebar to use the available screen width and
  collapse into a readable recent-chat or Work-task rail with clear active
  state, labels, counts, and one-tap expansion.
- Replaced hover-dependent conversation actions with a touch-friendly mobile
  action sheet, kept conversation titles readable, and synchronized the active
  item with the route as soon as navigation begins.
- Improved the mobile Notes workspace with clearer editor and preview controls,
  responsive content sizing, and safer behavior when switching notes.
- Kept the new-tab menu inside the visible application area on narrow screens
  and added Notes to its destinations.

### 🐛 Bug Fixes

- Streamed OpenAI-compatible `reasoning_content`, `reasoning`, and structured
  `reasoning_details` as a live thinking block instead of revealing them only
  after the answer completes. Reasoning is persisted, restored across branches,
  and timed independently from answer generation.
- Kept `-dev` visible on development images across Home, Login, Settings, and
  backend version APIs by using the injected build version consistently in both
  frontend and runtime package metadata.
- Stabilized the browser E2E environment around development-version labels and
  the compact mobile Work surface so the full quality gate reflects the UI's
  intended overlay behavior.

## [0.19.1] - 2026-08-03

Libre WebUI 0.19.1 fixes a container startup regression in 0.19.0. The
production image omitted dependencies that npm installed inside the backend
workspace, causing the compiled server to exit when it could not resolve
packages such as `undici`.

### 🐛 Bug Fixes

- Copy the backend workspace's production `node_modules` tree into the final
  Docker image alongside the root dependency tree, and add regression coverage
  for non-hoisted backend packages.

## [0.19.0] - 2026-08-03

Libre WebUI 0.19.0 expands the chat workspace with reusable knowledge
collections, standalone notes, folders, per-chat controls, webpage attachments,
voice dictation, follow-up suggestions, message editing, response ratings, and
richer artifact tools. Agents gain OpenCode and Pi support plus explicit model
selection, Codex can use the server's ChatGPT sign-in for chat and Work, and the
Usage page now measures Ollama and agent activity across a full-year heatmap.

This release also changes important security defaults. A fresh installation
still permits its first local administrator, but later public registration is
closed unless explicitly enabled. OAuth tokens no longer travel in callback
URLs, Compose services bind more narrowly by default, fetched webpages and
artifacts cross stricter trust boundaries, and all five CodeQL findings opened
against the release candidate are fixed in code with regression coverage.

### ✨ New Features

- **Knowledge collections.** Create reusable document collections in Settings,
  assign existing or newly uploaded documents to them, and attach an entire
  collection to a conversation as one context source.
- **Standalone notes.** A dedicated Notes page supports creating, editing,
  deleting, searching, and previewing encrypted-at-rest Markdown notes.
- **Chat folders.** Create, rename, collapse, and delete sidebar folders; move
  conversations between them or return a conversation to the unfiled list.
- **Per-chat controls.** Override the system prompt, temperature, top-p, top-k,
  min-p, maximum tokens, repeat penalty, seed, and context length for an
  individual conversation, with reset controls and persisted session state.
- **Expanded attachment menu.** Reuse an existing document, upload a new file,
  attach a knowledge collection, or fetch a public webpage into chat context.
- **Voice dictation.** Browsers with the Web Speech API can transcribe speech
  directly into the message composer while preserving already typed text.
- **Follow-up suggestions.** After a completed assistant response, Libre WebUI
  can generate short, clickable suggestions for the user's next message.
- **Editable conversations and ratings.** Edit and resend a previous user
  message from that point in the conversation, and record a positive or
  negative rating on assistant responses.
- **Richer code blocks.** Long code blocks start collapsed and can be expanded,
  downloaded with a language-aware filename, or opened in the artifact preview
  when the language supports it.
- **Artifact history.** Navigate earlier and later versions of an artifact from
  the slide-out panel without leaving the conversation.
- **Reasoning duration.** Thinking blocks show elapsed reasoning time during
  generation and retain the final duration with the saved response.
- **Conversation navigation.** The sidebar groups chats by date, adds archiving,
  and shows conversation previews on hover; settings navigation is searchable.
- **What's New dialog.** A version-aware modal summarizes newly installed
  features once after an upgrade and records the version locally when dismissed.
- **OpenCode and Pi agents.** The Agents group detects `opencode` and `pi`
  alongside Claude Code and Codex. Pi runs statelessly with tools disabled and a
  neutral system prompt so chats do not use the server user's Pi configuration.
- **Explicit agent model selection.** Claude Code offers its default, Sonnet,
  Opus, and Haiku choices; Codex exposes its documented ChatGPT-sign-in models;
  OpenCode discovers provider models and requires an explicit selection instead
  of inheriting a possibly unreachable CLI default.
- **Codex through ChatGPT sign-in.** The bundled administrator-only Codex
  provider reuses the server's `codex login` session for chat and sandboxed Work
  tasks. The CLI's OAuth client refreshes tokens, credentials never enter task
  containers, and administrators can disable the integration with
  `CODEX_OAUTH_MODELS_ENABLED=false`.
- **Full-year usage activity.** The administrator Usage page adds a responsive
  contribution-style calendar for the trailing year, per-day tooltips and call
  totals, top-model coloring, an intensity scale, and a ranked model legend
  designed to remain distinguishable in both themes.
- **Ollama and agent metering.** Local Ollama calls now contribute prompt and
  completion token counts, while agent CLI turns contribute usage events, so
  the activity calendar and model tables cover local, plugin, and agent chats.

### 🔧 Improvements

- New interface strings for notes, folders, controls, attachments, dictation,
  usage, and related states are included across all 25 shipped locales.
- Added database indexes for per-user notes and session folders and enforced
  clear storage policies: at most 100 notes and 100 folders per user, 200
  characters per note title, 200,000 characters per note, and 120 characters
  per folder name.
- Upgraded both application workspaces to TypeScript 7 while keeping ESLint on
  an isolated compatible TypeScript compiler; expanded toolchain regression
  tests prevent the two compiler paths from drifting.
- Added focused regression suites for webpage fetching, HTML artifacts, OAuth,
  registration, password handling, public deployment defaults, content limits,
  agent chats, Codex OAuth, and usage analytics.
- Refined the project and Helm descriptions and keywords around Libre WebUI's
  local-first chat, private knowledge, artifact, agent, and Work capabilities.

### 🐛 Bug Fixes

- **Agent chat selection now retains provider identity.** Starting a chat with an
  agent, or switching an existing chat to one, no longer fails after the model
  selector drops the agent provider metadata.
- **Work model selection excludes agent CLI entries.** Agent pseudo-models stay
  in chat's Agents group instead of appearing as unusable Work provider models.
- **Codex streaming handles every supported caller path.** Responses streams
  without a content-type are recognized, non-streaming callers receive an
  aggregated result, and accumulated output is retained when a terminal event
  carries no final text.
- Refactored What's New initialization and document-list loading so the frontend
  passes the current React effect and Fast Refresh lint rules without warnings.

### 🔒 Security

- **Registration is closed by default after bootstrap.** A fresh database still
  permits exactly one local administrator, while every later local or OAuth
  registration requires `ENABLE_SIGNUP=true` and still enters the existing
  approval flow.
- **Password policy is enforced server-side and in the UI.** New passwords must
  contain at least 12 characters with uppercase, lowercase, and numeric
  characters, and cannot exceed bcrypt's 72 UTF-8-byte input boundary.
- **OAuth callbacks no longer expose bearer tokens.** GitHub and Hugging Face
  flows bind cryptographically random state to short-lived HttpOnly, SameSite
  cookies. The resulting JWT crosses through a 60-second Secure, HttpOnly
  exchange cookie that is cleared immediately instead of appearing in URLs,
  browser history, referrers, or reverse-proxy logs.
- **Safer Compose defaults.** The WebUI binds to loopback by default; bundled
  Ollama is no longer published to the host unless the new opt-in override is
  used; signup defaults to disabled; and the private deployment separates the
  root-equivalent Work Docker socket and Watchtower into explicit overrides.
- **SSRF-resistant webpage attachments.** Only HTTP(S) URLs without embedded
  credentials are accepted. Every resolved IPv4/IPv6 address and every redirect
  hop must remain public, DNS is pinned for the connection, redirects are
  bounded, fetches time out after 15 seconds, and response bodies are limited to
  2 MB.
- **Parser-based HTML extraction.** Webpage text now uses an HTML parser instead
  of filtering regular expressions, ignores script/style/template content, and
  decodes entities once. This fixes CodeQL alerts #119, #120, and #121 without
  introducing double-unescaping or malformed-markup bypasses.
- **Isolated artifact previews.** HTML previews open inside an opaque-origin
  sandboxed iframe without same-origin or sandbox-escape privileges. SVG
  artifacts also render in a script-free sandbox with a restrictive content
  security policy instead of using direct HTML injection.
- **Protected server Codex credentials.** User-writable plugins cannot reserve
  the bundled Codex provider ID or receive the server user's OAuth access token;
  only the bundled definition matching its trust anchor can use that route.
- **CodeQL cookie fixes.** The OAuth transfer cookie is always Secure and
  HttpOnly, resolving alerts #117 and #118 for clear-text transmission and
  client-side exposure of a sensitive server cookie.
- Added a public security policy with private GitHub/email reporting,
  coordinated-disclosure expectations, documented trust boundaries, supported
  versions, and a good-faith research safe harbor.

### 📦 Dependencies

- Refreshed 31 direct and transitive dependencies. Notable upgrades include
  better-sqlite3 13, TypeScript 7, Xterm 6, Vite 8.2, KaTeX 0.18, Playwright
  1.62, Electron 41.10.3, electron-builder 26.15.7, React type definitions,
  i18next, Framer Motion, Lucide, PostCSS, and TanStack Query.
- Raised the `brace-expansion` override from 5.0.8 to 5.0.9 to close the
  remaining denial-of-service CVE bypass path; `npm audit` reports no known
  vulnerabilities at release time.

### 📚 Documentation

- Updated quick-start, authentication, Docker, external Ollama, local GPU,
  environment-variable, development-branch, agent CLI, provider connection,
  and private remote deployment guides for the new registration and network
  defaults.
- Added Docker Hub publishing metadata with installation paths, image-tag
  semantics, architecture support, security notes, and canonical project links.
- Replaced certification-style compliance claims with precise regulated-
  deployment guidance: Libre WebUI can support local, private, or air-gapped
  controls, but the complete deployment and organizational process determine
  compliance.
- Clarified the project charter's no-relicensing examples, added the canonical
  security-policy link, removed the obsolete Hetzner GPU tutorial, and fixed the
  private Compose documentation link so it works outside the repository.

## [0.18.0] - 2026-08-02

Libre WebUI 0.18.0 closes the remaining unauthenticated API surface, puts new
registrations behind administrator approval, and gives administrators two new
views of the instance: live system diagnostics and provider usage analytics.
Work gains a guarded local Git panel, previews now work behind HTTPS and for
remote browsers, and OpenRouter models can generate video and audio.

API clients that called provider, document, persona, TTS, or embedding routes
without a token must now authenticate, the chat WebSocket requires a valid
token on connect, and model install/delete/copy/push is administrator-only.
Schema migrations run automatically on first boot — back up your database
before upgrading.

### ✨ New Features

- **Registration approval queue.** Public signups now wait for an
  administrator. New accounts land in a pending state, are told so at sign-in,
  and appear in a Pending approvals card in user management to approve or
  remove. Existing accounts are unaffected, and the first account on a fresh
  install still becomes the active administrator.
- **Public registration can be disabled entirely** with `ENABLE_SIGNUP=false`.
  The sign-up link disappears, direct registration and OAuth account creation
  are refused, and the setting is absolute: it also blocks first-administrator
  creation on an empty database, so a private install sets it to `true` once,
  behind its outer identity boundary, to bootstrap.
- **Cloudflare Turnstile on password sign-in.** When configured, the login form
  requires a solved challenge and the server rejects tokens whose hostname or
  action do not match what it expects.
- **System diagnostics.** An administrator-only System page reports host,
  runtime, memory, storage, network interfaces, and — when the Docker socket is
  available — engine details and container states, refreshing every 30 seconds.
- **Provider usage analytics.** Every outbound provider call is metered — model,
  status, token counts, duration — and charted on an administrator-only Usage
  page with per-model and per-plugin breakdowns over 7 to 90 days. Prompts,
  responses, endpoints, and credentials are never stored.
- **Video and audio generation.** OpenRouter models with media capabilities can
  generate video and audio jobs alongside images, tracked through a job
  lifecycle and collected in a unified media gallery with kind filters.
- **Default vision model.** A configured vision model takes over automatically
  when a conversation turn includes images, selectable under Settings → Models.
- **Guarded local Git panel in Work.** A Git tab in the workspace offers init,
  status with ahead/behind, bounded diffs, explicit staging, commits, and local
  branch switching — all inside the task sandbox. There is deliberately no
  clone, fetch, pull, push, remote, or credential surface.
- **Tab context menu.** Right-click a tab for close, close others, and close to
  the right; the `+` menu gains Incognito Chat and, for administrators, direct
  Users, System, and Usage entries.
- **Private remote deployment kit.** `deploy/private/` ships a hardened Compose
  file (no published ports, read-only rootfs, dropped capabilities, resource
  limits, Cloudflare Tunnel), sysctl and fail2ban configs, and a backup script
  with a systemd timer, documented end to end.

### 🔧 Improvements

- **Compact admin and media surfaces.** The density pass that reshaped chat in
  0.17.0 now covers the System, Usage, and media surfaces: tighter panels,
  denser tables, and a smaller stat scale.
- **Dark mode is the default for new installs.** A pre-hydration script applies
  the theme before first paint, so there is no light flash. A saved light
  preference is respected.
- **Work surfaces show your wallpaper.** The Work page and its panes are
  translucent instead of opaque.
- **Documents are owned per user** and carry their type, size, and session
  across restarts. Every document route requires authentication.
- **OpenRouter requests identify the app** through attribution headers, sent
  only to OpenRouter's own endpoint.
- **Removed the model install access setting.** Model install, delete, copy,
  and push now require an administrator regardless of settings, so the toggle
  no longer did anything; the interface no longer shows install affordances to
  non-administrators, and its endpoint was removed.
- New toasts introduced this cycle are translated across all 25 locales
  instead of appearing in English everywhere.

### 🐛 Bug Fixes

- **Work previews now work for remote browsers and behind HTTPS.** Previews are
  proxied through the app origin as signed, revocable URLs instead of pointing
  the browser at a loopback port. Stopping a preview revokes its URL, and
  upstream cookies and credentials never reach the embedded page. Custom
  reverse proxies must forward HTTP and WebSocket traffic for
  `/api/work/previews/`; `WORK_PREVIEW_HOST` is no longer needed and was
  removed.
- Settings, keyboard shortcuts, the command palette, and the artifact panel are
  no longer reachable from the sign-in screen, and are closed when a session
  ends.
- The Agents surface is administrator-only in the interface, matching the
  backend.
- An explicit saved-session link can now leave incognito mode instead of being
  trapped in a private chat.

### 🔒 Security

- **The remaining unauthenticated API surface is closed.** Provider, document,
  persona, TTS, embedding, Hugging Face, and agent CLI routes all require
  authentication; model install, delete, copy, push, and unload require an
  administrator.
- **The chat WebSocket requires a valid token** and an allowed origin on
  connect, re-verifies both on every message, and enforces payload and rate
  limits (`CHAT_WS_MAX_PAYLOAD_BYTES`, `CHAT_WS_MAX_MESSAGES_PER_MINUTE`).
- **Identity is re-read from the database on every request**, so a deleted
  account is rejected and a role change applies without waiting for token
  expiry.
- Generated encryption keys are no longer written to logs, and key files are
  created with owner-only permissions.
- Work's Git integration runs fixed argument lists as an unprivileged user with
  hooks, prompts, credential helpers, external diff drivers, and network
  protocols disabled, and refuses repositories that escape the workspace.

### 📚 Documentation

- A private remote deployment guide covering Cloudflare Access and Tunnel,
  bootstrap order, and the security model.
- Documented `ENABLE_SIGNUP`, the Turnstile hostname and action binding, chat
  WebSocket limits, and the Work production hardening checklist.
- A system monitoring guide covering the System and Usage pages: what each
  reports, what usage metering never stores, and the Docker socket trust
  caveat.
- A media generation guide covering plugin capability blocks, the video job
  lifecycle, the unified gallery, storage encryption, and rate limits.
- Documented the registration approval flow, the default vision model,
  incognito chat, the tab context menu, and the dark-by-default theme in the
  authentication, models, and tips guides.

## [0.17.0] - 2026-08-01

Libre WebUI 0.17.0 reorganizes the interface around tabs. Home is a launcher,
chats and Work sessions open beside it, and `Cmd/Ctrl + K` reaches anything you
have. Work gains an in-browser terminal and an optional host folder workspace,
and a coding-agent CLI already installed on the server can now answer in chat
without an API key.

### ✨ New Features

- **Tabbed workspace.** Chats, Work sessions, and pages open as tabs in a
  browser-style strip. The `+` menu creates each kind and shows its shortcut,
  tabs survive a reload, and closing a session closes its tab.
- **Home launcher.** A new Home tab greets you, offers what to start, and lists
  recent chats and Work sessions to continue, with a live badge for Work
  runtimes that are currently active.
- **Command palette.** `Cmd/Ctrl + K` searches chats, Work sessions, and app
  actions from anywhere, including while a message composer has focus, so a
  draft is never lost to navigation. `Cmd/Ctrl + Shift + O` starts a chat and
  `Cmd/Ctrl + Shift + U` starts a Work session.
- **Installed agent CLIs as chat models.** When `claude` or `codex` is on the
  server's `PATH`, administrators see an **Agents** group in the model selector
  and can hold a normal conversation using the subscription that CLI is already
  signed in with. The CLI runs as the Libre WebUI server user and inherits its
  agent credentials, so it is admin-only and can be disabled entirely with
  `AGENT_CLI_MODELS_ENABLED=false`.
- **Work terminal.** A real interactive shell attaches to the task's sandboxed
  container under the identical container policy as the model's own tools, so
  it is a human-facing view of the sandbox rather than a way around it.
- **Host folder workspaces for Work (opt-in).** A task can be bound to a real
  directory instead of its Docker volume. Requested paths are resolved through
  symlinks, checked against an allowlist of roots, and credential directories
  are refused. Off by default behind `WORK_HOST_WORKSPACES_ENABLED`, because it
  deliberately narrows the sandbox.
- **Concurrent Work runtimes** with complete file tools, plus a workspace diff
  view showing what the model changed in its last turn.

### 🔧 Improvements

- **Denser interface.** A compact pass across chat, the composer, and the
  sidebar: slimmer message bubbles with hover-revealed actions, a tighter type
  scale, and a narrower reading column.
- **Redesigned chat history rail** with a dense tick timeline and a compact
  hover preview of each turn.
- **Reorganized settings.** Nine flat tabs became four labelled groups —
  General, Chat, Speech & images, and Connections — with quieter navigation.
- **Compact sidebar.** Models, Personas, Imagine, and Agents collapsed from four
  stacked rows into a single icon row, giving the space back to the conversation
  list. All four remain reachable from Home, the tab menu, and the palette.
- **Renamed the Libre Claw surface to Agents** in the interface and translated
  it across all 25 locales. The daemon keeps its own name where the daemon
  itself is meant.
- **Redesigned sign-in page** with a brand pane that states what the project is,
  and social sign-in that no longer renders an empty divider when no OAuth
  provider is configured.
- **Stronger Work container isolation**, including a policy fingerprint that is
  re-verified before a container is reused so one predating a hardening change
  is recreated rather than reused.
- Removed the duplicate Chat and Work entries from the sidebar navigation.

### 🐛 Bug Fixes

- The sign-in form no longer shows an "or" divider when neither GitHub nor
  Hugging Face OAuth is configured.
- Deleting a chat or Work session now also closes its tab instead of leaving a
  tab pointing at a missing session.
- Resolved React `set-state-in-effect` and fast-refresh warnings in the new tab
  bar and command palette.

### 📚 Documentation

- Restructured the README around what the project is, how to run it, and then
  depth, with a documentation index and deduplicated deployment guidance.
- Added a guide for using an installed coding agent as a chat model.
- Documented host folder workspaces, the browser terminal, the tabbed
  interface, and the new keyboard shortcuts.
- Documented the workspace Changes diff view.

## [0.16.1] - 2026-07-31

Libre WebUI 0.16.1 makes Work usable when Libre WebUI itself runs in Docker,
and makes provider model catalogs keep themselves current. A model refresh now
reports what actually happened instead of always confirming success.

### ✨ New Features

- Work now runs when Libre WebUI itself runs in Docker. The image ships the
  Docker CLI and every repository Compose file mounts the host Docker socket
  with its group, so `docker compose up -d` provides a working Work runtime.
  Task containers run as siblings of the Libre WebUI container on the same
  daemon. This gives every Libre WebUI administrator root-equivalent control
  of the Docker host; remove the `/var/run/docker.sock` mount from the Compose
  file to disable Work.
- Added `DOCKER_GID` and `DOCKER_SOCKET` Compose variables for hosts whose
  Docker socket is not owned by group `0`, and `WORK_PREVIEW_BIND` and
  `WORK_PREVIEW_HOST` for deployments where the browser reaches the Docker
  host at another address.

### 🔧 Improvements

- Plugin model catalogs now refresh on their own. A catalog that is missing or
  older than the refresh interval is rediscovered when the plugin list is
  read, so reloading the app reflects the provider's current models. A
  per-plugin backoff avoids probing an unreachable provider on every request,
  and a deadline keeps a slow provider from stalling the response.
- **Refresh models** now reports its outcome: whether the catalog was updated,
  was already current, could not be loaded, or was never fetched because no
  usable API key was configured. A key set only in the environment is ignored
  for a provider that runs an installed definition instead of the bundled one,
  and the message now says so.
- An unreachable Docker daemon now names the deployment change to make — a
  missing Docker CLI, an unmounted socket, or a socket group the backend user
  does not belong to — instead of reporting only that Docker is unavailable.
- Speech, image, and embedding models discovered from a provider's catalog no
  longer appear in the chat model picker. They remain available to the
  pickers that use them.

### 🐛 Bug Fixes

- Fixed discovered model catalogs never expiring. Models were fetched once at
  activation and then reused indefinitely, so a provider's newer models never
  appeared after a reload.
- Fixed a model catalog refresh reporting success when it never reached the
  provider. A missing API key, an unreachable endpoint, or an empty response
  silently returned the previous catalog and still showed a confirmation.

### 📚 Documentation

- Added a Provider connections guide for the workspace introduced in 0.16.0.
- Documented running Work when Libre WebUI is itself in Docker, including the
  socket requirement, its security consequence, how to read the socket group
  id, and how to disable Work, across the README, quick start, Docker,
  external Ollama, GPU, dev branch, Kubernetes, troubleshooting, environment
  variable, and Work guides.

## [0.16.0] - 2026-07-31

Libre WebUI 0.16.0 makes third-party and self-hosted model services a
first-class provider workflow. It adds a dedicated Provider connections
workspace, OpenAI Responses and Image API support, reliable custom endpoint
and model discovery routing, and safer provider-scoped configuration across
Chat and Work.

### ✨ New Features

- Added a searchable **Provider connections** workspace under
  **Settings → Plugins**, with a provider list, selected-provider details,
  activation state, a read-only capability-aware model catalog, and explicit
  per-user **Refresh models** discovery.
  ([#173](https://github.com/libre-webui/libre-webui/pull/173))
- Added selectable **Chat Completions** and **Responses** API modes for
  OpenAI-compatible providers in Chat and Work. Completed and streamed
  Responses output now covers text, reasoning, refusals, tool calls, usage,
  and incomplete results.
  ([#168](https://github.com/libre-webui/libre-webui/pull/168))
- Added OpenAI Image API support with GPT Image models, provider-qualified
  image selection, an independent image endpoint, and authenticated generation
  and gallery flows.
  ([#167](https://github.com/libre-webui/libre-webui/pull/167))

### 🔧 Improvements

- Kept provider configuration and advanced generation controls collapsed by
  default. Inherited values now appear as blank provider defaults, only
  changed overrides are saved, clearing an override restores inheritance, and
  in-flight saves or model refreshes no longer overwrite newer edits.
  ([#171](https://github.com/libre-webui/libre-webui/pull/171))
- Allowed absolute HTTP endpoints for self-hosted gateways on trusted
  networks, including container and service hostnames, while warning that
  credentials and traffic are unencrypted and continuing to prefer HTTPS.
  ([#172](https://github.com/libre-webui/libre-webui/pull/172))
- Expanded pull-request gates to cover formatting, linting, TypeScript,
  package regressions, Playwright, cross-platform Electron packaging, and
  non-publishing amd64/arm64 Docker builds, including stacked pull requests.
  ([#170](https://github.com/libre-webui/libre-webui/pull/170))

### 🐛 Bug Fixes

- Fixed custom endpoint and Base URL overrides so the selected route is
  honored consistently across Chat, Work, model discovery, image generation,
  embeddings, and text-to-speech. Invalid explicit routes now fail instead of
  silently falling back to a bundled provider endpoint.
  ([#165](https://github.com/libre-webui/libre-webui/pull/165),
  [#168](https://github.com/libre-webui/libre-webui/pull/168))
- Made discovered model catalogs persistent and per-user, derived `/models`
  routes from the effective provider endpoint, and waited for activation-time
  discovery so the first refreshed catalog is current.
  ([#165](https://github.com/libre-webui/libre-webui/pull/165))
- Preserved exact provider identity in Chat when Ollama or multiple plugins
  expose the same model ID. Missing or inactive providers now remain visibly
  unavailable instead of silently routing to a different provider with the
  same model name.
  ([#165](https://github.com/libre-webui/libre-webui/pull/165))
- Bound Responses replay state to the same provider, model, endpoint, and
  credential, and stopped active Work runs before replaying tool state after a
  provider route or credential change.
  ([#168](https://github.com/libre-webui/libre-webui/pull/168))

### 🔒 Security & Privacy

- Isolated provider endpoints, credentials, discovered catalogs, and
  capability routes by user; custom routes cannot borrow a bundled environment
  credential, image and gallery routes require authentication, redirects are
  not followed, and malformed or non-HTTP(S) routes remain rejected.
  ([#165](https://github.com/libre-webui/libre-webui/pull/165),
  [#167](https://github.com/libre-webui/libre-webui/pull/167),
  [#168](https://github.com/libre-webui/libre-webui/pull/168))

### 📚 Documentation

- Expanded the model, plugin architecture, troubleshooting, environment,
  migration, self-hosted gateway, and Kimi Code guidance for provider
  configuration, URL precedence, Responses mode, image generation, model
  discovery, inherited settings, and container networking.

### 🙏 Thanks

- Special thanks to
  [ZhengJin (@fangzhengjin)](https://github.com/fangzhengjin) for the detailed
  third-party-provider feedback and AI-assisted UX concept shared in
  [#163](https://github.com/libre-webui/libre-webui/issues/163). That feedback
  directly shaped Responses API support, reliable custom Base URL routing and
  model discovery, OpenAI image generation, simpler collapsed provider
  settings, hostname-based HTTP gateways for trusted self-hosted networks, and
  the new Provider connections workspace inside **Settings → Plugins**.

## [0.15.1] - 2026-07-29

Libre WebUI 0.15.1 makes Work feel native to Chat, adds an efficient local
MLX LM route for Apple Silicon, restores the live Ollama catalogue, and
hardens provider execution and dual-remote release publication.

### ✨ New Features

- Added a bundled **MLX LM** plugin path for local Apple Silicon inference,
  including an OpenAI-compatible example server, plugin manifest, validation,
  settings integration, Work routing, tests, and setup documentation.

### 🔧 Improvements

- Reworked the Work landing page and composer around the shared Chat model
  selector. Work now retains provider-scoped model identities, presents the
  selected model consistently on desktop and mobile, restores keyboard focus
  correctly, and keeps remote-provider disclosure integrated with the
  composer.
- Unified Work conversation identities with Chat. User messages now use the
  authenticated account avatar with an initials fallback, while worker
  messages use the Libre WebUI assistant avatar and matching conversation
  spacing.
- Added verified GitHub-to-Forgejo release mirroring with tag-parity checks,
  idempotent single-release and backfill commands, dry-run support,
  GitHub-backed release assets, tests, and updated release documentation.

### 🐛 Bug Fixes

- Fixed non-stream plugin calls, including generated titles, accidentally
  inheriting a saved `stream: true` preference and then appearing empty or
  invalid to the JSON response parser.
- Fixed Work providers returning truncated or malformed tool arguments.
  Invalid arguments are now preserved as provider metadata, validated before
  any tool in the same batch executes, and returned to the worker as an
  actionable retry instead of risking partial tool execution. Worker guidance
  also keeps individual file writes below 8,000 characters.
- Restored the complete live Ollama catalogue after ollama.com changed its
  model-card markup. Libre WebUI now loads and deduplicates every available
  page, decodes descriptions and metadata, recognizes capability badges such
  as `thinking`, `vision`, and `embedding`, removes the 50-model display cap,
  and falls back to the curated catalogue only when the live response is
  unreadable.

### 📚 Documentation

- Added a complete MLX LM guide for Apple Silicon and usage instructions for
  the bundled example server.
- Updated plugin architecture and release automation documentation for MLX LM
  and the dual-remote Forgejo release workflow.

## [0.15.0] - 2026-07-27

Libre WebUI 0.15.0 introduces **Work**, a native, admin-only coding-agent
environment built directly into Libre WebUI. Every Work task combines a durable
conversation and exact provider route in SQLite with its own persistent Docker
named volume and an on-demand, disposable container for isolated execution.
Users can return to an older task and continue with the same files, history,
model route, and tool activity without requiring Libre Claw or another agent
daemon.

This release also adds real-time agent activity, built-in worker skills, a
complete responsive workspace interface, automatic application previews, cloud
and plugin model routing, full localization, and extensive runtime and API
hardening.

### ✨ New Features

- Added distinct **Chat** and **Work** actions in the primary sidebar, with the
  active mode visibly selected. Work tasks appear in the normal task list and
  retain their title, provider, status, conversation, run history, and files
  when reopened.
- Added a durable workspace for every Work task: ownership, messages, runs,
  errors, provider routing, and activity are stored in Libre WebUI's database,
  while project files live in a task-specific Docker named volume mounted at
  `/workspace`.
- Added a managed, disposable Docker container identity for each task.
  Containers are created, started, stopped, or recreated on demand while the
  named volume survives run cancellation, preview shutdown, container
  replacement, and Libre WebUI restarts.
- Added a native autonomous tool loop with `list_files`, `read_file`,
  `write_file`, `search_files`, `run_command`, `start_preview`, and
  `stop_preview`. Server-owned workspace skills guide project discovery,
  focused editing, verification, recovery, and preview use without writing an
  `AGENTS.md` or another control file into the project.
- Added explicit model routing for tool-capable local Ollama and Ollama Cloud
  models plus configured completion/chat plugins through OpenAI-compatible,
  Anthropic, and Gemini tool adapters. Provider type and plugin identity are
  persisted with both the task and each run so equal model names cannot
  silently switch routes.
- Added an authenticated, resumable server-sent event stream for live run
  state, assistant response deltas, provider-exposed reasoning, tool calls and
  results, usage data, loaded skills, errors, and completion. The interface
  shows active rounds, elapsed time, expandable tool details, generated-token
  usage or an approximation when provider usage is unavailable, and
  reconnection state.
- Added a complete Work interface with Conversation, Files, Activity, and
  Preview surfaces; a pointer- and keyboard-resizable desktop split; compact
  mobile surface controls; editable task titles; cancellation; paginated
  history; and direct task deletion.
- Added a theme-aware workspace code editor with light and dark syntax
  highlighting, LTR code inside RTL layouts, supported-file formatting,
  `Cmd/Ctrl+S`, optimistic save-conflict detection, per-file browser drafts,
  navigation protection, and responsive fallbacks for large files.
- Added managed browser previews that can be embedded or opened separately.
  With no custom command, Work detects root or nested `package.json`
  development scripts, handles Next.js host arguments, or serves a plain
  `index.html` through a bundled zero-dependency static server.

### 🔧 Improvements

- Raised the default provider-agnostic Work budget to 48 model rounds and
  derived a larger bounded tool-call budget. Exhausted runs now request a final
  no-tools progress handoff and finish as **Needs input**, allowing a later run
  to continue in the same workspace instead of exposing a raw
  provider-specific round-limit error or claiming false completion.
- Added a dismissible, per-user disclosure for plugin-backed and Ollama Cloud
  routes. It explains that autonomous work can make multiple billable requests
  and can send conversation context and requested tool results, including file
  contents, to the selected service.
- Added consistent **Idle**, **Thinking**, **Complete**, **Needs input**, and
  **Error** states across the Work page and sidebar, while keeping task
  positions stable as activity and timestamps change. Status colors are now
  white `rgb(255, 255, 255)`, blue `rgb(48, 121, 255)`, green
  `rgb(76, 212, 117)`, yellow `rgb(255, 204, 0)`, and pink
  `rgb(255, 61, 129)`, respectively.
- Removed the misleading Work network toggle and standardized UI-created tasks
  on Docker bridge networking. Runtime readiness now describes Docker and
  available model routes without implying that Ollama is always required.
- Replaced yellow and amber warning surfaces with the `#ff7b52` coral palette,
  retained compatibility with existing saved accent preferences, and aligned
  code rendering with the active light or dark theme.
- Localized the complete Work experience across all 25 supported locales.
  Arabic now uses a genuinely mirrored RTL layout for navigation, pane order,
  tabs, and resize behavior while code, paths, commands, model identifiers, and
  tool output remain LTR.
- Added configurable runtime image, Docker command, command timeout, output,
  memory, CPU, PID, preview-port, model-round, active-runtime, and task
  admission limits.

### 🐛 Bug Fixes

- Fixed static Work projects failing preview startup with
  `ENOENT: /workspace/package.json`. Empty preview commands now detect plain
  static sites and single nested applications instead of always attempting
  `npm run dev` from the workspace root.
- Fixed ambiguous or unsupported preview layouts returning misleading npm
  failures. Work now returns actionable errors and preserves explicit custom
  commands for other project structures.
- Fixed Kimi Code and Moonshot Work requests by omitting sampling fields that
  Kimi fixes internally, removing obsolete temperature and penalty controls
  from migrated provider definitions, adding `k3-256k`, and preserving provider
  reasoning metadata across tool-call turns. Upstream quota throttling may
  still return HTTP 429.
- Fixed selected Work tasks being difficult to delete, task rows changing
  position during runs, stale polling restoring deleted tasks, and Work/Chat
  navigation selecting the wrong mode.
- Made plugin settings surface structured provider error details instead of
  reducing responses such as quota failures to a generic HTTP status message.
- Fixed stale file reads and saves replacing the active file, edits typed
  during an in-flight save being lost, failed saves discarding drafts, and
  older editor revisions overwriting files changed by the model or another
  browser action.
- Corrected Work layout, code highlighting, formatting, resizing, status
  indicators, and keyboard behavior across desktop, compact, dark, light, and
  Arabic RTL modes.

### 🔒 Security & Dependencies

- Required current administrator authorization for every Work endpoint and
  enforced task ownership across tasks, runs, event streams, files, previews,
  and cancellation. Administrator demotion blocks further Work access
  immediately, and account deletion cleans up owned Work resources before
  removing ownership metadata.
- Hardened task containers with a pinned Node runtime image, non-root UID/GID,
  read-only root filesystem, bounded temporary storage, dropped Linux
  capabilities, `no-new-privileges`, CPU, memory, PID, command-time, output,
  and concurrency limits, and only the task-owned volume mounted at
  `/workspace`.
- Added managed-resource and task-ownership labels, path and symlink
  containment, atomic writes, optimistic file versions, lifecycle locks,
  startup reconciliation, graceful shutdown, and fail-closed cleanup retries
  so resources with conflicting ownership are not reused or silently deleted.
- Published previews only to a Docker-assigned loopback host port and embedded
  them in a separate-origin sandboxed frame without Libre WebUI authentication
  credentials.
- Added authenticated per-user and guest-IP rate limiting to plugin discovery
  routes, stricter mutation limits, and a pre-authentication burst guard.
  Hardened Work preview lease cleanup against unvalidated dynamic callback
  invocation reported by CodeQL.
- Restricted Electron preview navigation to valid HTTP and HTTPS destinations.
- Documented the remaining security boundary: Work containers share the Docker
  host kernel, UI-created tasks have bridge egress, volumes have no independent
  quota, and neither the Docker socket nor provider credentials are mounted
  into a task.

### 🚀 Deployment Notes

- Work requires Docker to be installed, running, and callable by the Libre
  WebUI backend user. Running Libre WebUI through `npx` does not install Docker;
  when it is unavailable, Work reports the runtime as unavailable and never
  falls back to running model commands on the host. Chat continues to work
  without Docker.
- The standard Docker Compose and Helm/Kubernetes configurations do not
  currently expose a compatible nested Work runtime. Electron uses its
  separately managed backend, while source, `npx`, bare-metal, and VM
  deployments can use Work when their backend has Docker access.
- Embedded previews are published on the backend's loopback interface. They are
  suitable for a local browser but are not currently forwarded to remote
  browsers when Libre WebUI runs on another server.
- Complete Work backup and recovery requires both Libre WebUI's SQLite/data
  storage and its labeled Docker workspace volumes.

### 📚 Documentation

- Added a comprehensive Work guide covering architecture, tools, providers,
  data disclosure, live activity, worker skills, container lifecycle,
  persistence, backups, previews, security boundaries, configuration,
  deployment support, localization, and troubleshooting.
- Updated the README, quick start, model, shortcuts, authentication, storage,
  Docker, Kubernetes, Electron, hardware, environment-variable, Libre Claw,
  plugin, Kimi Code, and troubleshooting documentation for the Work release,
  and refreshed the Work screenshot.
- Removed obsolete tracked `AGENT.md` and `AGENTS.md` instruction files and
  ignored the repository-root `AGENTS.md` so private workspace guidance is not
  committed accidentally.

## [0.14.3] - 2026-07-25

Libre WebUI 0.14.3 completes the migration to the patched React Router 8 line, aligns the frontend with React 19 and Node.js 22.22, and hardens the bundled Qwen and Kyutai text-to-speech examples against local-path injection and unsafe or pathological text processing. The release removes the temporary router advisory exception and restores a strict zero-vulnerability npm audit gate.

### 🔧 Improvements

- Migrated the browser SPA from `react-router-dom` 7.18.1 to `react-router` 8.3.0, updated all routing imports and Vite chunking, and aligned the frontend with React and React DOM 19.2.8 plus matching type packages.
- Raised the supported Node.js baseline to 22.22 across package metadata, Docker images, GitHub Actions, and installation and desktop documentation.
- Consolidated the React runtime and type dependency graph at the workspace root to prevent duplicate React installations and keep lockfile resolution deterministic.

### 🐛 Bug Fixes

- Replaced Qwen TTS's permissive emoji regular expression with explicit Unicode code-point checks that remove the intended emoji sequences without consuming CJK, Arabic, Indic, mathematical, or other astral text.
- Reworked Qwen and Kyutai Markdown-link and stage-direction sanitization as bounded forward scanners so malformed or adversarial input is handled without repeated rescanning or polynomial regular-expression behavior.
- Rejected local filesystem paths in Kyutai TTS voice references while preserving built-in voices and explicitly allowed remote references.

### 🔒 Security & Dependencies

- Upgraded React Router to 8.3.0 and `brace-expansion` to 5.0.8, refreshed ESLint and minimatch to patched lockfile versions, and removed the obsolete `react-router-dom` package.
- Removed the temporary router advisory exception and custom audit wrapper; `npm audit --audit-level=moderate` now fails directly on every applicable advisory.
- Added regression coverage for exact Unicode interval boundaries, multilingual preservation, multi-code-point emoji sequences, local-path rejection, nested or malformed markup, and inputs exceeding 100,000 characters across the Qwen and Kyutai TTS examples.

## [0.14.2] - 2026-07-24

Libre WebUI 0.14.2 adds Kimi Code and Claude Opus 5, brings native Anthropic streaming and tool events up to the current Messages API, repairs macOS and Homebrew installation metadata, hardens versioned Docker and Helm releases, and resolves applicable dependency advisories.

### ✨ New Features

- Added a bundled Kimi Code provider for Moonshot AI's OpenAI-compatible API, with Kimi K3, Kimi K2.7 Code, and Kimi K2.7 Code HighSpeed model profiles, streaming, configurable generation valves, and per-user or environment-based credentials.
- Added Claude Opus 5 to the bundled Anthropic provider catalog.

### 🔧 Improvements

- Aligned the Anthropic catalog and controls with the current Claude API: retained supported public model snapshots, removed the retiring Claude Opus 4.1 entry and unsupported penalty controls, corrected the legacy temperature range, and expanded the default token budget for adaptive thinking.
- Aligned Helm chart, application, and Docker image versions with each release; pinned the 0.14.1 transition to its verified multi-architecture digest while preserving explicit tag overrides; made subsequent Kubernetes deployments use the chart `appVersion`; and limited chart publication to releases whose default Docker image exists.
- Made the local release command run the complete format, lint, security, package, build, and npm publish dry-run gate before it creates a release commit or tag, and added regression coverage for release status, Docker tags, Helm rendering, Homebrew metadata, macOS artifacts, and packaged npm contents.

### 🐛 Bug Fixes

- Fixed Anthropic requests for Opus 5 and other current Claude models by omitting rejected sampling parameters, using the native Messages payload and version header while streaming, parsing Anthropic text and tool-use events, and discovering models from the correct `/v1/models` endpoint.
- Fixed the macOS DMG installation canvas so Finder exposes only Libre WebUI and Applications, embeds the Retina background inside the app, preserves its Finder alias, and uses correctly scaled artwork and icon positions.
- Repaired Homebrew packaging by installing the CLI formula from the published npm tarball, matching the cask to the actual arm64 DMG and application bundle, separating the `libre-webui` formula from the `libre-webui-frontend` cask, and clarifying explicit formula installation.

### 🔒 Security & Dependencies

- Updated `body-parser` to 2.3.0, `fast-uri` to 3.1.4, PostCSS to 8.5.23, and tar to 7.5.22, and enforced patched transitive versions of `brace-expansion` 5.0.7, `js-yaml` 4.3.0, and `shell-quote` 1.10.0.
- Pinned React Router to 7.18.1 and added a time-bounded, fail-closed audit exception for an unstable-RSC-only advisory that does not apply to Libre WebUI's declarative browser SPA; the gate rejects version drift, RSC usage, malformed reports, additional advisories, and registry failures.

### 📚 Documentation

- Added Kimi Code setup, membership-aware model guidance, privacy boundaries, troubleshooting, and the `KIMI_API_KEY` environment variable to the provider documentation.
- Simplified the public project stewardship language, removed an unnecessary third-party comparison from the Hetzner deployment tutorial, and documented version-pinned Kubernetes releases.

## [0.14.1] - 2026-07-16

Libre WebUI 0.14.1 corrects the macOS installer artwork introduced in 0.14.0 so Finder presents the complete branded layout at the intended scale, keeps packaging support files out of the installation canvas, and preserves valid update metadata after finalization.

### 🔧 Improvements

- Added native Retina DMG artwork with a 760×500 72-DPI representation and a 1520×1000 144-DPI representation for a sharp, correctly sized installer on standard and high-density displays.
- Strengthened macOS artifact verification to mount the finished DMG and validate its checksum, background format, dimensions, density, Applications shortcut, visible item count, Finder metadata, application identifier, and ad-hoc signature before CI uploads it.

### 🐛 Bug Fixes

- Fixed Finder enlarging and cropping the branded installer background because the generated PNG was encoded at 25 DPI instead of the expected 72 DPI.
- Marked the background, volume icon, and disk-image metadata as Finder-invisible so the installation window exposes only Libre WebUI and the Applications shortcut.
- Regenerated the DMG blockmap and release checksum metadata after Finder finalization so differential updates and `latest-mac.yml` continue to describe the published artifact exactly.

## [0.14.0] - 2026-07-16

Libre WebUI 0.14.0 adds a compact conversation history rail for navigating long chats and brings the Electron desktop experience closer to the main product aesthetic with reliable scrolling, valid ad-hoc macOS packages, and a purpose-built installer.

### ✨ New Features

- Added a desktop conversation history rail that maps each user turn beside the chat, lets readers jump directly to any turn, and previews the matching prompt and active assistant response on hover or keyboard focus.
- Added keyboard navigation for the history rail with arrow, Home, End, Enter, and Escape behavior, localized accessible labels across all supported languages, reduced-motion support, and mirrored placement for right-to-left layouts.
- Redesigned the macOS arm64 DMG as a 760×500 branded installation canvas with original artwork, the “Make whatever comes next.” identity, a clear Applications drag target, and the same editorial visual language as the website and documentation.

### 🔧 Improvements

- Made the history rail follow the reader dynamically while scrolling in either direction, keep the active marker visible inside long rails, resolve regenerated branches to the active response, and preserve the selected position while a newer response streams.
- Kept the rail available in compact desktop windows while intentionally removing it from mobile chat layouts where it would compete with the conversation.
- Standardized constrained scrolling across application pages, sidebar history, Settings, model selectors, plugin and Hugging Face browsers, image generation, persona switching, keyboard shortcuts, and user menus.
- Switched the application shell to dynamic viewport sizing, tightened nested flex layouts, added stable scroll regions, and increased Electron scrollbar width for easier pointer interaction.
- Expanded end-to-end coverage for rail navigation, manual scroll synchronization, branching, live streaming, Arabic RTL placement, compact desktop behavior, mobile visibility, and Electron-sized wheel scrolling at the minimum 800×600 window size.

### 🐛 Bug Fixes

- Removed the Electron preload rule that made the entire document draggable and could intercept page or menu scroll gestures; window dragging is now limited to the explicit title-bar surfaces.
- Fixed clipped or difficult-to-scroll Electron pages and dialogs by giving their actual content regions bounded height and native overflow behavior.
- Made unsigned macOS distribution builds structurally valid by applying an explicit ad-hoc signature with hardened runtime entitlements instead of producing an unverified application bundle.
- Added macOS artifact verification that checks the DMG checksum, mounted application bundle, identifier, and ad-hoc code signature before CI uploads the package.

### 📚 Documentation

- Updated the Electron desktop guide with the ad-hoc signing model, packaged-app verification command, safe Gatekeeper approval steps, quarantine removal for verified downloads, and the future Developer ID/notarization path.

## [0.13.4] - 2026-07-15

Libre WebUI 0.13.4 restores purpose-built code rendering throughout streamed responses, makes automatic titles reliable with reasoning-capable Ollama models, hardens the plugin API against abusive request volumes, and modernizes Electron packaging to remove deprecated dependency warnings.

### 🔧 Improvements

- Unified streaming and completed code behind the same accessible code-block component, with localized copy feedback, stable styling, and consistent dimensions as responses finish.
- Expanded syntax highlighting for C#, Go, Kotlin, PHP, Ruby, Rust, SQL, Swift, and YAML, including common language aliases.
- Made long streaming code blocks follow the newest output until the reader intentionally scrolls away.
- Added end-to-end coverage for live code rendering, CommonMark fence parsing, bare HTML documents, reader-controlled scrolling, code-safe LaTeX preprocessing, and title-generation request behavior.

### 🐛 Bug Fixes

- Fixed reasoning-capable Ollama models consuming the entire automatic-title token budget before producing visible text by disabling reasoning for title utility requests.
- Restored specialized code blocks as soon as generated code begins streaming instead of temporarily displaying code as plain text or exposing Markdown fence markers.
- Improved streaming parsing for incomplete and multiple CommonMark code fences, backtick and tilde fences, indented fences, variable-length fences, CRLF input, and unfenced HTML documents.
- Prevented LaTeX preprocessing from modifying fenced or inline generated code and removed the visual layout jump when a streaming code block completes.

### 🔒 Security & Dependencies

- Added an IP-based limit of 200 requests per 15 minutes to `/api/plugins`, applied before optional authentication to protect authentication, filesystem, credential-store, and plugin-enumeration work.
- Upgraded `electron-builder` to 26.15.6 and modernized its Electron packaging dependencies, removing the deprecated `inflight`, `glob` 7, and `boolean` packages that produced installation warnings.
- Added a package-lock regression test that fails when any dependency is marked deprecated.
- Raised the supported Node.js minimum to 22.12 to match the modern Electron packaging toolchain.

### 📚 Documentation

- Updated the README, Quick Start, troubleshooting guide, and Electron desktop build guide to document the Node.js 22.12 minimum.

## [0.13.3] - 2026-07-15

Libre WebUI 0.13.3 fixes automatic chat titles so generated summaries appear immediately in the sidebar, strengthens accent-adapted light themes while preserving the existing dark palette, and refocuses the project documentation around local-first operation, provider choice, and inspectable independence.

### 🔧 Improvements

- Strengthened the opt-in accent-adapted light palette so the selected color is clearer across the canvas, settings, composer, chat surfaces, and supporting interface states without becoming overpowering.
- Preserved the existing adaptive dark palette and readable text contrast for preset and custom accent colors.
- Expanded end-to-end regression coverage for generated-title updates, fallback behavior, adaptive theme visibility, persistence, and contrast.

### 🐛 Bug Fixes

- Fixed automatically generated chat titles remaining stuck on the original user-message preview by applying the already-persisted title response directly to the sidebar's local session state.
- Removed the redundant second title-update request, kept generation status active until the sidebar updates, and made notifications accurately distinguish generated summaries from fallback previews.
- Improved generated-title cleanup by stripping common wrappers and `Title:` prefixes, truncating long valid summaries at a readable word boundary, and reliably identifying empty provider responses as fallbacks.
- Replaced fixed white surfaces in key light-theme chat and settings views with adaptive semantic surface colors so the chosen accent is reflected throughout the interface.

### 📚 Documentation

- Reworked the README around Libre WebUI's local-first model, provider flexibility, Apache 2.0 licensing, inspectable project commitments, inclusive participation, deployment choices, and clearly stated privacy and security boundaries.
- Updated the design guide to document the clearer light-mode accent treatment and unchanged dark-mode behavior.
- Added project-scoped release instructions covering dual-remote verification, main-before-tag CI gates, release artifact checks, and the final `main`-to-`dev` synchronization.

## [0.13.2] - 2026-07-15

Libre WebUI 0.13.2 is a focused interface and provider-routing release. It keeps appearance choices stable across reloads, adds an optional accent-adapted palette for light and dark mode, routes speech through the exact selected TTS plugin and per-user valve, restores bundled plugin discovery for packed `npx` installs, and improves Arabic right-to-left behavior across desktop and mobile layouts.

### ✨ New Features

- Added an opt-in **Adapt to accent** appearance style that tints the canvas, surfaces, borders, text hierarchy, and neutral scales from a preset or custom accent in both light and dark mode, while preserving the existing neutral palettes as the default style.
- Added localized controls for choosing the default or accent-adapted appearance across all 25 supported locales.

### 🔧 Improvements

- Improved Arabic and other right-to-left layouts across the desktop and mobile shell, sidebar, chat, settings, model selector, artifact panel, dialogs, and notifications by using direction-aware logical positioning.
- Applied the saved language and text direction before the first React render, localized relative timestamps, isolated Latin usernames inside Arabic greetings, allowed message text to choose its natural direction, and kept code and model identifiers left-to-right.
- Added end-to-end and packaged-runtime regression coverage for theme persistence, adaptive palettes and contrast, RTL desktop/mobile behavior, shared TTS model aliases, per-user valves, and packed `npx` launches.

### 🐛 Bug Fixes

- Fixed light/dark mode and accent preferences reverting after a refresh by persisting theme changes locally and to the backend, retrying failed saves, reconciling stale responses, and preserving hydrated preferences for the same signed-in user.
- Fixed TTS provider selection when multiple plugins expose the same model alias by preserving the plugin ID through settings, test playback, read-aloud, sentence streaming, and autoplay, while using the selected provider's default voice and audio format.
- Fixed authenticated plugin credentials and valve values so they are stored and resolved per user, allowing TTS requests to reach the configured endpoint such as Kyutai's `/v1/audio/speech` address.
- Fixed bundled plugin discovery in packed `npx libre-webui` installs launched from an arbitrary working directory, while continuing to support writable custom plugin directories.
- Removed duplicate TTS model entries and made no-authentication TTS providers available to the model and plugin selectors.

### 📚 Documentation

- Updated `DESIGN.md` to document the default neutral appearance and the opt-in accent-adapted light and dark palettes.

## [0.13.1] - 2026-07-14

Libre WebUI 0.13.1 is a maintenance release focused on reliable npm packaging and cross-platform installation. It fixes `npx libre-webui` on Windows, restores the CLI entry point in the published package, and hardens Docker and release automation against the same packaging regressions.

### 🔧 Improvements

- Updated the project screenshot to reflect the current UI.

### 🐛 Bug Fixes

- Fixed `npx libre-webui` on Windows by replacing the POSIX-only `postinstall` command with a cross-platform Node.js script.
- Ensured the npm package retains both the `libre-webui` CLI entry point and its required postinstall script.
- Copied the postinstall script into every Docker dependency stage so Buildx can complete `npm ci --omit=dev` on amd64 and arm64.
- Made release npm commands run correctly on Windows and preserved complete paths when parsing Git porcelain status output.
- Added regression tests for npm package contents, release status parsing, and Docker dependency-stage layout.

## [0.13.0] - 2026-07-13

Libre WebUI 0.13.0 is a creator-focused interface release. It brings a quieter, warm-neutral design system to the full workspace and gives every new chat a broader range of localized starting prompts, making the blank canvas feel more considered and less repetitive.

### ✨ New Features

- Added 11 creator-oriented welcome prompts that rotate as users start new chats, alongside the existing personalized time-of-day greeting.
- Persisted welcome-prompt rotation for the current session, with an in-memory fallback when browser storage is unavailable.

### 🔧 Improvements

- Reworked the application around a cohesive warm-neutral visual system with editorial typography, quieter surfaces, hairline separators, neutral primary actions, and restrained motion in both light and dark modes.
- Refreshed the chat experience, including the welcome canvas, composer, messages, branch controls, model selection, sidebar, and image-generation workflow.
- Standardized Gallery, Models, Personas, User Management, and Libre Claw with shared `PageShell` and `PageHeader` layouts, while aligning settings, authentication, onboarding, and management surfaces with the same component language.
- Expanded the new-chat prompt library across all 25 supported locales and added end-to-end coverage for prompt rotation.
- Removed third-party font downloads in favor of privacy-friendly system font stacks, and improved reduced-motion and mobile input behavior.

### 📚 Documentation

- Updated `DESIGN.md` with the warm-neutral palette, semantic surface and ink roles, editorial typography, responsive layout guidance, and motion principles used by the new interface.

## [0.12.1] - 2026-07-08

Libre WebUI 0.12.1 introduces a refreshed brand identity alongside verified provider catalog updates and significant repository maintenance. This release refreshes 14 dependencies to keep the build environment secure and modern, while streamlining internal release automation and removing obsolete scripts and documentation.

### ✨ New Features

- Introduced a new Libre WebUI wordmark logo featuring bold "Libre" and regular "WebUI" text in white on black, with updated favicons, logos, and the Electron application icon.

### 🔧 Improvements

- Updated the project screenshot to reflect the current interface.
- Refactored and improved the release changelog generation pipeline with new shared library modules and dedicated tests.
- Removed obsolete local helper scripts, stale maintenance shell scripts, deprecated type stubs (`@types/express-rate-limit` and `@types/uuid`), and outdated documentation to clean up the repository.

### 🐛 Bug Fixes

- Added explicit spacing between "Libre" and "WebUI" in the logo for better readability.
- Refreshed verified provider plugin catalogs and provider models from verified sources across multiple providers, including Anthropic, Gemini, GitHub, Groq, Hugging Face, Mistral, OpenAI, and OpenRouter.

### 🔒 Security & Dependencies

- Refreshed 14 dependencies, including `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `electron`, `png-to-ico`, `prettier`, `sharp`, `framer-motion`, `i18next`, `lucide-react`, `react-router-dom`, `@types/node`, `@types/multer`, `tsx`, and `vite`.

## [0.12.0] - 2026-06-30

Libre WebUI 0.12.0 is the agent integration release. It replaces the previous
OpenClaw bridge with a first-class Libre Claw control surface inside Libre WebUI,
including admin-only backend routes, a dedicated frontend page, run timelines,
approvals, automations, usage/fallback visibility, docs, and full localization.

### ✨ New Features

- Added a first-class **Libre Claw** agent surface in the app, available from the
  sidebar as **Libre Claw**, with daemon connection status, dashboard access, and
  a dedicated `/agents` route.
- Added admin-only backend proxy routes under `/api/libre-claw` for daemon
  status, health, dashboard URL, model routing, fallback routing, theme updates,
  runs, run events, permissions, usage, and automations.
- Added Libre Claw run management from WebUI: start chat or goal-mode runs, pass
  optional provider/model overrides, inspect durable run history, stream
  incremental run events, and cancel active runs.
- Added WebUI approval handling for Libre Claw tool calls, including
  `allow_once`, `deny`, and `always_allow_tool` permission resolutions.
- Added Libre Claw automation controls for scheduled report/Telegram routes,
  including create, update, run now, pause, resume, and delete actions.
- Added Libre Claw usage and fallback visibility so admins can inspect provider
  usage records and fallback route state from the same agent page.
- Added backend environment configuration for Libre Claw daemon connectivity via
  `LIBRE_CLAW_BASE_URL` and `LIBRE_CLAW_TIMEOUT_MS`.

### 🔧 Improvements

- Reworked the run timeline UI so assistant deltas are grouped into readable
  responses while tool calls, tool results, permission requests, usage events,
  errors, and run lifecycle events remain inspectable.
- Added demo-safe frontend API responses for the Libre Claw page so demo mode
  can render the agent surface without requiring a running daemon.
- Completed Libre Claw translations across all supported locales. English and
  French define the source copy, and the remaining locale files now carry the
  full Libre Claw key set instead of falling back to English.
- Updated the README product overview with Libre Claw agent support, including
  memory, tools, approvals, run timelines, automations, usage, and the default
  local daemon URL.
- Removed stale OpenClaw plugin validation hooks and the old bundled OpenClaw
  plugin entry now that Libre Claw is the supported agent integration.

### 🐛 Bug Fixes

- Fixed demo-mode system info so the UI reports the current built application
  version instead of the old hardcoded `0.1.0` value.
- Hardened artifact title sanitization by decoding basic HTML entities and
  stripping malformed or quoted HTML tags without eating safe plain-text title
  content.

### 🔒 Security & Dependencies

- Refreshed 17 dependencies through Dependabot, including `axios`, `pdfjs-dist`,
  `tar`, `electron`, `vite`, `i18next`, `lucide-react`,
  `@tanstack/react-query`, `framer-motion`, `@playwright/test`,
  TypeScript ESLint packages, `prettier`, `postcss`, and `autoprefixer`.

### 📚 Documentation

- Added `docs/31-LIBRE_CLAW_INTEGRATION.md` with setup, architecture, route
  mapping, run modes, approval behavior, automations, memory/tool notes, and
  troubleshooting guidance.
- Replaced the old OpenClaw integration documentation with the Libre Claw
  integration guide.

### ⚠️ Breaking Changes

- The old OpenClaw integration path has been removed and replaced by Libre Claw.
  Users who relied on the previous OpenClaw plugin/config should run the Libre
  Claw daemon and configure Libre WebUI with `LIBRE_CLAW_BASE_URL` when the
  daemon is not on `http://127.0.0.1:8766`.

## [0.11.0] - 2026-06-22

Libre WebUI 0.11.0 is a stabilization and architecture release. It focuses on artifact reliability, demo/auth hardening, smoother streaming, test coverage, and a large backend/frontend cleanup pass on top of the 0.10.0 theme and model-provider work.

### ✨ New Features

- Added optional Cloudflare Turnstile protection for public account creation, configured from backend environment variables and rendered only when enabled.
- Added Tailscale-friendly development hosting/origin support so Libre WebUI can be reached from another device during local development.
- Added Playwright e2e coverage for demo login, one-user mode, artifact detection/rendering, artifact resize behavior, cloud-model regression coverage, mobile sidebar behavior, and async locale loading.

### 🔧 Improvements

- Set blue as the default accent color and polished the remaining auth, artifact demo, badge, icon, logo, and model-flow surfaces to follow the current design system.
- Improved artifact reliability for multi-file HTML, filename-qualified bundles, standalone full HTML documents, local file reference cleanup, and themed empty/fallback preview states.
- Made artifact pane resizing release pointer state correctly so the pane no longer feels stuck to the mouse after resize.
- Made code-block streaming smoother with requestAnimationFrame-coalesced updates, a lightweight streaming code renderer, lazy rich markdown rendering, and split markdown/math/highlighting chunks.
- Reworked title generation so it honors the existing toggle, resolves the current running model correctly, supports plugin-backed title generation, falls back to Ollama, and sanitizes generated titles.
- Split major backend chat orchestration into focused services for WebSocket handling, shared chat context, assistant completion persistence, plugin streaming, Ollama streaming, title generation, and request preparation.
- Split plugin capabilities into smaller adapters/services for chat, streaming, embeddings, image generation, TTS, validation, uploads, variables, and provider response conversion.
- Slimmed large frontend surfaces by extracting Settings tabs, Model Manager sections, Model Selector tabs, Persona Form tabs, Sidebar sections, API domain clients, and chat store helpers.
- Added gated frontend/backend loggers and routed noisy development diagnostics through explicit debug controls.
- Updated release tooling with a security preflight and kept the production build free of the previous large chunk warnings.

### 🐛 Bug Fixes

- Fixed toggled session title generation so titles are generated only when the option is enabled.
- Fixed demo mode persona avatars so bundled/local demo images render correctly.
- Fixed chat routing and settings state edge cases after the shared generation refactor.
- Fixed dark-mode artifact demo surfaces so generated previews no longer fall back to the old default blue styling.
- Added regression coverage around cloud model suffix handling without re-documenting the 0.10.0 cloud model feature itself.

### 🔒 Security & Dependencies

- Remediated npm security advisories and refreshed dependency locks after 0.10.0, including updates around `multer`, `undici`, `ws`, `ip-address`, `brace-expansion`, `tmp`, and `qs`.
- Added `npm audit` to the release preflight path and verified the package lock reports zero vulnerabilities after the release update.
- Updated GitHub Actions dependencies, including `actions/checkout`, and hardened the release workflow checks before publishing.

### 📚 Documentation

- Refreshed the README to describe the current Libre WebUI product, model/provider story, install paths, and project positioning.
- Audited and rewrote the project docs so the model examples, setup guidance, plugin docs, auth docs, artifacts docs, environment variables, and deployment guides match the current application.
- Updated DESIGN.md with the current blue-accent direction and UI guidance without repeating the 0.10.0 custom-accent release notes.

### ⚠️ Breaking Changes

- No known user-facing breaking changes. The plugin and chat internals were heavily refactored, but existing plugin configuration and normal app workflows remain compatible.

## [0.10.0] - 2026-06-12

### What's New

0.10.0 expands model-provider workflows, theme customization, and release maintenance. The release adds a bundled llama.cpp provider profile, first-class Ollama Cloud browsing, a full custom accent system, quieter authentication/plugin logging, and dependency updates needed for the current Electron and frontend stack.

### ✨ New Features

- Added a bundled `llama.cpp` completion provider profile for `qwen3-35b-a3b`, including configurable endpoint, sampling, token, penalty, and streaming defaults
- Added an Ollama Cloud category in the Models library and model selector, backed by Ollama's dedicated cloud listing
- Added custom accent selection in Appearance with violet, blue, cyan, teal, emerald, amber, rose, slate, and custom color options
- Added runtime-generated accent shade scales so custom accents can drive buttons, links, focus rings, sliders, progress bars, selected states, and glow shadows

### 🔧 Improvements

- Reworked Tailwind theme tokens to use CSS variables for `primary` and `accent`, with generated custom palettes meeting white-text contrast targets
- Refined light and dark neutral palettes to reduce glare while preserving contrast across app backgrounds, panels, inputs, and message surfaces
- Persisted accent preferences through frontend state, backend preferences, import/export defaults, local rehydration, logout cleanup, and demo mode
- Added accent translation keys across all supported locales and verified locale key parity against English
- Expanded demo-mode preference APIs so Appearance, generation, embedding, system-message, and default-model settings can be exercised without a backend connection
- Standardized the Libre WebUI wordmark through a shared `Logo` component across loading, login, setup, sidebar, and settings surfaces
- Replaced fixed violet styling in persona adaptive-learning controls with active-accent tokens
- Recolored Ollama library and Cloud badges from cyan to the design-system info-blue treatment
- Reduced noisy debug logging across optional auth, chat, document search, plugin lookup, plugin deletion, TTS, image generation, and WebSocket auth paths
- Returned package version in auth system info for UI/version display
- Updated Dependabot targeting to `main` and ignored incompatible Electron and ESLint major bumps until their upstream compatibility gaps are resolved

### 🐛 Bug Fixes

- Fixed a critical app-wide `Too many re-renders` crash in `SettingsModal` by memoizing image-generation model/plugin arrays
- Fixed Ollama Cloud model pulls by tagging cloud library results with `:cloud` before install/run actions
- Fixed Ollama Cloud generation failures by stripping unsupported non-positive `num_predict` values before cloud requests
- Fixed cloud model pull functionality
- Fixed auto-title generation for persona/current-model workflows by resolving the real running model before sending title prompts
- Quietly handles expired or invalid JWTs in auth and WebSocket flows without dumping routine stack traces
- Kept the lint toolchain on ESLint 9 for compatibility with the current React plugin stack

### 📚 Documentation

- Expanded `DESIGN.md` with custom accent presets, generated shade-scale behavior, token usage rules, light/dark neutral guidance, and contrast requirements

### 📦 Dependencies

- Bumped package versions to `0.10.0`
- Updated Electron to `41.7.1` and Electron Builder to `26.15.2`
- Bumped frontend/backend dependencies including React Query, i18next, KaTeX, lucide-react, React Router, Vite, pdfjs-dist, TypeScript tooling, Tailwind Merge, Zustand, Express, Multer, Better SQLite3, and related lockfile entries
- Remediated npm security advisories through dependency and lockfile updates, including `qs`, `tmp`, `ip-address`, `brace-expansion`, `ws`, and related transitive packages

## [0.9.0] - 2026-04-28

### What's New

A visual refresh paired with a data-layer rewrite. The UI gets a new indigo design system, violet accents, and a deeper dark mode for OLED-friendly contrast. Under the hood, every component that used to fetch its own data via `useEffect` + `useState` now goes through TanStack Query — components share a cache, refetch on invalidation instead of re-mount, and the React Compiler-era `set-state-in-effect` lint rule passes cleanly across the codebase.

### ✨ New Features

- New indigo-based design system with violet accents and refined range sliders
- Deeper, near-black dark-mode neutrals for less glare on OLED panels

### 🔧 Improvements

- Migrated all server-state loading to TanStack Query across personas, users, models (Ollama + HuggingFace), image gallery, settings, and auth — gives shared caching, request deduplication, and consistent loading/error handling
- Image gallery's "load more" now uses `useInfiniteQuery` with cursor-based pagination instead of manual offset bookkeeping
- Mutations (create / update / delete in Persona and User managers) now invalidate queries instead of locally splicing arrays, so concurrent edits from another tab stay in sync
- Embedding model discovery rate-limits requests so providers don't get hammered when the embedding picker is opened repeatedly
- Retired the legacy `ophelia` theme in favor of the unified indigo system

### 🐛 Bug Fixes

- Restored the build after a Dependabot batch broke compatibility with dev dependencies
- Stopped CodeQL from scanning Homebrew formula templates as Ruby, eliminating spurious analysis failures

### 📦 Dependencies

- Added `@tanstack/react-query` (~14 KB gzipped) for the data-layer migration
- Multiple Dependabot-driven bumps across production and dev dependency groups

## [0.8.7] - 2026-04-05

### What's New

0.8.7 is a cleanup release focused on the rough edges we hit right after 0.8.6. The main work here was making packaged `npx` installs behave reliably, removing hardcoded embedding defaults so people can use the models they actually configured, and tightening a few release-time paths that were easy to ship stale data through.

### ✨ New Features

- Users can now choose real embedding-capable models from Ollama and OpenAI-compatible providers instead of being stuck with a hardcoded default
- Auto title generation can now follow the current running chat model when you do not want to maintain a separate task model just for titles

### 🔧 Improvements

- Added packaged release smoke tests that build the real npm tarball, boot the packaged backend, and verify both asset lookup and provider-backed embedding flows
- Reworked Homebrew publishing so the tap files are rendered from release templates using the actual release version and computed hashes
- Upgraded Electron to 40.8.5 for the desktop build to pick up upstream security fixes

### 🐛 Bug Fixes

- Fixed `npx libre-webui` path resolution so packaged installs can reliably find the app `package.json`, backend metadata, and frontend build output
- Fixed embedding model discovery so it uses the logged-in user's configured provider credentials and endpoint layout instead of assuming one hardcoded path
- Fixed title generation for plugin-backed and persona-backed chats by resolving the effective active model before generating titles

## [0.8.6] - 2026-04-03

### What's New

This release is a security and maintenance update addressing multiple high and moderate severity vulnerabilities across runtime and development dependencies. ESLint tooling compatibility has been restored and CI/CD actions have been updated.

### 🔒 Security

- Bumped `electron` 40.0.0 → 40.8.4 — patches CVE-2026-34767, CVE-2026-34773, CVE-2026-34775, CVE-2026-34776, CVE-2026-34777, CVE-2026-34778
- Bumped `lodash` → 4.18.1 — patches CVE-2026-4800 (high) and CVE-2026-2950 (moderate), prototype pollution via `_.unset`/`_.omit`
- Bumped `path-to-regexp` → 8.4.2 — patches CVE-2026-4926 (high) and CVE-2026-4923 (moderate)
- Bumped `@xmldom/xmldom` → 0.8.12 — patches CVE-2026-34601 (high)
- Bumped `brace-expansion` → 5.0.5 — patches CVE-2026-33750 (moderate)
- Bumped `picomatch` → 4.0.4 — patches CVE-2026-33671 and CVE-2026-33672
- Bumped `flatted` → 3.3.3 — patches prototype pollution via `parse()`

### 🔧 Improvements

- Downgraded ESLint from v10 to v9 to restore compatibility with `eslint-plugin-react` (`contextOrFilename.getFilename is not a function`)
- Bumped CI actions: `docker/setup-buildx-action` v3 → v4, `docker/login-action` v3 → v4, `docker/build-push-action` v6 → v7

## [0.8.5] - 2026-03-06

### What's New

This release focuses on strengthening security with critical dependency updates. We've addressed important vulnerabilities in core packages to ensure a safer experience for all users.

### 🔧 Improvements

- Updated multer to version 2.1.1 to address CVE-2026-3520 security vulnerability
- Upgraded tar package to version 7.5.10 to resolve GHSA-qffp security advisory

## [0.8.4] - 2026-03-03

### ✨ New Features

- Added `TRUST_PROXY` environment variable for running behind reverse proxies (Nginx, Caddy, etc.) — supports numeric, boolean, and string values

### 🔧 Improvements

- Bumped `actions/upload-artifact` from v6 to v7 and `actions/download-artifact` from v7 to v8 across all CI workflows
- Dockerfile now copies `.npmrc` into build stages for consistent dependency resolution
- Added `legacy-peer-deps=true` to `.npmrc` to resolve peer dependency conflicts during install
- Release script now works on Windows by enabling shell mode in `spawnSync`

### 🐛 Bug Fixes

- Downgraded ESLint from v10 to v9 to fix `eslint-plugin-react` incompatibility (`getFilename is not a function`)
- Added missing `@eslint/js` devDependency
- Resolved high-severity vulnerabilities in rollup, minimatch, and multer via dependency updates and overrides
- Fixed minimatch ReDoS vulnerability (GHSA-3ppc-4f35-3m26)

### 📦 Dependencies

- Bumped multiple frontend and backend dependencies via Dependabot

## [0.8.3] - 2026-02-16

### What's New

This maintenance release focuses on improving development infrastructure and dependency management. The update resolves CI pipeline conflicts and ensures better compatibility across the development toolchain.

### 🔧 Improvements

- Updated development dependencies across frontend and backend components for better security and performance
- Resolved npm peer dependency conflicts in ESLint configuration
- Removed incompatible brace-expansion package override to prevent build issues

### 🐛 Bug Fixes

- Fixed CI pipeline failures caused by conflicting ESLint peer dependencies
- Resolved npm install errors during continuous integration builds

## [0.8.2] - 2026-02-16

### What's New

This release introduces intelligent tool activity indicators that show users when AI agents are actively working with tools, along with enhanced internationalization support across 25 languages. Administrators now have granular control over model installations with new permission settings.

### ✨ New Features

- **Tool Activity Indicators**: Real-time visual feedback showing when AI tools are running, with actual tool names displayed during execution
- **Admin Model Control**: New toggle allowing administrators to restrict non-admin users from installing models
- **Enhanced Internationalization**: Added comprehensive translations across 25 languages including Arabic, Japanese, Korean, and European languages

### 🔧 Improvements

- **Better Tool Feedback**: Improved activity labels and removed debug logging for cleaner tool execution displays
- **Plugin Error Handling**: Enhanced error handling with proper internationalization key support and controlled input validation
- **Documentation Updates**: Added AI agent support section and updated project badges with dynamic versioning

### 🐛 Bug Fixes

- **Security Patches**: Updated axios to version 1.13.5 and resolved qs denial of service vulnerability
- **ESLint Compatibility**: Fixed ESLint 10 incompatibility issues with eslint-plugin-react and typescript-eslint
- **Tool Indicators**: Eliminated duplicate tool activity indicators, ensuring single clean display per tool
- **WebSocket Cleanup**: Removed unused tool-events capability from WebSocket connections

## [0.8.1] - 2026-02-08

### What's New

This release focuses on stability and security improvements with enhanced documentation. Key updates include security patches for the plugin service, reduced console noise for better debugging, and a completely revamped README for easier onboarding.

### 🔧 Improvements

- Revamped README documentation for better clarity and user experience
- Expanded OpenClaw integration documentation with comprehensive setup guides
- Reduced excessive console logging in chat components and WebSocket connections for cleaner debug output
- Improved TypeScript error handling by replacing explicit `any` types with `unknown` in catch clauses

### 🐛 Bug Fixes

- Patched CodeQL security vulnerabilities in the plugin service
- Prevented duplicate i18next initialization that could cause localization conflicts

## [0.8.0] - 2026-02-08

### What's New

This release introduces OpenClaw agent integration, bringing advanced AI agent capabilities to Libre WebUI through a comprehensive plugin system. Enhanced plugin infrastructure now supports real-time streaming, image content handling, and automatic model discovery, while expanded internationalization covers 19 languages.

### ✨ New Features

- **OpenClaw Agent Integration**: Complete plugin system for AI agent workflows with session routing and WebSocket support
- **Enhanced Plugin System**: Real-time Server-Sent Events (SSE) streaming for plugin responses
- **Image Content Support**: Plugins can now handle and render image content in responses
- **Automatic Model Discovery**: Models are automatically detected from plugin API endpoints
- **Structured Tool Calls**: Tool call responses are now rendered as structured content in assistant messages
- **Identity Passthrough**: User identity can be passed through plugins via system prompt prefix and username
- **Documentation Links**: Added GitLab mirror and documentation links in settings

### 🔧 Improvements

- **Internationalization**: Comprehensive translation coverage for ModelSelector, ImageUpload, avatar components, and User Management across 19 languages
- **Model State Validation**: Enhanced selectedModel validation after loading to prevent stale state issues
- **Generic Plugin Support**: OpenClaw plugin now supports all users instead of being user-specific
- **Provider/Model Format**: Improved OpenClaw plugin integration with standardized provider/model format

### 🐛 Bug Fixes

- Fixed OpenClaw session routing to use HTTP session-key header instead of WebSocket
- Removed conflicting stream option from OpenClaw plugin
- Corrected avatar translation key paths
- Fixed model pull progress status message translations

## [0.7.1] - 2026-02-03

### What's New

This release improves Windows compatibility with automatic VRAM management when switching models, preventing memory exhaustion issues that could freeze the system. Security vulnerabilities have been patched and TTS stability has been improved.

### ✨ New Features

- **Auto-Unload Models**: Automatically unload running Ollama models before switching to a new one, preventing VRAM exhaustion on Windows (where GPU memory cannot spill to system RAM like on Linux)

### 🔧 Improvements

- **Code Quality**: Remove unused eslint-disable directive after eslint-plugin-react-refresh 0.5.0 upgrade

### 🐛 Bug Fixes

- **Security**: Patch @isaacs/brace-expansion ReDoS vulnerability (CVE) via npm override
- **TTS Stability**: Add thread lock for audio generation concurrency to prevent race conditions

### 🔄 Dependencies

- Bump pdfjs-dist, eslint-plugin-react-refresh, @types/node
- Bump the all-dependencies group with 3 updates

## [0.7.0] - 2026-02-01

### What's New

This release introduces a major new plugin variables (valves) system that allows dynamic configuration of plugin settings with database persistence and security validation. Enhanced HuggingFace model management now supports GGUF model downloads directly from the browser, and comprehensive internationalization improvements make the interface more accessible across all supported languages.

### ✨ New Features

- **Plugin Variables (Valves)**: Configure plugin settings dynamically with database persistence, input validation, and configurable endpoint overrides
- **GGUF Model Downloads**: Download GGUF models directly from HuggingFace through the model browser interface
- **Development Version Display**: Show commit hash in version string for development builds
- **Enhanced Documentation**: New local GPU stack guide, Hetzner GPU deployment tutorial, plugin system architecture docs, and GitLab mirror link

### 🔧 Improvements

- **Plugin Variables Performance**: Added 5-second TTL cache for resolved plugin variables to improve response times
- **Model Selection**: Filter embedding models from chat model selector for cleaner interface
- **Dark Theme Consistency**: Plugin variables input styling now matches dark theme design
- **Internationalization**: Comprehensive translation updates across all 21 supported languages with missing keys added
- **Settings Interface**: Plugin variables editor now properly displays in settings modal

### 🐛 Bug Fixes

- **Security**: Added input validation and SSRF protection for plugin variables to prevent sensitive data exposure
- **Model Manager**: Fixed missing loadData dependency in ModelManager useCallback hook
- **UI Components**: Resolved hardcoded strings in multiple components that weren't using translation keys
- **HuggingFace Integration**: Fixed GGUF pull functionality in model manager's HuggingFace section

## [0.6.3] - 2026-01-29

### What's New

This release introduces comprehensive desktop support with native Windows and Linux Electron builds, alongside significant persona management improvements. The update also includes enhanced internationalization support and important security fixes.

### ✨ New Features

- **Desktop Applications**: Native Windows and Linux Electron builds now available
- **Enhanced Persona Controls**: Keyboard input support for precise parameter value entry in persona configuration

### 🔧 Improvements

- **Better User Experience**: Model selector now displays persona names instead of technical IDs
- **Expanded Localization**: Added missing translations for persona settings, Hugging Face Hub integration, and prompt length indicators across all supported languages
- **Improved Build Pipeline**: Enhanced CI/CD workflows with better artifact naming and cross-platform development builds

### 🐛 Bug Fixes

- **Security**: Patched node-tar CVE-2026-24842 vulnerability through npm override
- **Linux Desktop**: Fixed Electron builds with proper icon support and hash-based routing for file:// protocol
- **Package Consistency**: Standardized Debian package naming for Linux distributions

## [0.6.2] - 2026-01-25

### What's New

This release brings Libre WebUI desktop app to Windows and Linux, alongside the existing macOS version. The Electron frontend app now works on all three major platforms, allowing users to run the UI natively while connecting to a locally-running backend server.

### ✨ New Features

- **Windows Electron App**: Native Windows installer (.exe) and portable builds
- **Linux Electron App**: AppImage and .deb packages for Linux distributions
- **Cross-Platform Dev Builds**: New CI workflow builds dev artifacts for all platforms on every push

### 🐛 Bug Fixes

- **Linux Icon Support**: Fixed missing app icon in Linux builds by properly extracting icons to extraResources
- **File Protocol Routing**: Fixed "Not allowed to load local resource: file:///login" error by switching to hash-based navigation for Electron's file:// protocol
- **Linux About Dialog**: Fixed empty About dialog on Linux with proper icon path detection

### 🔄 CI/CD

- Added `electron-dev.yml` workflow to build dev versions on all platforms when pushing to dev/main
- Renamed artifact uploads to include `-frontend` suffix to clarify these are frontend-only builds
- Added `ELECTRON_BUILD=true` environment variable to Linux build script

## [0.6.1] - 2026-01-25

### What's New

This release focuses on stability and Docker deployment improvements. Key fixes include enabling TTS audio playback in browsers, allowing network access from other devices on your LAN, and better compatibility with HuggingFace model names containing slashes.

### 🐛 Bug Fixes

- **CSP**: Allow data and blob URIs for media-src to enable TTS audio playback
- **CORS**: Allow network IPs in Docker environment for LAN access
- **UI**: Pure dark theme tab visibility and remove TTS speed slider
- **Storage**: Auto-cleanup corrupted preferences to prevent app crashes
- **TTS**: Add Python 3.12 support and audio format detection
- **Ollama**: Support HuggingFace model names with slashes in API routes
  - Change routes to avoid path params with slashes (path-to-regexp limitation)
  - DELETE /models/:name -> DELETE /models?name=
  - GET /models/:name -> GET /models/show?name=
  - POST /models/:name/pull -> POST /models/pull with { name } body
  - POST /models/:name/push -> POST /models/push with { name } body
  - Updated frontend API calls to match new endpoint signatures

## [0.6.0] - 2026-01-24

### What's New

This release introduces full HuggingFace Hub integration with GGUF model detection and direct Ollama pulls, along with significant improvements to the Kyutai TTS system including GPU acceleration and expanded voice libraries. The update also addresses critical security vulnerabilities and enhances internationalization support across all 23 supported languages.

### ✨ New Features

- **HuggingFace Hub Integration**: Browse and pull models directly from HuggingFace with automatic GGUF detection
- **Kyutai TTS 1.6B Model**: Added GPU-accelerated TTS with expanded voice library and sentence-by-sentence streaming
- **Enhanced Model Browser**: New HuggingFace model browser component with improved UI and filtering
- **Comprehensive Documentation**: Added detailed guides for Kyutai TTS and HuggingFace Hub integration

### 🔧 Improvements

- **UI Enhancements**: Renamed AMOLED theme to "Pure Black" with improved borders and styling
- **Image Generation**: Expanded textarea from 3 to 5 rows with client-side prompt length validation
- **Code Rendering**: Improved code block display in chat messages
- **Settings Reorganization**: Moved System tab to Manage Models page for better organization
- **Plugin Management**: Allow dots in plugin IDs for more flexible naming

### 🐛 Bug Fixes

- **Critical Security**: Fixed SSRF vulnerabilities and sensitive data logging issues
- **TTS Audio Quality**: Resolved audio crackling, improved normalization, and fixed tensor processing errors
- **Voice Downloads**: Implemented auto-retry for corrupted voice downloads with force re-download capability
- **Internationalization**: Added missing translation keys across all 23 supported languages

## [0.5.2] - 2026-01-22

### What's New

This release introduces comprehensive Qwen3-TTS support with a new text-to-speech server implementation and complete documentation. Multiple stability improvements ensure reliable audio generation, including better handling of long text inputs and multi-GPU environments.

### ✨ New Features

- Added Qwen3-TTS server with complete setup documentation and examples
- Implemented text chunking for reliable generation of long audio content

### 🔧 Improvements

- Enhanced text sanitization with more aggressive filtering for cleaner TTS input
- Optimized memory handling by moving tensors to CPU before concatenation

### 🐛 Bug Fixes

- Fixed multi-GPU tensor mismatches by forcing single GPU usage
- Resolved server hangs with improved text sanitization and timeout handling

## [0.5.1] - 2026-01-22

### What's New

This release addresses dependency version requirements for the Qwen3-TTS integration. The update ensures proper compatibility and resolves potential installation issues with the text-to-speech functionality.

### 🐛 Bug Fixes

- Fixed incorrect Qwen-TTS version requirement in example server dependencies

## [0.5.0] - 2026-01-22

### What's New

This release introduces Qwen3-TTS integration, bringing advanced text-to-speech capabilities to Libre WebUI. Users can now generate high-quality speech output using Qwen's latest TTS model with a complete server setup and plugin configuration.

### ✨ New Features

- **Qwen3-TTS Integration**: Added full support for Qwen3 text-to-speech model with dedicated plugin
- **TTS Server Example**: Included complete server implementation with setup instructions and dependencies
- **Plugin Service Enhancement**: Expanded plugin service to support TTS functionality and improved plugin management

## [0.4.3] - 2026-01-22

### What's New

This maintenance release focuses on security improvements and dependency updates. We've addressed a critical security vulnerability in lodash and improved ESM compatibility for the Electron build process.

### 🔧 Improvements

- Updated Electron build tools to latest versions (electron-builder 26.5.0, @electron/rebuild 4.0.2) for better compatibility and performance
- Scoped tar v6 override specifically to electron-builder to improve ESM module compatibility

### 🐛 Bug Fixes

- **Security**: Updated lodash to version 4.17.23 to resolve prototype pollution vulnerability
- Fixed ESM compatibility issues in the Electron build process

## [0.4.2] - 2026-01-22

### What's New

This release focuses on security and stability improvements with critical dependency updates. We've addressed a prototype pollution vulnerability and updated key build tools to their latest versions.

### 🔧 Improvements

- Updated Electron build tools to latest versions for better compatibility and performance
- Refreshed development dependencies to ensure optimal build processes

### 🐛 Bug Fixes

- Resolved prototype pollution vulnerability by updating lodash to version 4.17.23

## [0.4.1] - 2026-01-22

### What's New

This release includes critical security patches and improved CI/CD infrastructure for better reliability.

### 🔧 Improvements

- **ARM64 Performance**: Switched to native ARM64 runners to eliminate QEMU emulation overhead
- **CI/CD Updates**: Upgraded GitHub Actions checkout from v4 to v6 and enhanced workflow permissions

### 🐛 Bug Fixes

- **Security Patches**: Updated node-tar to version 7.5.4+ to resolve CVE-2026-23950 and CVE-2026-23745
- **Dependency Updates**: Bumped all dependency groups with 3 critical updates

## [0.4.0] - 2026-01-14

### What's New

This release introduces comprehensive internationalization support, making Libre WebUI accessible to users worldwide with 21 new language options. The interface now supports multiple languages with proper right-to-left text rendering for Arabic and includes a convenient language switcher component.

### ✨ New Features

- **Multi-language support**: Added translations for 24 languages including Arabic (with RTL support), Chinese, French, German, Spanish, Italian, Japanese, Korean, Russian, Hindi, Bengali, Thai, Vietnamese, Indonesian, Dutch, Polish, Czech, Ukrainian, Danish, Swedish, Portuguese, Icelandic, Malay, and Turkish
- **Language switcher component**: New interface element allowing users to easily change the application language
- **Right-to-left text support**: Proper RTL rendering for Arabic and other RTL languages

### 🔧 Improvements

- Enhanced type safety across backend routes with improved type assertions
- Updated workflow permissions configuration for better security compliance

## [0.3.3] - 2026-01-13

### What's New

This release introduces private chat sessions with in-memory storage, allowing users to have conversations that aren't persisted to the main chat history. We've also refreshed the brand with a new "Libre" wordmark and improved typography, plus added native macOS installation support through Homebrew.

### ✨ New Features

- **Private Chat Sessions**: Start private conversations with in-memory storage and clear UI indicators to distinguish from regular chats
- **macOS Installation**: Native Homebrew formula and cask support for easy installation on macOS systems
- **Enhanced WebSocket Communication**: Message history now included in private chat sessions for better context preservation

### 🔧 Improvements

- **New Branding**: Updated to "Libre" wordmark with refreshed logos and favicons across the application
- **Typography Update**: Switched to 'Roboto Slab' font for consistent branding throughout the interface
- **Better Error Handling**: Global 401 Unauthorized error handling in API response interceptor
- **Enhanced Chat Layout**: Improved ChatMessage component styling and updated LoginPage branding
- **Documentation Expansion**: Added comprehensive guides for Docker, Kubernetes, hardware requirements, and environment variables

### 🐛 Bug Fixes

- Fixed Helm package version synchronization in CI pipeline

## [0.3.2] - 2026-01-09

### What's New

This release introduces Kubernetes deployment support with a complete Helm chart, making it easier to deploy Libre WebUI in production environments. We've also enhanced the Docker development workflow with dedicated development builds and improved documentation.

### ✨ New Features

- **Kubernetes Support**: Added comprehensive Helm chart for Kubernetes deployments with configurable services, ingress, autoscaling, and Ollama integration
- **Development Docker Images**: Introduced dedicated `-dev` tagged Docker images for development builds
- **Enhanced Docker Compose**: Added GPU-enabled and external Ollama configurations for both development and production environments

### 🔧 Improvements

- **CI/CD Pipeline**: Automated Docker image building and Helm chart publishing workflows
- **Documentation**: Expanded README with comprehensive Docker and Kubernetes deployment guides
- **Development Experience**: Added development-specific Docker Compose configurations for various use cases
- **Version Display**: Settings modal now clearly shows `-dev` tag for development builds

## [0.3.1] - 2026-01-08

### What's New

This release focuses on security and stability improvements with a critical fix for plugin authentication handling and updated dependencies. The plugin service now properly respects authentication requirements, ensuring better security for authenticated environments.

### 🔧 Improvements

- Updated React Router to version 7.12.0 for enhanced security and performance

### 🐛 Bug Fixes

- Fixed plugin service to properly respect `no_auth_required` setting when filtering plugins by capability

## [0.3.0] - 2026-01-08

### What's New

This release introduces a comprehensive image generation system with gallery management, plugin support, and enhanced UI components. Major security improvements include rate limiting and vulnerability fixes, while the interface receives theme consistency updates and better navigation.

### ✨ New Features

- **Image Generation Plugin System**: Full plugin architecture supporting image generation with ComfyUI integration
- **Image Gallery**: Dedicated gallery page with lightbox viewer and organized image management
- **Enhanced Model Selector**: Improved model selection interface with expanded options
- **Plugin Credentials Service**: Secure credential management for plugin authentication

### 🔧 Improvements

- **Imagine Workflow**: Image generation now redirects to gallery page with additional options
- **Chat Input**: Removed auto-send behavior when generating images for better user control
- **Theme Consistency**: Primary theme colors now applied to Imagine page
- **Plugin Network Access**: HTTP connections now allowed for private network IPs

### 🐛 Bug Fixes

- **Security**: Added rate limiting and resolved format string vulnerabilities
- **Artifact Navigation**: Fixed navigation issues within iframe components
- **AMOLED Theme**: Drag handle now correctly uses purple accent color

## [0.2.9] - 2026-01-08

### What's New

This release introduces a major overhaul of the artifacts viewing experience with a new slide-out panel system and resizable interface. We've also added secure per-user API key storage for plugins, giving users better control over their plugin credentials.

### ✨ New Features

- **Artifacts slide-out panel**: View artifacts in a dedicated resizable panel with drag handle for better content inspection
- **Per-user plugin API keys**: Store and manage API keys securely on a per-user basis for enhanced plugin functionality

### 🔧 Improvements

- Enhanced input field styling consistency across dark and light themes
- Updated plugin interface with improved button alignment and status indicators

### 🐛 Bug Fixes

- Fixed artifact expand button visibility when titles are too long
- Prevented inline artifact height overflow by adding proper constraints
- Resolved package version synchronization issues
- Corrected plugin status dot visibility problems

## [0.2.8] - 2026-01-07

### 🐛 Bug Fixes

- Fixed crash when running via `npx libre-webui` - the backend couldn't find `package.json` to read the version number because the file path structure is different when installed via npm vs development. The server would start but immediately crash with "Cannot find module '../package.json'".

## [0.2.7] - 2026-01-06

### 🐛 Bug Fixes

- Fixed data persistence when running via npx (data now stored in `~/.libre-webui/`)
- Fixed first-time setup not showing encryption key to user

### 🔧 Improvements

- Changed default port to 8080 in production
- Added startup message with version and URL
- Browser now opens automatically on startup

## [0.2.6] - 2026-01-06

### What's New

This release fixes critical issues preventing `npx libre-webui` from running correctly.

### 🐛 Bug Fixes

- Fixed `__dirname is not defined` error in ESM modules (encryptionService)
- Fixed Express 5 wildcard route syntax (`*` → `{*splat}`)
- Fixed CORS blocking API requests when frontend is served from same port
- Fixed frontend not serving on root path in production
- Fixed frontend connecting to wrong API port in production builds
- Fixed route registration order (routes now register before error handlers)
- Fixed missing packages error when installing via npx

## [0.2.2] - 2026-01-05

### What's New

This release brings significant enhancements to the chat experience with live LaTeX formula rendering and improved UI navigation. The persona system has been upgraded with better memory capabilities and streamlined display, while new code-aware input features enhance developer workflows.

### ✨ New Features

- **Live LaTeX formatting** - Scientific formulas now render automatically in chat messages
- **Code-aware text input** - Enhanced text area with syntax highlighting and code-specific features
- **Copy button for messages** - Quickly copy any chat message content
- **Scroll-to-bottom button** - Easy navigation in long chat conversations
- **Media upload component** - New interface for uploading files and media

### 🔧 Improvements

- **Enhanced persona memory system** - Improved context retention and recall capabilities
- **Redesigned persona display** - Cleaner sidebar layout for persona and TTS controls
- **Better persona management** - Streamlined persona cards and quick-switch functionality
- **Code signing support** - Electron app builds now include code signing with fallback options
- **Updated dependencies** - Latest versions of development tools and GitHub Actions

### 🐛 Bug Fixes

- Fixed background image state conflicts between system and persona themes
- Resolved persona button z-index layering issues
- Improved sidebar display consistency for persona and TTS elements

## [0.2.1] - 2026-01-04

### What's New

This release introduces conversation branching functionality, allowing users to explore different response paths and regenerate AI responses while maintaining conversation history. We've also enhanced the visual experience with improved syntax highlighting and better text-to-speech handling for longer messages.

### ✨ New Features

- **Conversation Branching**: Create and navigate different response paths within conversations with persistent branching support
- **Response Regeneration**: Regenerate AI responses while preserving conversation branches
- **Desktop Application**: Added official desktop app support
- **Cosmic Space Theme**: New purple AMOLED theme with custom syntax highlighting

### 🔧 Improvements

- Updated title generation prompts for better conversation naming
- Enhanced syntax highlighter with optimized performance
- Improved settings interface with cleaner organization
- Updated documentation with new screenshots and v0.2.0 features

### 🐛 Bug Fixes

- Fixed text-to-speech chunking for large messages to prevent audio cutoffs
- Resolved background chat image display issues
- Fixed database saving to skip undefined values and prevent data corruption

## [0.2.0] - 2026-01-04

### What's New

This release introduces a native desktop app for macOS, comprehensive text-to-speech functionality, and enhanced model discovery with Ollama integration. The update also brings visual improvements with new themes and better chat experience features.

### ✨ New Features

- **Desktop App**: Native Electron app for macOS Silicon with DMG installer and proper macOS integration
- **Text-to-Speech**: Complete TTS system with voice selection, settings panel, and one-click message playback
- **Model Discovery**: Browse Library section with Ollama model discovery and installation
- **Auto-Title Generation**: Automatic chat session titles for better organization
- **Chain-of-Thought**: Support for `<thinking>` tag in AI responses
- **New Theme**: Purple/AMOLED theme option

### 🔧 Improvements

- Enhanced first-time setup wizard now displays encryption key
- Improved new session styling and user experience
- Better plugin support for images across Anthropic, Gemini, and OpenAI
- Updated model provider configurations
- Darkened background view for better readability

### 🐛 Bug Fixes

- Fixed background image persistence and user data isolation
- Resolved TTS voice settings not being saved or loaded properly
- Fixed macOS desktop app click issues and traffic light button overlap
- Corrected API URL handling in Electron file:// protocol
- Auto-retry backend connection when starting desktop app
- Fixed environment file path detection for encryption key generation

## [0.1.11] - 2025-12-16

### 🔒 Security Fixes

- **Fixed High-Severity Vulnerabilities:** Resolved 3 critical security issues identified by Dependabot
  - HIGH: glob CLI command injection via -c/--cmd (GHSA-5j98-mcp5-4vw2)
  - HIGH: auth0/node-jws improperly verifies HMAC signature
  - MODERATE: mdast-util-to-hast unsanitized class attribute (GHSA-4fh9-h7wg-q85m)
  - MODERATE: body-parser denial of service vulnerability
  - MODERATE: js-yaml prototype pollution in merge (GHSA-mh29-5h37-fv8m)
  - MODERATE: vite server.fs.deny bypass on Windows
- **Zero Vulnerabilities:** All security issues resolved via npm audit fix

### 🐛 Bug Fixes

- Fixed React linting errors for OAuth components (useEffect dependencies)
- Replaced Math.random() with React.useId() hook in form components for proper ID generation
- Resolved setState-in-effect warnings in useChat hook

### 🔧 Technical Improvements

- Updated 47+ dependencies for improved stability and security
- CI pipeline enhancements: actions/checkout (5→6), actions/setup-node (5→6)
- Code quality improvements to pass stricter React linting rules

## [0.1.10] - 2025-09-17

### 🎨 UI/UX Enhancements

- **Fixed SettingsModal Corner Rendering:** Resolved visual bug where header border overlapped with container's rounded corners, creating an imperfect border appearance in the upper corners
- **Enhanced Keyboard Shortcuts Indicator:** Repositioned the KeyboardShortcutsIndicator to the top-right corner for better visual hierarchy and accessibility
- **Improved SettingsModal Layout:** Enhanced responsive behavior and layout consistency across different screen sizes

### ⚙️ Developer Experience

- **Enhanced Update Script:** Added environment variable loading support to the update script tool, enabling dynamic configuration during plugin updates and system maintenance
- **Plugin System Improvements:** Streamlined the plugin update process with better environment configuration handling

### 🔧 Technical Improvements

- **Dependency Security Updates:** Comprehensive dependency updates including 47+ package updates across development and production dependencies
- **CI Pipeline Enhancements:** Updated GitHub Actions workflow dependencies (actions/setup-node v4→v5, actions/checkout v4→v5) for improved build reliability
- **Package Management:** Optimized package-lock.json for better dependency resolution and security

## [0.1.9] - 2025-08-04

### 📱 Mobile Experience Revolution

- **Responsive Sidebar System:** Completely redesigned mobile sidebar behavior with intelligent layout switching - compact sidebar pushes content on mobile while expanded sidebar overlays, ensuring optimal space usage
- **Unified Chat Input Design:** Transformed the chat input into a modern, integrated interface similar to ChatGPT/Claude with all controls (attachment, model selector, send button) seamlessly embedded within a single rounded container
- **Mobile-First Artifact Display:** Redesigned artifact preview components with responsive dimensions (256px on mobile, 320px on tablet, 384px on desktop) and intelligent vertical stacking to prevent content overflow
- **Smart Model Name Truncation:** Long model names now truncate gracefully with responsive width limits (128px mobile, 192px desktop) and hover tooltips showing full names

### 🎨 User Interface Enhancements

- **Vertical Artifact Headers on Mobile:** Artifact headers now stack title above buttons on mobile for better space utilization and touch accessibility
- **Perfect Icon Alignment:** Fixed all button icon centering issues in chat input and artifact components for pixel-perfect visual consistency
- **Compact Mobile Controls:** Ultra-compact artifact controls (20px buttons) on mobile with icon-only interface, expanding to full-sized buttons with labels on desktop
- **Seamless Textarea Integration:** Chat input textarea now blends invisibly into the input container with transparent background and perfect text alignment

### ✨ Added

- **Live System Message Updates:** Dynamic system message updating capability for real-time configuration changes
- **Responsive Breakpoint System:** Comprehensive responsive design with mobile (< 640px), tablet (640px-1024px), and desktop (≥ 1024px) specific layouts
- **Touch-Optimized Interactions:** Enhanced touch manipulation and proper tap targets for all mobile controls

### 🔧 Technical Improvements

- **Mobile-Responsive Component Architecture:** Complete refactoring of layout components to support dual desktop/mobile layouts with intelligent switching
- **Flexbox Layout Optimization:** Advanced flexbox implementations for perfect alignment and responsive behavior across all screen sizes
- **CSS Class Hierarchy:** Implemented comprehensive responsive class system with mobile-first approach and desktop enhancements
- **Container Overflow Management:** Added proper overflow handling and width constraints to prevent horizontal scrolling issues

### 🐛 Bug Fixes

- **Mobile Content Overflow:** Fixed artifact content appearing beside preview windows instead of below on mobile screens
- **Sidebar Overlay Issues:** Resolved sidebar positioning conflicts where content would be pushed off-screen or overlap incorrectly
- **Icon Alignment Problems:** Corrected vertical centering issues across all button icons in chat interface and artifact controls
- **Model Name Display:** Fixed long model names breaking layout and overlapping with other UI elements
- **Container Spacing:** Resolved inconsistent spacing and padding issues across mobile and desktop layouts

### 🚀 Performance Improvements

- **Reduced Mobile Bundle:** Optimized mobile interfaces with conditional rendering and smaller component sizes
- **Smooth Animations:** Enhanced transitions and hover effects for better user feedback
- **Touch Performance:** Improved touch responsiveness with proper touch-action CSS properties

### 📚 User Experience Impact

- **Consistent Cross-Device Experience:** Seamless functionality whether using mobile phone, tablet, or desktop
- **Modern Chat Interface:** Contemporary design matching leading AI chat applications
- **Improved Accessibility:** Better touch targets, readable text sizes, and intuitive navigation patterns
- **Professional Visual Polish:** Pixel-perfect alignment and consistent spacing throughout the interface

### ⚠️ Breaking Changes

- None. All changes are backward compatible and enhance existing functionality.

### 🎯 Developer Experience

- **Responsive Design Patterns:** Established reusable patterns for mobile-first responsive components
- **Component Architecture:** Modular approach to layout components supporting multiple screen sizes
- **CSS Utility System:** Comprehensive responsive utility classes for consistent styling

## [0.1.8] - 2025-08-01

### 🔒 Security Enhancements

- **Critical Persona Privacy Fix:** Fixed major security vulnerability where personas were accessible across users due to missing authentication middleware and fallback to 'default' user
- **Proper User Isolation:** Added authentication middleware (`optionalAuth`) to all user-context API routes ensuring complete user data isolation
- **Memory Privacy:** Fixed persona memory system to properly scope to the creating user, preventing cross-user memory access

### 📱 Mobile Experience Improvements

- **Enhanced Mobile Sidebar UX:** Redesigned mobile sidebar behavior - removed close button and replaced with smart compact/expand functionality
- **Improved Mobile Navigation:** Mobile users can now easily switch between chats without getting stuck - sidebar compacts instead of closing
- **Mobile Content Animation:** Fixed mobile content animation to slide right instead of compressing, preserving readability and maintaining proper proportions
- **Click-Away Support:** Added intelligent click-away detection that compacts expanded sidebar on mobile for better UX
- **Touch-Optimized Interactions:** Enhanced touch manipulation and improved button targets for better mobile usability

### ✨ New Features

- **Single Sign-On (SSO):** Complete GitHub and Hugging Face OAuth2 integration with secure token handling and enhanced user experience
- **Model Selector Enhancements:** Repositioned and added compact mode to ModelSelector component with improved UI/UX
- **AI-Powered Development Tools:** Integrated AI-powered changelog generation and development analysis tools for better project maintenance

### 🔧 Technical Improvements

- **Authentication Architecture:** Implemented proper authentication middleware across all API routes requiring user context
- **Memory System Refactoring:** Fixed parameter ordering and improved memory retrieval for persona-specific data
- **Code Quality:** Removed unused dependencies, fixed linting warnings, and optimized component performance with proper useCallback usage
- **OAuth Security:** Enhanced OAuth callback handling with better error handling and prevention of multiple executions
- **Docker Configuration:** Updated Docker files with improved OAuth environment variable support

### 🐛 Critical Bug Fixes

- **Persona Visibility Bug:** Resolved issue where personas created by one user were visible to other users
- **Memory Parameter Fix:** Corrected `getMemories()` parameter order that was causing memory lookup failures
- **Authentication Context:** Fixed missing user context in API calls that was causing fallback to 'default' user
- **Mobile Sidebar State:** Fixed mobile sidebar getting stuck in closed state without recovery options
- **useCallback Dependencies:** Resolved React Hook dependency warnings in PersonaCard component

### 📚 Documentation & Developer Experience

- **Enhanced Changelog Generation:** Improved AI-powered changelog generation with better categorization and clarity
- **OAuth Documentation:** Added comprehensive OAuth setup and configuration documentation
- **Mobile UX Guidelines:** Documented mobile-first design principles and touch interaction patterns

### ⚠️ Breaking Changes

- Personas created before this version may need to be reassigned to the correct user if they were incorrectly stored under 'default' user
- API routes now properly enforce user authentication - unauthenticated requests will no longer fall back to 'default' user context

### 🎯 User Impact

- **Enhanced Privacy:** Your personas and memories are now truly private and cannot be accessed by other users
- **Better Mobile Experience:** Significantly improved mobile navigation with intuitive sidebar behavior and proper content layout
- **Improved Security:** Enhanced user data isolation and proper authentication across all user-specific features
- **Smoother Interactions:** Better touch support and optimized animations create a more responsive mobile experience

## [0.1.7] - 2025-07-22

## Libre WebUI v0.1.7 - 2025-07-22

This release focuses on enhanced security and usability with the addition of Single Sign-On (SSO) options and improvements to the overall user experience. We've also invested in streamlining our development process with AI-powered tools for analysis and changelog generation.

**✨ New Features**

- **Single Sign-On (SSO):** Added support for GitHub and Hugging Face OAuth2, allowing users to easily log in with their existing accounts.
- **AI Development Analysis:** Introduced AI-powered tools to assist with development and provide insights into project health.
- **AI-Powered Changelog Generation:** Implemented automated changelog generation to improve release note accuracy and efficiency.

**🔧 Improvements**

- **OAuth Configuration:** Enhanced OAuth configuration handling for both GitHub and Hugging Face, providing clearer error messages and a more streamlined setup process.
- **Performance:** Optimized token management functions for improved application responsiveness.
- **Docker Support:** Updated Dockerfile and provided example environment variables for GitHub OAuth configuration in Docker Compose.

**🐛 Bug Fixes**

- **OAuth Handling:** Resolved issues with OAuth callback handling to prevent multiple executions and improve user feedback.
- **Emoji Display:** Corrected emoji display in documentation and improved overall formatting.
- **API URL Consistency:** Refactored API base URL handling for consistency across the application.

**📚 Documentation**

- Expanded documentation for AI Development Analysis and Changelog Regeneration scripts.
- Improved documentation formatting and clarity throughout the project.

--

## [0.1.6] - 2025-07-20

## Libre WebUI v0.1.6 - 2025-07-20

This release focuses on enhancing the user experience with improved streaming performance, a more refined chat interface, and expanded documentation. We've also streamlined the release process and improved overall stability. This version delivers a smoother and more feature-rich experience for both casual users and developers.

### ✨ Added

- **View Mode Toggle:** Introduced a toggle to switch between different viewing modes for artifact rendering, providing greater control over how outputs are displayed.
- **OpenRouter Support:** Expanded multi-AI support to include OpenRouter, offering users more flexibility in choosing their preferred AI providers.
- **Debugging Tools for Streaming:** Added initial debugging tools to assist in diagnosing and resolving issues with streaming performance.

### 🔧 Improved

- **Streaming Performance:** Significantly enhanced streaming performance through batching of messages, resulting in faster and more responsive chat interactions.
- **Chat Message Scrolling:** Improved scrolling behavior within the `ChatMessages` component, making it easier to follow conversations, especially during active streaming.
- **Model Update Instructions:** Enhanced instructions for updating models in the README, providing clearer guidance for users.
- **Release Process:** Streamlined the release process by incorporating code formatting _before_ committing changes, ensuring consistent code style across releases.

### 🐛 Fixed

- **README Typo:** Corrected a typographical error in the README front matter.
- **Release Script Error Handling:** Improved error handling and validation within the release script, making it more robust and reliable.

### 📚 Documentation

- **Documentation Layout:** Added necessary imports for `Tabs` and `TabItem` components to enhance the layout and organization of documentation pages.
- **Updated Documentation:** General documentation updates across multiple files (00-README.md, 01-QUICK_START.md, 02-WORKING_WITH_MODELS.md, 03-PRO_TIPS.md, 04-KEYBOARD_SHORTCUTS.md, 05-DEMO_MODE.md) to reflect the latest features and improvements.

### 🔒 Security

- No security-related changes in this release.

### ⚠️ Breaking Changes

- No breaking changes in this release.

### Technical Details

- **Streaming Optimization:** Implemented message batching during streaming to reduce network overhead and improve perceived responsiveness. This involved refactoring the message handling logic within the streaming component.
- **Release Process Automation:** The release process now includes a pre-commit hook that automatically formats code using a configured formatter (e.g., Prettier). This ensures consistent code style and reduces the risk of style-related merge conflicts.
- **Documentation Updates:** Documentation updates primarily focused on clarifying existing instructions and adding details about new features. The addition of `Tabs` and `TabItem` imports allows for more structured and organized documentation layouts.
- **Error Handling:** Improved error handling in the release script now includes more specific error messages and validation checks to identify and address potential issues during the release process.

### User Impact

- **Faster Chat Experience:** The streaming performance improvements result in a noticeably faster and more responsive chat experience, especially when interacting with AI models.
- **Improved Usability:** The enhanced scrolling behavior makes it easier to follow conversations and review past messages.
- **Clearer Guidance:** Updated documentation provides clearer instructions and guidance for using Libre WebUI, making it easier for new users to get started.
- **More Flexible AI Choices:** Support for OpenRouter expands the range of AI providers users can choose from.

---

## [0.1.5] - 2025-07-20

## Libre WebUI v0.1.5 - 2025-07-20

This release focuses on bolstering the core infrastructure of Libre WebUI, enhancing security, and significantly expanding documentation to empower both users and developers. We've added support for OpenRouter, improved key management for persistent storage, and streamlined the overall user experience through various refinements.

### ✨ Added

- **OpenRouter Support:** Integrated support for the OpenRouter API, allowing users to leverage a wider range of models and providers through the plugin system.
- **Persistent Storage for Encryption Keys:** Added support for Docker persistent storage for encryption keys, ensuring key security and availability across container restarts.

### 🔧 Improved

- **User Email Handling:** Updated user email handling to allow `null` values instead of requiring empty strings, providing greater flexibility in user data management.
- **JWT and Encryption Handling:** Enhanced JWT and encryption handling for improved security and reliability.
- **Docker Build Process:** Updated the Dockerfile to include additional dependencies for SQLite and OpenSSL, streamlining the local build process and improving compatibility.

### 🐛 Fixed

- **Changelog Generation:** Improved the changelog generation process in the release script to filter noise and better categorize commits, resulting in a cleaner and more informative changelog.
- **Linting Issues:** Addressed various linting issues throughout the codebase, improving code quality and maintainability.

### 📚 Documentation

- **Extensive Documentation Updates:** Significantly expanded documentation with new sections covering:
  - Plugin Architecture
  - RAG (Retrieval Augmented Generation) Feature
  - SQLite Migration
  - Authentication & Security
  - Artifacts Feature
  - Release Automation
  - Docker External Ollama Setup
  - Persona Development Framework
  - Community Charter
- **Development Branch Guide:** Added a guide for contributing to the development branch.
- **Outdated Database Encryption Removal:** Removed the outdated Database Encryption implementation, streamlining the codebase and focusing on the new, improved key management system.

### 🔒 Security

- **Enhanced Key Management:** Implemented support for Docker persistent storage for encryption keys, providing a more secure and reliable method for storing sensitive data.
- **JWT & Encryption Improvements:** Strengthened JWT and encryption handling to mitigate potential security vulnerabilities.
- **Security Documentation:** Expanded security documentation to provide users with a comprehensive understanding of the security features and best practices.

### ⚠️ Breaking Changes

- None in this release.

### Technical Details

- **SQLite & OpenSSL Dependencies:** The Dockerfile now explicitly includes SQLite and OpenSSL, ensuring consistent build environments and resolving potential dependency issues.
- **Encryption Key Storage:** Encryption keys are now designed to be stored persistently outside the container, preventing data loss on container restarts. This is achieved through volume mounting in Docker.
- **OpenRouter Integration:** The OpenRouter integration connects Libre WebUI to the OpenRouter API and its provider-backed model catalog.
- **JWT Handling:** JWTs are now generated and validated with enhanced security measures, including stronger algorithms and key rotation considerations.

### User Impact

This release provides a more robust and secure experience for all Libre WebUI users. The addition of OpenRouter expands model options, while improved documentation empowers users to customize and extend the platform. The enhanced security features protect user data and ensure a reliable and trustworthy experience. The streamlined build process and improved changelog make development and contribution easier for the community.

---

## [0.1.4] - 2025-07-17

## Libre WebUI v0.1.4 - 2025-07-17

This release focuses on enhancing the security and reliability of Libre WebUI, introducing database encryption and improved error handling. We've also made significant improvements to API rate limiting and streamlined dependency management. These changes aim to provide a more secure and robust experience for all users.

### ✨ Added

- **Automatic Encryption Key Generation:** Libre WebUI now automatically generates and stores an encryption key in the `.env` file during initial setup, simplifying the configuration process.
- **Database Encryption Service:** Implemented a robust database encryption service utilizing AES-256-GCM to protect sensitive user data at rest.

### 🔧 Improved

- **API Rate Limiting:** Enhanced rate limiting for the `/api/personas` route, allowing up to 500 requests per window. This prevents abuse and ensures service stability. Rate limiting logic has been refined across persona operations for better performance.
- **Error Handling:** Improved error handling in database migration and encryption processes, providing more informative error messages and preventing unexpected failures.
- **Preference Decryption:** Refactored the preference decryption logic for improved clarity and maintainability.

### 🐛 Fixed

- **Dependency Updates:** Updated `@napi-rs/canvas` and other core dependencies to the latest versions, resolving potential vulnerabilities and improving performance.
- **Header Component Dependencies:** Cleaned up unnecessary dependencies within the Header component, reducing bundle size and improving load times.

### 📚 Documentation

- **Changelog Updates:** Added an "Unreleased" section to the changelog to facilitate smoother release automation and tracking of upcoming changes.
- **README Updates:** Updated the README.md file with relevant information about the latest features and improvements.

### 🔒 Security

- **AES-256-GCM Encryption:** Implemented AES-256-GCM encryption for the entire database, protecting user data from unauthorized access. The encryption key is securely stored and managed.
- **Dependency Updates:** Updated dependencies to address potential security vulnerabilities.

### ⚠️ Breaking Changes

- None. This release does not introduce any breaking changes.

### Technical Details

- **Encryption Implementation:** The database encryption service utilizes AES-256-GCM with a randomly generated key stored in the `.env` file. This key should be treated as highly sensitive and protected accordingly.
- **Rate Limiting:** Rate limiting is implemented using a sliding window algorithm to provide a balance between performance and protection against abuse.
- **Dependency Management:** `package-lock.json` has been updated to ensure consistent dependency versions across all environments.
- **`.env` Configuration:** The `.env` file now includes a variable for the encryption key. Users should ensure this file is not committed to version control.

### User Impact

- **Enhanced Security:** Database encryption protects your personal data from unauthorized access, providing peace of mind.
- **Improved Reliability:** Enhanced error handling and dependency updates contribute to a more stable and reliable experience.
- **Faster Performance:** Dependency cleanup and optimized rate limiting contribute to improved performance and responsiveness.
- **Simplified Setup:** Automatic encryption key generation simplifies the initial setup process.

---

## [0.1.3] - 2025-07-16

## Libre WebUI v0.1.3 - 2025-07-16

This release focuses on enhancing the Persona management experience, improving security, and laying the groundwork for more advanced features like memory and mutation engines. We've also made significant improvements to documentation and developer tooling, making it easier to contribute and extend Libre WebUI.

### ✨ Added

- **Persona Management:** Implemented avatar and background image upload components within the PersonaForm for richer persona customization.
- **Memory & Mutation Engine Services:** Added core services for Memory and Mutation engines, paving the way for more dynamic and intelligent chatbot behavior.
- **Gemini Plugin Support:** Added support for the Gemini plugin, including specific payload formatting and response conversion.
- **Contributor Recognition:** Added a `CONTRIBUTORS.md` file to publicly acknowledge and thank project maintainers and community contributors.
- **Provider Plugin Enhancements:** Expanded provider plugin support for new services and models, increasing flexibility and choice.

### 🔧 Improved

- **Persona Export/Import:** Enhanced Persona export/import functionality to include embedding model, memory, and mutation settings, enabling complete persona backups and sharing.
- **Persona Interface:** Improved the Persona page layout and styles for a more intuitive user experience. Streamlined memory status display in the PersonaCard component.
- **Chat Input:** Updated the ChatInput component to display the version number and a warning message.
- **Embedding Model Selection:** Enhanced the Persona Development Framework section with dynamic embedding model selection and advanced memory systems documentation. The PersonaForm now supports dynamic model selection.
- **File Uploads:** Simplified API calls for file uploads by removing redundant headers, improving efficiency.
- **Dependency Management:** Updated dependencies across the project, ensuring compatibility and stability.

### 🐛 Fixed

- **Persona Download:** Improved error handling in the persona download function for more robust operation.
- **Network Access (Development):** Enabled network access for the development server using the `--host` flag, facilitating easier local testing.
- **Import Resolution:** Refactored imports to use file extensions, resolving potential import issues.

### 📚 Documentation

- **Persona Development Framework:** Expanded documentation to cover dynamic embedding model selection and advanced memory systems.
- **Contribution Guidelines:** Updated contribution guidelines to direct pull requests to the `dev` branch instead of `main`.

### 🔒 Security

- **SSRF Vulnerability:** Fixed a Server-Side Request Forgery (SSRF) vulnerability in `pluginService.ts`.
- **Format String Injection:** Fixed a format string injection vulnerability in `chatService.ts`.
- **JWT Secret Handling:** Updated JWT_SECRET handling for both production and development environments to improve security.
- **Rate Limiting:** Implemented rate limiting for persona operations to prevent abuse and ensure service availability. Reordered middleware and updated configuration for the `/api/personas` route to optimize rate limiting effectiveness. CodeQL analysis was performed to identify and address potential vulnerabilities.

### ⚠️ Breaking Changes

- None identified in this release.

### Technical Details

- **Docker Updates:** Updated the Dockerfile and package.json to ensure a consistent and reproducible build environment. Added a missing dependency (`lowlight`) to the Dockerfile.
- **CI/CD:** Updated the Docker build action to version 6.
- **Refactoring:** Removed unused components and cleaned up the codebase for improved maintainability. Simplified API calls and streamlined component rendering.
- **Rate Limiting Implementation:** Rate limiting is implemented using a token bucket algorithm with configurable limits per IP address.
- **Gemini Plugin Integration:** The Gemini plugin integration utilizes a specific payload format and response conversion logic to ensure compatibility with the Libre WebUI API.

---

## [0.1.2] - 2025-07-09

## Libre WebUI v0.1.2 - 2025-07-09

This release focuses on significantly expanding user personalization and management capabilities with the introduction of the Persona Development Framework. Alongside this, we’ve made substantial improvements to security, user experience, and core functionality like model pulling and chat interactions. This version delivers a more robust and customizable experience for all users.

### ✨ Added

- **Persona Development Framework:** Introduced a comprehensive framework for creating, managing, and utilizing custom personas within the chat interface. Users can now define unique personalities and backgrounds for their AI interactions.
- **Persona Import/Export:** Added functionality to export personas as JSON files, allowing for easy sharing and backup. Users can also import personas from existing JSON files.
- **Model Pulling with Streaming Progress:** Implemented a new model pulling mechanism with streaming progress updates and cancellation support, providing a more responsive and user-friendly experience when downloading models.
- **Conditional Keyboard Shortcuts Indicator:** Added a visual indicator to the chat interface to display available keyboard shortcuts, improving usability.
- **Loading Screen Branding:** Enhanced the loading screen during authentication with a logo and branding elements for a more polished user experience.

### 🔧 Improved

- **Chat Functionality with Persona Support:** Enhanced the chat functionality to seamlessly integrate with the Persona Development Framework. Users can now select and apply personas to their chat sessions.
- **Persona Management in Chat Sessions:** Improved chat session management to include persona selection and background application, ensuring consistent personality throughout the conversation.
- **User Management & CORS:** Enhanced user management features with optional password updates and improved CORS handling for multi-user environments.
- **Background Image Handling:** Improved background image handling for a more visually appealing and customizable interface.
- **Chat Input Enhancements:** Enhanced the ChatInput component with advanced features toggle and improved button layout for better usability.
- **Helmet Configuration:** Updated Helmet configuration with a production-ready Content Security Policy (CSP) for enhanced security.

### 🐛 Fixed

- **Persona Table Initialization:** Resolved an issue with the initialization of the persona table in the database.
- **Session Handling Redirection:** Corrected session handling to properly include the location pathname for redirection logic.
- **Raw JSON Response for Persona Download:** Fixed an issue where persona downloads were returning an API response wrapper instead of raw JSON.
- **Multi-User CORS Origin:** Resolved a CORS issue affecting multi-user environments.
- **Shell Command Injection Vulnerabilities:** Addressed and mitigated potential shell command injection vulnerabilities in release scripts.

### 📚 Documentation

- **Persona Development Framework Documentation:** Added comprehensive documentation detailing the Persona Development Framework, including instructions on creating, managing, and utilizing personas.

### 🔒 Security

- **Enhanced Security Headers & CSP:** Updated security headers and implemented a robust Content Security Policy (CSP) for improved protection against various attacks, especially for Docker deployments.
- **CSP Configuration for Production:** Fine-tuned the CSP configuration for production environments to maximize security without impacting functionality.

### ⚠️ Breaking Changes

- None identified in this release.

### Technical Details

- **Database Schema Update:** The persona table has been added to the database schema. Developers should ensure their database migrations are up-to-date.
- **API Endpoints:** New API endpoints have been added for persona management (creation, editing, deletion, import/export). Refer to the updated API documentation for details.
- **CORS Configuration:** The CORS configuration has been updated to allow for more flexible origin handling. Developers should review the configuration to ensure it meets their specific requirements.
- **CSP Configuration:** The CSP configuration has been significantly updated. Developers should review the configuration to ensure it aligns with their security policies and application requirements.
- **Chat Service Refactor:** The chat service has been refactored to integrate with the Persona Development Framework. Developers extending the chat service should be aware of these changes.
- **PersonaRow Interface:** The `PersonaRow` interface has been simplified by removing unused fields to improve code clarity and maintainability.

---

## [0.1.1] - 2025-07-07

## Libre WebUI v0.1.1 - 2025-07-07

This release focuses on significantly improving Docker deployment, enhancing configuration options, and streamlining the release process. We've added robust automation for releases and made it easier to customize and deploy Libre WebUI in various environments, including support for external Ollama instances. This version also lays the groundwork for future scalability and maintainability.

### ✨ Added

- **Automated Release System:** Implemented a fully automated release pipeline using conventional commits, enabling faster and more reliable releases. The release script now supports `--patch`, `--minor`, and `--major` flags for version bumping.
- **External Ollama Support (Docker):** The Docker setup now supports connecting to an external, pre-existing Ollama instance, providing greater flexibility in deployment scenarios.
- **Dynamic Version Display:** The application now dynamically displays the version number from `package.json` within the SettingsModal, ensuring users always have access to the current version information.
- **Configurable Data Directory:** Added the `DATA_DIR` environment variable, allowing users to specify the database path for persistent data storage.

### 🔧 Improved

- **Docker Deployment:** Major improvements to the Dockerfile and related files for multi-service startup, flexible frontend port configuration, and environment variable handling. WebSocket connection logic has been updated for improved stability.
- **Timeout Configurations:** Enhanced timeout configurations for both the Ollama service and API calls, improving responsiveness and reliability under varying network conditions.
- **Code Readability & Consistency:** Significant improvements to code formatting and consistency across the codebase, particularly within Docker-related files, enhancing maintainability and collaboration.

### 🐛 Fixed

- **Docker Configuration Issues:** Resolved several issues related to Docker deployment, including incorrect configurations and potential startup failures.
- **WebSocket Connection Stability:** Addressed issues with WebSocket connections within the Docker environment, improving the overall stability of the application.

### 📚 Documentation

- **Docker Documentation:** Updated the README with comprehensive documentation for Docker configurations, including instructions for external Ollama setup and environment variable usage. Improved table formatting for better readability.
- **General README Updates:** Clarified various sections of the README for improved user understanding.

### 🔒 Security

- No specific security changes in this release.

### ⚠️ Breaking Changes

- No breaking changes are introduced in this release.

### Technical Details

- **Conventional Commits:** The release process now leverages conventional commits for automated versioning and changelog generation.
- **Dockerfile Optimization:** The Dockerfile has been restructured to support multi-service startup and improved resource utilization.
- **Environment Variable Configuration:** The addition of `DATA_DIR` and improved handling of other environment variables provide greater control over application behavior.
- **WebSocket Updates:** WebSocket connection logic has been updated to handle potential connection issues and improve stability.

### User Impact

- **Easier Deployment:** The improved Docker configuration and external Ollama support make it significantly easier to deploy Libre WebUI in various environments.
- **Increased Customization:** The `DATA_DIR` environment variable allows users to customize data storage locations.
- **Enhanced Reliability:** Improved timeout configurations and WebSocket stability contribute to a more reliable and responsive user experience.
- **Automatic Updates:** The automated release system ensures users receive timely updates with new features and bug fixes.

---
