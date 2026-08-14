---
sidebar_position: 45
title: 'Platform Foundation'
description: 'Persistence, storage, coordination, and recovery contracts for Libre WebUI.'
slug: /PLATFORM_FOUNDATION
---

# Platform Foundation

Libre WebUI supports a local-first `solo` profile and a shared `team` profile.
Solo uses SQLite, encrypted local blobs, encrypted embedded vectors, local
coordination, and an embedded durable worker. Team uses PostgreSQL,
S3-compatible private blobs, PGVector, Redis coordination, and an external
durable worker. Startup rejects mixed profiles instead of silently splitting
state between local and shared backends.

## Current milestone

| Area         | Implemented foundation                                                                | Remaining caller work                                                         |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Persistence  | SQLite and PostgreSQL repositories, immutable migrations, pooled transactions         | New domains must use repository boundaries                                    |
| Blobs        | Encrypted local and S3-compatible streaming stores, ranges, checksums, durable quotas | Move chat attachments, avatars, and other remaining inline binary fields      |
| Vectors      | Encrypted embedded vectors, PGVector ACLs, and deletion-safe document index rebuilds  | New embedding callers must preserve the same authority and lifecycle contract |
| Coordination | Local and Redis events, cache, leases, rate limits, invalidation, and health          | Keep Redis non-authoritative                                                  |
| Jobs/events  | SQLite/PostgreSQL queues, transactional events, workers, retries, cancellation, admin | Every new side effect needs an idempotency or outbox design                   |
| Operations   | Health gates, signed/encrypted backup archives, clean-target restore, verification    | Exercise restore and cross-replica acceptance for each deployment environment |

## Runtime profiles

`LIBRE_PLATFORM_MODE=solo` is the default. It selects SQLite, local blobs,
embedded vectors, local coordination, and the embedded durable worker. Redis
may be selected in solo mode, but doing so does not make SQLite or local files
safe to share across replicas.

`LIBRE_PLATFORM_MODE=team` requires all shared dependencies at once:

- `DATABASE_BACKEND=postgres` with `DATABASE_URL`;
- `BLOB_STORE_BACKEND=s3`;
- `VECTOR_STORE_BACKEND=pgvector`;
- `COORDINATION_BACKEND=redis` with `REDIS_URL`; and
- `JOB_WORKER_MODE=external`.

These selectors are a coherent set. Team startup fails when any shared
dependency is missing or when a local backend is mixed into the profile.

### Migrate an existing solo installation

Stop every Libre application and worker before migrating. The examples use the
installed `libre-webui` command from global npm or Homebrew. Without installing
globally, replace it with `npx --yes libre-webui@latest`. From a source checkout,
build once and replace `libre-webui migrate-postgres` with
`npm run migrate:postgres --`. Configure the target PostgreSQL, S3, and
versioned encryption-key environment exactly as the target team deployment,
then run the read-only analysis first:

```bash
libre-webui migrate-postgres \
  --source /absolute/path/to/data.sqlite \
  --plugins /absolute/path/to/plugins \
  --mode dry-run
```

Apply only to the empty target identified by that report. A failed run leaves a
checksummed import journal; resume that same source and target rather than
starting an unrelated import:

```bash
libre-webui migrate-postgres \
  --source /absolute/path/to/data.sqlite \
  --plugins /absolute/path/to/plugins \
  --mode apply

# Only after an interrupted apply of this exact source and target:
libre-webui migrate-postgres \
  --source /absolute/path/to/data.sqlite \
  --plugins /absolute/path/to/plugins \
  --mode apply --resume

libre-webui migrate-postgres \
  --source /absolute/path/to/data.sqlite \
  --plugins /absolute/path/to/plugins \
  --mode validate
```

