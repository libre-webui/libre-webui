---
sidebar_position: 23
title: 'Docker'
description: 'Deploy Libre WebUI with Docker and Docker Compose.'
slug: /DOCKER
keywords: [libre webui docker, docker compose, container deployment]
---

# Docker

Docker is the easiest production-style deployment for a single server.

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

## Public Access

For a public domain, set:

```env
CORS_ORIGIN=https://your-domain.example
BASE_URL=https://your-domain.example
```

Put Libre WebUI behind HTTPS with a reverse proxy or platform load balancer.

## Useful Commands

```bash
docker compose ps
docker compose logs -f libre-webui
docker compose logs -f ollama
docker compose pull
docker compose up -d
```

## Related Docs

- [Docker with External Ollama](./DOCKER_EXTERNAL_OLLAMA)
- [Environment Variables](./ENVIRONMENT_VARIABLES)
- [Database Encryption](./DATABASE_ENCRYPTION)
- [Troubleshooting](./TROUBLESHOOTING)
