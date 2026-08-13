---
sidebar_position: 45
title: 'Platform Foundation'
description: 'Persistence, storage, coordination, and recovery contracts for Libre WebUI.'
slug: /PLATFORM_FOUNDATION
---

# Platform Foundation

Libre WebUI remains a local-first, single-replica application in this release.
The platform foundation introduces explicit contracts and safety gates needed
for a future shared deployment without pretending that the migration is
complete. SQLite, local encrypted storage, the embedded vector index, an
inactive durable-job substrate, and one application replica remain the
supported profile. No domain handler worker is bootstrapped yet.

The existing Helm guard still permits at most one running application replica.
Do not remove it until PostgreSQL, S3-compatible blobs, PGVector, durable jobs,
shared event replay, and Redis-backed coordination have all passed the
multi-replica acceptance suite.

## Current milestone

| Area         | Available now                                                           | Still required                                                                                            |
| ------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Persistence  | Async identity repository and transaction-scoped unit of work on SQLite | Move every domain behind repositories; PostgreSQL repositories, migrations, and verified offline transfer |
| Migrations   | Versioned, checksummed SQLite ledger and legacy-schema adoption         | PostgreSQL migration leader, mixed-version policy, and upgrade fixtures                                   |
| Blobs        | Encrypted streaming local adapter and contract                          | Resource metadata/backfill, S3 adapter, MinIO parity tests, HTTP Range proxy                              |
| Vectors      | Encrypted embedded adapter with SQL-side ACL predicates                 | Migrate RAG/memory callers and add PGVector with PostgreSQL parity tests                                  |
| Coordination | Local and real Redis coordinator contracts                              | Move tickets, caches, locks, limits, presence, and invalidation to the coordinator                        |
| Jobs/events  | SQLite v3 durable jobs/attempts and ordered transactional event log     | Domain callers, handler bootstrap, admin API, external worker, and shared-database acceptance             |
| Operations   | Split health probes and read-only recovery inventory                    | Signed encrypted backup, coordinated restore, and automated restore verification                          |

PostgreSQL, S3, PGVector, and an external job worker are intentionally
unavailable selections. Startup reports a configuration blocker instead of
falling back to local state.

## Runtime profiles

`LIBRE_PLATFORM_MODE=solo` is the default. It selects SQLite, local blobs,
embedded vectors, local coordination, and the inactive `embedded` job-worker
selector. Redis may be selected in solo mode to exercise the coordination
adapter, but doing so does not make SQLite or local files safe to share across
replicas. No job worker starts until audited domain handlers are registered.

`LIBRE_PLATFORM_MODE=team` requires all shared dependencies at once:

- `DATABASE_BACKEND=postgres` with `DATABASE_URL`;
- `BLOB_STORE_BACKEND=s3`;
- `VECTOR_STORE_BACKEND=pgvector`;
- `COORDINATION_BACKEND=redis` with `REDIS_URL`; and
- `JOB_WORKER_MODE=external`.

Team mode is expected to fail configuration validation in this release because
the PostgreSQL, S3, PGVector, and external-worker adapters have not shipped.
This is a safety property, not a setup error that operators should bypass.

## Persistence and migration boundary

Identity and authorization now use asynchronous repositories. The repository
transaction callback receives a unit of work bound to the same database
connection; using the global repository from inside that callback is rejected.
This proves the transaction boundary required by a future PostgreSQL pool while
preserving the current SQLite behavior.

The SQLite migration coordinator adopts existing installations only after
validating the required schema. It records a numbered migration name and
checksum, verifies them on every startup, rejects newer/unknown/mismatched
ledgers, and fails startup when migration or schema validation fails. Readiness
and recovery inventory consume the same canonical inspection contract.

Before importing stateful application services, startup copies the existing
SQLite database and active WAL/SHM files into a private scratch directory and
validates that copy. `PLATFORM_PREFLIGHT_TMP_DIR` must have enough free space
for the database plus its WAL. The supplied Docker and Helm deployments mount
dedicated disk-backed temp storage there; startup does not rely on the bounded
`/tmp` tmpfs. A missing legacy encryption key or a historical nested data
directory blocks startup before a replacement key, database, or plugin state
can be created.

Schema v4 adds a keyed equality token for encrypted identity emails. Recovery
requires every token to be present and match its authenticated email. Startup
permits a missing token with an authenticated email or a non-envelope legacy
value during the narrow crash window after v4 commits, so repository
initialization can finish the encryption/token backfill. Older releases
accepted arbitrary email strings and used blank values to clear the field;
adoption preserves nonblank values and normalizes blanks to `NULL`. Damaged
envelope-shaped values and any non-null mismatch still fail preflight.

This is the first vertical slice of the repository migration. Legacy database
consumers are allow-listed by a boundary test; new application code may not
import the native SQLite database outside the persistence implementation.
Authenticated runtime storage now fails startup closed when SQLite cannot be
initialized; it cannot silently select the historical cwd-dependent JSON files.
Those compatibility branches remain only as migration debt until each legacy
domain is moved behind its repository.

