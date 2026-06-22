---
sidebar_position: 1
title: 'Docker with External Ollama'
description: 'Run Libre WebUI in Docker while connecting to an existing Ollama instance.'
slug: /DOCKER_EXTERNAL_OLLAMA
keywords: [libre webui docker, docker external ollama, docker compose, ollama]
image: /img/social/15.png
---

# Docker with External Ollama

Use this setup when Ollama already runs on your host, another server, or a Tailscale/LAN machine.

## Prerequisites

Confirm Ollama is reachable:

```bash
curl http://localhost:11434/api/version
```

Pull a model if the instance is new:

```bash
ollama pull gemma3:4b
```

## Start Libre WebUI

From the repository root:

```bash
docker compose -f docker-compose.external-ollama.yml up -d
```

Open [http://localhost:8080](http://localhost:8080).

The compose file points `OLLAMA_BASE_URL` to `http://host.docker.internal:11434` by default.

## Custom Ollama URL

For a different host:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434 docker compose -f docker-compose.external-ollama.yml up -d
```

For Linux hosts that do not resolve `host.docker.internal`, add this to the service:

```yaml
extra_hosts:
  - 'host.docker.internal:host-gateway'
```

## Data Persistence

The compose file stores Libre WebUI data in Docker volumes:

- `libre_webui_data`
- `libre_webui_temp`

Set stable secrets for production:

```env
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-64-hex-characters
```

Back up the data volume and encryption key together.

## Network Access

If you access the app from another device, include that origin:

```env
CORS_ORIGIN=http://localhost:8080,http://192.168.1.50:8080
```

For a public domain, use HTTPS and set:

```env
BASE_URL=https://your-domain.example
CORS_ORIGIN=https://your-domain.example
```

## Useful Commands

```bash
docker compose -f docker-compose.external-ollama.yml ps
docker compose -f docker-compose.external-ollama.yml logs -f libre-webui
docker compose -f docker-compose.external-ollama.yml restart
docker compose -f docker-compose.external-ollama.yml pull
docker compose -f docker-compose.external-ollama.yml up -d
```

## Troubleshooting

**Libre WebUI cannot reach Ollama**

```bash
docker compose -f docker-compose.external-ollama.yml exec libre-webui \
  wget -O- http://host.docker.internal:11434/api/version
```

If that fails, use an explicit LAN/Tailscale IP in `OLLAMA_BASE_URL`.

**Models do not appear**

Check the Ollama host:

```bash
ollama list
```

The Model Manager reads from the configured Ollama instance.

**CORS errors**

Make sure `CORS_ORIGIN` matches the exact browser origin, including scheme and port.

## Related Docs

- [Docker](./DOCKER)
- [Working with Models](./WORKING_WITH_MODELS)
- [Troubleshooting](./TROUBLESHOOTING)
