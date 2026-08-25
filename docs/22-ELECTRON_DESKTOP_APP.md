---
sidebar_position: 1
title: 'Desktop App'
description: 'Install the Libre WebUI desktop application for macOS, Windows, and Linux, and connect it to a local or remote server.'
slug: /ELECTRON_DESKTOP_APP
keywords:
  [
    libre webui desktop,
    desktop app,
    macos app,
    windows app,
    linux app,
    native app,
    dmg installer,
    offline ai chat,
  ]
---

# 🖥️ Desktop App

The Libre WebUI desktop app wraps the web interface in a native window for
macOS, Windows, and Linux. It connects to a Libre WebUI server: one running on
the same machine, or any server you point it at.

The app is developed in
[its own repository](https://github.com/libre-webui/libre-webui-desktop);
installers for every release are attached to the main repository's
[GitHub releases](https://github.com/libre-webui/libre-webui/releases).

## 📦 Download and Install

Grab the package for your platform from the
[latest release](https://github.com/libre-webui/libre-webui/releases/latest):

- **macOS (Apple Silicon)**: `Libre-WebUI-Desktop-{version}-mac-arm64.dmg`
  or `.zip`, or `brew install --cask libre-webui/tap/libre-webui-desktop`
- **Windows**: `Libre-WebUI-Desktop-Setup-{version}.exe` (installer) or
  `Libre-WebUI-Desktop-{version}.exe` (portable)
- **Linux**: `Libre-WebUI-Desktop-{version}.AppImage` or
  `Libre-WebUI-Desktop-{version}-{arch}.deb`

Releases before the rename shipped these assets under the
`Libre-WebUI-Frontend` prefix with an app bundle named
`Libre WebUI Frontend.app`.

### macOS blocks the app as damaged

Libre WebUI temporarily uses an ad-hoc signature for macOS builds. This keeps
the application bundle structurally valid, but it does not identify the
publisher to Apple and cannot be notarized. After copying the application to
Applications, approve it in **System Settings → Privacy & Security → Open
Anyway**.

If macOS does not offer that option, remove the quarantine attribute only after
verifying that the application came from the official Libre WebUI release:

```bash
xattr -dr com.apple.quarantine "/Applications/Libre WebUI Desktop.app"
open "/Applications/Libre WebUI Desktop.app"
```

Do not disable Gatekeeper globally. Seamless distribution still requires a
Developer ID Application certificate and Apple notarization.

## 🔌 Connecting to a Server

The app is a client; it needs a Libre WebUI server. On first launch a landing
screen offers two paths:

- **Local**: the app probes for a server on your machine (port 3001, the
  default for the Docker image and `npx libre-webui`) and connects when its
  health check answers.
- **Remote**: enter the URL of any reachable Libre WebUI server, such as a
  homelab or team deployment. The app verifies it before connecting.

Your choice is remembered. To change servers later, use
**Libre WebUI → Switch Server…** in the menu bar. If a remembered server stops
answering, the app returns to the landing screen instead of a blank window.

To run a local server, see [Quick Start](./QUICK_START): Docker Compose,
`npx libre-webui`, and Homebrew all work.

## 🧰 Work in the Desktop App

The desktop package does not bundle the backend, Docker, or a Work container
runtime. Work availability is determined by the server it connects to:

- a native backend that can run `docker info` can create task-scoped Work
  containers and named volumes;
- the standard repository Compose deployment provides Docker-backed Work by
  mounting the host Docker socket, while a custom container deployment without
  a reachable runtime reports Work as unavailable;
- a Kubernetes server provides Pod/PVC-backed Work when the Helm chart is
  installed with `work.enabled=true`; and
- the app continues to support Chat when Work is unavailable.

Work files live on the server's Docker host or Kubernetes storage, not inside
the desktop app. Previews travel through Libre WebUI's signed same-origin
proxy, so local and remote desktop clients can use them when the server's
reverse proxy preserves HTTP and WebSocket traffic.

## 🎨 Desktop Integration

- Native menu bar with app, edit, view, window, and help menus
- Custom macOS title bar (`hiddenInset`) with traffic lights in the sidebar
- Dark mode follows the system preference
- External links open in your default browser, never inside the app
- The renderer runs with context isolation and without Node integration

## 🚧 Limitations

- **macOS architecture**: current macOS packages support Apple Silicon
  (`arm64`) only
- **Requires a server**: the app does not bundle the backend
- **Work depends on the server runtime**: no Docker or Kubernetes runtime is
  included
- **No auto-updates**: updates require downloading a new package

---

See [Work: Isolated Workspaces](./WORKSPACES) for runtime, provider, storage, and
preview security details.
