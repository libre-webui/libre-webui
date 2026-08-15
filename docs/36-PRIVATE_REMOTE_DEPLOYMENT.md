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

This template is the single-replica `solo` topology: SQLite, local encrypted
blobs, embedded vectors, local coordination, and an embedded job worker share
the application data volume. Do not turn it into a team deployment by changing
backend selectors in `.env`. Team deployments must use the repository's
`docker-compose.team.yml` (and `docker-compose.team.work.yml` when Work is
enabled), which provisions PostgreSQL/PGVector, versioned S3 storage, Redis,
an external worker, and the gateway as one coordinated topology.

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
- The bundled SearXNG service powers optional [web search](./WEB_SEARCH). It
  is internal-only and inert until an administrator enables search in
  Settings > Search; set `SEARXNG_SECRET` in `.env` before starting the
  stack.
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
host. A read-only socket mount does not make Docker API access read-only. The
integrated backup helper refuses to inherit a raw Docker socket; migrate Work
to the filtered proxy before relying on scheduled integrated backups.

## Bootstrap

1. Create a non-root sudo operator and verify key-based SSH login before
   disabling root SSH.
2. Copy `deploy/private/.env.example` to `/opt/libre-webui/.env`, set mode
   `0600`, generate unique secrets, and size `BLOB_QUOTA_BYTES_PER_USER` for
   the host. `BLOB_QUOTA_RESERVATION_TTL_MS` expires abandoned upload
   reservations; its default is one hour.
3. If Work will be enabled, set `DOCKER_GID` to the numeric group that owns
   `/var/run/docker.sock`.
4. Store the Cloudflare tunnel token in
   `/opt/libre-webui/secrets/tunnel-token` with mode `0640` or stricter.
5. Create a Cloudflare Access self-hosted application for the complete
   hostname, use a 24-hour session, and allow only the intended identities.
   Enable **Protect with Access** on the tunnel route. If monitoring requires a
   public health check, create a separate path-scoped application or policy for
   `/health/live` only. Never add a blanket Bypass policy to the main application:
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

Before taking a backup, run the read-only recovery inventory inside the running
deployment container. This uses the exact deployed application version,
environment, and mounted data volume. A command from a host checkout can inspect
the wrong database or run source that differs from the deployed image.

```bash
docker exec libre-webui \
  libre-webui recovery-check --json --data-dir /app/backend/data
```

Exit status `0` means no recovery-readiness blockers were found, `1` means the
JSON report contains blockers, and `2` means the command could not run. The
report includes only an encryption-key fingerprint and secret-presence flags;
it never prints a key or other secret value. Keep the inventory with the
corresponding backup so operators can compare the application version, schema
fingerprint, expected Work resources, and exclusions before a restore.

Create dedicated backup encryption and signing keys with the exact deployed
image. Keep this directory off the application volume and copy the encryption
key and signing private key to a separate protected recovery location:

```bash
install -d -m 0700 /etc/libre-webui/backup-keys
image_ref=$(docker inspect libre-webui --format '{{.Image}}')
docker run --rm --user 0:0 --read-only --network none --cap-drop ALL \
  --security-opt no-new-privileges \
  --mount type=bind,src=/etc/libre-webui/backup-keys,dst=/backup-keys \
  --entrypoint /usr/local/bin/libre-webui "$image_ref" \
  backup keygen \
  --directory /backup-keys
```

Key generation refuses existing output files. Never generate new keys over an
existing backup set: losing either the archive encryption key or the signing
identity makes the corresponding recovery proof unusable.

Install the provided backup and restore scripts and systemd units, then enable
the timer:

```bash
install -d -m 0700 /var/backups/libre-webui
install -m 0750 deploy/private/libre-webui-backup \
  /usr/local/sbin/libre-webui-backup
install -m 0750 deploy/private/libre-webui-restore \
  /usr/local/sbin/libre-webui-restore
install -m 0644 deploy/private/libre-webui-backup.{service,timer} \
  /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now libre-webui-backup.timer
```

The unit optionally reads maintenance-only overrides from
`/etc/libre-webui/backup.env`; it does not load the application `.env`. Create
the file as root only when an override is needed:

```bash
install -d -m 0750 /etc/libre-webui
install -m 0600 /dev/null /etc/libre-webui/backup.env
```

`LIBRE_WEBUI_STACK_DIR`, `LIBRE_WEBUI_BACKUP_RETENTION_DAYS`,
`LIBRE_WEBUI_CONTAINER_NAME`, and `LIBRE_WEBUI_BACKUP_KEY_DIR` can be set there
directly. Keep the file owned by root and mode `0600`. A custom key directory
must remain readable by root inside the systemd sandbox.

Changing `LIBRE_WEBUI_BACKUP_DIR` also changes the systemd write boundary. The
directory must exist before the service starts, and the unit needs a matching
drop-in. For example, after setting
`LIBRE_WEBUI_BACKUP_DIR=/srv/backups/libre-webui` in `backup.env`:

