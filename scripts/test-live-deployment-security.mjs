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
  assert.doesNotMatch(source, /let userId = 'default'/);
  assert.match(source, /authorizeChatUpgrade/);
  assert.match(source, /isAllowedWebSocketOrigin/);
  assert.match(source, /CHAT_WS_MAX_PAYLOAD_BYTES/);
  assert.match(source, /CHAT_WS_MAX_MESSAGES_PER_MINUTE/);
  assert.match(source, /userModel\.getUserById/);
  assert.match(source, /rejectUpgrade\(socket, 401/);
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
    '/models/pull',
    '/pull/stream',
    '/models/copy',
    '/models/push',
    '/models/unload',
    '/models/unload-all',
  ]) {
    const start = source.indexOf(`'${route}'`);
    assert.notEqual(start, -1, route);
    assert.match(source.slice(start, start + 180), /requireAdmin/, route);
  }

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
  assert.doesNotMatch(compose, /docker\.sock/);
  assert.doesNotMatch(compose, /^\s+watchtower:/m);
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
});
