---
sidebar_position: 44
title: 'Recovery Readiness'
description: 'Inventory the state that must be coordinated for a reliable Libre WebUI backup and restore.'
slug: /RECOVERY_READINESS
---

# Recovery Readiness

Libre WebUI provides a read-only recovery inventory as the first backup and
restore safety gate. It reports what known state exists and which detected
conditions block a snapshot. It does not acquire a maintenance lock, copy,
encrypt, upload, delete, repair, or restore data.

```bash
npm run build:backend
npm run --silent recovery:check -- --json > recovery-inventory.json
```

The command exits with status `0` when no blockers are found, `1` when the
report is complete but recovery blockers exist, and `2` for invalid arguments
or an unexpected collection failure. Use `--data-dir PATH` or `--database PATH`
to inspect a non-default location. A default or `--data-dir` volume inventory
accepts only the canonical `DATA_DIR/data.sqlite` file and rejects hard-linked,
symlinked, or non-regular database/WAL/SHM entries. An explicit `--database`
path may be outside `DATA_DIR`, but the selected database and any companions
must still be regular files and cannot be symlinks.

The runtime also reads historical plugin definitions from the deterministic
backend package `plugins` directory and, for a relative `PLUGINS_DIR`, its
historical backend-relative location. Recovery inventories those active legacy
paths and blocks a volume-only snapshot when they contain custom definitions.
Packaged deployments may pass `--legacy-plugins-dir PATH` more than once when
their image layout relocates those compatibility directories.

For the private Compose deployment, run it inside the deployed container so
the report describes that container's mounted volume, code, and secrets:

```bash
docker exec libre-webui \
  node /app/backend/dist/cli/recoveryInventory.js \
  --json --data-dir /app/backend/data
```

## What the inventory checks

The versioned JSON report records:

- application, Node.js, operating-system, and architecture versions;
- SQLite file and WAL/SHM sizes, `quick_check`, foreign-key validation, schema
  fingerprint, user version, missing required tables, and no-follow source-file
  validation before a private inspection snapshot is created;
- data-directory readability, writability, file count, and byte count;
- the selected encryption-key source and a one-way 16-character fingerprint;
- no-follow, single-link validation for the persistent `.encryption_key` file;
- presence, counts, sizes, and data-directory inclusion for custom plugin
  definitions, plus the encrypted local blob root, embedded media, voice
  references, document text, legacy document vectors, and platform vectors
  with their ACL/filter rows;
- bounded, read-only authentication of every canonical local blob object and
  embedded platform-vector envelope, including full blob chunk/checksum
  verification and configured-key availability;
- bounded, read-only authentication of every recognizable legacy text
  AES-GCM envelope across chats, notes, documents, preferences, plugin
  secrets, gallery/media state, and account email, plus every AAD-bound saved
  voice name, recording, and transcript envelope;
- Work task/run/preview counts and the expected Docker volumes, Kubernetes
  PVCs, or hashed host-path identities; Docker volumes must carry both the
  managed label and the exact owning task ID;
- legacy media-generation job states plus durable jobs by state, attempts by
  outcome, event stream/event counts, and the last global event cursor;
- bounded, read-only authentication of every encrypted durable job and event
  payload, plus bounded syntax validation of every opaque reference payload;
  and
- explicit blockers, warnings, and data that lives outside the application
  data directory.

The report never includes encryption keys, JWT/session secrets, provider
credentials, plugin contents, user content, or literal host-workspace paths.
Only secret-presence booleans and the non-reversible encryption-key fingerprint
are emitted.

A read-only data mount is valid for recovery inspection and produces a warning,
not a blocker. Application readiness still requires writable storage; never
start Libre WebUI against the read-only snapshot used by the backup helper.

## Blockers

Treat any blocker as a failed recovery gate. Typical blockers include a
missing or corrupt database, an incomplete schema, an absent/conflicting key,
corrupt or unauthenticated legacy or platform ciphertext, exceeded
verification bounds,
an unreadable data directory, a linked or non-regular SQLite source, active
Work runs or previews, media jobs, or
durable jobs, a missing or incorrectly labelled Work workspace, durable event
head mismatches or sequence gaps, custom plugin definitions outside the data
directory, or a runtime control plane that cannot verify external workspaces.
Quiesce active work and resolve missing dependencies before taking the
snapshot; do not edit the report to hide a blocker.

Encrypted durable payloads are authenticated against their job/event identity
and validated as canonical bounded JSON. Opaque reference payloads are bounded
and syntax-checked only: the current substrate has no authoritative blob
reference repository with which recovery can prove target existence or access.
The report marks `referenceTargetsVerified` false and warns whenever such
references are present; it never exposes payload or reference values.

Legacy text fields predate a mandatory envelope marker, so genuine plaintext
rows from older schema generations remain readable and are not reported as
authenticated ciphertext. Canonical envelopes are always authenticated;
three-part values with an envelope-width IV or authentication tag fail closed
when malformed. Saved voice fields have an unambiguous binary envelope and are
always required to authenticate against their profile, owner, and field
identity. The JSON `encryption.legacyCiphertext` section reports authenticated
text/binary record and byte totals without exposing plaintext.

When schema v4's `users.email_lookup` column is present, recovery also
authenticates every non-null email and recomputes its domain-separated keyed
lookup token. A missing or mismatched token, or a token attached to a null
email, blocks the snapshot. Pre-v4 databases remain compatible because they do
not have this derived lookup column.

## Current backup boundary

The private-deployment backup helper archives the `libre-webui-data` volume,
validates it, and pairs it with the quiesced recovery inventory and a SHA-256
manifest. The archive remains unencrypted and unsigned. It does not include
Docker Work volumes, Kubernetes PVCs, host-bound workspace folders, external
model/provider state, or protected environment configuration. Keep those
exclusions visible and back them up independently until coordinated,
manifest-signed, operator-encrypted backup and clean-restore tooling lands.

When `PLUGINS_DIR` points outside `DATA_DIR`, recovery inventories that exact
directory and marks it as excluded from the application-volume archive. Any
definitions there block the volume-only snapshot until the operator arranges a
matching plugin-directory snapshot. The same rule applies to active legacy
plugin directories. Symlinked, non-regular, or unreadable JSON definitions are
always blockers and are never followed or silently omitted.

The v3 durable jobs/events schema is included in SQLite recovery inventory, but
no domain feature calls it, no handler worker is bootstrapped, and no admin API
or external worker exists. Its current rows can be checked and restored; this
does not claim production job processing is enabled.

For production, store encryption and JWT secrets in a protected secret
manager, keep backup archives off-host and encrypted, and test restores into a
clean compatible environment. The inventory is a preflight snapshot of known
state, not a maintenance lock or independent proof that every external resource
can be restored.