## Blob and vector storage foundation

The storage contracts and solo implementations are available, but existing
gallery, document, voice, chat attachment, avatar, and persona-memory callers
have not yet been migrated. Their current SQLite fields remain authoritative
until an explicit, verified data migration switches each resource.

The recovery gate authenticates every durable object and embedded-vector
envelope sequentially under explicit aggregate limits. It also strictly
authenticates recognizable legacy text envelopes and every saved-voice binary
envelope with the application `ENCRYPTION_KEY`; it never uses the runtime
decrypt-and-return-original compatibility fallback. It does not initialize,
repair, rewrite, or delete source storage; corrupt ciphertext, unknown or wrong
keys, non-canonical blob layouts, and exceeded verification limits block the
snapshot.

The default recovery bounds are 250,000 local objects, 64 GiB of encrypted and
plaintext blob bytes, 250,000 vector rows, 4 GiB of serialized vector
ciphertext, and 500 million vector components. Tests and embedded callers may
override per-run limits through `RecoveryInventoryOptions`; the CLI never
silently samples or skips excess state.

Legacy ciphertext verification defaults to one million populated candidate
fields and 16 GiB each of aggregate stored and authenticated plaintext bytes.
Plaintext rows from old schema generations remain compatible because legacy
text envelopes have no durable marker; the report counts only authenticated
envelopes. Saved voice envelopes are unambiguous and always authenticate with
profile/owner/field identity as additional data.

### Encrypted local blobs

`BlobStore` is owner-scoped and exposes streaming put/read, metadata/stat,
inclusive byte ranges, and idempotent deletion. `LocalEncryptedBlobStore`
writes opaque UUID-keyed objects below an application-supplied root; the
integration target is `${DATA_DIR}/blobs`. It uses exclusive staging files,
fsync, and an atomic same-filesystem rename, with `0700` directories and `0600`
files.

Every object has a random 256-bit data key. AES-256-GCM encrypts private
metadata and independently authenticates bounded body chunks. Additional
authenticated data binds the blob ID, owner, purpose, chunk index, and
plaintext length. The versioned storage keyring wraps each data key. The
descriptor records plaintext size, SHA-256, content type, creation time, format
version, and encryption key ID. Full reads verify SHA-256; range reads
authenticate every touched chunk.

The quota contract reserves capacity before streaming, consumes actual bytes,
commits only after atomic visibility, and releases failed reservations. Durable
usage accounting still belongs in the caller's relational transaction. A
grace-based reconciler deletes old unreferenced objects and stale staging
files, recovering from a crash between object rename and metadata commit.

Only `BLOB_STORE_BACKEND=local` is implemented. S3 remains blocked until an
adapter passes the same contract against MinIO, including private ACLs,
checksums, range reads, quota races, aborts, crash recovery, and idempotent
deletion.

### Encrypted embedded vectors

`VectorStore` requires an actor on every query and mutation. Records carry a
namespace, opaque tenant-scoped ID, owner, resource ID, embedding model,
dimensions, version, source revision, equality attributes, and optional
user/group grants.

SQLite applies namespace/model/dimension/version, owner or grant, resource,
and attribute predicates before encrypted embeddings leave the database. Only
that bounded, authorized candidate set is decrypted and cosine-scored. The
same opaque vector ID is isolated per owner without revealing another tenant's
existence. Upserts replace embeddings, ACLs, and attributes atomically;
deletes are owner-scoped and cascade related rows.

Embeddings use AES-256-GCM with identity and model metadata bound as additional
authenticated data. Queryable identity, grant, model, version, revision, and
filter metadata remain plaintext, so callers must not put secrets in filter
attributes. Embeddings themselves are sensitive derived data.

Only `VECTOR_STORE_BACKEND=embedded` is implemented. A future PGVector adapter
must apply actor and resource predicates inside the nearest-neighbor SQL query
before ordering and limiting. Post-filtering global nearest neighbors is
prohibited. PostgreSQL deployments must use TLS, encrypted storage/backups, a
least-privilege role, and non-sensitive SQL logging; source blobs and text
remain envelope-encrypted.

### Storage encryption keys

During the current caller-migration period, deployments that enable a versioned
keyring must set a stable 64-character `ENCRYPTION_KEY`, include that same key
under the exact `legacy` entry of `STORAGE_ENCRYPTION_KEYS`, and set
`STORAGE_ENCRYPTION_ACTIVE_KEY_ID` to one entry. Writes use the active key;
reads accept all configured key IDs to support staged rotation. This temporary
legacy requirement prevents the existing encryption service from independently
creating a different key. Retain old keys until every object and vector has
been rewritten or rewrapped and verified.

When that map is absent, the adapter accepts the existing 64-character
`ENCRYPTION_KEY` as key ID `legacy`, or reads the existing
`${DATA_DIR}/.encryption_key` file when the environment key is absent. The
storage factory only accepts a regular, non-symlinked key file with private
permissions; it never creates, rewrites, or replaces that file. If explicit
environment configuration conflicts with the persistent key, startup fails
closed. During rotation, a detected legacy environment/file key must remain in
the versioned map under the exact key ID `legacy` until old envelopes have been
rewritten and verified. Missing, malformed, mismatched, and unknown keys fail
closed.

