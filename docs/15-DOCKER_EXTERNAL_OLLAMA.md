---
sidebar_position: 1
title: "Docker External Ollama Setup"
description: "Simple Docker deployment for Libre WebUI with external Ollama. Complete guide for Docker Compose, networking, and container management."
slug: /DOCKER_EXTERNAL_OLLAMA
keywords: [libre webui docker, docker external ollama, easy docker ai setup, libre webui vs open webui docker, docker compose ai, container ai deployment, ollama docker network, simplified docker setup]
image: /img/docusaurus-social-card.jpg
---

# 🐳 Docker with External Ollama Setup

This guide covers running Libre WebUI in Docker while connecting to an external Ollama instance running on your host machine.

## 🎯 Overview

When you already have Ollama running on your host machine and want to run Libre WebUI in a Docker container, you need a specialized configuration that:

- Connects to your external Ollama instance
- Properly configures port mappings
- Maintains data persistence

## 📁 Required Files

This setup uses two specialized files:

### `docker-compose.external-ollama.yml`

Docker Compose configuration that:
- Removes the internal Ollama service
- Configures external Ollama connection
- Sets up proper port mappings

### `Dockerfile` (Modified)

Updated Docker image that:
- Supports flexible frontend port configuration
- Uses environment variables for port settings
- Connects to external Ollama via `host.docker.internal`

## 🚀 Quick Start

### Prerequisites

1. **Ollama running on host machine**:
   ```bash
   ollama serve
   ```
   
2. **Verify Ollama is accessible**:
   ```bash
   curl http://localhost:11434/api/version
   ```

### Launch Container

<Tabs>
  <TabItem value="compose" label="🐳 Docker Compose (Recommended)" default>

**Using pre-built image:**
```bash
# Pull and run with external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

**Building locally from source:**
```bash
# First, build the local Docker image
docker build --no-cache -t libre-webui:latest .

# Then run with external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

:::tip When to Build Locally
Build locally when:
- You want to use the latest development code
- You've made custom modifications to the source
- The pre-built image doesn't work for your architecture
:::

  </TabItem>
  <TabItem value="docker-run" label="🏃 Direct Docker Run">

**Quick single command:**
```bash
# Run directly with Docker (builds automatically)
docker run -d \
  --name libre-webui \
  -p 8080:5173 \
  -p 3001:3001 \
  -e OLLAMA_BASE_URL=http://host.docker.internal:11434 \
  -e FRONTEND_PORT=5173 \
  -v libre_webui_data:/app/backend/data \
  $(docker build -q .)
```

  </TabItem>
</Tabs>

### Access Application

- **Web Interface**: `http://localhost:8080`
- **Backend API**: `http://localhost:3001`
- **Frontend Internal**: Port 5173 (mapped to 8080)

## ⚙️ Configuration Details

### Port Mapping

| Service | Internal Port | External Port | Description |
|---------|---------------|---------------|-------------|
| Frontend | 5173 | 8080 | Web interface access |
| Backend | 3001 | 3001 | API endpoints |
| Ollama | N/A | 11434 | External on host |

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://host.docker.internal:11434` | External Ollama URL |
| `FRONTEND_PORT` | `5173` | Internal frontend port |
| `JWT_SECRET` | *(auto-generated)* | Authentication secret - **REQUIRED for production** |
| `CORS_ORIGIN` | `http://localhost:8080` | Frontend origin for CORS |

### Custom Ollama URL

If your Ollama is running on a different host or port:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434 docker-compose -f docker-compose.external-ollama.yml up -d
```

## 🔧 Troubleshooting

### Build Issues

**SQLCipher Compilation Errors**
If you encounter errors like "Could not find sqlite3 development headers" during local builds:

```bash
# The Dockerfile includes these dependencies automatically:
# - sqlite-dev (SQLite development headers)
# - openssl-dev (OpenSSL development libraries) 
# - libffi-dev (Foreign Function Interface library)
# - python3-dev (Python development headers for node-gyp)

# If build still fails, try clearing Docker cache:
docker system prune -f
docker build --no-cache -t libre-webui:latest .
```

### Common Issues

**1. "Ollama service is not available"**
```bash
# Check if Ollama is running on host
curl http://localhost:11434/api/version

# Check from inside container
docker exec -it libre-webui-libre-webui-1 wget -O- http://host.docker.internal:11434/api/version
```

**2. Frontend not accessible at port 8080**
```bash
# Check container logs
docker-compose -f docker-compose.external-ollama.yml logs libre-webui

# Verify port mapping
docker-compose -f docker-compose.external-ollama.yml ps
```

**3. CORS errors in browser**
- Verify `CORS_ORIGIN` matches your access URL
- Check browser developer tools for specific CORS messages

### Debugging Commands

```bash
# View container logs
docker-compose -f docker-compose.external-ollama.yml logs -f

# Check container status
docker-compose -f docker-compose.external-ollama.yml ps

# Restart services
docker-compose -f docker-compose.external-ollama.yml restart

# Rebuild and restart
docker-compose -f docker-compose.external-ollama.yml up -d --build
```

## 📊 Data Persistence

The container uses Docker volumes for data persistence:

- `libre_webui_data`: SQLite database and user data
- `libre_webui_temp`: Temporary files and uploads

Data persists across container restarts and rebuilds.

## 🔒 Security Considerations

1. **JWT Secret**: 
   - **Development**: Auto-generated secure random secret (sessions don't persist across restarts)
   - **Production**: **MUST** set `JWT_SECRET` environment variable for persistent sessions
   - Generate secure secret: `openssl rand -hex 64`
2. **Network Access**: Ensure Ollama is only accessible from trusted sources
3. **Firewall Rules**: Configure appropriate firewall rules for port 8080
4. **HTTPS**: Consider using a reverse proxy with SSL for production

## 🎛️ Advanced Configuration

### Custom Docker Network

```yaml
# Add to docker-compose.external-ollama.yml
networks:
  libre-webui-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.20.0.0/16
```

### Resource Limits

```yaml
# Add to libre-webui service in docker-compose.external-ollama.yml
deploy:
  resources:
    limits:
      memory: 1G
      cpus: '0.5'
```

### Custom Environment File

Create `.env.external-ollama`:
```bash
OLLAMA_BASE_URL=http://host.docker.internal:11434
# Generate with: openssl rand -hex 64
JWT_SECRET=your-cryptographically-secure-64-char-hex-secret-here
CORS_ORIGIN=http://localhost:8080
```

Then use:
```bash
docker-compose -f docker-compose.external-ollama.yml --env-file .env.external-ollama up -d
```

## ✅ Verification

After successful startup, verify everything is working:

1. **Frontend accessible**: Visit `http://localhost:8080`
2. **Backend healthy**: `curl http://localhost:3001/health`
3. **Ollama connected**: Check for Ollama connection messages in logs
4. **Models available**: Verify models are listed in the UI

## 🔄 Updating

To update to the latest version:

```bash
# Pull latest changes
git pull

# Rebuild and restart
docker-compose -f docker-compose.external-ollama.yml up -d --build
```

---

**🚀 Ready to start chatting?** Visit `http://localhost:8080` after running the setup commands above.
