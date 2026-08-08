---
sidebar_position: 36
title: 'Private Remote Deployment'
description: 'Harden a single-server Libre WebUI deployment behind Cloudflare Access and Tunnel.'
slug: /PRIVATE_REMOTE_DEPLOYMENT
keywords:
  [libre webui private deployment, cloudflare tunnel, production hardening]
---

# Private Remote Deployment

This pattern runs Libre WebUI, Ollama, and Cloudflare Tunnel on one Docker host
without publishing the application or Ollama ports. Cloudflare Access is the
outer identity boundary; Libre WebUI authentication remains the inner boundary.
Work and Watchtower are separate, root-equivalent opt-ins.

Use [`deploy/private/docker-compose.yml`](https://github.com/libre-webui/libre-webui/blob/main/deploy/private/docker-compose.yml)
as the starting point. It defaults to the `main` image:

```env
LIBRE_WEBUI_IMAGE=ghcr.io/libre-webui/libre-webui:main
```

The `dev` tag is suitable for an explicitly opted-in development instance, not
the client default.

## Security model

- Cloudflare Access protects the entire hostname, including `/api/*` and
  WebSocket upgrades. Do not add public bypass paths.
- Libre WebUI requires a current account for application APIs. Model lifecycle
  and Work operations require the current database role to be administrator.
- The application, Ollama, SearXNG, and cloudflared only use a private Compose
  network. The host publishes no application ports.
- The bundled SearXNG service powers optional web search. It is internal-only
  and inert until an administrator enables search in Settings > Search; set
  `SEARXNG_SECRET` in `.env` before starting the stack.
- The app runs non-root with a read-only root filesystem, no Linux
  capabilities, no-new-privileges, and CPU, memory, and PID limits.
- Work is disabled unless one of its overrides is included. When enabled,
  its containers add their own read-only root filesystem, capability drop,
  resource limits, workspace volume, and default-deny network policy.

The base stack mounts no Docker socket. Enabling Work with
`docker-compose.work-proxy.yml` keeps it that way: a socket proxy on an
internal network holds the socket and forwards only the API sections Work
uses (containers, images, volumes, networks, exec, info); swarm, secrets,
build, and system endpoints are denied at the proxy, and the application
needs no socket mount or socket-group membership. The proxy narrows the
Docker API surface, not the blast radius of what it forwards — whoever can
create containers can still bind-mount host paths — so treat it as a real
hardening layer, not as multi-tenant isolation.

The raw-socket alternatives remain the largest trust boundary: the
`docker-compose.work.yml` and Watchtower overrides give a container a
process that can issue arbitrary Docker API calls, which can control the
host. A read-only socket mount does not make Docker API access read-only.

## Bootstrap

1. Create a non-root sudo operator and verify key-based SSH login before
   disabling root SSH.
2. Copy `deploy/private/.env.example` to `/opt/libre-webui/.env`, set mode
   `0600`, and generate unique secrets.
3. If Work will be enabled, set `DOCKER_GID` to the numeric group that owns
   `/var/run/docker.sock`.
4. Store the Cloudflare tunnel token in
   `/opt/libre-webui/secrets/tunnel-token` with mode `0640` or stricter.
5. Create a Cloudflare Access self-hosted application for the complete
   hostname, use a 24-hour session, and allow only the intended identities.
   Enable **Protect with Access** on the tunnel route. If monitoring requires a
   public health check, create a separate path-scoped application or policy for
   `/health` only. Never add a blanket Bypass policy to the main application:
   matching Bypass policies defeat its Allow policy.
6. Leave `ENABLE_SIGNUP=false`. Once the Access allowlist protects the hostname,
   create the first local administrator; an empty database permits that one
   bootstrap account automatically. Enable registration only for a deliberate
   later registration window.
7. Configure Turnstile hostname restrictions and set
   `TURNSTILE_EXPECTED_HOSTNAME` to the exact public hostname.

Start and verify:

```bash
cd /opt/libre-webui
docker compose config --quiet
docker compose up -d
docker compose ps
```

To enable Work, include the socket-proxy override deliberately:

```bash
docker compose -f docker-compose.yml -f docker-compose.work-proxy.yml up -d
```

The raw-socket variant (`docker-compose.work.yml`) remains available for
deployments that need it, with the trust consequences described above.

Once Access is active, command-line smoke tests need a Cloudflare Access
service token unless the exact path has a narrow bypass. Store the credentials
outside shell history and send both headers:

```bash
curl --fail --silent --show-error \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://your-hostname.example/api/auth/system-info
```

An unauthenticated request to a protected application API must return `401`:

```bash
curl --output /dev/null --write-out '%{http_code}\n' \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://your-hostname.example/api/work/tasks
```

## Host hardening

The directory includes an sshd drop-in and fail2ban jail. Before applying the
sshd drop-in, verify a separate non-root sudo session in another terminal. Test
configuration with `sshd -t` before reloading SSH.

Use UFW (or an equivalent firewall) to default-deny inbound traffic and permit
only rate-limited SSH. Docker publishes no service ports in this template:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw limit OpenSSH
ufw enable
```

Keep unattended security upgrades enabled. Disable X11, agent, and TCP
forwarding unless the deployment has a documented need for them.

## Backups and recovery

Install the provided backup script and systemd units, then enable the timer:

```bash
install -m 0750 deploy/private/libre-webui-backup \
  /usr/local/sbin/libre-webui-backup
install -m 0644 deploy/private/libre-webui-backup.{service,timer} \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now libre-webui-backup.timer
```

The backup briefly stops the application to produce a consistent data-volume
archive. Copy archives off-host using encrypted storage and regularly test a
restore. Back up `.env` separately in a secrets manager; never place it inside
an unencrypted archive. Ollama models can be pulled again. Work task volumes
need a separate retention policy when their content matters.

## Updates

Update pinned images manually after reviewing and backing up the deployment. If
automatic updates are an accepted risk, add the socket-bearing Watchtower
override explicitly:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.watchtower.yml \
  up -d
```

Watchtower then checks labelled application and Ollama images every 30 minutes.
A client deployment follows `main`; an experimental instance may override
`LIBRE_WEBUI_IMAGE` with `:dev`. Keep health checks and an off-host backup so a
bad update can be rolled back to a previously recorded digest.
