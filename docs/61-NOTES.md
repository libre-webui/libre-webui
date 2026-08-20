---
sidebar_position: 61
title: 'Notes'
description: 'Durable Markdown notes with revision restore, attachments, sharing, export, and reversible AI-assisted edits.'
slug: /NOTES
keywords: [notes, markdown, revisions, attachments, sharing, ai editing]
---

# Notes

Notes are durable Markdown documents that live independently of a chat or Work
task. Use them for a brief, research record, checklist, draft, or any material
you want to keep while conversations and model choices change.

The Notes page opens existing notes in read-only preview. Choose **Edit** when
you intend to change one; edits autosave after a short delay. The list is
searchable, pinned notes stay prominent, and Cmd/Ctrl-K can search inside your
own and shared note content without maintaining a plaintext search index on
disk.

## Markdown preview and export

The preview renders standard Markdown, including tables. It also supports basic
inline HTML and SVG after sanitization: scripts, event handlers, and unsafe URLs
are removed before the result reaches the page.

**Export** downloads the current note content as a `.md` file. This export is
plain text and contains neither attachments nor revision history; protect it as
you would any other copy of the note.

## Revisions and restore

Every title or content change snapshots the previous title and content before
the update commits. The **Revisions** tab shows the retained versions and a
line-by-line diff against the current note. Restoring an older revision first
snapshots the current state, so a restore can itself be reversed.

Libre keeps the newest 50 revisions per note. Changing only the pinned state
does not create a content revision.

## Attachments

The **Attachments** tab uploads, lists, downloads, and deletes files associated
with a note. A note may carry up to 10 attachments, each no larger than 10 MiB.
Attachment bytes use the platform blob store under the note owner's identity,
so owner quota, encryption, backup, and deletion behavior follow the selected
solo or team storage profile.

Downloads reauthorize access to the note, use `private, no-store`, are served as
attachments with `nosniff`, and do not render arbitrary uploaded content inline.
Libre does not currently scan attachment bytes for malware. Treat files from
other people as untrusted after download.

## Sharing

An owner can grant another authenticated user:

- **Read** — open the note, view revisions, and download attachments.
- **Write** — additionally edit content, restore a revision, manage
  attachments, and use AI-assisted editing.

Authorization is checked on every request, so revoking a grant applies on the
next read or write. Only the owner can pin, share, revoke shares, or delete the
note. The global administrator role does not itself confer access to private
note content.

Notes are not public links and the editor is not a simultaneous collaborative
document surface: there is no presence indicator, shared cursor, or merge
protocol for two people editing at once.

## AI-assisted edits

The **Assist** tab sends an instruction, note title, and current Markdown to the
model and provider selected in the application. The model returns a complete
proposed replacement. Libre displays that proposal as a diff; **Discard** makes
no change, while **Apply** uses the ordinary update path and therefore keeps the
previous state as a revision.

Generating a proposal does not persist it. Applying it does. A remote provider
receives the note content and instruction under that provider's retention,
privacy, and billing terms; choose a local model when the note must stay on your
configured Ollama infrastructure. An assist instruction is limited to 4,000
characters, and a proposal must fit the normal note content limit.

## Notes as chat tools

When [Chat Tools](./49-CHAT_TOOLS.md) are enabled, supported models can use:

- `list_notes` and `read_note` for authorized own or shared notes;
- `create_note`, which requires side-effect approval; and
- `update_note`, which also requires approval and snapshots the previous
  content as a revision.

The note tools operate under the invoking user's identity. They read Markdown
content, not attachment bytes. Incognito chats do not offer tools.

## Storage, encryption, and portability

Titles, content, and retained revisions are encrypted at rest by the
application encryption service. Attachments use the encrypted platform blob
store. This is application-layer protection, not full-disk or end-to-end
encryption; secure the database, blob storage, backups, and encryption keys as
one deployment boundary.

The versioned per-user archive includes current Notes and their pinned state. It
deliberately excludes revision history and attachments. A complete server
recovery therefore requires the database, encryption material, and relevant
blob storage rather than only a user archive. See
[Data Portability](./41-DATA_PORTABILITY.md) and
[Recovery Readiness](./44-RECOVERY_READINESS.md).

## Limits

| Item | Limit |
| ---- | ----- |
| Notes owned per user | 100 |
| Title | 200 characters |
| Markdown content | 200,000 characters |
| Retained revisions per note | 50 |
| Attachments per note | 10 |
| Attachment size | 10 MiB each |
| AI edit instruction | 4,000 characters |

## API

All routes require an authenticated session or an API token with the `notes`
scope. Shared-note access follows the same read/write rules as the interface.

| Method | Path | Purpose |
| ------ | ---- | ------- |
| `GET` | `/api/notes` | List own and shared notes |
| `POST` | `/api/notes` | Create a note |
| `GET` | `/api/notes/:noteId` | Read one note |
| `PUT` | `/api/notes/:noteId` | Update content, title, or pinned state |
| `DELETE` | `/api/notes/:noteId` | Delete an owned note |
| `GET` | `/api/notes/:noteId/revisions` | List retained revisions |
| `POST` | `/api/notes/:noteId/revisions/:revisionId/restore` | Restore a revision |
| `GET` | `/api/notes/:noteId/attachments` | List attachments |
| `POST` | `/api/notes/:noteId/attachments` | Upload an attachment |
| `GET` | `/api/notes/:noteId/attachments/:attachmentId` | Download an attachment |
| `DELETE` | `/api/notes/:noteId/attachments/:attachmentId` | Delete an attachment |
| `POST` | `/api/notes/:noteId/assist` | Generate a non-persisted edit proposal |

## Related Docs

- [Sharing](./56-SHARING.md)
- [Chat Tools](./49-CHAT_TOOLS.md)
- [Authentication & Security](./12-AUTHENTICATION.md)
- [Database Encryption](./19-DATABASE_ENCRYPTION.md)
- [Data Portability](./41-DATA_PORTABILITY.md)
- [Pro Tips](./03-PRO_TIPS.md)
