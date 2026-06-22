---
sidebar_position: 2
title: 'Personas'
description: 'Create reusable AI personas with model settings, prompts, memory, and import/export.'
slug: /PERSONA_DEVELOPMENT_FRAMEWORK
keywords: [personas, ai personalities, memory, persona import, persona export]
image: /img/social/16.png
---

# Personas

Personas let you save a reusable assistant profile with its own model, system prompt, generation settings, avatar/background, and optional memory behavior.

## What a Persona Stores

- Name and description
- Model ID
- Avatar and background
- System prompt
- Temperature, top-p, top-k, context window, max tokens, and penalties
- Optional embedding model
- Optional memory settings
- Optional mutation/adaptation settings

Persona data is scoped per user.

## Create a Persona

1. Open **Personas** from the sidebar.
2. Create a new persona.
3. Choose a model.
4. Write the system prompt.
5. Tune generation parameters.
6. Save and start a chat with that persona.

## Recommended Uses

| Persona            | Useful settings                                      |
| ------------------ | ---------------------------------------------------- |
| Code reviewer      | Low temperature, concise prompt, coding model        |
| Editor             | Medium temperature, writing style instructions       |
| Research assistant | Document Chat enabled, embedding model installed     |
| Creative partner   | Higher temperature, larger max token budget          |
| Support agent      | Strict tone and response format in the system prompt |

## Parameter Limits

Libre WebUI validates persona settings before saving:

| Parameter      | Range         |
| -------------- | ------------- |
| Temperature    | 0 to 2        |
| Top P          | 0 to 1        |
| Top K          | 1 to 100      |
| Context window | 128 to 131072 |
| Max tokens     | 1 to 8192     |

## Memory

Persona memory stores selected interactions as searchable memories. Memories include content, context, timestamps, importance scores, memory type, access counts, decay data, and optional embeddings.

Memory features include:

- Memory status and statistics
- Core memory retrieval
- Memory wipe
- Similar-memory consolidation
- Global decay

Semantic memory search uses the configured embedding model. `nomic-embed-text` is a good local starting point.

## Mutation State

When mutation settings are enabled, Libre WebUI stores a runtime state for the persona. The mutation engine can track mood, learned preferences, interaction patterns, and a mutation log based on conversation signals.

This is stateful assistant behavior, not a guarantee of autonomous reasoning. Keep prompts and settings explicit for production workflows.

## Import and Export

Personas can be exported as JSON and imported into another Libre WebUI instance. Exports include the persona configuration and advanced settings where present.

There is also a DNA-style export route that includes the persona, memories, and mutation log when those records exist.

## Related Docs

- [Working with Models](./WORKING_WITH_MODELS)
- [Document Chat](./RAG_FEATURE)
- [Database Encryption](./DATABASE_ENCRYPTION)
