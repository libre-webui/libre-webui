# Data portability

Libre WebUI can export and import a versioned, per-user JSON archive from
**Settings → Data Management**. The archive is intended for moving supported
personal data between Libre WebUI installations or restoring that data into an
account. It is not a complete server backup.

## Archive version 3

The current format is identified by:

```json
{
  "format": "libre-webui-user-data",
  "version": 3,
  "integrity": {
    "algorithm": "sha256",
    "canonicalization": "libre-json-sort-v1",
    "digest": "<64 lowercase hexadecimal characters>"
  }
}
```

The backend creates the export from authenticated, user-scoped database
queries. It contains:

- user preferences, except a selected reusable voice-profile reference;
- chat folders;
- chat sessions, messages, branches, ratings, artifacts, and per-chat
  settings;
- standalone Notes;
- knowledge collections;
- extracted document content and metadata, session/collection associations,
  and text chunks.

Document embeddings are not exported because they are derived data. Regenerate
embeddings after import when semantic retrieval is enabled. Libre WebUI stores
the extracted text used by RAG, not the original uploaded PDF or text-file
bytes, so an archive cannot recreate the original upload byte-for-byte.

Each archive includes an `exclusions` list. Version 3 deliberately excludes:

- accounts, passwords, login sessions, and OAuth state;
- provider credentials and encrypted plugin variables;
- cloned-voice reference recordings and transcripts, which are biometric data
  and require separate consent-aware handling;
- personas and persona memory;
- generated image, audio, and video library files;
- Work tasks, runs, sandboxes, and Docker or Kubernetes volumes.

Use a database/data-directory backup with the same `ENCRYPTION_KEY` for full
server recovery. Work also requires a consistent backup of its named volumes.
See [SQLite migration and backup](./10-SQLITE_MIGRATION.md) and
[Work workspaces](./33-WORKSPACES.md#deletion-account-changes-and-backup).

## Integrity and export validation

Version 3 protects the archive payload with a SHA-256 integrity digest. The
`libre-json-sort-v1` canonical form omits the top-level `integrity` field,
sorts every JSON object's keys lexicographically, preserves array order, and
hashes the resulting compact JSON as UTF-8. Import rejects a version 3 archive
whose digest does not match, even if its JSON remains syntactically valid.

This digest detects accidental corruption and post-export changes. It is not a
digital signature, does not authenticate who created the file, and does not
make the archive confidential. Treat an archive like any other copy of the
user's private chats and Notes.

Before offering a download, export runs the same schema, field-size, ID, and
archive-count checks used by import. It also verifies that the pretty-printed
JSON downloaded by the web UI is no larger than the 50 MiB upload limit. Export
returns a precise validation error instead of offering a file that Libre WebUI
already knows it cannot restore.

Current archive and account limits are:

- 50 MiB per uploaded or generated archive;
- 100 chat folders;
- 5,000 chat sessions;
- 100,000 chat messages;
- 100 Notes, with titles up to 200 characters and content up to 200,000
  characters;
- 5,000 knowledge collections;
- 5,000 documents;
- 100,000 document chunks;
- individual general content fields up to 2,000,000 characters and IDs up to
  256 characters, with narrower bounds where the runtime resource does so.

## Safe import behavior

Selecting a file asks the backend to preflight it immediately. Settings shows
the incoming totals, projected create/overwrite/skip counts, ID remaps, and
migration warnings before enabling the final Import action. Changing the
conflict policy calculates and displays a fresh preview.

Preflight verifies the integrity digest where available, migrates supported old
formats, validates the complete schema, resource counts, unique IDs,
timestamps, content bounds, and included relationships, and plans conflicts and
reference remapping without writing data. Dangling folder, collection,
message-parent, or document associations are rejected instead of being
silently dropped. The backend repeats validation and conflict planning for the
actual import. All writes occur in one database transaction on both supported
SQLite and PostgreSQL backends; an error rolls back preferences, folders,
sessions/messages, Notes, collections, documents, and chunks together.

Two conflict policies are available:

- **Skip duplicates** keeps records with matching IDs and imports new records.
  Preferences are merged with the account's current preferences.
- **Overwrite existing** replaces records with matching IDs. Preferences are
  replaced over Libre WebUI defaults. Records absent from the archive are never
  deleted.

Both policies are idempotent for records with matching IDs. If an ID is already
owned by another account on the target server, Libre WebUI deterministically
remaps it and every included reference to it. It never overwrites or reads
another user's resource. References to excluded or unavailable resources, such
as a persona from another installation, remain a documented exception: the
preflight reports that the session will be detached before import.

The result shown in Settings reports created, overwritten, and skipped counts
for folders, sessions, Notes, collections, and documents. After a successful
import, Libre reloads preferences, chats, and folders and refreshes documents.

## Older archives

The importer accepts version 2 `libre-webui-user-data` archives and migrates
them to version 3 during validation. Version 2 did not have an integrity digest
and did not contain Notes, so Libre cannot verify its origin or recover Notes
that were never exported. The preflight preview states both limitations.

The importer also accepts the former `libre-webui-export` version `1.0` shape.
That browser-generated format contained preferences and only the sessions
loaded in that browser. Its `documents` array was always empty, and it did not
contain folders, Notes, knowledge collections, or document chunks. Libre
reports these migration limitations before import.

## HTTP endpoints

All endpoints require the authenticated user's bearer token or session:

| Method | Endpoint                            | Purpose                             |
| ------ | ----------------------------------- | ----------------------------------- |
| `GET`  | `/api/preferences/export`           | Build the current user's v3 archive |
| `POST` | `/api/preferences/import/preflight` | Validate and plan without writes    |
| `POST` | `/api/preferences/import`           | Validate and import transactionally |

The web UI sends the archive as a `multipart/form-data` field named `archive`
and the conflict policy as a `strategy` field. The upload limit is 50 MiB. For
smaller API-driven migrations, the two POST endpoints also accept JSON:

```json
{
  "data": { "format": "libre-webui-user-data", "version": 3 },
  "strategy": "skip"
}
```

`strategy` is either `skip` or `overwrite`. For compatibility with the former
preferences-only client, `mergeStrategy: "merge"` maps to `skip` and
`mergeStrategy: "replace"` maps to `overwrite`.
