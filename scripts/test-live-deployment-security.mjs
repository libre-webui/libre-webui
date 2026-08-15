import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
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
    /isModelDownloadMode\(value\) \? value : 'admins'/
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
  assert.match(
    service,
    /async getDocument\(\s*documentId: string,\s*userId: string\s*\)/
  );
  assert.match(service, /storageService\.getDocument\(documentId, userId\)/);
  assert.match(service, /storageService\.getAllDocuments\(userId\)/);
  assert.match(
    service,
    /domains\.documents\.deleteAndEnqueue\(\s*documentId,\s*userId,/
  );
});

test('private deployment template defaults to main and publishes no ports', () => {
  const compose = read('deploy/private/docker-compose.yml');
  assert.match(compose, /libre-webui\/libre-webui:main/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /ENABLE_SIGNUP: \$\{ENABLE_SIGNUP:-false\}/);
  assert.match(
    compose,
    /BLOB_QUOTA_BYTES_PER_USER: \$\{BLOB_QUOTA_BYTES_PER_USER:-10737418240\}/
  );
  assert.match(
    compose,
    /BLOB_QUOTA_RESERVATION_TTL_MS: \$\{BLOB_QUOTA_RESERVATION_TTL_MS:-3600000\}/
  );
  assert.match(compose, /stop_grace_period: 20s/);
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /^\s+watchtower:/m);
  const application = compose.slice(
    compose.indexOf('  libre-webui:'),
    compose.indexOf('\n  ollama:')
  );
  assert.match(
    application,
    /com\.centurylinklabs\.watchtower\.enable: 'false'/
  );
  const envExample = read('deploy/private/.env.example');
  assert.match(envExample, /^BLOB_QUOTA_BYTES_PER_USER=10737418240$/m);
  assert.match(envExample, /^BLOB_QUOTA_RESERVATION_TTL_MS=3600000$/m);
});

