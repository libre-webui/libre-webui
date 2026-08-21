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
libre-webui recovery-check --json > recovery-inventory.json
```

From a source checkout, run `npm run build:backend` once and replace
`libre-webui recovery-check` with `npm run recovery:check --`. Packaged npx and
Homebrew installs inspect `~/.libre-webui` by default; `DATA_DIR` and explicit
path options override that location.

The command exits with status `0` when no blockers are found, `1` when the
report is complete but recovery blockers exist, and `2` for invalid arguments
or an unexpected collection failure. Use `--data-dir PATH` or `--database PATH`
to inspect a non-default location. A default or `--data-dir` volume inventory
accepts only the canonical `DATA_DIR/data.sqlite` file and rejects hard-linked,
symlinked, or non-regular database/WAL/SHM entries. An explicit `--database`
path may be outside `DATA_DIR`, but the selected database and any companions
must still be regular files and cannot be symlinks. When `--database` is used
without `--data-dir`, recovery treats the database's parent as its data root so
the matching key, blobs, and plugin definitions are inventoried together.

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
  libre-webui recovery-check --json --data-dir /app/backend/data
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

The private-deployment helper stops the application when it was running and
uses that container's immutable image, mounted data volume, and environment to
create an integrated solo archive. The manifest is Ed25519-signed and the
complete payload is encrypted with an operator-held AES-256-GCM backup key. It
contains SQLite, local blobs and embedded vectors, runtime selectors, and the
protected configuration needed to decrypt restored state. The helper verifies
the signature, ciphertext checksum, and decrypted payload before publishing
the archive and metadata report. `libre-webui-restore` accepts only a new
Docker volume, verifies the decrypted recovery inventory before copying any
data, and publishes recovered configuration as private files in a new target
directory.

Protected runtime configuration includes the PostgreSQL pool, connection,
idle, statement, and migration-lock timeouts; the Redis connection timeout;
both durable blob-quota settings; the platform selectors; and the S3 prefix and
addressing mode. These values are inside the signed and encrypted payload, not
the plaintext manifest, and are republished as mode-`0600` configuration on an
applied restore.

The solo archive does not include Docker Work volumes, Kubernetes PVCs,
host-bound workspace folders, Ollama models, or external provider state. Keep
those signed-manifest exclusions visible and snapshot external Work storage
separately. The team profile uses the separate offline team workflow: a
PostgreSQL exported snapshot, exact versioned S3 ciphertext objects, PGVector
inventory, runtime configuration, and key identity are sealed into the same
signed/encrypted archive format and verified against a clean PostgreSQL/S3
target during restore. Redis cache, presence, wake-ups, and leases are rebuilt
from canonical SQL state.

Team backup also authenticates every bounded encrypted durable job and event
payload inside the exact exported PostgreSQL snapshot. Its protected signed
inventory records the job, event, stream, cursor, envelope, reference, and
authenticated-plaintext totals. Every event stream must contain exactly the
contiguous sequence `1..last_sequence`, and PostgreSQL's global cursor sequence
must not lag the greatest stored cursor. Restore repeats these checks against
the clean target and requires the complete result to match the signed source
inventory before it reports success. Gaps between distinct global cursor values
are valid because PostgreSQL identity allocation is not transactional;
per-stream sequences are the contiguous ordering contract.

When `PLUGINS_DIR` points outside `DATA_DIR`, recovery inventories that exact
directory and marks it as excluded from the application-volume archive. Any
definitions there block the volume-only snapshot until the operator arranges a
matching plugin-directory snapshot. The same rule applies to active legacy
plugin directories. Symlinked, non-regular, or unreadable JSON definitions are
always blockers and are never followed or silently omitted.

Durable jobs and ordered events are active in both profiles. Recovery blocks
while a job attempt or Work execution is active, validates job/event payloads
and contiguous stream heads, and preserves their canonical SQL state. Solo
runs the bounded embedded worker; team runs the same registered handlers in an
external worker and uses Redis only for wake-up and fan-out.

For production, store encryption and JWT secrets in a protected secret
manager, keep backup archives off-host and encrypted, and test restores into a
clean compatible environment. The inventory is a preflight snapshot of known
state, not a maintenance lock or independent proof that every external resource
can be restored.

## Signed and encrypted backup commands

The examples below use the installed `libre-webui` command from global npm or
Homebrew. Without installing globally, replace `libre-webui` with
`npx --yes libre-webui@latest`. From a source checkout, build the backend once
and replace `libre-webui backup` with `npm run recovery:backup --`.
The production Docker image exposes the same command at
`/usr/local/bin/libre-webui`. Team backup and restore additionally require
PostgreSQL 16 `pg_dump` and `pg_restore`; they are included in the production
image and on the Homebrew formula's command path. Install a compatible
PostgreSQL client explicitly before using these commands from plain npm/npx.

Generate the
operator-held AES-256-GCM archive key and Ed25519 signing keypair in a private
directory, then move the private keys to protected off-host storage:

```bash
install -d -m 0700 /absolute/private/libre-backup-keys
libre-webui backup keygen \
  --directory /absolute/private/libre-backup-keys
