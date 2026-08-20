---
sidebar_position: 24
title: 'Kubernetes'
description: 'Deploy Libre WebUI on Kubernetes with Helm.'
slug: /KUBERNETES
keywords: [libre webui kubernetes, helm chart, k8s deployment]
---

# Kubernetes

Libre WebUI ships a Helm chart under `helm/libre-webui`.

## Work on Kubernetes

Work runs natively on Kubernetes — no Docker daemon, CLI, or socket is
involved anywhere. Enable it at install time:

```bash
helm install libre-webui ./helm/libre-webui --set work.enabled=true
```

This switches the backend to `WORK_RUNTIME_BACKEND=kubernetes` and creates:

- a dedicated sandbox namespace (`work.namespace`, default
  `libre-webui-work`) holding one Pod per running sandbox and one
  PersistentVolumeClaim per task workspace (`work.workspaceSize`, default
  `5Gi` — a real per-task disk quota; a named Work policy can set a
  different size for the tasks created under it);
- a namespace-scoped Role and RoleBinding granting the backend's
  ServiceAccount exactly `pods` (get/list/create/delete), `pods/exec`
  (get/create), and `persistentvolumeclaims` (get/list/create/delete) in
  that namespace — no secrets, no cluster scope. This grant replaces the
  Docker socket entirely: the API server, not the application, enforces
  that a sandbox spec cannot mount host paths;
