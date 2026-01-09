---
sidebar_position: 23
title: "Docker"
description: "Deploy Libre WebUI with Docker and Docker Compose"
slug: /DOCKER
keywords: [libre webui docker, docker compose, container deployment]
---

# Docker Deployment

Deploy Libre WebUI using Docker and Docker Compose.

## Quick Start

### With Bundled Ollama (Recommended)

Everything in one command - includes Ollama:

```bash
docker-compose up -d
```

Access at `http://localhost:8080`

### With NVIDIA GPU

For GPU-accelerated inference:

```bash
docker-compose -f docker-compose.gpu.yml up -d
```

### With External Ollama

If Ollama is already running on your host:

```bash
docker-compose -f docker-compose.external-ollama.yml up -d
```

## Docker Compose Files

| File | Use Case |
|------|----------|
| `docker-compose.yml` | Bundled Ollama (CPU) |
| `docker-compose.gpu.yml` | Bundled Ollama (NVIDIA GPU) |
| `docker-compose.external-ollama.yml` | External Ollama on host |

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://ollama:11434` | Ollama API URL |
| `PORT` | `3001` | Backend port |
| `SINGLE_USER_MODE` | `false` | Skip authentication |
| `JWT_SECRET` | auto-generated | Auth secret (set for production) |

### Custom Configuration

Create a `.env` file:

```env
OLLAMA_BASE_URL=http://ollama:11434
JWT_SECRET=your-secure-secret-here
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Data Persistence

Data is stored in Docker volumes:

- `libre_webui_data` - Database and user data
- `ollama_data` - Downloaded models (bundled Ollama only)

### Backup

```bash
docker run --rm -v libre_webui_data:/data -v $(pwd):/backup alpine tar czf /backup/backup.tar.gz /data
```

### Restore

```bash
docker run --rm -v libre_webui_data:/data -v $(pwd):/backup alpine tar xzf /backup/backup.tar.gz -C /
```

## Development Builds

Development builds from the `dev` branch:

```bash
# CPU
docker-compose -f docker-compose.dev.yml up -d

# NVIDIA GPU
docker-compose -f docker-compose.dev.gpu.yml up -d

# External Ollama
docker-compose -f docker-compose.dev.external-ollama.yml up -d
```

Development builds use separate volumes (`libre_webui_dev_data`) to prevent conflicts.

Pull latest dev image:

```bash
docker pull librewebui/libre-webui:dev
```

## Updating

```bash
docker-compose pull
docker-compose up -d
```

## Troubleshooting

### Ollama not connecting

```bash
# Check if Ollama is running
docker-compose logs ollama

# For external Ollama, verify it's accessible
curl http://localhost:11434/api/version
```

### View logs

```bash
docker-compose logs -f libre-webui
```

### Reset everything

```bash
docker-compose down -v
docker-compose up -d
```

## Building from Source

```bash
docker build -t libre-webui:local .
```

Then update `docker-compose.yml` to use `image: libre-webui:local` instead of the published image.
