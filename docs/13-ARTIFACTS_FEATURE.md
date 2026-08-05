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
a CDN, the application vendors what they ask for and serves it from
`/artifact-runtime` on its own origin:

| Available to artifacts                                             | How it is reached                   |
| ------------------------------------------------------------------ | ----------------------------------- |
| React and ReactDOM                                                 | `import ... from 'react'`           |
| JSX and TSX                                                        | compiled in the frame by Babel      |
| Tailwind utilities                                                 | generated from the markup, no build |
| Recharts, Lucide icons, D3, Three.js, Chart.js, Papa Parse, Lodash | `import ... from '<name>'`          |
| Mermaid                                                            | `mermaid` artifacts, or by import   |

React artifacts are compiled and mounted in the sandbox: export the component
as the module default and it renders. Every library shares one React instance,
so hooks behave normally.

HTML artifacts that load a library from a CDN still work — a `<script>` or
`<link>` pointing at Tailwind, Chart.js, D3, Three.js, Papa Parse, Lodash,
Mermaid, React or Babel is redirected to the local build in the same document
position, so inline scripts still find `Chart`, `d3`, or `React` when they run.
A library outside that set is simply unavailable; inline it instead.

Because the frame has an opaque origin, `localStorage` and `sessionStorage`
throw inside an artifact. Keep state in memory.

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
