---
sidebar_position: 63
title: 'Omarchy Plugin'
description: 'Put Libre WebUI in the Omarchy bar: server status, health, and a one-click launcher for the Omarchy Linux desktop.'
slug: /OMARCHY_PLUGIN
keywords:
  [
    libre webui,
    omarchy,
    omarchy plugin,
    omarchy linux,
    hyprland,
    arch linux,
    bar widget,
    ollama,
    self-hosted ai,
    local ai,
    status widget,
    launcher,
  ]
---

# Omarchy Plugin

Libre WebUI ships an official plugin for [Omarchy](https://omarchy.org), the opinionated Arch Linux + Hyprland desktop. One bar icon, one panel: whether your Libre WebUI server is up, which version it runs, how fast it answers, and a one-click launch into the app.

The plugin is **verified on the Omarchy plugin marketplace** — reviewed by a marketplace maintainer at the exact published commit.

- Marketplace listing: [plugins.omarchy.org → Libre WebUI](https://plugins.omarchy.org/plugin.html?id=org.librewebui.companion)
- Source repository: [libre-webui/omarchy-libre-webui](https://github.com/libre-webui/omarchy-libre-webui)

## What it does

- **Status at a glance** — the bar icon lights up when your server goes down; the panel shows online/offline, the running version, and response latency. The probe uses the unauthenticated `/health/live` endpoint, so no credentials are stored and it works against local and remote servers alike.
- **One-click launch** — open Libre WebUI as a chromeless web-app window (`omarchy-launch-webapp`) or a regular browser tab. Right-click the bar icon to launch directly.
- **Start it when it's down** — configure an optional start command (`systemctl --user start libre-webui`, `docker start libre-webui`, …) and a Start button appears whenever the server is offline, with fast re-probing until it answers.
- **Keyboard-first** — Enter opens the app, `R` refreshes, arrow keys and Escape behave like every other Omarchy panel.

## Install

```sh
omarchy plugin add https://github.com/libre-webui/omarchy-libre-webui.git --enable
```

Then add the widget to your bar from the bar settings. Don't have Libre WebUI yet? One command:

```sh
npx libre-webui@latest
```

and the widget's default server URL (`http://localhost:8080`) finds it immediately.

## Settings

| Setting          | Default                 | Purpose                                                             |
| ---------------- | ----------------------- | ------------------------------------------------------------------- |
| Server URL       | `http://localhost:8080` | Where your Libre WebUI server lives — local or remote.              |
| Refresh interval | 30 s                    | How often the health probe runs.                                    |
| Open as          | Web app window          | `omarchy-launch-webapp` app window vs `xdg-open` browser tab.       |
| Start command    | _(empty)_               | Optional command the Start button runs while the server is offline. |

## Mouse and IPC

| Action       | Effect             |
| ------------ | ------------------ |
| Left click   | Toggle the panel   |
| Right click  | Launch Libre WebUI |
| Middle click | Refresh now        |

The widget answers shell IPC, so you can bind keys in Hyprland:

```sh
omarchy-shell shell toggle org.librewebui.companion
```

Extra IPC verbs: `refresh`, `launch`.

## Remove

```sh
omarchy plugin remove org.librewebui.companion
```

## Security

The plugin is deliberately minimal: its only network access is the health probe against the server URL you configure, response bodies are size-capped at the producer, and the URL is never interpolated into shell text. The marketplace's security review covered exactly these properties; the full history is public in the [repository](https://github.com/libre-webui/omarchy-libre-webui) and the marketplace submission thread.
