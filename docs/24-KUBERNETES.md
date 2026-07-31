---
sidebar_position: 24
title: 'Kubernetes'
description: 'Deploy Libre WebUI on Kubernetes with Helm.'
slug: /KUBERNETES
keywords: [libre webui kubernetes, helm chart, k8s deployment]
---

# Kubernetes

Libre WebUI ships a Helm chart under `helm/libre-webui`.

## Work Availability

The current Helm chart does not create a Work runtime. The image ships the
Docker CLI and the repository Compose files mount the host Docker socket, but
the chart mounts no container-runtime socket and Kubernetes nodes do not
normally expose one. Work therefore reports **Runtime unavailable** in a normal
chart installation; Chat and the other application features continue to work.

Do not mount a node's container-runtime socket into the WebUI pod. Supporting
Work safely in Kubernetes requires a separate runtime driver with tightly
scoped RBAC, one isolated workload and persistent volume per task, admission and
resource policies, cleanup guarantees, and a preview-routing design. Those
resources are not part of the current chart.

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

A future Work runtime would also need an independent backup policy for
task-owned persistent volumes. Work files do not live in the Libre WebUI data
PVC.

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
