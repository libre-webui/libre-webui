---
sidebar_position: 2
title: 'Artifacts'
description: 'Render interactive HTML, React components, Mermaid diagrams, SVG, JSON, and code beside chat.'
slug: /ARTIFACTS_FEATURE
keywords:
  [
    libre webui artifacts,
    interactive ai content,
    html preview,
    svg preview,
    sandboxed rendering,
  ]
image: /img/social/13.png
---

# Artifacts

Artifacts turn model-generated files and code blocks into a previewable side panel. They are useful for games, diagrams, HTML demos, JSON payloads, scripts, and generated assets.

Artifacts are different from [Work](./WORKSPACES). An artifact is created from
a normal chat response and rendered in the browser; it does not give the model a
persistent filesystem or shell. A Work task keeps durable project files and
conversation history, and runs model tools inside a task-scoped Docker
container.

## Supported Inputs

Libre WebUI detects:

- Explicit `<artifact>` blocks
- Fenced code blocks with artifact-friendly languages
- Standalone full HTML documents
- Multi-file HTML bundles made from `index.html`, CSS, and JavaScript blocks
- JSX and TSX components
- Mermaid diagrams
- SVG blocks
- JSON blocks
- Code and text snippets

## Artifact Types

| Type      | Preview behavior                                                   |
| --------- | ------------------------------------------------------------------ |
| HTML      | Sandboxed iframe preview with scripts and interaction enabled      |
| React     | JSX or TSX compiled and mounted, with Tailwind and the library set |
| Mermaid   | Diagram drawn in the sandbox, themed with the application          |
| SVG       | Inline visual preview                                              |
| JSON      | Formatted code view                                                |
| Code/text | Syntax-highlighted code view                                       |

## Multi-File HTML Bundles

When a model returns related HTML, CSS, and JavaScript blocks, Libre WebUI tries to merge them into a runnable HTML artifact. It removes local stylesheet/script references and inlines matching generated CSS and JavaScript.

For the most reliable result, ask the model for one self-contained HTML file:

```text
Create a complete self-contained HTML file with inline CSS and JavaScript.
It should run in a browser without local files.
```

## Viewer Controls

Artifacts open in a resizable side panel with:

- Preview and Code tabs
- Copy
- Download
- Open in new window
- Expand/fullscreen controls where available

If an interactive artifact needs keyboard input, click inside the preview first or open it in a new window.

## Sandbox Behavior

HTML artifacts load through `GET /api/artifacts/sandbox`, a small backend
document that hosts the preview. The indirection matters: an `srcdoc` frame
inherits the embedder's Content Security Policy, and the application policy
forbids inline scripts, so artifacts rendered that way are blocked in
production. The sandbox host is fetched over the network instead, so it carries
its own policy, and the preview frame it creates inherits that one.

The artifact policy allows inline script and `eval`, because that is what an
artifact is made of, and names no host but this application's own. An artifact
can render and compute; it cannot fetch from a CDN, and it cannot call home.

The frame itself allows scripts, forms, modals, popups, pointer lock, and
downloads, but never `allow-same-origin`, so an artifact runs on an opaque
origin with no access to the application's cookies, storage, or DOM. Its
feature policy allows clipboard access, fullscreen, and gamepad input.

## The Artifact Runtime

Generated artifacts assume libraries are available. Rather than let them reach
a CDN, the application vendors what they ask for:

| Available to artifacts                                        | How it is reached                   |
| ------------------------------------------------------------- | ----------------------------------- |
| React, ReactDOM, Framer Motion                                | `import ... from 'react'`           |
| JSX and TSX                                                   | compiled in the frame by Babel      |
| Tailwind utilities                                            | generated from the markup, no build |
| Recharts, Chart.js, Plotly, D3                                | `import ... from '<name>'`          |
| Three.js with controls, loaders, environments and more addons | `THREE.OrbitControls`, or by import |
| Lucide icons, Lodash, MathJS, Papa Parse, Tone.js             | `import ... from '<name>'`          |
| Mermaid                                                       | `mermaid` artifacts, or by import   |

An artifact that reaches for a library outside this set gets a notice naming
it, rather than a blank preview and a policy error in the console.

The frame never fetches any of it. The application page — which carries the
user's session — loads the bundles it needs and inlines them into the artifact
document, and the artifact's own `import` statements are compiled to lookups
against a small registry rather than left as network module resolution.

That indirection is not incidental. A sandboxed frame has an opaque origin, so
the browser treats its requests as cross-site and sends no session cookie.
Behind an authenticating proxy — Cloudflare Access, Authelia, oauth2-proxy —
such a request comes back as a redirect to a login page, which the sandbox
policy then refuses to load, and the artifact fails with a Content Security
Policy error. Inlining removes the request, so artifacts behave the same on a
laptop and behind a corporate gate.

React artifacts are compiled and mounted in the sandbox: export the component
as the module default and it renders. Every library resolves React from the
same registry, so there is one React instance and hooks behave normally.

HTML artifacts that load a library from a CDN still work — a `<script>` or
`<link>` pointing at Tailwind, Chart.js, D3, Three.js, Papa Parse, Lodash,
Mermaid, React or Babel is replaced by the vendored build inline, in the same
document position, so inline scripts still find `Chart`, `d3`, or `React` when
they run. A library outside that set is unavailable; inline it instead.

Because the frame has an opaque origin, real `localStorage`, `sessionStorage`
and `document.cookie` throw. The sandbox supplies in-memory stand-ins so an
artifact that uses them keeps running; the contents last as long as the preview
does and are not shared with the application.

Artifacts still execute generated code: inspect untrusted HTML before
downloading or reusing it outside the preview, and do not place secrets in an
artifact.

## Better Prompts

For games:

```text
Build a complete browser game as one HTML file.
Use canvas.
Inline all CSS and JavaScript.
Show controls on screen.
Avoid external assets unless they are optional.
```

For dashboards:

```text
Create one self-contained HTML dashboard.
Use semantic HTML, responsive CSS, and no build step.
Include sample data inline.
```

For React components:

```text
Return one React component in a single jsx block.
Export it as the default export.
Style it with Tailwind classes.
Import anything you need from react, recharts, or lucide-react.
```

For SVG:

```text
Return only one valid SVG code block with width, height, and viewBox.
```

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Pro Tips](./PRO_TIPS)
- [Working with Models](./WORKING_WITH_MODELS)
- [Troubleshooting](./TROUBLESHOOTING)
