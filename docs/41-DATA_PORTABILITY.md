# Data portability

Libre WebUI can export and import a versioned, per-user JSON archive from
**Settings → Data Management**. The archive is intended for moving supported
personal data between Libre WebUI installations or restoring that data into an
account. It is not a complete server backup.

## Archive version 2

The current format is identified by:

```json
{
  "format": "libre-webui-user-data",
  "version": 2
}
```

The backend creates the export from authenticated, user-scoped database
queries. It contains:

- user preferences, except a selected reusable voice-profile reference;
- chat folders;
- chat sessions, messages, branches, ratings, artifacts, and per-chat
  settings;
- knowledge collections;
- extracted document content and metadata, session/collection associations,
  and text chunks.

Document embeddings are not exported because they are derived data. Regenerate
embeddings after import when semantic retrieval is enabled. Libre WebUI stores
the extracted text used by RAG, not the original uploaded PDF or text-file
bytes, so an archive cannot recreate the original upload byte-for-byte.

Each archive includes an `exclusions` list. Version 2 deliberately excludes:

- accounts, passwords, login sessions, and OAuth state;
- provider credentials and encrypted plugin variables;
- cloned voice reference recordings and transcripts;
- personas, notes, and persona memory;
- generated image, audio, and video library files;
- Work tasks, runs, sandboxes, and Docker or Kubernetes volumes.

Use a database/data-directory backup with the same `ENCRYPTION_KEY` for full
server recovery. Work also requires a consistent backup of its named volumes.
See [SQLite migration and backup](./10-SQLITE_MIGRATION.md) and
[Work workspaces](./33-WORKSPACES.md#backup-and-restore).

## Safe import behavior

The browser asks the backend to preflight an archive before importing it. The
preflight validates the complete schema, supported version, resource counts,
IDs, timestamps, relationships, and content bounds without writing data. The
backend repeats validation and conflict planning inside the import operation.
All writes occur in one SQLite transaction; an error rolls back preferences,
folders, sessions/messages, collections, documents, and chunks together.

Two conflict policies are available:

- **Skip duplicates** keeps records with matching IDs and imports new records.
  Preferences are merged with the account's current preferences.
- **Overwrite existing** replaces records with matching IDs. Preferences are
  replaced over Libre WebUI defaults. Records that are absent from the archive
  are never deleted.

Both policies are idempotent for records with matching IDs. If an ID is already
owned by another account on the target server, Libre WebUI deterministically
remaps it and all included references. It never overwrites or reads another
user's resource. References to excluded or unavailable resources, such as a
persona from another installation, are removed.

The result shown in Settings reports created, overwritten, and skipped counts
for folders, sessions, collections, and documents. Warnings identify migrations,
ID remapping, and detached references.

## Legacy archives

The importer accepts the former `libre-webui-export` version `1.0` shape and
migrates it during validation. That browser-generated format contained
preferences and the sessions loaded in that browser. Its `documents` array was
always empty, and it did not contain folders, knowledge collections, or
document chunks. The importer cannot recover data that was never present in a
legacy file and reports this limitation as a warning.

## HTTP endpoints

All endpoints require the authenticated user's bearer token or session:

| Method | Endpoint                            | Purpose                             |
| ------ | ----------------------------------- | ----------------------------------- |
| `GET`  | `/api/preferences/export`           | Build the current user's v2 archive |
| `POST` | `/api/preferences/import/preflight` | Validate and plan without writes    |
| `POST` | `/api/preferences/import`           | Validate and import transactionally |

The web UI sends the archive as a `multipart/form-data` field named `archive`
and the conflict policy as a `strategy` field. The upload limit is 50 MB. For
smaller API-driven migrations, the two POST endpoints also accept JSON:

```json
{
  "data": { "format": "libre-webui-user-data", "version": 2 },
  "strategy": "skip"
}
```

`strategy` is either `skip` or `overwrite`. For compatibility with the former
preferences-only client, `mergeStrategy: "merge"` maps to `skip` and
`mergeStrategy: "replace"` maps to `overwrite`.
