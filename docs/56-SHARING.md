---
sidebar_position: 56
title: 'Sharing'
description: 'Grant-based sharing for chats, personas, prompts, skills, and knowledge.'
slug: /SHARING
keywords: [sharing, grants, permissions, collaboration, access control]
---

# Sharing

Every shareable resource in Libre WebUI moves through one grant model:
owner → user or group principals → `read`, `write`, or `admin`
permission. There is no per-feature permission system to learn twice, and
the global administrator role deliberately confers **no** access to
private content — administration is a feature-level power, not a content
read.

## What can be shared

| Resource              | Read means                              | Write means                          |
| --------------------- | --------------------------------------- | ------------------------------------ |
| Chats                 | Open and read the conversation          | — (chats stay owner-writable)        |
| Notes                 | Read the note                           | Edit content (revisions still apply) |
| Knowledge collections | Documents join your search and RAG      | —                                    |
| Personas              | Use the persona in your own chats       | —                                    |
| Prompts               | Use the prompt from the composer        | Edit it (versioned)                  |
| Skills                | Load the skill in your chats            | Edit it (versioned)                  |
| Calendars             | See its events beside your own          | Create and edit events in it         |
| Tool servers          | Call the server's tools (when granted)  | —                                    |

Shared resources appear in the recipient's own lists tagged with the
owner and permission; deletion always stays with the owner.

## How access is decided

Every read re-runs the same authorization decision
(`owner → direct grant → group grant`), so revoking a grant or removing
someone from a group applies on their very next request — nothing is
cached into staleness. Shared knowledge collections additionally publish
their grant set into the vector index ACL, so retrieval enforces exactly
the same permission as a direct fetch, inside the query, without
re-embedding anything on share or revoke.

## The share dialog

Each surface uses the same dialog: choose **User** or **Group**, enter
the exact name (there is deliberately no fuzzy search — sharing confirms
a name you already know rather than enumerating accounts), pick the
permission, done. Existing grants list with resolved display names and a
one-click revoke. Recipients get an in-app notification when something
is shared with them.

## What sharing is not

- Sharing a chat never lets the recipient generate into it; model calls
  always run under the invoking user's own credentials and access.
- Sharing a persona exposes its definition, never the owner's persona
  memories or evolution state.
- There are no anonymous public links; every share is to an
  authenticated user or group on the instance.
- Session folders do not cascade-share their chats yet; share chats
  individually.
