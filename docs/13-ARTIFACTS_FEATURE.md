---
sidebar_position: 2
title: 'Artifacts'
description: 'Render interactive HTML, SVG, JSON, code, and bundled multi-file outputs beside chat.'
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
- SVG blocks
- JSON blocks
- Code and text snippets

## Artifact Types

| Type      | Preview behavior                                              |
| --------- | ------------------------------------------------------------- |
| HTML      | Sandboxed iframe preview with scripts and interaction enabled |
| SVG       | Inline visual preview                                         |
| JSON      | Formatted code view                                           |
| Code/text | Syntax-highlighted code view                                  |
| React     | Captured as code; use HTML for direct browser preview         |

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
artifact is made of, and closes every network directive. A self-contained
artifact runs; one that pulls a script, stylesheet, font, or image from a CDN
does not, and neither can an artifact call home. Data and blob URLs stay
available for generated assets.

The frame itself allows scripts, forms, modals, popups, pointer lock, and
downloads, but never `allow-same-origin`, so an artifact runs on an opaque
origin with no access to the application's cookies, storage, or DOM. Its
feature policy allows clipboard access, fullscreen, and gamepad input.

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

For SVG:

```text
Return only one valid SVG code block with width, height, and viewBox.
```

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Pro Tips](./PRO_TIPS)
- [Working with Models](./WORKING_WITH_MODELS)
- [Troubleshooting](./TROUBLESHOOTING)
