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

HTML artifacts run in an iframe sandbox that allows scripts, forms, modals, popups, pointer lock, downloads, clipboard access, fullscreen, and gamepad access. This is enough for most generated demos and games while keeping them isolated from the main application shell.

Artifacts can still execute code inside their sandbox. Treat untrusted generated code like any other code before downloading or reusing it outside Libre WebUI.

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

- [Pro Tips](./PRO_TIPS)
- [Working with Models](./WORKING_WITH_MODELS)
- [Troubleshooting](./TROUBLESHOOTING)