Embedded vector queries apply ACL and metadata predicates in SQLite, then
aggregate candidate count, encrypted bytes, and count-by-dimension scoring work
before returning any ciphertext to Node for decryption. Queries exceeding any
budget fail closed and must be narrowed by resource or metadata scope.

## Coordination

The coordinator contract provides events, expiring cache entries, fenced
leases, and fixed-window rate-limit consumption. The local implementation is
only for the one-replica solo profile. The Redis implementation uses separate
command and subscription clients, bounded payloads, health checks, key
namespacing, atomic scripts, unique owner tokens, lease expiry, and fencing
tokens. It never falls back to local coordination after a Redis error.

Redis is not the source of truth. Authorization, durable jobs, and replayable
events must remain in the database; Redis is a wake-up, cache invalidation,
presence, quota, and coordination layer. Critical work must also validate its
database lease or fencing token before committing a side effect.

Existing process-local tickets, caches, connection limits, Work events, and
runtime locks have not yet moved to this coordinator, so Redis selection alone
does not permit more replicas.

## Durable jobs and events

SQLite migration v3 provides durable job, attempt, event-stream head, and
ordered event tables. The service contract supports idempotent enqueue,
bounded retries, cancellation, progress, lease heartbeat/reclaim, dead-letter
state, and replay by global cursor. Encrypted JSON payloads use the platform
keyring with job/event identity as authenticated data; payload references are
opaque bounded identifiers.

This is substrate, not an activated application feature. No existing domain
caller submits work, no handler worker is bootstrapped at application startup,
and there is no admin API or external worker. The recovery inventory reports
these facts, counts every job state and attempt outcome, records event streams,
events, and the last cursor, blocks running jobs, and authenticates every
encrypted payload under aggregate row/ciphertext/plaintext limits. Opaque
reference targets are syntax-checked but cannot be existence- or
authorization-verified until an authoritative blob-reference repository is
available. Recovery also rejects stream-head mismatches and non-contiguous
per-stream event sequences.

Monotonic lease tokens fence stale workers from later database commits. Fencing
does not provide exactly-once execution: a worker can complete an external side
effect and fail before recording success. Handler adoption therefore requires
provider idempotency keys or a transactional outbox/inbox protocol, plus actor
authorization revalidation immediately before each side effect.

SQLite migration v4 adds a unique keyed email lookup token beside randomized
identity ciphertext. The token is an HMAC under the application encryption key:
it restores atomic duplicate-email enforcement without storing plaintext or
using deterministic encryption. Startup authenticates and backfills every
legacy identity email before accepting traffic.

## Health and recovery

Deployment probes now distinguish process liveness from dependency readiness:

- `/health` and `/health/live` are process-only;
- `/health/ready` checks the database, canonical schema ledger, writable data
  storage, and registered required dependencies while redacting details; and
- `/health/deep` requires a current administrator and runs SQLite integrity and
  foreign-key checks in a bounded worker outside the HTTP event loop.

Run `npm run --silent recovery:check -- --json` after building the backend. The
inventory is read-only and reports schema/key identities, the local blob root,
legacy and platform-vector counts, authenticates local platform blob/vector
ciphertext, legacy application and saved-voice ciphertext, and encrypted
durable job/event payloads, and reports data sizes,
plugin definitions and whether they are inside the backup root, embedded media,
Work resources and exact ownership labels, job/attempt/event checkpoints,
active Work runs/previews and jobs, blockers, and known exclusions. It is a
pre-backup gate, not a complete backup. See
[Recovery Readiness](./44-RECOVERY_READINESS.md).

## Required next migrations

Before this roadmap phase can be declared complete:

1. Move chats/resources/settings, plugin/media state, personas/memory, and Work
   behind transaction-scoped repositories; remove insecure JSON fallbacks.
2. Add PostgreSQL migrations/repositories, a migration advisory lock, and an
   offline SQLite-to-PostgreSQL transfer with count and hash verification.
3. Add relational blob references/quota reservations and durable deletion
   outbox; migrate gallery first, then documents, voices, attachments, and
   avatars through verified dual-read/backfill/cutover steps.
4. Migrate document and persona embeddings through `VectorStore`, including
   model/version/revision rebuild state; add S3/MinIO and PGVector parity suites.
5. Migrate video, document ingestion, Work, and batch synthesis onto the
   durable substrate; bootstrap audited handlers, add an admin API, adopt
   side-effect idempotency/outbox patterns, and implement an external worker
   only with shared-database acceptance tests.
6. Move coordination and replay to Redis plus durable SQL events; validate
   cross-replica ticket consumption, cache invalidation, quotas, revocation,
   reconnect ordering, and Redis-outage recovery.
7. Add versioned signed manifests, operator-encrypted backups, clean-target
   restore, and automated restore verification for SQL, blobs, vectors,
   configuration/key identities, Work storage, and job/outbox checkpoints.
