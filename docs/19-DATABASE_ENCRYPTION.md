---
sidebar_position: 4
title: 'Database Encryption'
description: 'Application-level AES-256-GCM encryption and key handling in Libre WebUI.'
slug: /DATABASE_ENCRYPTION
keywords:
  [database encryption, aes-256-gcm, libre webui security, encrypted storage]
image: /img/social/19.png
---

# Database Encryption

Libre WebUI includes an application-level encryption service for sensitive values before they are written to storage.

## Encryption Method

The backend uses AES-256-GCM through Node.js crypto. The encryption key must be 32 bytes, represented as a 64-character hex string:

```env
ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
```

Generate a key:

```bash
openssl rand -hex 32
```

## Key Storage

Libre WebUI loads the key in this order:

1. `ENCRYPTION_KEY` from the environment.
2. A persisted `.encryption_key` file under `DATA_DIR` or `backend/data` for Docker/data-dir installs.
3. A newly generated key.

If no key is found, the backend generates one and stores it:

- In persistent data storage when `DATA_DIR` is set or Docker mode is enabled.
- In `backend/.env` for regular development.

## Important Key Rules

- Back up `ENCRYPTION_KEY` with the database.
- Do not rotate the key unless you have a migration plan for encrypted values.
- Losing the key means encrypted values cannot be recovered.
- Changing the key without re-encrypting data will make existing encrypted values unreadable.

## What This Protects

Encryption is applied by code paths that use the encryption service or encrypted storage helpers. It is designed for sensitive application values such as credentials and private user data handled by those helpers.

It is not full-disk encryption, SQLite page encryption, or end-to-end encryption between users and the browser. Use disk encryption and HTTPS for those layers.

### Work Data

Application-layer encryption does not encrypt an entire Work task. Work source
files and project dependencies are ordinary files in task-scoped Docker named
volumes. Work conversations, tool results, command output, and task metadata are
stored in SQLite and are not automatically encrypted merely because some
credential-storage paths use the encryption service.

Protect the Docker data root and `DATA_DIR` with access controls and disk
encryption when required. Back up the database, `ENCRYPTION_KEY`, and managed
Work volumes together. Sending a Work task to a remote model can also disclose
conversation context and requested file or command output to that provider;
storage encryption does not change that network boundary.

## Docker and Kubernetes

Set a stable key explicitly for production:

```env
ENCRYPTION_KEY=replace-with-64-hex-characters
DATA_DIR=/data
```

Mount `DATA_DIR` on persistent storage. In Kubernetes, store the key in a Secret and mount data on a PersistentVolume.

## Troubleshooting

**Invalid key length**

The key must be exactly 64 hex characters. Generate a new one with:

```bash
openssl rand -hex 32
```

**Data cannot be decrypted after redeploy**

Confirm the same `ENCRYPTION_KEY` is used and the same `DATA_DIR` volume is mounted.

**Development generated a new key**

Restart after the backend writes the generated key to `backend/.env`, or set `ENCRYPTION_KEY` manually.

## Related Docs

- [SQLite Storage](./SQLITE_MIGRATION)
- [Work: Isolated Workspaces](./WORKSPACES)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Docker](./DOCKER)
- [Kubernetes](./KUBERNETES)