```bash
install -d -m 0700 /srv/backups/libre-webui
systemctl edit libre-webui-backup.service
```

Add this exact path in the editor, then reload the unit:

```ini
[Service]
ReadWritePaths=/srv/backups/libre-webui
```

```bash
systemctl daemon-reload
systemctl start libre-webui-backup.service
```

Without the matching `ReadWritePaths=` entry, `ProtectSystem=strict` correctly
prevents the timer from writing to a custom location.

The backup service allows up to six hours for large archives. The helper
acquires a host lock, stops the application only when it was already running,
and creates the archive against the quiesced volume with the exact deployed
image. The archive has a signed manifest and an operator-encrypted payload; it
includes the data directory plus the runtime and secret configuration required
to open that state. The helper then independently verifies the complete
archive before atomically publishing its metadata report. Its read-only
maintenance containers receive a private writable `/tmp` tmpfs for SQLite
inspection and authenticated archive verification; no temporary plaintext is
persisted in the container layer. Copy both files and the separately protected
recovery keys off-host.

When Work uses `docker-compose.work-proxy.yml`, recovery must also prove that
every database-referenced Work volume still exists. The helper reads the
deployed application's `DOCKER_HOST`, locates the socket-proxy service in the
same live Compose project, and discovers their one shared internal network from
Docker's actual network attachments. Compose prefixes that network with the
project name, so do not configure or hardcode a guessed network name. Only the
archive-creation container joins that internal network and can reach the
filtered proxy; it receives no raw socket. Independent archive verification
continues with `--network none`. A missing proxy, an unexpected endpoint, an
external or ambiguous shared network, or a raw-socket mount fails before the
application is stopped and before an archive is published.

Test recovery into a new volume without replacing the live volume:

```bash
LIBRE_WEBUI_RESTORE_IMAGE="$image_ref" \
  libre-webui-restore \
  /var/backups/libre-webui/libre-webui-integrated-YYYYMMDDTHHMMSSZ.lwb \
  libre-webui-restore-drill
```

The restore helper refuses an existing volume or configuration target, verifies
the archive and its internal recovery inventory in disposable storage, then
copies data into the new volume and writes recovered `runtime.json` and
`secrets.json` with private permissions. It never rewires or starts the live
stack. Inspect the recovered configuration, update deployment-specific values
deliberately, and test the restored volume with an isolated stack.

Ollama models can be pulled again. Docker Work volumes, Kubernetes Work PVCs,
and host-bound Work folders are outside the application data directory and
require their own coordinated snapshots and retention policy.

## Updates

Libre WebUI is stateful even when its image tag is mutable. The base Compose
file permanently labels the application as excluded from Watchtower. Upgrade
it only as a coordinated operator action:

1. Record the running image ID and resolve the reviewed replacement to an
   immutable digest.
2. Run `libre-webui recovery-check`, start the backup service, and require a
   newly created archive and verification report before continuing.
3. Set `LIBRE_WEBUI_IMAGE` to the reviewed digest, pull it, and recreate only
   `libre-webui` with Docker Compose. Do not remove or recreate its data volume.
4. Require `/health/ready`, sign-in, session/history, document retrieval, and
   Work smoke tests to pass. Roll back to the recorded image digest if they do
   not; preserve both the failed state and the verified backup for diagnosis.

The host-side sequence is intentionally manual. Replace the digest only after
reviewing it, and inspect the newest `.lwb` and `.json` pair before the pull:

```bash
docker inspect libre-webui --format '{{.Config.Image}} {{.Image}}'
docker exec libre-webui \
  libre-webui recovery-check --json --data-dir /app/backend/data
systemctl start libre-webui-backup.service
systemctl --no-pager --full status libre-webui-backup.service
ls -lt /var/backups/libre-webui/libre-webui-integrated-* | head

# Set LIBRE_WEBUI_IMAGE=ghcr.io/libre-webui/libre-webui@sha256:REVIEWED_DIGEST
# in the root-owned .env, then recreate only the application.
docker compose pull libre-webui
docker compose up -d --no-deps libre-webui
docker inspect libre-webui --format '{{.State.Health.Status}} {{.Image}}'
```

The optional socket-bearing Watchtower override remains available only for the
sidecars explicitly labelled in the base file:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.watchtower.yml \
  up -d
```

Watchtower checks Ollama and SearXNG every 30 minutes. Ollama model data remains
in its named volume, and SearXNG configuration remains in its bind mount. It
does not update Libre WebUI, cloudflared, the Work socket proxy, or Work
sandboxes. A client deployment follows `main`; an experimental instance may
select `:dev`, but the application still requires the same backup-gated manual
upgrade. Never attach this private solo stack to team persistence services;
deploy the complete team topology instead.
