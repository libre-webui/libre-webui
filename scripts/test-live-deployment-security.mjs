import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const read = file => fs.readFileSync(path.resolve(file), 'utf8');

test('sensitive first-time setup data requires the current administrator', () => {
  const source = read('backend/src/routes/auth.ts');
  const route = source.slice(
    source.indexOf("'/encryption-key'"),
    source.indexOf('/**\n * Signup endpoint')
  );
  assert.match(route, /authenticate/);
  assert.match(route, /requireAdmin/);
});

test('generated encryption keys are stored privately and never logged', () => {
  const source = read('backend/src/services/encryptionService.ts');
  assert.doesNotMatch(source, /Generated key: \$\{newKeyString\}/);
  assert.doesNotMatch(
    source,
    /logger\.warn\(`\s*ENCRYPTION_KEY=\$\{encryptionKey\}`\)/
  );
  assert.match(source, /fs\.chmodSync\(keyPath, 0o600\)/);
  assert.match(source, /fs\.chmodSync\(envPath, 0o600\)/);
});

test('chat WebSockets fail closed without a current account', () => {
  const source = read('backend/src/websocketServer.ts');
  const server = read('backend/src/index.ts');
  assert.doesNotMatch(source, /let userId = 'default'/);
  assert.match(source, /authorizeChatUpgrade/);
  assert.match(source, /isAllowedWebSocketOrigin/);
  assert.match(source, /CHAT_WS_MAX_PAYLOAD_BYTES/);
  assert.match(source, /CHAT_WS_MAX_MESSAGES_PER_MINUTE/);
  assert.match(source, /userModel\.getUserById/);
  assert.match(source, /rejectUpgrade\(socket, 401/);
  assert.match(source, /RegisteredWebSocketServers/);
  assert.match(source, /closeWebSocketServer\(wss\)/);
  assert.match(source, /closeWebSocketServer\(terminalServer\)/);
  assert.match(server, /registeredWebSockets\.close\(\)/);
  assert.match(server, /closeCoordinator\(\)/);
  assert.match(server, /Promise\.allSettled/);
});

test('private application APIs require authentication', () => {
  for (const file of [
    'backend/src/routes/agentCli.ts',
    'backend/src/routes/documents.ts',
    'backend/src/routes/embeddings.ts',
    'backend/src/routes/huggingfaceHub.ts',
    'backend/src/routes/ollama.ts',
    'backend/src/routes/personas.ts',
    'backend/src/routes/tts.ts',
  ]) {
    assert.match(read(file), /router\.use\(authenticate\)/, file);
  }
});

test('Ollama lifecycle operations require the current administrator', () => {
  const source = read('backend/src/routes/ollama.ts');
  for (const route of [
    '/models/pull-all',
    '/models/pull-all/stream',
    '/models/copy',
    '/models/push',
    '/models/unload',
    '/models/unload-all',
  ]) {
    const start = source.indexOf(`'${route}'`);
    assert.notEqual(start, -1, route);
    assert.match(source.slice(start, start + 180), /requireAdmin/, route);
  }

  // Individual pulls follow the persisted download mode, which fails closed
  // to admins-only; the mode itself is changed through an admin-only route.
  for (const route of ['/models/pull', '/pull/stream']) {
    const start = source.indexOf(`'${route}'`);
    assert.notEqual(start, -1, route);
    assert.match(
      source.slice(start, start + 180),
      /requireModelDownloadAccess/,
      route
    );
  }
  const putAccess = source.indexOf("router.put(\n  '/models/access'");
  assert.notEqual(putAccess, -1);
  assert.match(source.slice(putAccess, putAccess + 120), /requireAdmin/);
  const accessService = read('backend/src/services/modelAccessService.ts');
  assert.match(
    accessService,
    /isModelDownloadMode\(row\?\.value\) \? row\.value : 'admins'/
  );
  assert.match(accessService, /if \(user\.role === 'admin'\) return true;/);

  const deleteRoute = source.slice(
    source.indexOf("router.delete(\n  '/models'")
  );
  assert.match(deleteRoute.slice(0, 180), /requireAdmin/);

  const createRoute = source.slice(source.indexOf('// Create a model'));
  assert.match(createRoute.slice(0, 220), /requireAdmin/);

  const blobRoute = source.slice(source.indexOf('// Push a blob'));
  assert.match(blobRoute.slice(0, 220), /requireAdmin/);
});

test('document data is scoped to the authenticated user', () => {
  const routes = read('backend/src/routes/documents.ts');
  const service = read('backend/src/services/documentService.ts');
  assert.match(routes, /requireUserId\(req\)/);
  assert.ok(
    routes.indexOf("router.get('/embeddings/status'") <
      routes.indexOf("router.get('/:documentId'")
  );
  assert.match(service, /getDocument\(documentId: string, userId: string\)/);
  assert.match(service, /storageService\.getDocument\(documentId, userId\)/);
  assert.match(service, /storageService\.getAllDocuments\(userId\)/);
  assert.match(service, /storageService\.deleteDocument\(documentId, userId\)/);
});

test('private deployment template defaults to main and publishes no ports', () => {
  const compose = read('deploy/private/docker-compose.yml');
  assert.match(compose, /libre-webui\/libre-webui:main/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /ENABLE_SIGNUP: \$\{ENABLE_SIGNUP:-false\}/);
  assert.match(compose, /stop_grace_period: 20s/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /^\s+watchtower:/m);
});

test('deployment health and backups fail closed on incomplete state', () => {
  const dockerfile = read('Dockerfile');
  const backup = read('deploy/private/libre-webui-backup');
  const server = read('backend/src/index.ts');
  const recoveryInventory = read(
    'backend/src/services/recoveryInventoryService.ts'
  );
  assert.match(dockerfile, /HEALTHCHECK[^\n]*--timeout=5s/);
  assert.match(dockerfile, /localhost:3001\/health\/ready/);
  assert.match(
    server,
    /Promise\.resolve\(\)\.then\(\(\) => closeDatabase\(\)\)/
  );
  assert.ok(
    server.indexOf('registeredWebSockets.close()') <
      server.indexOf('closeDatabase()'),
    'SQLite must close only after active HTTP and WebSocket work drains'
  );
  assert.match(backup, /flock -n/);
  assert.match(backup, /recoveryInventory\.js/);
  assert.match(backup, /--volumes-from "\$\{container_name\}:ro"/);
  assert.doesNotMatch(
    recoveryInventory,
    /blockers\.push\('The configured data directory is not writable\.'/,
    'a quiesced read-only recovery source must not fail backup preflight'
  );
  assert.match(backup, /\.partial/);
  assert.match(backup, /tar -tzf/);
  assert.match(backup, /sha256sum/);
  assert.match(backup, /--format '\{\{\.Image\}\}'/);
  assert.match(backup, /stop --timeout 20 libre-webui/);
  assert.match(backup, /chmod 0733 "\$\{recovery_scratch\}"/);
  assert.match(backup, /--env TMPDIR=\/recovery-tmp/);
  assert.match(backup, /container_was_running=/);
  assert.match(backup, /if \[\[ "\$\{container_was_running\}" == true \]\]/);
  assert.ok(
    (backup.match(/sync -f "\$\{backup_dir\}"/g) || []).length >= 2,
    'backup final-name and manifest directory entries must be durable'
  );
  const backupService = read('deploy/private/libre-webui-backup.service');
  assert.match(backupService, /TimeoutStartSec=6h/);
  assert.match(
    backupService,
    /EnvironmentFile=-\/etc\/libre-webui\/backup\.env/
  );
  assert.match(backupService, /ReadWritePaths=-\/var\/backups\/libre-webui/);
  const privateDeploymentDocs = read('docs/36-PRIVATE_REMOTE_DEPLOYMENT.md');
  assert.match(privateDeploymentDocs, /backup\.env/);
  assert.match(
    privateDeploymentDocs,
    /LIBRE_WEBUI_BACKUP_DIR[\s\S]*ReadWritePaths=\/srv\/backups\/libre-webui/
  );
  assert.ok(
    backup.indexOf('trap cleanup EXIT') <
      backup.indexOf('docker compose -f "${compose_file}" stop'),
    'restart cleanup must be armed before the application is stopped'
  );
  assert.ok(
    backup.indexOf('mv "${manifest_partial}" "${manifest}"') >
      backup.indexOf('mv "${inventory_partial}" "${inventory}"'),
    'the manifest must be published last as the completed-set marker'
  );
});

test('local Compose defaults enable Work without publishing Ollama', () => {
  for (const file of [
    'docker-compose.yml',
    'docker-compose.gpu.yml',
    'docker-compose.external-ollama.yml',
    'docker-compose.dev.yml',
    'docker-compose.dev.gpu.yml',
    'docker-compose.dev.external-ollama.yml',
  ]) {
    const compose = read(file);
    assert.match(compose, /docker\.sock/, file);
    assert.match(compose, /group_add:/, file);
    assert.doesNotMatch(compose, /11434:11434/, file);
    assert.match(compose, /ENABLE_SIGNUP=\$\{ENABLE_SIGNUP:-false\}/, file);
    assert.match(compose, /WEBUI_BIND_ADDRESS:-127\.0\.0\.1/, file);
  }

  assert.match(
    read('docker-compose.ollama-host.yml'),
    /OLLAMA_BIND_ADDRESS:-127\.0\.0\.1/
  );
  assert.match(read('deploy/private/docker-compose.work.yml'), /docker\.sock/);
  assert.match(
    read('deploy/private/docker-compose.watchtower.yml'),
    /docker\.sock/
  );

  // The socket-proxy Work override keeps the socket out of the application:
  // only the proxy service mounts it (read-only), the app gets a filtered
  // tcp endpoint, the proxy network stays internal, and no dangerous API
  // section is enabled.
  const workProxy = read('deploy/private/docker-compose.work-proxy.yml');
  assert.match(workProxy, /DOCKER_HOST: tcp:\/\/docker-socket-proxy:2375/);
  assert.match(
    workProxy,
    /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/
  );
  assert.equal(workProxy.match(/docker\.sock/g).length, 2);
  assert.doesNotMatch(workProxy, /group_add/);
  assert.match(workProxy, /internal: true/);
  for (const denied of ['SWARM', 'SECRETS', 'CONFIGS', 'BUILD', 'COMMIT']) {
    assert.ok(
      !new RegExp(`${denied}: 1`).test(workProxy),
      `proxy must not enable ${denied}`
    );
  }
});
