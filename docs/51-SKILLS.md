---
sidebar_position: 51
title: 'Skills'
description: 'Markdown skills the model loads lazily by slug.'
slug: /SKILLS
keywords: [skills, instructions, manifest, load_skill, workspace]
---

# Skills

A skill is a named set of Markdown instructions the model loads only when it
needs them. Each skill has a slug (`$docs-style`), a display name, a short
description, and the full instructions.

## Lazy loading

The description is the manifest: when tools are enabled for a turn, the
built-in `load_skill` tool lists every enabled skill's slug, name, and
description, and the model fetches the full instructions with one call. Long
instructions therefore never occupy context until they are used. Mentioning
`$slug` in a message nudges the model toward loading that skill.

## Lifecycle

Skills can be disabled without deleting them; a disabled skill leaves the
manifest and refuses to load. Updates bump the version and archive the prior
revision, with rollback restoring any revision as a new version. Export
produces a `libre-skill.v1` JSON document and import recreates it. Names,
descriptions, and instructions are encrypted at rest; the slug stays plain.

## Sharing and profiles

Skills are private by default and shareable through the common
resource-grant model. An assistant profile can bind a subset of skills, and
sessions using that profile only see those skills in the manifest.

## Example

Create a skill under **Settings → Skills** (or pick one of the starter
templates there and edit it):

- Slug: `cite-sources`
- Name: `Cite sources`
- Description: `How to cite evidence: numbered references with URLs, no
unreferenced claims.` (this line is what the model sees in the manifest —
  make it say when to use the skill)
- Instructions:

  ```markdown
  # Citing sources

  - Every factual claim gets a numbered reference like [1].
  - End with a References section: number, title, URL.
  - If no source exists, say so instead of inventing one.
  ```

Enable the tools toggle in the composer and ask:

> Summarize the latest results and $cite-sources.

Typing `$` autocompletes your skill slugs. The model sees `cite-sources`
in its manifest, calls `load_skill` to fetch the instructions above, and
formats the answer accordingly. Disable the skill on its card and it
disappears from the manifest without being deleted.
