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
- Plugin credentials and variables
- System settings

Sensitive values are encrypted at the application layer when they pass through the encrypted storage helpers.

## JSON Compatibility

Older Libre WebUI installs used JSON files for some data. Current builds use SQLite as the primary storage path and keep storage access behind service/model layers so the rest of the app does not need to know the persistence format.

If you are upgrading an old install, back up the whole data directory before starting the newer backend.

## Backup

Stop the backend before copying the database:

```bash
cp -R backend/data backend/data.backup
```

For deployments using `DATA_DIR`:

```bash
cp -R "$DATA_DIR" "$DATA_DIR.backup"
```

## Restore

Stop the backend, replace the data directory with your backup, then restart. Keep the same `ENCRYPTION_KEY`; encrypted values cannot be decrypted with a different key.

## Operational Notes

- SQLite runs with WAL enabled for better concurrent reads.
- The data directory must be writable by the backend process.
- Keep `DATA_DIR` on persistent storage in Docker and Kubernetes.
- Back up `ENCRYPTION_KEY` together with the database.

## Related Docs

- [Database Encryption](./DATABASE_ENCRYPTION)
- [Docker](./DOCKER)
- [Kubernetes](./KUBERNETES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
