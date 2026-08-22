# Libre Work Computer image

A GUI-capable variant of the Work sandbox: a virtual desktop (Xvfb +
fluxbox), Chromium, and a loopback-only VNC server bridged to a WebSocket
(x11vnc + websockify), layered over the standard Work base image. Tasks
running this image under a policy with **Work Computer** enabled get a live,
watchable screen in the Work view.

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

1. Build (or push and pull) the image on the Docker host that runs Work
   sandboxes.
2. In **User management → Work policies**, create or edit a policy: set its
   **Image** to `libre-work-computer:latest` and check **Work Computer
   (GUI + browser)**.
3. Start a Work task under that policy (network access on). The **Screen**
   tab appears in the workspace pane; opening it starts the GUI session and
   connects the view-only screen.

## What runs inside

`start-computer` (idempotent, invoked by the server when the screen is
opened) starts: Xvfb on display `:1` (1280×800), fluxbox, Chromium with an
isolated profile persisted at `/workspace/.browser-profile` (logins survive
container restarts), x11vnc bound to `127.0.0.1` in view-only mode, and
websockify listening on container port 6080 — the only network-reachable
surface. The backend publishes that port on the Docker host's loopback and
re-authenticates every viewer with a one-use, task-bound ticket.

xdotool and ImageMagick are preinstalled for upcoming phases (agent control
of the desktop, takeover, teach mode) so this image will not need to change.

Overhead relative to the base image: ~650 MB on disk; a running GUI session
adds roughly 300–800 MB of memory depending on browser use. Size policies
accordingly (2g memory is a workable floor, 4g is comfortable).
