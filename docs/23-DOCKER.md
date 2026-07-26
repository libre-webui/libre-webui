---
sidebar_position: 23
title: 'Docker'
description: 'Deploy Libre WebUI with Docker and Docker Compose.'
slug: /DOCKER
keywords: [libre webui docker, docker compose, container deployment]
---

# Docker

Docker is the easiest production-style deployment for a single server.

## Work Availability

The standard Libre WebUI image supports Chat and the rest of the normal
application, but it does not provide the native Work runtime. The image
deliberately contains neither the Docker CLI nor the host Docker socket, so the
Work page reports **Runtime unavailable**.

Running Libre WebUI in Docker is different from letting a native Libre WebUI
backend create isolated Work containers. Installing Docker on the host does not
make its daemon available inside the WebUI container.

Do not add `/var/run/docker.sock` as a casual workaround. A process with access
to that socket has root-equivalent control of the Docker host. Operators who
design a separate runtime integration must isolate the daemon, restrict trusted
administrators, and back up the task volumes independently.

For the currently supported local Work path, run Libre WebUI natively with
`npx libre-webui` or from source on a machine whose backend process can invoke
Docker. See [Work: Isolated Workspaces](./WORKSPACES).

## Bundled Ollama

Runs Libre WebUI and Ollama in one Compose stack:

```bash
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

## NVIDIA GPU

Use the GPU Compose file when Docker has NVIDIA runtime access:

```bash
docker compose -f docker-compose.gpu.yml up -d
```

Confirm GPU access from the Ollama container if models are still running on CPU.

## External Ollama

Use this when Ollama is already running on the host or another server:

```bash
docker compose -f docker-compose.external-ollama.yml up -d
```

Override the Ollama URL if needed:

```bash
OLLAMA_BASE_URL=http://192.168.1.10:11434 docker compose -f docker-compose.external-ollama.yml up -d
```

## Data Persistence

Libre WebUI stores backend data in `/app/backend/data` inside the container. The Compose files mount that path as a named volume.

For production, set stable secrets:

```env
JWT_SECRET=replace-with-a-long-random-secret
ENCRYPTION_KEY=replace-with-64-hex-characters
```

Back up the data volume and encryption key together.

If you operate a custom Work-capable runtime, its task files live in separate
Docker named volumes and are not included in the normal
`/app/backend/data` backup.

## Public Access

The repository Compose file currently sets `CORS_ORIGIN` directly. A value in
your shell or `.env` file does not replace that literal. Edit the
`libre-webui.environment` entry or save an explicit override as
`compose.origin.yml`:

```yaml
services:
  libre-webui:
    environment:
      CORS_ORIGIN: https://your-domain.example
      BASE_URL: https://your-domain.example
```

Apply the override together with the selected repository Compose file:

```bash
docker compose -f docker-compose.yml -f compose.origin.yml up -d
```

Then put Libre WebUI behind HTTPS with a reverse proxy or platform load
balancer.

## Useful Commands

```bash
docker compose ps
docker compose logs -f libre-webui
docker compose logs -f ollama
docker compose pull
docker compose up -d
```

## Related Docs

- [Work: Isolated Workspaces](./WORKSPACES)
- [Docker with External Ollama](./DOCKER_EXTERNAL_OLLAMA)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Troubleshooting](./TROUBLESHOOTING)