test('deployment health and backups fail closed on incomplete state', () => {
  const dockerfile = read('Dockerfile');
  const backup = read('deploy/private/libre-webui-backup');
  const restore = read('deploy/private/libre-webui-restore');
  const server = read('backend/src/index.ts');
  const recoveryInventory = read(
    'backend/src/services/recoveryInventoryService.ts'
  );
  assert.match(dockerfile, /HEALTHCHECK[^\n]*--timeout=5s/);
  assert.match(dockerfile, /localhost:3001\/health\/ready/);
  assert.ok(
    server.indexOf('registeredWebSockets.close()') <
      server.indexOf('closePersistence()'),
    'selected persistence must close only after active HTTP and WebSocket work drains'
  );
  assert.match(backup, /flock -n/);
  assert.match(backup, /recoveryBackup\.js create/);
  assert.match(backup, /recoveryBackup\.js verify/);
  assert.match(backup, /--offline/);
  assert.match(backup, /backup-encryption\.key/);
  assert.match(backup, /backup-signing-private\.pem/);
  assert.match(backup, /backup-signing-public\.pem/);
  assert.match(backup, /--volumes-from "\$\{container_name\}:ro"/);
  assert.doesNotMatch(
    recoveryInventory,
    /blockers\.push\('The configured data directory is not writable\.'/,
    'a quiesced read-only recovery source must not fail backup preflight'
  );
  assert.match(backup, /\.partial/);
  assert.match(backup, /--format '\{\{\.Image\}\}'/);
  assert.match(backup, /stop --timeout 20 libre-webui/);
  assert.match(backup, /container_was_running=/);
  assert.match(backup, /if \[\[ "\$\{container_was_running\}" == true \]\]/);
  assert.match(backup, /sync -f "\$\{archive\}"/);
  assert.match(backup, /sync -f "\$\{backup_dir\}"/);
  assert.match(backup, /com\.docker\.compose\.project/);
  assert.match(backup, /com\.docker\.compose\.service=docker-socket-proxy/);
  assert.match(backup, /create_network_args=\(--network none\)/);
  assert.match(
    backup,
    /create_network_args=\(--network "\$\{proxy_network\}"\)/
  );
  assert.match(backup, /proxy_network_internal/);
  assert.match(backup, /refuses to inherit the raw Docker socket/i);
  assert.doesNotMatch(
    backup,
    /--mount[^\n]*\/var\/run\/docker\.sock/,
    'backup maintenance containers must never receive the raw Docker socket'
  );
  const createContainer = backup.slice(
    backup.indexOf('docker run --rm'),
    backup.indexOf('docker run --rm', backup.indexOf('docker run --rm') + 1)
  );
  const verifyContainer = backup.slice(
    backup.indexOf('docker run --rm', backup.indexOf('docker run --rm') + 1)
  );
  assert.match(createContainer, /"\$\{create_network_args\[@\]\}"/);
  assert.doesNotMatch(createContainer, /--network none/);
  assert.match(verifyContainer, /--network none/);
  assert.equal(
    backup.match(/--tmpfs \/tmp:rw,nosuid,nodev,noexec/g)?.length,
    2,
    'backup creation and independent verification both need writable private temporary storage'
  );
  assert.match(restore, /Restore refuses an existing Docker volume/);
  assert.match(restore, /recoveryBackup\.js restore-apply/);
  assert.match(restore, /signing-public-key/);
  assert.match(restore, /backup-encryption\.key/);
  assert.match(restore, /created_volume=false/);
  assert.match(restore, /install -m 0600/);
  assert.match(restore, /LIBRE_WEBUI_RESTORE_IMAGE/);
  assert.match(restore, /--entrypoint sh[\s\\]+"\$\{image_ref\}"/);
  assert.match(restore, /--tmpfs \/tmp:rw,nosuid,nodev,noexec/);
  assert.doesNotMatch(
    restore,
    /\balpine:/,
    'restore must not introduce a second mutable image into the trusted path'
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
  assert.match(privateDeploymentDocs, /Ed25519|signed manifest/);
  assert.match(privateDeploymentDocs, /AES-256-GCM|operator-encrypted/);
  assert.match(privateDeploymentDocs, /libre-webui-restore/);
  assert.match(privateDeploymentDocs, /docker-compose\.team\.yml/);
  assert.match(privateDeploymentDocs, /excluded from Watchtower/);
});

test('private backup discovers the rendered Work proxy network and keeps verification offline', t => {
  const project = 'libre-private-backup-render-test';
  const composeEnvironment = {
    ...process.env,
    PUBLIC_HOSTNAME: 'chat.example.com',
    JWT_SECRET: 'test-jwt-secret',
    ENCRYPTION_KEY: '31'.repeat(32),
    SEARXNG_SECRET: 'test-searx-secret',
    TURNSTILE_SITE_KEY: 'test-site-key',
    TURNSTILE_SECRET_KEY: 'test-secret-key',
    TURNSTILE_EXPECTED_HOSTNAME: 'chat.example.com',
  };
  const rendered = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '-f',
        'deploy/private/docker-compose.yml',
        '-f',
        'deploy/private/docker-compose.work-proxy.yml',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env: composeEnvironment }
    )
  );
  const proxyNetwork = rendered.networks['docker-proxy'].name;
  assert.equal(proxyNetwork, `${project}_docker-proxy`);
  assert.equal(rendered.networks['docker-proxy'].internal, true);
  assert.deepEqual(
    Object.keys(rendered.services['docker-socket-proxy'].networks),
    ['docker-proxy']
  );
  assert.equal(
    rendered.services['libre-webui'].environment.DOCKER_HOST,
    'tcp://docker-socket-proxy:2375'
  );

  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-private-backup-helper-')
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stack = path.join(root, 'stack');
  const backup = path.join(root, 'backup');
  const rawBackup = path.join(root, 'raw-backup');
  const keys = path.join(root, 'keys');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'docker.log');
  for (const directory of [stack, backup, rawBackup, keys, bin]) {
    fs.mkdirSync(directory, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(stack, 'docker-compose.yml'), 'services: {}\n');
  for (const key of [
    'backup-encryption.key',
    'backup-signing-private.pem',
    'backup-signing-public.pem',
  ]) {
    fs.writeFileSync(path.join(keys, key), 'test-key', { mode: 0o600 });
  }
  fs.writeFileSync(log, '');

  const fakeDocker = String.raw`#!/usr/bin/env node
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(args) + '\n');
const output = value => process.stdout.write(String(value) + '\n');
const fail = message => {
  process.stderr.write(message + '\n');
  process.exit(64);
};
const valueAfter = name => {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) fail('missing option ' + name);
  return args[index + 1];
};

if (args[0] === 'volume') {
  if (
    process.env.DOCKER_HOST !== 'tcp://docker-socket-proxy:2375' ||
    process.env.FAKE_ATTACHED_NETWORK !== process.env.FAKE_NETWORK
  ) {
    fail('filtered Docker proxy is unreachable from this container network');
  }
  if (args[1] === 'ls') output('libre-work-task-1');
  else if (args[1] === 'inspect')
    output('libre-work-task-1\ttrue\twork-task-1');
  else fail('unexpected volume command');
  process.exit(0);
}

if (args[0] === 'inspect') {
  const target = args[1];
  const format = valueAfter('--format');
  if (target === 'libre-webui') {
    if (format === '{{.Image}}') output('sha256:reviewed-image');
    else if (format === '{{.State.Running}}') output('false');
    else if (format.includes('.Config.Env')) {
      output('DOCKER_HOST=tcp://docker-socket-proxy:2375');
      output('WORK_RUNTIME_BACKEND=docker');
    } else if (format.includes('.Mounts')) {
      if (process.env.FAKE_RAW_SOCKET === '1') output('present');
    } else if (format.includes('com.docker.compose.project')) {
      output(process.env.FAKE_PROJECT);
    } else if (format.includes('.NetworkSettings.Networks')) {
      output(process.env.FAKE_NETWORK);
      output(process.env.FAKE_PROJECT + '_private');
    } else fail('unexpected application inspect format');
  } else if (target === 'fake-proxy-id') {
    if (format === '{{.State.Running}}') output('true');
    else if (format.includes('.NetworkSettings.Networks'))
      output(process.env.FAKE_NETWORK);
    else fail('unexpected proxy inspect format');
  } else fail('unexpected inspect target');
  process.exit(0);
}

if (args[0] === 'ps') {
  if (!args.includes('label=com.docker.compose.service=docker-socket-proxy'))
    fail('proxy service label filter is missing');
  if (!args.includes('label=com.docker.compose.project=' + process.env.FAKE_PROJECT))
    fail('proxy project label filter is missing');
  output('fake-proxy-id');
  process.exit(0);
}

if (args[0] === 'network' && args[1] === 'inspect') {
  if (args[2] !== process.env.FAKE_NETWORK) fail('wrong proxy network');
  output('true');
  process.exit(0);
}

if (args[0] === 'run') {
  const network = valueAfter('--network');
  const cli = args.indexOf('/app/backend/dist/cli/recoveryBackup.js');
  if (cli === -1) fail('recovery CLI is missing');
  const operation = args[cli + 1];
  if (operation === 'create') {
    if (network !== process.env.FAKE_NETWORK) fail('create joined the wrong network');
    const environment = fs.readFileSync(valueAfter('--env-file'), 'utf8');
    const dockerHost = environment
      .split(/\r?\n/)
      .find(line => line.startsWith('DOCKER_HOST='))
      .slice('DOCKER_HOST='.length);
    const nestedEnvironment = {
      ...process.env,
      DOCKER_HOST: dockerHost,
      FAKE_ATTACHED_NETWORK: network,
    };
    const listed = childProcess.execFileSync(
      process.execPath,
      [__filename, 'volume', 'ls', '--format', '{{.Name}}'],
      { encoding: 'utf8', env: nestedEnvironment }
    ).trim();
    if (listed !== 'libre-work-task-1') fail('Work volume was not listed');
    const inspected = childProcess.execFileSync(
      process.execPath,
      [__filename, 'volume', 'inspect', listed],
      { encoding: 'utf8', env: nestedEnvironment }
    ).trim();
    if (inspected !== 'libre-work-task-1\ttrue\twork-task-1')
      fail('Work volume labels were not inspected');
    const archive = path.join(
      process.env.FAKE_BACKUP_DIR,
      path.basename(valueAfter('--output'))
    );
    fs.writeFileSync(archive, 'verified archive', { mode: 0o600 });
    output(JSON.stringify({
      created: true,
      workVolumeInventory: {
        taskId: 'work-task-1',
        volume: listed,
        present: true,
      },
    }));
  } else if (operation === 'verify') {
    if (network !== 'none') fail('archive verification must stay offline');
    const archive = path.join(
      process.env.FAKE_BACKUP_DIR,
      path.basename(valueAfter('--archive'))
    );
    if (!fs.existsSync(archive)) fail('archive is missing');
    output(JSON.stringify({ payloadVerified: true }));
  } else fail('unexpected recovery operation');
  process.exit(0);
}

fail('unexpected docker command: ' + args.join(' '));
`;
  fs.writeFileSync(path.join(bin, 'docker'), fakeDocker, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'flock'), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });

  const helperEnvironment = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    LIBRE_WEBUI_STACK_DIR: stack,
    LIBRE_WEBUI_BACKUP_DIR: backup,
    LIBRE_WEBUI_BACKUP_KEY_DIR: keys,
    FAKE_DOCKER_LOG: log,
    FAKE_NETWORK: proxyNetwork,
    FAKE_PROJECT: project,
    FAKE_BACKUP_DIR: backup,
  };
  const helper = path.resolve('deploy/private/libre-webui-backup');
  const result = spawnSync('bash', [helper], {
    encoding: 'utf8',
    env: helperEnvironment,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const reportName = fs
    .readdirSync(backup)
    .find(name => /^libre-webui-integrated-.*\.json$/.test(name));
  assert.ok(reportName, 'backup report must be published');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(backup, reportName), 'utf8'))
      .workVolumeInventory,
    {
      taskId: 'work-task-1',
      volume: 'libre-work-task-1',
      present: true,
    }
  );
  const calls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  const create = calls.find(
    call => call[0] === 'run' && call.includes('create')
  );
  const verify = calls.find(
    call => call[0] === 'run' && call.includes('verify')
  );
  assert.equal(create[create.indexOf('--network') + 1], proxyNetwork);
  assert.equal(verify[verify.indexOf('--network') + 1], 'none');
  assert.ok(calls.some(call => call[0] === 'volume' && call[1] === 'ls'));
  assert.ok(calls.some(call => call[0] === 'volume' && call[1] === 'inspect'));
  assert.doesNotMatch(JSON.stringify(create), /\/var\/run\/docker\.sock/);

  fs.writeFileSync(log, '');
  const rawResult = spawnSync('bash', [helper], {
    encoding: 'utf8',
    env: {
      ...helperEnvironment,
      LIBRE_WEBUI_BACKUP_DIR: rawBackup,
      FAKE_BACKUP_DIR: rawBackup,
      FAKE_RAW_SOCKET: '1',
    },
  });
  assert.equal(rawResult.status, 1);
  assert.match(rawResult.stderr, /refuses to inherit the raw Docker socket/i);
  const rawCalls = fs
    .readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  assert.equal(
    rawCalls.some(call => call[0] === 'run'),
    false
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

test('private Watchtower opt-in excludes stateful application updates', () => {
  const compose = read('deploy/private/docker-compose.yml');
  const service = (name, next) => {
    const start = compose.indexOf(`  ${name}:`);
    const end = next ? compose.indexOf(`\n  ${next}:`, start) : compose.length;
    assert.notEqual(start, -1, `${name} service must exist`);
    assert.notEqual(end, -1, `${next} service must follow ${name}`);
    return compose.slice(start, end);
  };
  const watchtower = read('deploy/private/docker-compose.watchtower.yml');

  assert.match(
    service('libre-webui', 'ollama'),
    /com\.centurylinklabs\.watchtower\.enable: 'false'/
  );
  assert.match(
    service('ollama', 'searxng'),
    /com\.centurylinklabs\.watchtower\.enable: 'true'/
  );
  assert.match(
    service('searxng', 'cloudflared'),
    /com\.centurylinklabs\.watchtower\.enable: 'true'/
  );
  assert.match(
    service('cloudflared'),
    /com\.centurylinklabs\.watchtower\.enable: 'false'/
  );
  assert.match(watchtower, /WATCHTOWER_LABEL_ENABLE: 'true'/);
  assert.match(watchtower, /com\.centurylinklabs\.watchtower\.enable: 'false'/);
});
