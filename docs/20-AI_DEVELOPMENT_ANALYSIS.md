---
sidebar_position: 3
title: 'AI Development Analysis'
description: 'Use local Ollama models to generate changelog summaries and development analysis.'
slug: /AI_DEVELOPMENT_ANALYSIS
keywords:
  [
    ai development analysis,
    ollama development tools,
    ai changelog generation,
    local ai development,
  ]
image: /img/social/20.png
---

# AI Development Analysis

Libre WebUI includes repository scripts that can use local Ollama to summarize changes, generate changelog drafts, and inspect project health. These tools are for maintainers and run from the local checkout.

## Scripts

| Command                        | Purpose                                       |
| ------------------------------ | --------------------------------------------- |
| `npm run changelog`            | Generate a conventional changelog preview     |
| `npm run changelog:ai`         | Generate an AI-assisted changelog             |
| `npm run changelog:ai:summary` | Generate a concise AI summary                 |
| `npm run changelog:ai:impact`  | Generate technical impact notes               |
| `npm run analyze`              | Run project analysis with optional AI insight |
| `npm run analyze:quick`        | Run analysis without AI                       |
| `npm run analyze:metrics`      | Print metrics only                            |

## Requirements

- Ollama running locally or reachable through `OLLAMA_BASE_URL`
- A local model installed
- Git history available in the repository

Good local model choices:

```bash
ollama pull gemma3:4b
ollama pull qwen3:8b
```

The scripts expose model overrides:

```bash
CHANGELOG_AI_MODEL=gemma3:4b npm run changelog:ai
ANALYSIS_AI_MODEL=qwen3:8b npm run analyze
```

If Ollama is unavailable, the changelog scripts fall back to non-AI generation where supported.

## Environment Variables

| Variable             | Purpose                                             |
| -------------------- | --------------------------------------------------- |
| `OLLAMA_BASE_URL`    | Ollama server URL, default `http://localhost:11434` |
| `CHANGELOG_AI_MODEL` | Model used by AI changelog scripts                  |
| `ANALYSIS_AI_MODEL`  | Model used by development analysis                  |

## Good Release Notes

Use AI output as a draft, then edit it. A good changelog entry should:

- Describe user-visible changes first.
- Group fixes, features, docs, and internal work.
- Avoid implementation noise unless it affects users or operators.
- Mention breaking changes clearly.
- Link to commits or pull requests when useful.

## Related Docs

- [Release Automation](./RELEASE_AUTOMATION)
- [Model Updater](./MODEL_UPDATER)
- [Working with Models](./WORKING_WITH_MODELS)