- NetworkPolicies that default-deny all sandbox traffic, allow ingress only
  from the backend on the preview port, and give network-enabled sandboxes
  egress to the internet minus `work.networkPolicy.blockedEgressCidrs`
  (private ranges, the CGNAT range some managed clusters use for pod and
  service CIDRs, and the cloud-metadata link-local range by default —
  verify your cluster's pod and service CIDRs are covered). Sandbox DNS is
  allowed only to `kube-system`; a cluster running node-local DNS needs its
  own DNS carve-out.

Sandboxes run non-root with a read-only root filesystem, all capabilities
dropped, seccomp `RuntimeDefault`, and no ServiceAccount token. Files,
commands, git, and interactive terminals ride the exec subresource through
the API server; preview is served from the sandbox Pod IP through the signed
same-origin proxy, which requires the backend to run in-cluster (the normal
chart topology). Host-folder workspaces are not supported on this backend.

Two operator notes. NetworkPolicy enforcement requires a CNI that
implements it (Calico, Cilium, recent kind releases, and most
managed-cluster defaults do) — verify with your cluster before treating
sandbox isolation as active; the CI end-to-end suite reports whether the
cluster it runs on enforces. And never mount a node's container-runtime
socket into the WebUI pod; the Kubernetes backend exists precisely so that
is unnecessary.

## Install

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui
```

The default chart deploys Libre WebUI with persistent storage and a bundled
Ollama service. The 0.14.1 transition is pinned to its verified
multi-architecture image digest; subsequent charts default to the matching
semantic `appVersion` image. Set `image.tag` or `image.digest` explicitly only
when you intentionally want a different image. A non-empty `image.tag` takes
precedence over the transition digest.

The default `solo` profile accepts `replicaCount: 0` for a deliberate suspension
or `replicaCount: 1` for normal operation. It rejects larger values and the
HorizontalPodAutoscaler because SQLite, local files, and process-local
coordination are not safe behind multiple pods. A zero-replica release
provisions its control-plane resources but serves no Libre WebUI traffic.

For multiple replicas, configure the complete `team` profile. It uses
PostgreSQL/PGVector, S3-compatible blob storage, Redis, and a separate durable
worker; the chart refuses a partial mixture of shared and local backends. Start
from a protected values file like this:

```yaml
replicaCount: 3

env:
  LIBRE_PLATFORM_MODE: team
  DATABASE_BACKEND: postgres
  DATABASE_SSL_MODE: verify-full
  POSTGRES_MIGRATION_MODE: apply
  POSTGRES_POOL_MAX: 10
  POSTGRES_CONNECT_TIMEOUT_MS: 5000
  POSTGRES_IDLE_TIMEOUT_MS: 30000
  POSTGRES_STATEMENT_TIMEOUT_MS: 30000
  POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: 60000
  OLLAMA_TIMEOUT: 300000
  OLLAMA_LONG_OPERATION_TIMEOUT: 900000
  OLLAMA_MAX_CONTEXT: 32768
  BLOB_STORE_BACKEND: s3
  VECTOR_STORE_BACKEND: pgvector
  COORDINATION_BACKEND: redis
  JOB_WORKER_MODE: external
  STORAGE_ENCRYPTION_ACTIVE_KEY_ID: active
  S3_BUCKET: libre-blobs
  S3_REGION: us-east-1
  S3_BLOB_PREFIX: libre/blobs

worker:
  replicaCount: 1

secrets:
  databaseUrl: postgresql://libre:replace-me@postgres.example/libre
  redisUrl: rediss://redis.example:6379/0
  jwtSecret: '<one-stable-high-entropy-secret-for-every-replica>'
  encryptionKey: '<legacy-64-character-lowercase-hex-key>'
  storageEncryptionKeys: '{"legacy":"<legacy-64-character-lowercase-hex-key>","active":"<active-64-character-lowercase-hex-key>"}'
  s3AccessKeyId: replace-me
  s3SecretAccessKey: replace-me
```

`secrets.encryptionKey` must exactly match the `legacy` entry, and the key map
must also contain `STORAGE_ENCRYPTION_ACTIVE_KEY_ID`. `secrets.jwtSecret` must
be one stable, high-entropy value shared by every app and worker pod; the chart
rejects team mode without it so sessions never depend on pod-local generated
material. Keep verified TLS for managed PostgreSQL; do not add driver TLS
parameters to `databaseUrl`. Pool limits apply to every app and worker pod, so
reserve at least
`(replicaCount + worker.replicaCount) * POSTGRES_POOL_MAX` database connections
plus operational headroom. Install with the protected values file:

```bash
helm upgrade --install libre-webui \
  oci://ghcr.io/libre-webui/charts/libre-webui \
  --values /absolute/path/to/libre-team-values.yaml
```

Do not commit that file or pass production secrets through `--set`. Store it
with a protected encrypted-values workflow. Scale model providers and Work
sandbox Pods independently; when `work.enabled=true`, the external team worker
receives the same runtime image, StorageClass, and `work.env` limits as app pods.
The worker also receives the same resolved Ollama endpoint, request timeouts,
and maximum automatically adopted context as the app, because document
embeddings, durable chats, and Work runs execute provider calls there.
An active team application (a positive `replicaCount`, or enabled autoscaling)
requires at least one external worker, and the chart rejects a zero-worker
configuration before installation. Set both `replicaCount` and
`worker.replicaCount` to zero for a full suspension. Setting only the app count
to zero is a deliberate worker-only drain or recovery mode: no web traffic is
served, but the worker continues processing queued durable work.

### Team upgrades and schema compatibility

Libre supports an exact-schema-version policy, not mixed-version or zero-downtime
database upgrades. The application and external-worker Deployments each use
`Recreate`, which prevents old and new pods from overlapping within that one
Deployment. Kubernetes does not coordinate the two Deployments as a single
upgrade boundary. Before upgrading, stop new ingress, let or cancel active
durable and Work jobs, scale both old Deployments to zero, take a verified team
backup, and confirm every old app and worker pod has terminated. Only then
upgrade the release with `POSTGRES_MIGRATION_MODE=apply`; one new process holds
the PostgreSQL advisory leader lock while all other new processes wait and
validate the same migration ledger. Restore the previous verified backup into a
clean PostgreSQL/S3 target for rollback; never point an older binary at a schema
it does not exactly support. Expect an intentional service interruption during
this procedure.

## Access Locally

```bash
kubectl port-forward svc/libre-webui 8080:8080
```

Open [http://localhost:8080](http://localhost:8080).

## External Ollama

Use an existing Ollama endpoint:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set ollama.bundled.enabled=false \
  --set ollama.external.enabled=true \
  --set ollama.external.url=http://my-ollama:11434
```

## Secrets

Set a stable JWT secret and encryption key for production. By default the chart
creates `<release>-libre-webui-secrets` from non-empty `secrets.*` values:

```bash
helm upgrade --install libre-webui \
  oci://ghcr.io/libre-webui/charts/libre-webui \
  --set-string secrets.jwtSecret="$(openssl rand -hex 64)" \
  --set-string secrets.encryptionKey="$(openssl rand -hex 32)"
```

For an operator-managed Secret, set `secrets.existingSecret`. The chart then
renders no Secret and both application and worker pods reference the named
object:

```yaml
secrets:
  existingSecret: libre-webui-runtime
```

Create that Secret before installing the release. It must contain
`jwt-secret` and `encryption-key`. Team mode additionally requires
`database-url`, `redis-url`, and `storage-encryption-keys`. The optional keys
understood by the chart are `session-secret`, `s3-access-key-id`,
`s3-secret-access-key`, and `s3-session-token`. GitHub and Hugging Face OAuth
can also read their `*-client-id` and `*-client-secret` pairs from the named
Secret when the corresponding non-empty `secrets.githubClientId` or
`secrets.huggingfaceClientId` value enables that integration. The chart
deliberately does not validate or copy the Secret's values; a missing required
key leaves the Pod unable to start.

For production automation, prefer `secrets.existingSecret` with an
external-secrets controller or supply stable values through an encrypted Helm
values workflow. Command-line `--set` values can be exposed through process
inspection and are retained in Helm release metadata. Add provider credentials
through a deliberate chart extension or configure per-user credentials in the
WebUI.

## Application and worker NetworkPolicies

Set `networkPolicy.enabled=true` to render ingress policies for the application
and, in team mode, the external durable worker:

```yaml
networkPolicy:
  enabled: true
```

The application accepts ingress only on its HTTP container port. The worker
accepts no ingress. These policies do not restrict egress: application and
worker processes must still reach the configured PostgreSQL, Redis, S3,
Ollama, tool, and model-provider endpoints, and operators decide where those
services live.

This setting is separate from `work.networkPolicy.enabled`, which controls the
default-deny policies in the Work sandbox namespace and is enabled by default
when Work is enabled. Both settings require a CNI that actually enforces
Kubernetes NetworkPolicy; rendering the objects alone does not prove network
isolation.

## Persistence

Keep the Libre WebUI data PVC and Ollama model PVC on persistent storage. Back up the Libre WebUI data volume and the encryption key together.

Work task workspaces live in their own PVCs in the sandbox namespace, not in
the Libre WebUI data PVC. Complete Work recovery needs both the database
(task ownership, resource names, runs) and those PVCs; back them up together
under the same policy.

## Ingress

For public access, configure ingress with HTTPS and set the exact browser
origin through the chart:

```bash
helm upgrade libre-webui \
  oci://ghcr.io/libre-webui/charts/libre-webui \
  --reuse-values \
  --set env.TRUST_PROXY=1 \
  --set-string env.CORS_ORIGIN=https://your-domain.example
```

`TRUST_PROXY` is an exact hop count, not a boolean. Its safe chart default is
`0`, which ignores forwarded client addresses. Use `1` only when one ingress
proxy connects directly to Libre; count every trusted load balancer or proxy
hop in a longer fixed chain and keep the Service unreachable around that
chain. A count that is too small groups clients under a proxy address and can
exhaust shared login limits; a count that is too large can trust a
client-supplied address. The chart accepts only `0` through `16`, never
unbounded `true`, and sends the value only to HTTP application pods.

The current chart does not expose `BASE_URL` or OAuth callback URL values.
Deployments using OAuth must extend the chart or patch the Deployment to set
those variables, and the callback URLs must match the public domain.

## Resource Planning

For local Ollama inside the cluster, schedule the Ollama pod on nodes with enough memory and GPU capacity for the models you plan to run. If your cluster already has a dedicated Ollama or inference service, external Ollama is usually simpler.

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Authentication](./AUTHENTICATION)