The completion marker is withheld until relational rows, plugin definitions,
local encrypted blobs, embedded vectors, and legacy persona vectors have all
been transferred and authenticated in PostgreSQL/S3/PGVector. The command
never invents a source encryption key: `ENCRYPTION_KEY` must match the source
`.encryption_key`, and `STORAGE_ENCRYPTION_KEYS` must contain the configured
active key plus the matching `legacy` entry.

### Run the bundled team profile

Start from the shipped fail-closed template. Keep the completed environment
file outside the repository and restrict it to its operator:

```bash
cp deploy/team/.env.example /absolute/path/to/libre-team.env
chmod 600 /absolute/path/to/libre-team.env
```

Replace every `REPLACE_*` value before startup. Generate the PostgreSQL
password with a URL-safe alphabet (for example, `openssl rand -hex 32`) because
the same literal is both the server password and part of `DATABASE_URL`.
`ENCRYPTION_KEY` and every value inside `STORAGE_ENCRYPTION_KEYS` must be
exactly 64 hexadecimal characters. On a fresh installation the `legacy` entry
must equal `ENCRYPTION_KEY`; for SQLite migration both must equal the source
key. Keep a different active key for new blob writes and retain old keys until
the object inventory proves they are unused.

The same file may set `POSTGRES_MIGRATION_MODE`, `POSTGRES_POOL_MAX`, the
supported PostgreSQL timeouts, `REDIS_CONNECT_TIMEOUT_MS`, `OLLAMA_BASE_URL`,
`OLLAMA_TIMEOUT`, `OLLAMA_LONG_OPERATION_TIMEOUT`, and `OLLAMA_MAX_CONTEXT`;
the shared Compose environment sends each value identically to the application
and external worker. The provider timeouts accept 1,000-3,600,000 milliseconds,
maximum context accepts 128-2,097,152 tokens, and the long timeout cannot be
shorter than the standard timeout; malformed values fail both server
entrypoints before state is created. Node-local Agent CLI binaries and Codex
OAuth token files are not supported by external durable workers, so the team
profile pins both provider paths off and startup rejects attempts to enable
them. Then start the application replicas, external durable worker,
PostgreSQL/PGVector, Redis, versioned MinIO bucket, and gateway:

```bash
docker compose --env-file /absolute/path/to/libre-team.env \
  -f docker-compose.team.yml up --build --scale libre-webui=3 -d
docker compose --env-file /absolute/path/to/libre-team.env \
  -f docker-compose.team.yml ps
```

The base team profile deliberately mounts no Docker socket, so Docker-backed
Work is unavailable. Enable it only by including the shipped production
overlay in every lifecycle command:

```bash
docker compose --env-file /absolute/path/to/libre-team.env \
  -f docker-compose.team.yml -f docker-compose.team.work.yml \
  up --build --scale libre-webui=3 -d
docker compose --env-file /absolute/path/to/libre-team.env \
  -f docker-compose.team.yml -f docker-compose.team.work.yml ps
```

That overlay points both application and worker processes at one filtered
Docker socket proxy on an internal-only network. Neither process receives the
raw socket or socket-group membership, and host-folder Work workspaces stay
disabled. The proxy exposes only info, images, containers, exec, volumes,
networks, and the write methods those lifecycle calls require. This narrows the
API surface but does not make Docker a tenant boundary: container creation can
still bind-mount host paths. Use a dedicated VM or rootless/separate Work daemon
when host isolation matters.

Do not expose the Compose-owned PostgreSQL, Redis, or MinIO services directly.
For managed dependencies, use the Helm team profile and retain verified TLS;
the Compose file disables PostgreSQL TLS only on its private project network.
Readiness remains failed until an external worker is present.

## Persistence and migration boundary

Identity and authorization now use asynchronous repositories. The repository
transaction callback receives a unit of work bound to the same database
connection; using the global repository from inside that callback is rejected.
This is the transaction boundary used by the PostgreSQL connection pool while
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

