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
| `DATABASE_URL` | - | PostgreSQL connection string (uses SQLite if not set) |
| `ENCRYPTION_KEY` | auto-generated | 64-char hex key for AES-256 encryption |

### Custom Configuration

Create a `.env` file:

```env
OLLAMA_BASE_URL=http://ollama:11434
JWT_SECRET=your-secure-secret-here
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

## Database

### PostgreSQL (Default in Docker)

The default `docker-compose.yml` includes a PostgreSQL container. No extra configuration needed:

```bash
docker-compose up -d
```

This starts PostgreSQL alongside the app with `DATABASE_URL=postgresql://libre:libre@postgres:5432/libre_webui`.

### SQLite (Lightweight / Single-User)

To use SQLite instead, remove or comment out the `DATABASE_URL` environment variable and the `postgres` service from your `docker-compose.yml`. The app will automatically fall back to SQLite, stored in the `libre_webui_data` volume.

### Migrating from SQLite to PostgreSQL

If you've been running on SQLite and want to switch to PostgreSQL:

1. Add the `postgres` service to your `docker-compose.yml`
2. Add `DATABASE_URL=postgresql://libre:libre@postgres:5432/libre_webui` to the environment
3. Restart: `docker-compose up -d`

The app **automatically migrates** all your existing SQLite data (users, chats, personas, settings, documents) to PostgreSQL on the first startup. This runs inside a transaction — if anything fails, nothing is written and your SQLite data stays intact.

The migration only runs once. On subsequent starts it detects the migration is already done and skips it.

## Data Persistence

Data is stored in Docker volumes:

- `libre_webui_data` - SQLite database (if used), uploads, and encryption keys
- `postgres_data` - PostgreSQL data (if using PostgreSQL)
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
