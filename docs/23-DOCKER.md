---
sidebar_position: 23
title: 'Docker'
description: 'Deploy Libre WebUI with Docker and Docker Compose.'
slug: /DOCKER
keywords: [libre webui docker, docker compose, container deployment]
---

# Docker

Docker is the easiest production-style deployment for a single server.

For an Internet-reachable single-server installation, start with
[Private Remote Deployment](./PRIVATE_REMOTE_DEPLOYMENT). Its Compose template
publishes no application ports, defaults to the `main` image, and adds an outer
Cloudflare Access boundary, host controls, backups, and container limits.

## Work Availability

Work is enabled in every repository Compose file. The image ships the Docker
CLI, and the Compose files mount `/var/run/docker.sock`, so the backend drives
the same daemon that runs Libre WebUI. Work task containers are therefore
**siblings** of the Libre WebUI container, not children of it, and they appear
in `docker ps` on the host.

A process with access to that socket has root-equivalent control of the Docker
host. Enabling Work by default is a deliberate choice: Work is a core feature,
and it cannot function without daemon access. The consequence is that **every
Libre WebUI administrator is effectively a host administrator**. Plan for it:

- Keep the stack on a host whose administrators you already trust.
- Do not expose the published port to an untrusted network.
- Remove the `/var/run/docker.sock` mount from your Compose file to disable
  Work. Nothing else in Libre WebUI depends on it, and the Work page then
  reports **Runtime unavailable**.

On Linux the socket belongs to the `docker` group instead of root, so the
non-root app user needs that group id. Set it once:

```bash
echo "DOCKER_GID=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  alpine stat -c '%g' /var/run/docker.sock)" >> .env
```

Read it through a container as shown. A macOS host reports a different value
than the container sees, because Docker Desktop proxies the socket through a
VM. If the group is wrong, the Work page names the problem instead of failing
silently. See [Work: Isolated Workspaces](./WORKSPACES).

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