Application services use asynchronous dialect repositories. Native SQLite is
restricted to SQLite adapters, migration/recovery inspection, and explicitly
injected health checks. Runtime storage is initialized from the selected
`Persistence`; PostgreSQL activation never falls through to the SQLite
singleton or historical cwd-dependent JSON files.

## Blob and vector storage foundation

Generated gallery media and document source files use `BlobStore`; document
RAG and persona memory use `VectorStore`. SQLite legacy gallery rows are
dual-read and adopted into blob references on first access. Relational
metadata and a durable reference are authoritative; provider URLs and physical
S3 keys are never persisted as application content. Chat attachments, avatars,
and other remaining inline binary fields are not yet blob-store callers and
must not be described as migrated.

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
commits only after atomic visibility, and releases failed reservations. SQLite
uses `BEGIN IMMEDIATE`; PostgreSQL uses serializable transactions and row
locks. S3 object metadata and quota usage commit or roll back in one database
transaction. Startup reconciles expired reservations and quota objects whose
physical blob is missing. `BLOB_QUOTA_BYTES_PER_USER` sets the durable per-owner
limit and `BLOB_QUOTA_RESERVATION_TTL_MS` bounds abandoned reservations.

`BLOB_STORE_BACKEND=s3` uses a private S3-compatible bucket. Libre uploads
opaque object keys and application-encrypted chunk streams, keeps encrypted
descriptors in PostgreSQL, supports inclusive HTTP ranges, verifies plaintext
and ciphertext SHA-256 digests, and performs idempotent deletion. A deleting
row remains durable until physical deletion and atomic metadata/quota removal
succeed; reconciliation retries interrupted deletes and removes aged physical
orphans. The Docker-gated MinIO suite covers cross-replica read/delete,
tenant isolation, quota contention, unconsumed streams, and injected database
failures at commit and deletion boundaries.

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

`VECTOR_STORE_BACKEND=pgvector` applies namespace, model, dimensions, version,
resource, attribute, owner, and grant predicates inside the same SQL statement
as distance ordering and `LIMIT`. Post-filtering global nearest neighbors is
prohibited. Group authorization is resolved from a trusted current-membership
resolver for every query; caller-supplied `groupIds` are ignored. Revocation is
therefore immediate and forged group claims cannot retrieve candidates.

Document ingestion and the embedding-regeneration maintenance endpoint capture
one immutable execution specification before work begins: enabled state, model,
vector version, chunker version, chunk size, overlap, and similarity threshold.
That same specification controls chunk generation, relational publication,
vector upsert, and semantic query; a preference change during a run cannot
produce mixed-model chunks or query a vector under a different threshold.
The published document metadata records the aggregate chunk revision and this
specification so SQL remains the authoritative index manifest.

Regeneration holds an auto-renewing coordinator lease for each document and
rechecks the owner-scoped row plus its permanent deletion tombstone before
relational publication and before and after vector mutation. A deletion may
commit while an upsert is in flight; the post-upsert authority check then
removes the recreated vectors. PostgreSQL/team semantic reads never mutate
PGVector. SQLite may lazily republish relational embeddings only when the
stored manifest proves the exact current model and chunk configuration; that
optional mutation reloads the row and chunks while holding the same document
lease. A busy or superseded revision is skipped and remains eligible for
keyword fallback or an explicit regeneration.

Document indexes are replaced in compensated batches of at most 1,000 vectors,
and exact-index checks page through the complete resource manifest rather than
assuming one mutation batch is the whole document. A document may publish at
most 100,000 chunks, so no single document exceeds the portable archive's
total document-chunk ceiling. Ingestion rejects
the 100,001st chunk before embedding or relational/vector publication and
dead-letters that durable job without retry; increase the embedding chunk size
or remove excessive paragraph breaks before uploading again.

Pre-manifest solo databases can contain authenticated inline document vectors
without any record of the model or chunker that created them. First semantic
use treats only their presence as an upgrade signal: it rechunks authoritative
document text and generates every vector again under the current captured
specification while holding the document lease. It never copies the legacy
payload or labels it with today's preference. Provider failure or a busy lease
leaves the legacy row unchanged and keyword-searchable.

