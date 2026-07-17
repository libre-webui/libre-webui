# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### ✨ New Features

- Added a bundled Kimi Code provider for Moonshot AI's OpenAI-compatible API, with Kimi K3, Kimi K2.7 Code, and Kimi K2.7 Code HighSpeed model profiles, streaming, configurable generation valves, and per-user or environment-based credentials.

### 🔧 Improvements

- Aligned Helm chart, application, and Docker image versions with each release; pinned the 0.14.1 transition to its verified multi-architecture digest while preserving explicit tag overrides; made subsequent Kubernetes deployments use the chart `appVersion`; and limited chart publication to releases whose default Docker image exists.
- Made the local release command run the complete format, lint, security, package, build, and npm publish dry-run gate before it creates a release commit or tag.

### 🐛 Bug Fixes

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
