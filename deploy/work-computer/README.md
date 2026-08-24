# Libre Work Computer image

A GUI-capable variant of the Work sandbox: a virtual desktop (Xvfb +
openbox with a tint2 dock), Chromium, and a loopback-only VNC server bridged to a WebSocket
(x11vnc + websockify), layered over the standard Work base image. Tasks
running this image under a policy with **Work Computer** enabled get a live,
watchable screen in the Work view.

The browser start page renders an offline, fully procedural Three.js valley
city inspired by the bundled desktop wallpaper. Its terrain, river, gardens,
architecture, sun, moon, stars, birds, and city lights follow the same browser
clock shown on screen. Chromium renders the scene through SwiftShader because
the sandbox has no physical GPU; the page does not load the wallpaper as a
texture or background.

## Pull (recommended)

CI publishes this image on every change to this directory, built on the
exact Work base pin from the application source:

```bash
docker pull ghcr.io/libre-webui/libre-work-computer:main   # or :dev
docker tag ghcr.io/libre-webui/libre-work-computer:main libre-work-computer:latest
```

Behind a filtered Docker API proxy that denies `/build`, this is the whole
install: pull and tag on the Docker host, then press **Enable**.

## Build

```bash
docker build \
  --build-arg WORK_BASE_IMAGE="node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3" \
  -t libre-work-computer:latest \
  deploy/work-computer
```

Use the same base your deployment already runs (the default above matches
the built-in `WORK_RUNTIME_IMAGE`), so shell tooling stays identical between
GUI and headless tasks.

## Enable it

The easy path: an administrator presses **Enable** on the Work Computer
card shown on the Work landing page. The backend builds this image from
its bundled copy of this directory and creates a ready **Work Computer**
policy automatically. When the image already exists on the daemon,
**Enable** skips the build and only creates the policy.

The manual path, for deployments that build images elsewhere — including
those behind a filtered Docker API proxy (such as
`deploy/private/docker-compose.work-proxy.yml`), which denies the build
endpoint on purpose:

1. Build (or push and pull) the image on the Docker host that runs Work
   sandboxes.
2. In **User management → Work policies**, create or edit a policy: set its
   **Image** to `libre-work-computer:latest` and check **Work Computer
   (GUI + browser)**.
3. Start a Work task under that policy (network access on). The **Screen**
   tab appears in the workspace pane; opening it starts the GUI session
   and connects the screen.

## What runs inside

`start-computer` (idempotent, invoked by the server when the screen is
opened) starts: Xvfb on display `:1` (1280×800), openbox with a baked-in wallpaper and a tint2 dock (Chromium and terminal launchers, running apps, clock), lxterminal available, Chromium maximized on a branded start page with an
isolated profile persisted at `/workspace/.browser-profile` (logins survive
container restarts), x11vnc bound to `127.0.0.1`, and websockify listening
on container port 6080 — the only network-reachable surface. The backend
publishes that port on the Docker host's loopback and re-authenticates
every viewer with a one-use, task-bound ticket.

Audio: PulseAudio plays into a null sink; its monitor is captured per
connection (`socat` + `parec`, raw s16le 44.1 kHz stereo) and served over a
second websockify bridge on container port 6081, published and
authenticated exactly like the screen. Silence transmits nothing — Pulse
suspends idle sources.

The VNC session has two per-session passwords generated at start (0600
passwd file in the state dir): the entry before `__BEGIN_VIEWONLY__`
grants full mouse/keyboard control and is released by the backend only to
the current takeover-lease holder; the entry after it is view-only and
goes to every authorized watcher. The VNC server itself keeps view-only
connections' input inert, so a leaked watch credential cannot drive the
screen.

xdotool and ImageMagick power the agent's `computer_observe` and
`computer_act` tools (screenshots in, OS-level input out). Chromium also
exposes its DevTools endpoint on the container's loopback (port 9222,
never published): the observe/act scripts read the active tab URL, page
focus, and focused-element identity from it for focus assertions and
outcome verification. It shares the trust domain of the DISPLAY the
sandbox already fully controls. Images built before this flag keep
working — the semantic signals are simply absent, and focus assertions
then fail closed — but rebuild to get them.

Overhead relative to the base image: ~650 MB on disk; a running GUI session
adds roughly 300–800 MB of memory depending on browser use. Size policies
accordingly (2g memory is a workable floor, 4g is comfortable).