SQLite-to-team migration fails closed when such a legacy document is not fully
covered by authenticated current manifest metadata and an exact encrypted
platform-vector index. Current preferences do not prove a historical vector's
model. When dry-run reports this blocker, start the current release in
solo/SQLite mode with the same `DATA_DIR` and `ENCRYPTION_KEY`, enable and
select the desired embedding model, use **Settings -> Documents -> Regenerate
embeddings** for every affected owner, and rerun the migration dry-run. Only
then may team repository reads ignore the preserved inline ciphertext while
the proven vectors move to PGVector.

Confidentiality differs by backend. Embedded SQLite encrypts embeddings with
application AES-256-GCM after applying metadata ACL predicates. PGVector must
operate on the numeric embedding and therefore does not application-encrypt
that column. Treat embeddings as sensitive derived data: require TLS,
encrypted PostgreSQL volumes and backups, a least-privilege application role,
restricted database administration, and SQL logs that never include vector or
source content. Source text, persona memory content, gallery metadata, and blob
descriptors remain envelope-encrypted. Vector attributes are queryable
plaintext and must never contain secrets.

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

Application ticketing, caches, shared invalidation, connection limits, Work
events, and distributed runtime locks use this boundary. Redis selection alone
still does not make local persistence shareable; team mode requires the entire
shared profile.

## Durable jobs and events

SQLite migration v3 provides durable job, attempt, event-stream head, and
ordered event tables. The service contract supports idempotent enqueue,
bounded retries, cancellation, progress, lease heartbeat/reclaim, dead-letter
state, and replay by global cursor. Encrypted JSON payloads use the platform
keyring with job/event identity as authenticated data; payload references are
opaque bounded identifiers.

Application and standalone-worker bootstraps register audited handlers for
document ingestion, media continuation, and retriable resource cleanup. The
admin boundary exposes bounded inspection and cancellation. Enqueue is
idempotent, and relational creation/deletion paths insert their durable job in
the same SQLite/PostgreSQL transaction. Resource cleanup removes vectors,
private blobs, durable references, cache entries, and resource-targeted queued
work through retry-safe operations.

The recovery inventory counts every job state and attempt outcome, records
event streams and their last cursor, blocks unsafe running work, and
authenticates encrypted payloads under aggregate limits. Recovery also rejects
stream-head mismatches and non-contiguous per-stream sequences.

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

Run `libre-webui recovery-check --json`; from a source checkout, build the
backend once and use `npm run recovery:check -- --json`. The inventory is
read-only and reports schema/key identities, the local blob root,
legacy and platform-vector counts, authenticates local platform blob/vector
ciphertext, legacy application and saved-voice ciphertext, and encrypted
durable job/event payloads, and reports data sizes,
plugin definitions and whether they are inside the backup root, embedded media,
Work resources and exact ownership labels, job/attempt/event checkpoints,
active Work runs/previews and jobs, blockers, and known exclusions. It is a
pre-backup gate, not a complete backup. See
[Recovery Readiness](./44-RECOVERY_READINESS.md).

## Known remaining cutovers

The foundation does not imply that every binary field is already a blob.
Saved-voice audio, chat attachments, avatars, and future plugin-defined binary
resources need explicit reference metadata, dual-read/backfill, retention, and
deletion tests before they can move. Likewise, every future embedding caller
must carry model, dimensions, version, source revision, owner, resource scope,
and trusted grants through `VectorStore`; direct vector-table access is not an
accepted shortcut.

New long-running or externally visible side effects must register a durable
resource target, support cancellation and retry, and use a transactional
enqueue/outbox boundary with the owning relational mutation. Add each new
resource to the cross-replica upload/read/search/delete and backup/restore
acceptance gates before enabling it in team deployments.
