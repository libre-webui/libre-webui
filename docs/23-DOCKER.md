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

Work is enabled in repository Compose files by default. The image ships the
Docker CLI and Compose mounts `/var/run/docker.sock`, so Work task containers
are **siblings** of the Libre WebUI container. They appear in `docker ps` on the
host.

A process with access to that socket has root-equivalent control of the Docker
host. Enabling Work by default is a deliberate choice: Work is a core feature,
and it cannot function without daemon access. The consequence is that **every
Libre WebUI administrator is effectively a host administrator**. Plan for it:

- Keep the stack on a host whose administrators you already trust.
- Do not expose the published port to an untrusted network.
- Remove the `/var/run/docker.sock` mount when Work is not required. The Work
  page then reports **Runtime unavailable**.

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

The WebUI port binds to host loopback by default. Set
`WEBUI_BIND_ADDRESS=0.0.0.0` only when a trusted LAN or a host reverse proxy must
reach it, and restrict the port with the host firewall.

Ollama remains private to the Compose network. To make it available to host
applications on loopback, add the explicit host override:

```bash
docker compose -f docker-compose.yml -f docker-compose.ollama-host.yml up -d
```

Set `OLLAMA_BIND_ADDRESS` only when another machine must reach Ollama, and
protect that port with a firewall and authentication-capable proxy.

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

## Socket-Isolated Work

The standard Compose files mount the Docker socket into the Libre WebUI
container so Work can run task containers; that mount is root-equivalent
control of the Docker host. To keep Work without giving the web application
the socket, use the socket-proxy variant:

```bash
docker compose -f docker-compose.socket-proxy.yml up -d
```

A socket proxy on an internal network holds `/var/run/docker.sock` and
forwards only the API sections Work uses (containers, images, volumes,
networks, exec, info). Swarm, secrets, configs, build, and system endpoints
are denied at the proxy. Libre WebUI reaches it via
`DOCKER_HOST=tcp://docker-socket-proxy:2375` — no socket mount, no
`DOCKER_GID`, and the interactive terminal and system diagnostics work
unchanged. See the Workspaces documentation for what this boundary does and
does not cover.

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

Repository Compose files bind the WebUI to loopback and set `CORS_ORIGIN`
directly. A value in
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
balancer. Set `WEBUI_BIND_ADDRESS` to the exact interface that proxy needs; do
not publish the port on every interface unless the firewall requires it.

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