```

For a quiesced solo data directory, create and independently verify an archive:

```bash
libre-webui backup create \
  --offline \
  --data-dir /absolute/path/to/libre-data \
  --output /absolute/backups/libre-solo.lwbackup \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-private-key /absolute/private/libre-backup-keys/backup-signing-private.pem

libre-webui backup verify \
  --archive /absolute/backups/libre-solo.lwbackup \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-public-key /absolute/private/libre-backup-keys/backup-signing-public.pem
```

Restore first as a preflight, then apply only to a new, empty target directory:

```bash
libre-webui backup restore-preflight \
  --archive /absolute/backups/libre-solo.lwbackup \
  --target /absolute/restore/libre-data \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-public-key /absolute/private/libre-backup-keys/backup-signing-public.pem

libre-webui backup restore-apply \
  --archive /absolute/backups/libre-solo.lwbackup \
  --target /absolute/restore/libre-data \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-public-key /absolute/private/libre-backup-keys/backup-signing-public.pem

libre-webui backup restore-verify \
  --target /absolute/restore/libre-data
```

For team mode, stop all application replicas and workers, keep the source
PostgreSQL/S3/keyring environment loaded, and create the coordinated archive:

```bash
libre-webui backup create-team \
  --offline \
  --output /absolute/backups/libre-team.lwbackup \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-private-key /absolute/private/libre-backup-keys/backup-signing-private.pem
```

Load environment variables for a distinct, empty PostgreSQL database and an
empty versioned S3 bucket before restore. Preflight verifies the signature and
encrypted archive, validates the protected inventory, and proves the selected
target database and bucket prefix are empty without publishing data. Apply
restores into those clean targets, verifies the resulting PostgreSQL schema,
exact S3 objects, and PGVector records, and writes the protected runtime
configuration into a new private directory:

```bash
libre-webui backup restore-team-preflight \
  --archive /absolute/backups/libre-team.lwbackup \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-public-key /absolute/private/libre-backup-keys/backup-signing-public.pem

libre-webui backup restore-team-apply \
  --archive /absolute/backups/libre-team.lwbackup \
  --configuration-output /absolute/restore/libre-team-config \
  --encryption-key /absolute/private/libre-backup-keys/backup-encryption.key \
  --signing-public-key /absolute/private/libre-backup-keys/backup-signing-public.pem
```

Never point a restore at the source database, source bucket, an existing data
directory, or a configuration directory containing files. Keep the public
signing key with the restore runbook; possession of the archive and public key
alone cannot decrypt the payload.

If team restore reports that rollback was incomplete, treat both selected
targets as dirty and do not retry immediately. Inspect and clean the target
PostgreSQL database, then enumerate and remove every object version and delete
marker under the exact target S3 prefix. Run `restore-team-preflight` again;
apply is safe to retry only after that clean-target preflight succeeds.

## Scheduled verified recovery drills

Backups that were never restored are hope, not recovery. A drill proves the
instance is actually recoverable by exercising the exact pipeline above,
end to end, without any downtime and without an operator:

1. A quiescent snapshot of the data directory is staged — the SQLite
   database through the online backup API, blobs and files by physical
   copy. The drill waits for a quiet moment: it refuses to run while any
   durable job is mid-flight, the same rule `recovery-check` enforces.
2. The staged copy becomes a signed, AES-256-GCM-encrypted archive with
   ephemeral drill keys, running the complete recovery inventory.
3. The archive is verified, restored into an isolated temporary target,
   and the restored environment is verified again.
4. The drill records what it measured — restore duration is the
   demonstrated RTO, and the spacing between successful drills bounds the
   achievable RPO of the current schedule — then deletes every artifact.
   Drills are verification, not backups: no archive or key is retained.

Enable the schedule with `RECOVERY_DRILL_INTERVAL_HOURS` (for example `24`);
drills then run on the shared scheduler under a coordinator lease, so
replicas and overlapping ticks cannot double-run. The System page shows the
drill history with a "Run drill now" button for administrators, backed by
`GET /api/recovery/drills` and `POST /api/recovery/drills/run`. A drill
that fails unattended alerts every administrator through the notification
inbox (and any subscribed webhook targets); manual runs report their
refusal directly instead. `RECOVERY_DRILL_HISTORY` bounds the retained
history (default 60 entries).

Drills cover the solo (SQLite) profile, where the filesystem archive is the
authoritative backup path. The team profile keeps its coordinated
`backup create-team` flow, whose restore rehearsal remains an operator
runbook step for now.
