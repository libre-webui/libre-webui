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

Set a stable JWT secret and encryption key for production. The current chart
creates its own `<release>-libre-webui-secrets` object from `secrets.*` values;
it does not have an `existingSecret` setting, so pre-creating an unrelated
generic Secret does not wire those values into the pod.

```bash
helm upgrade --install libre-webui \
  oci://ghcr.io/libre-webui/charts/libre-webui \
  --set-string secrets.jwtSecret="$(openssl rand -hex 64)" \
  --set-string secrets.encryptionKey="$(openssl rand -hex 32)"
```

For production automation, supply stable values through an encrypted Helm
values workflow or an external-secrets integration you maintain; command-line
values can be exposed through process inspection and are retained in Helm
release metadata. The current chart exposes only the secret keys declared in
`values.yaml`. Add provider keys through a deliberate chart extension or
configure per-user credentials in the WebUI.

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
  --set-string env.CORS_ORIGIN=https://your-domain.example
```

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
