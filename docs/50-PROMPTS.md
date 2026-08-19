---
sidebar_position: 50
title: 'Prompt Library'
description: 'Reusable slash-command prompts with typed variables, versions, and sharing.'
slug: /PROMPTS
keywords: [prompts, prompt library, slash commands, variables, templates]
---

# Prompt Library

Prompts are reusable instruction templates with a slash-command identity.
Each prompt has a slug (`/review-pr`), a title, optional description and
tags, template content, and typed variables.

## Variables

Content references variables as `{{name}}`. Every referenced variable must
be declared, and each declaration is typed: `text`, `number`, `select`
(with options), or `boolean`, optionally required and with a default. When
a prompt is inserted in the composer, its variables are collected before the
content is rendered.

## Versions

Updating a prompt bumps its version and archives the prior revision. The
history view lists revisions; a rollback restores an old revision as a new
version, so the trail stays linear and nothing is silently rewritten.

## Sharing, export, and import

Prompts are private by default and shareable through the common
resource-grant model (read or write, to users or groups). Export produces a
`libre-prompt.v1` JSON document; import recreates it, refusing a slug
collision unless overwrite is requested. Prompt titles, descriptions,
content, variables, and tags are encrypted at rest; the slug stays plain so
slash lookup works.

## Profiles

An assistant profile can bind one prompt; the rendered content then leads
the profile's own system prompt for every session using that profile.
