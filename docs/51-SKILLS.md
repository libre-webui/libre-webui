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
revision, with rollback restoring any revision as a new version. The
interchange form is a `SKILL.md` document — frontmatter carrying the name,
slug, and description, followed by the Markdown instructions verbatim —
which export downloads and import accepts alongside the JSON envelope.
Names, descriptions, and instructions are encrypted at rest; the slug stays
plain.

## Importing from a store

Skills can be pulled straight from a remote source under **Settings →
Skills → From URL**. Accepted forms: a [skills.sh](https://skills.sh)
listing link, a GitHub repository or tree/blob URL, an `owner/repo/skill`
shorthand (resolved against the conventional `skills/<name>/SKILL.md`
layout), or a direct link to any SKILL.md file. The fetch runs through the
same pinned egress guard as tool servers — public addresses only, size
capped — and the document lands as your own editable skill, so a remote
source never updates itself silently.

## Bundled files

A skill can carry companion files in the `SKILL.md` folder layout —
reference documents, templates, and script sources the instructions point
at. `load_skill` lists the bundle at the end of the instructions, and the
model reads a file on demand with the `read_skill_file` tool, so a large
reference never occupies context until it is actually needed.

Files travel everywhere the skill does: **Settings → Skills → From
folder** uploads a local SKILL.md folder in one step, a remote import
pulls the text files sitting next to the fetched SKILL.md, the JSON export
carries the bundle, and the edit modal manages files one by one. Paths are
relative and can never escape the skill; contents are text-only, encrypted
at rest, and bounded (32 files, 200 KB each, 1 MB per skill).

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
