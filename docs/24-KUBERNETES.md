---
sidebar_position: 24
title: "Kubernetes"
description: "Deploy Libre WebUI on Kubernetes with Helm"
slug: /KUBERNETES
keywords: [libre webui kubernetes, helm chart, k8s deployment]
---

# Kubernetes Deployment

Deploy Libre WebUI on Kubernetes using Helm.

## Quick Start

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui
```

This deploys:
- Libre WebUI
- Bundled Ollama instance
- PersistentVolumeClaims for data

## Access the Application

After installation, follow the NOTES output. For ClusterIP (default):

```bash
kubectl port-forward svc/libre-webui 8080:8080
```

Then open `http://localhost:8080`

## Configuration

### External Ollama

Connect to an existing Ollama instance instead of bundled:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set ollama.bundled.enabled=false \
  --set ollama.external.enabled=true \
  --set ollama.external.url=http://my-ollama:11434
```

### NVIDIA GPU Support

Enable GPU acceleration for Ollama:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set ollama.bundled.gpu.enabled=true
```

### Ingress

Expose via Ingress:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=chat.example.com
```

With TLS:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set ingress.enabled=true \
  --set ingress.hosts[0].host=chat.example.com \
  --set ingress.tls[0].secretName=chat-tls \
  --set ingress.tls[0].hosts[0]=chat.example.com
```

### API Keys

Set cloud provider API keys:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set secrets.openaiApiKey=sk-... \
  --set secrets.anthropicApiKey=sk-ant-...
```

Or create a secret manually:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: libre-webui-secrets
type: Opaque
stringData:
  OPENAI_API_KEY: sk-...
  ANTHROPIC_API_KEY: sk-ant-...
```

### Autoscaling

Enable HorizontalPodAutoscaler:

```bash
helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui \
  --set autoscaling.enabled=true \
  --set autoscaling.minReplicas=2 \
  --set autoscaling.maxReplicas=10
```

## Values Reference

Key configuration options:

| Value | Default | Description |
|-------|---------|-------------|
| `replicaCount` | `1` | Number of replicas |
| `image.repository` | `librewebui/libre-webui` | Image repository |
| `image.tag` | `latest` | Image tag |
| `service.type` | `ClusterIP` | Service type |
| `service.port` | `8080` | Service port |
| `ingress.enabled` | `false` | Enable Ingress |
| `ollama.bundled.enabled` | `true` | Deploy bundled Ollama |
| `ollama.bundled.gpu.enabled` | `false` | Enable GPU for Ollama |
| `ollama.external.enabled` | `false` | Use external Ollama |
| `ollama.external.url` | `""` | External Ollama URL |
| `persistence.enabled` | `true` | Enable persistence |
| `persistence.size` | `5Gi` | PVC size |
| `autoscaling.enabled` | `false` | Enable HPA |

See [values.yaml](https://github.com/libre-webui/libre-webui/blob/main/helm/libre-webui/values.yaml) for all options.

## Upgrading

```bash
helm upgrade libre-webui oci://ghcr.io/libre-webui/charts/libre-webui
```

## Uninstalling

```bash
helm uninstall libre-webui
```

Note: PersistentVolumeClaims are not deleted by default. Remove manually if needed:

```bash
kubectl delete pvc -l app.kubernetes.io/instance=libre-webui
```

## Pulling Models

After deployment, pull models into the bundled Ollama:

```bash
kubectl exec -it deployment/libre-webui-ollama -- ollama pull llama3.2
```

## Troubleshooting

### Check pod status

```bash
kubectl get pods -l app.kubernetes.io/name=libre-webui
```

### View logs

```bash
kubectl logs -l app.kubernetes.io/name=libre-webui -f
```

### Check Ollama connection

```bash
kubectl exec -it deployment/libre-webui -- wget -qO- http://libre-webui-ollama:11434/api/version
```
