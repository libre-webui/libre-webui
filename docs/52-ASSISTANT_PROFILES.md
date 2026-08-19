---
sidebar_position: 52
title: 'Assistant Profiles'
description: 'Personas compose model, prompt, tools, skills, and knowledge into one reusable assistant.'
slug: /ASSISTANT_PROFILES
keywords: [assistant profiles, personas, bindings, composition]
---

# Assistant Profiles

Personas have grown into assistant profiles: beyond a model, generation
parameters, avatar, and optional memory, a persona can now bind the
resources an assistant composes.

## Bindings

| Binding               | Effect                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Prompt                | The bound library prompt's rendered content leads the persona's own system prompt.           |
| Tool servers          | Sessions using the profile offer only these registered servers (of those the user may use).  |
| Built-in tools        | Restricts the built-in tools offered; empty means all available.                              |
| Skills                | Restricts the skill manifest to these skills.                                                 |
| Knowledge collections | Scopes the `search_documents` tool to these collections.                                      |
| Voice                 | A TTS provider and voice identity for clients that read replies aloud.                        |

Bindings carry a revision counter that advances on every change, and they
are validated structurally when saved. Authorization is never frozen at
bind time: every bound resource is re-resolved against the invoking user's
effective permissions when the persona is used, so a revoked grant takes
effect immediately.

## Sharing

Personas remain shareable through the common resource-grant model, and the
existing persona memory, mutation, and DNA export features are unchanged.
