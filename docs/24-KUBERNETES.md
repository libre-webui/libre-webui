---
sidebar_position: 24
title: 'Kubernetes'
description: 'Deploy Libre WebUI on Kubernetes with Helm.'
slug: /KUBERNETES
keywords: [libre webui kubernetes, helm chart, k8s deployment]
---

# Kubernetes

Libre WebUI ships a Helm chart under `helm/libre-webui`.

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

Set a stable JWT secret and encryption key for production. Use Kubernetes Secrets rather than plaintext values files.

```bash
kubectl create secret generic libre-webui-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -hex 64)" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -hex 32)"
```

Add provider API keys the same way when you want deployment-wide plugin credentials.

## Persistence

Keep the Libre WebUI data PVC and Ollama model PVC on persistent storage. Back up the Libre WebUI data volume and the encryption key together.

## Ingress

For public access, configure ingress with HTTPS and set backend origins:

```env
BASE_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

OAuth callback URLs must match the public domain.

## Resource Planning

For local Ollama inside the cluster, schedule the Ollama pod on nodes with enough memory and GPU capacity for the models you plan to run. If your cluster already has a dedicated Ollama or inference service, external Ollama is usually simpler.

## Related Docs

- [Docker](./DOCKER)
- [Hardware Requirements](./HARDWARE_REQUIREMENTS)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Authentication](./AUTHENTICATION)
