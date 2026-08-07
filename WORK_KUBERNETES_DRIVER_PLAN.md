# Work Kubernetes Runtime Driver — Implementation Plan

Status: phase 1 complete — the `WorkRuntimeDriver` seam exists
(`backend/src/services/workRuntimeDriver.ts`) with the Docker driver as the
only implementation, including the terminal transport; behavior is
unchanged and the full Work suite passes against it. Phases 2–5 are not
built. The deployment matrix in `docs/33-WORKSPACES.md` still marks
Kubernetes as unsupported; this plan describes how to change that without
weakening the Work security model.

## Goal

Run Work task sandboxes as Kubernetes Pods with PVC-backed workspaces, so a
Libre WebUI deployed by the existing Helm chart gets Work without any Docker
daemon, socket, or socket proxy. Everything user-visible — tasks, runs, file
tools, commands, git, terminal, preview — behaves identically to the Docker
backend.

## Non-goals

- No changes to the Docker backend's behavior; it remains the default.
- No host-folder workspaces on Kubernetes (`WORK_HOST_WORKSPACES_ENABLED`
  implies hostPath mounts; explicitly unsupported, fails with a clear error).
- No multi-node scheduling policy beyond what the cluster already does; the
  driver requests resources and lets the scheduler place Pods.
- No operator/CRD. The backend creates Pods directly, exactly as it creates
  containers today. An operator can come later without changing the seam.

## What the driver must cover (today's runtime surface)

Inventoried from `workRuntimeService.ts`, `workTerminalService.ts`, and
`systemDiagnosticsService.ts`:

| Operation                                  | Docker today                                                                      | Kubernetes equivalent                                                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Availability probe                         | `docker info`                                                                     | API server `/version` + namespace access check                                                                                                                                                                                |
| Workspace storage                          | named volume + labels                                                             | PVC + labels (`ai.libre-webui.task=<UUID>`)                                                                                                                                                                                   |
| Sandbox runtime                            | `docker run` keeper (`tail -f /dev/null`)                                         | Pod with same keeper command                                                                                                                                                                                                  |
| Lifecycle                                  | `start` / `stop --time 1` / `rm -f`                                               | create Pod / delete Pod (grace 1s) / delete Pod                                                                                                                                                                               |
| Existence & state                          | `container inspect`                                                               | get Pod by name (phase, labels)                                                                                                                                                                                               |
| Ownership check                            | inspect task label                                                                | Pod label selector match                                                                                                                                                                                                      |
| Policy staleness                           | inspect vs. policy fingerprint                                                    | fingerprint annotation on the Pod; mismatch → delete & recreate (same rule as today)                                                                                                                                          |
| Startup reconciliation                     | `ps --filter label=…`                                                             | list Pods + PVCs by label selector                                                                                                                                                                                            |
| Image pull                                 | `image inspect` + `pull`                                                          | kubelet pulls; driver reports `ErrImagePull` states as preparation errors                                                                                                                                                     |
| File tools, commands, git, preview scripts | `docker exec` (+ stdin for writes)                                                | exec subresource (stdin/stdout/stderr streams)                                                                                                                                                                                |
| Interactive terminal                       | Engine API exec + hijacked Upgrade stream                                         | exec subresource with TTY over WebSocket — same Duplex contract as `workTerminalService`                                                                                                                                      |
| Preview                                    | publish `4173` → `127.0.0.1:<random>` on the Docker host                          | per-task ClusterIP Service (or Pod IP) : 4173; the signed same-origin proxy targets it unchanged                                                                                                                              |
| Network isolation                          | managed bridge, ICC disabled                                                      | dedicated sandbox namespace + NetworkPolicy: deny pod-to-pod, deny access to the app/cluster services, allow egress (DNS filtering via `dnsConfig` when `WORK_RUNTIME_DNS` is set)                                            |
| Hardening                                  | non-root, read-only rootfs, caps dropped, no-new-privileges, pids/memory/cpu/swap | securityContext: `runAsUser/runAsGroup 1000`, `readOnlyRootFilesystem`, `capabilities.drop: [ALL]`, `allowPrivilegeEscalation: false`, `seccompProfile: RuntimeDefault`; resources limits; `/tmp` = emptyDir with `sizeLimit` |
| Docker diagnostics                         | Engine API GET                                                                    | degrade gracefully: report backend=kubernetes with Pod counts, or "not applicable"                                                                                                                                            |

Everything in-container already flows through exec — there is no bind-mount
file access on the volume path — which is why parity is achievable: the
exec subresource is the only nontrivial transport to build.

## The seam: `WorkRuntimeDriver`

Phase 1 extracts an interface owned by `workRuntimeService`, which keeps all
policy (validation, leases, locks, budgets, ownership rules) and delegates
only mechanics:

```ts
interface WorkRuntimeDriver {
  probe(): Promise<void>; // throws with an operator-actionable reason
  ensureWorkspace(task): Promise<void>; // volume/PVC, labeled
  ensureRuntime(task): Promise<void>; // container/Pod running, policy-fresh
  runtimeState(task): Promise<'absent' | 'stopped' | 'running'>;
  stopRuntime(task): Promise<void>;
  removeRuntime(task): Promise<void>;
  removeWorkspace(task): Promise<void>;
  exec(task, spec: ExecSpec): Promise<ProcessResult>; // bounded output, timeout, optional stdin
  openTerminal(task, tty: TtySpec): Promise<WorkTerminalSession>;
  listManaged(): Promise<DiscoveredWorkContainer[]>; // reconciliation
  removeOrphan(name: string): Promise<void>;
  previewEndpoint(task): Promise<{ host: string; port: number } | null>;
}
```

