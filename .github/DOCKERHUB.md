# Libre WebUI

**A local-first workspace for chat, private knowledge, artifacts, and isolated model-driven work.**

Self-hosted. Provider-flexible. Apache 2.0. No application telemetry.

[![Latest release](https://img.shields.io/github/v/release/libre-webui/libre-webui?style=flat-square&label=release&color=2563eb)](https://github.com/libre-webui/libre-webui/releases)
[![License](https://img.shields.io/badge/license-Apache--2.0-15803d?style=flat-square)](https://github.com/libre-webui/libre-webui/blob/main/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/libre-webui/libre-webui?style=flat-square&label=stars&color=ff7b52)](https://github.com/libre-webui/libre-webui)

![Libre WebUI](https://raw.githubusercontent.com/libre-webui/libre-webui/main/screenshot.png)

Libre WebUI connects to local models through Ollama or to providers you choose. It includes document search, interactive artifacts, personas, multi-user access controls, image and speech providers, and task-scoped Work containers for model-driven file and command workflows.

## Start with Docker

The repository includes Compose configurations for bundled Ollama, an existing Ollama server, and NVIDIA GPU inference:

```bash
git clone https://github.com/libre-webui/libre-webui.git
cd libre-webui
docker compose up -d
```

Open <http://localhost:8080>. The first account created on a fresh installation becomes the administrator; further registration remains disabled unless an administrator enables it deliberately.

See the [Docker deployment documentation](https://docs.librewebui.org/DOCKER) for persistent secrets, HTTPS, backups, external Ollama, and GPU configuration.

> The repository's Compose files mount the Docker socket so Work can create isolated task containers. Docker socket access is root-equivalent access to the host. Remove that mount when Work is not required.

## Image tags

- `latest` — current stable image from the production branch
- `dev` — current development image; may include unfinished or breaking changes
- Semantic versions such as `0.18.0` — immutable release lines
- Commit tags such as `sha-667921d` — builds tied to an exact source revision

Images are published for Linux AMD64 and ARM64 to both Docker Hub and GitHub Container Registry.

## Other installation paths

- npm: `npx libre-webui`
- GHCR: `ghcr.io/libre-webui/libre-webui`
- Kubernetes: `helm install libre-webui oci://ghcr.io/libre-webui/charts/libre-webui`
- Desktop clients: [GitHub Releases](https://github.com/libre-webui/libre-webui/releases)

## Links

- [Website](https://librewebui.org)
- [Documentation](https://docs.librewebui.org)
- [Source code](https://github.com/libre-webui/libre-webui)
- [Release notes](https://github.com/libre-webui/libre-webui/releases)
- [Security policy](https://github.com/libre-webui/libre-webui/security/policy)
- [Project charter](https://github.com/libre-webui/libre-webui/blob/main/CHARTER.md)
