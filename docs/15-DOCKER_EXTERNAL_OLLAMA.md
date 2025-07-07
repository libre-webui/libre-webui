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

```bash
# Build and run with external Ollama configuration
docker-compose -f docker-compose.external-ollama.yml up -d
```

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
| `JWT_SECRET` | `your-super-secret-jwt-key-change-this-in-production` | Authentication secret |
| `CORS_ORIGIN` | `http://localhost:8080` | Frontend origin for CORS |

### Custom Ollama URL

If your Ollama is running on a different host or port:

```bash
OLLAMA_BASE_URL=http://192.168.1.100:11434 docker-compose -f docker-compose.external-ollama.yml up -d
```

## 🔧 Troubleshooting

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

1. **Change JWT Secret**: Always set a secure JWT_SECRET in production
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
JWT_SECRET=your-secure-secret-here
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

**💡 Need help with the standard Docker setup?** See the main [Docker documentation](../DOCKER.md).

**🚀 Ready to start chatting?** Visit `http://localhost:8080` after running the setup commands above.