Selection: `WORK_RUNTIME_BACKEND=docker | kubernetes` (default `docker`).
The Docker driver is a mechanical move of the existing `this.docker([...])`
call sites; the terminal service folds into the driver so the endpoint
resolution stays in one place.

## Kubernetes driver specifics

- **Client**: `@kubernetes/client-node` (official, supports exec WebSocket
  streams and in-cluster config). No shelling out to `kubectl`.
- **Config**: in-cluster ServiceAccount by default; `KUBECONFIG` for
  development. `WORK_K8S_NAMESPACE` (default `libre-webui-work`),
  `WORK_K8S_STORAGE_CLASS`, `WORK_K8S_WORKSPACE_SIZE` (default `5Gi` —
  first real per-task disk quota, an improvement over Docker).
- **Naming**: reuse `task.containerName`/`task.volumeName` (already
  DNS-safe `libre-work-<hex>`), so records need no migration.
- **RBAC** (the payoff): the sandbox ServiceAccount gets
  `pods, pods/exec, services, persistentvolumeclaims` create/get/list/delete
  **in the sandbox namespace only**. No secrets, no nodes, no cluster scope.
  Compare: the Docker socket is root on the host; the socket proxy narrows
  the API but not bind-mounts. Here the API server enforces that a sandbox
  Pod spec cannot mount hostPath (admission can forbid it outright), so a
  compromised backend is contained in a namespace for the first time.
- **Preview**: Pod publishes nothing; a per-task ClusterIP Service named
  after the task exposes 4173. `previewEndpoint()` returns the service DNS;
  the existing signed proxy and CSP wrap it unchanged. Cleaned up with the
  Pod (ownerReference: Service → Pod, so orphan GC is automatic).
- **Startup reconciliation**: identical planner (`planStartupReconciliation`
  is already pure); discovery lists Pods by the managed label. Orphan PVCs
  are reported, never auto-deleted (same stance as Docker volumes).
- **Helm**: chart adds the sandbox namespace, ServiceAccount + Role +
  RoleBinding, NetworkPolicies, and values for image/limits/storage. Gated
  behind `work.enabled=false` by default.

## Phases

Each phase lands independently, keeps `npm run test:work` green, and is a
separate PR.

1. **Extract the driver seam.** Pure refactor of `workRuntimeService` +
   `workTerminalService` behind `WorkRuntimeDriver`; Docker driver only;
   zero behavior change. Exit: full suite green, diff reviewed as a move.
   This is the riskiest phase — it touches every lifecycle path — and the
   most valuable even if Kubernetes never ships (it also unlocks e.g. a
   remote-runtime driver later).
2. **Kubernetes driver core.** probe, PVC + Pod lifecycle, exec transport
   (covers file tools, commands, git, preview-detect scripts), policy
   fingerprint annotation, reconciliation. Exit: a task runs end-to-end on
   a kind cluster minus preview/terminal.
3. **Terminal + preview.** exec-with-TTY WebSocket bridged into the
   existing `/ws/work-terminal` server; per-task Service + proxy target.
   Exit: interactive shell and hot-reload preview work on kind.
4. **Hardening + Helm + docs.** NetworkPolicies, admission notes, RBAC
   templates, `values.yaml`, docs 33/26/24 updates, deployment matrix flip.
   Exit: `helm install` on a fresh kind cluster gives working, isolated
   Work; documented threat-model deltas.
5. **CI.** GitHub Actions job: kind cluster, install chart, run a scripted
   task exercising every tool surface. Keeps the driver from rotting.

Rough effort: phase 1 is the long pole (the service is ~2,700 lines with
call sites woven through every path); phases 2–3 are mostly new code against
a stable seam; 4–5 are configuration and plumbing. 1 ≈ 2 ≈ (3+4) > 5.

## Open decisions

1. **Namespace model** — single shared sandbox namespace (recommended:
   simple RBAC, NetworkPolicy does inter-task isolation, matches the
   Docker bridge model) vs. namespace-per-task (stronger blast-radius
   containment, but RBAC must then span namespace creation — much wider
   grant, probably not worth it in v1).
2. **Exec output streaming** — `runCommand` today buffers with a 50k cap.
   Keep buffered semantics in v1 (identical limits), stream later.
3. **kind vs k3d for CI** — kind unless something forces otherwise.
4. **Terminal idle/limits** — reuse the existing session accounting
   untouched; only the transport changes. (Decision is just: confirm.)

## Risks

- **Seam regressions** (phase 1): mitigated by the existing behavior tests
  plus running the full suite against the Docker driver on every commit.
- **Exec WebSocket flakiness** under proxies/ingress between backend and
  API server: backend talks to the API server directly in-cluster, not
  through the public ingress — document that assumption.
- **PVC access mode**: RWO is fine (one Pod per task at a time is already
  the lifecycle-lock invariant), but must be stated: no two Pods per task.
- **Image**: kubelet pulls per node; first task on a node pays the pull.
  Same digest-pinning guidance as Docker (`WORK_RUNTIME_IMAGE`).
