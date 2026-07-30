---
sidebar_position: 2
title: 'SQLite Storage'
description: 'How Libre WebUI stores application data with SQLite.'
slug: /SQLITE_MIGRATION
keywords: [sqlite, database, storage, migration, data directory]
image: /img/social/10.png
---

# SQLite Storage

Libre WebUI stores application data in SQLite by default. The storage layer keeps chats, messages, users, preferences, documents, document chunks, personas, plugin credentials, memories, and related metadata in one local database.

## Database Location

The backend uses this location order:

1. `DATA_DIR` when set.
2. `backend/data` from the project root.

The SQLite file is named `data.sqlite`.

Example:

```env
DATA_DIR=/var/lib/libre-webui
```

## What SQLite Stores

- Users and roles
- Sessions and messages
- Preferences and UI settings
- Documents and chunks
- Personas and persona settings
- Persona memories and mutation state
- Plugin credentials and their routing/auth bindings, variables, per-user
  activations, writable-definition approvals, and discovered model catalogs
- System settings
- Work task ownership, model/provider routing, runs, messages, tool activity,
  status, and Docker resource identifiers

Sensitive values are encrypted at the application layer when they pass through the encrypted storage helpers.

## Work Storage Is Split

Work conversation and task metadata live in SQLite, but Work files do not. Each
task receives a dedicated Docker named volume mounted at `/workspace`. The
container is replaceable execution state; the named volume is the task's durable
filesystem.

This means a database backup by itself is not a complete Work backup. Back up
the corresponding Docker volumes using your Docker host's volume-backup process.
Libre WebUI labels managed Work volumes with
`ai.libre-webui.managed=true` and the owning task ID.

Deleting a Work task permanently removes its SQLite records and managed named
volume. Cancelling a run, stopping a preview, or restarting the backend does not
delete its files.

## JSON Compatibility

Older Libre WebUI installs used JSON files for some data. Current builds use SQLite as the primary storage path and keep storage access behind service/model layers so the rest of the app does not need to know the persistence format.

If you are upgrading an old install, back up the whole data directory before starting the newer backend.

Legacy plugin activation in `.status.json` is migrated once into per-user
SQLite rows for accounts that exist at upgrade time, but only for exact
hash-anchored bundled definitions. Legacy custom and shadow definitions remain
quarantined until an administrator re-imports them, and approval does not
restore old activation rows. Later accounts start with no active plugins, and
each account's activation changes are independent.

## Backup

Stop the backend before copying the database:

```bash
cp -R backend/data backend/data.backup
```

For deployments using `DATA_DIR`:

```bash
cp -R "$DATA_DIR" "$DATA_DIR.backup"
```

If the instance uses Work, also back up every managed Work named volume while
the backend is stopped. Keep the database, encryption key, and Work-volume
backup from the same point in time.

## Restore

Stop the backend, replace the data directory with your backup, then restart. Keep the same `ENCRYPTION_KEY`; encrypted values cannot be decrypted with a different key.

For Work, restore the named volumes under the exact names recorded in the
restored database before starting the backend. Libre WebUI can recreate a task
container, but it cannot reconstruct missing workspace files from the
conversation history.

## Operational Notes

- SQLite runs with WAL enabled for better concurrent reads.
- The data directory must be writable by the backend process.
- Keep `DATA_DIR` on persistent storage in Docker and Kubernetes.
- Back up `ENCRYPTION_KEY` together with the database.
- Account for Work named volumes separately when measuring, migrating, or
  restoring storage.

## Related Docs

- [Database Encryption](./DATABASE_ENCRYPTION)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
- [Kubernetes](./KUBERNETES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
