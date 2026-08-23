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

## Work Availability

This Compose setup changes where Ollama runs; Work remains enabled through the
mounted host Docker socket. It grants Libre WebUI root-equivalent control of the
Docker host, so use it only where Libre WebUI administrators are also trusted
host administrators. On Linux, set `DOCKER_GID` in `.env` to the group owning
the socket. Remove the mount if Work is not wanted. See
[Work: Isolated Workspaces](./WORKSPACES).

## Prerequisites

Confirm Ollama is reachable:

```bash
curl http://localhost:11434/api/version
```

Pull a model if the instance is new:

```bash
ollama pull gemma4:12b
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

The repository Compose file currently sets `CORS_ORIGIN` directly. A value in
your shell or `.env` file does not replace that literal. Edit the
`libre-webui.environment` entry or add an explicit Compose override, for example
`compose.origin.yml`:

```yaml
services:
  libre-webui:
    environment:
      CORS_ORIGIN: http://localhost:8080,http://192.168.1.50:8080
      BASE_URL: http://192.168.1.50:8080
```

Apply both files:

```bash
docker compose \
  -f docker-compose.external-ollama.yml \
  -f compose.origin.yml \
  up -d
```

For a public domain, use the exact HTTPS origin for both values and terminate
traffic with HTTPS.

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

- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker](./DOCKER)
- [Working with Models](./WORKING_WITH_MODELS)
- [Troubleshooting](./TROUBLESHOOTING)
