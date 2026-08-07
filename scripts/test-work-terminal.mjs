import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const terminalModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workTerminalService.js')
  ).href
);
const serverModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'workTerminalServer.js'))
    .href
);

const {
  WORK_TERMINAL_DEFAULTS,
  boundedDimension,
  buildExecCreatePayload,
  resolveDockerEndpoint,
} = terminalModule;
const { WORK_TERMINAL_WS_PATH, parseTerminalClientMessage } = serverModule;

test('the interactive shell inherits the sandbox container policy', () => {
  const payload = buildExecCreatePayload();

  // A human at the terminal gets exactly the privileges the model's tools get:
  // the same unprivileged uid, the same workspace, inside the same hardened
  // container. Nothing here can re-add capabilities the container dropped.
  assert.equal(payload.User, '1000:1000');
  assert.equal(payload.WorkingDir, '/workspace');
  assert.equal(payload.Tty, true);
  assert.equal(payload.AttachStdin, true);
  assert.deepEqual(payload.Cmd, [...WORK_TERMINAL_DEFAULTS.shell]);
  assert.deepEqual(payload.Env, ['TERM=xterm-256color']);
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, /Privileged|CapAdd|"root"|"0:0"/);
});

test('terminal transport follows the resolved Docker endpoint', () => {
  assert.deepEqual(resolveDockerEndpoint(undefined, undefined), {
    kind: 'unix',
    socketPath: '/var/run/docker.sock',
  });
  assert.deepEqual(resolveDockerEndpoint('/custom/docker.sock', undefined), {
    kind: 'unix',
    socketPath: '/custom/docker.sock',
  });
  assert.deepEqual(
    resolveDockerEndpoint(undefined, 'unix:///run/user/1000/docker.sock'),
    { kind: 'unix', socketPath: '/run/user/1000/docker.sock' }
  );
  // A plain-HTTP tcp endpoint (a socket proxy holding the real socket)
  // carries the same hijacked exec stream over a Connection: Upgrade tunnel.
  assert.deepEqual(
    resolveDockerEndpoint(undefined, 'tcp://docker-socket-proxy:2375'),
    { kind: 'tcp', host: 'docker-socket-proxy', port: 2375 }
  );
  // WORK_DOCKER_SOCKET pins the Unix socket over any DOCKER_HOST.
  assert.deepEqual(
    resolveDockerEndpoint('/explicit.sock', 'tcp://10.0.0.5:2375'),
    { kind: 'unix', socketPath: '/explicit.sock' }
  );
  // Endpoints this client cannot speak to report unavailable rather than
  // silently attaching to the wrong transport: TLS-verified tcp, ssh.
  assert.equal(
    resolveDockerEndpoint(undefined, 'tcp://10.0.0.5:2376', '1'),
    null
  );
  assert.equal(
    resolveDockerEndpoint(undefined, 'ssh://user@daemon.host'),
    null
  );
});

test('only well-formed control frames reach the shell', () => {
  assert.deepEqual(
    parseTerminalClientMessage('{"type":"input","data":"ls\\n"}'),
    {
      type: 'input',
      data: 'ls\n',
    }
  );
  assert.deepEqual(
    parseTerminalClientMessage('{"type":"resize","cols":120,"rows":30}'),
    { type: 'resize', cols: 120, rows: 30 }
  );

  // Anything malformed is dropped instead of being written to the pty.
  assert.equal(parseTerminalClientMessage('not json'), null);
  assert.equal(parseTerminalClientMessage('"just-a-string"'), null);
  assert.equal(parseTerminalClientMessage('null'), null);
  assert.equal(parseTerminalClientMessage('{"type":"input"}'), null);
  assert.equal(parseTerminalClientMessage('{"type":"input","data":5}'), null);
  assert.equal(parseTerminalClientMessage('{"type":"exec","data":"ls"}'), null);
  assert.equal(
    parseTerminalClientMessage('{"type":"resize","cols":"80","rows":24}'),
    null
  );
  assert.equal(
    parseTerminalClientMessage(
      `{"type":"input","data":"${'a'.repeat(1_048_600)}"}`
    ),
    null
  );
});

test('resize dimensions are bounded before reaching the Docker API', () => {
  assert.equal(boundedDimension(80), 80);
  assert.equal(boundedDimension(1_000), 1_000);
  assert.equal(boundedDimension(0), null);
  assert.equal(boundedDimension(-5), null);
  assert.equal(boundedDimension(1_001), null);
  assert.equal(boundedDimension(24.5), null);
  assert.equal(boundedDimension(Number.NaN), null);
});

test('terminal sessions are bounded per task and time out when idle', () => {
  assert.ok(WORK_TERMINAL_DEFAULTS.maxSessionsPerTask >= 1);
  assert.ok(WORK_TERMINAL_DEFAULTS.maxSessionsPerTask <= 4);
  assert.ok(WORK_TERMINAL_DEFAULTS.idleTimeoutMs >= 60_000);
  assert.equal(WORK_TERMINAL_WS_PATH, '/ws/work-terminal');
});
