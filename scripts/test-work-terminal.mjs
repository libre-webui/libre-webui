import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-terminal-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const terminalModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workTerminalService.js')
  ).href
);
const serverModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'workTerminalServer.js'))
    .href
);
const userModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'models', 'userModel.js')
  ).href
);
const ticketModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'websocketTicketService.js'
    )
  ).href
);
const taskModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workTaskService.js')
  ).href
);

const {
  WORK_TERMINAL_DEFAULTS,
  boundedDimension,
  buildExecCreatePayload,
  resolveDockerEndpoint,
} = terminalModule;
const {
  WORK_TERMINAL_MAX_INPUT_BYTES,
  WORK_TERMINAL_WS_PATH,
  createWorkTerminalServer,
  parseTerminalClientMessage,
} = serverModule;
const { userModel } = userModule;
const { websocketTicketService } = ticketModule;
const { workTaskService } = taskModule;
const { workTerminalService } = terminalModule;

const persistenceModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'persistence', 'index.js')
  ).href
);

test.after(async () => {
  await persistenceModule.closePersistence();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const activeUser = {
  id: 'user-1',
  username: 'operator',
  email: null,
  role: 'admin',
  status: 'active',
  approvedAt: null,
  approvedBy: null,
  avatar: null,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const terminalTask = {
  id: 'task-1',
  userId: activeUser.id,
  title: 'Terminal test',
  model: 'test-model',
  providerType: 'ollama',
  status: 'idle',
  networkEnabled: false,
  volumeName: 'work-test-volume',
  containerName: 'work-test-container',
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

class FakeWebSocket extends EventEmitter {
  OPEN = 1;
  CONNECTING = 0;
  CLOSED = 3;
  readyState = this.OPEN;
  bufferedAmount = 0;
  sent = [];
  terminated = false;

  send(data) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    queueMicrotask(() => this.emit('close'));
  }

  terminate() {
    this.terminated = true;
    this.close();
  }
}

const terminalRequest = {
  url: '/ws/work-terminal?ticket=ticket-1&taskId=task-1',
  headers: {},
};

const closeTerminalServer = server =>
  new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

function installTerminalMocks(t, overrides = {}) {
  const originalConsume = websocketTicketService.consume;
  const originalGetUserById = userModel.getUserById;
  const originalGetTaskRecord = workTaskService.getTaskRecord;
  const originalOpen = workTerminalService.open;
  websocketTicketService.consume =
    overrides.consume ||
    (async () => ({
      userId: activeUser.id,
      sessionExpiresAt: Date.now() + 60_000,
    }));
  userModel.getUserById = overrides.getUserById || (async () => activeUser);
  workTaskService.getTaskRecord =
    overrides.getTaskRecord || (() => terminalTask);
  workTerminalService.open = overrides.open || originalOpen;
  t.after(() => {
    websocketTicketService.consume = originalConsume;
    userModel.getUserById = originalGetUserById;
    workTaskService.getTaskRecord = originalGetTaskRecord;
    workTerminalService.open = originalOpen;
  });
}

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

test('the WebSocket rejects oversized frames before buffering the terminal protocol', async () => {
  const server = createWorkTerminalServer();
  assert.equal(
    server.options.maxPayload,
    WORK_TERMINAL_MAX_INPUT_BYTES,
    'the ws-layer cap must match the parser cap'
  );
  await closeTerminalServer(server);
});

test('terminal shutdown drains in-flight ticket authorization and rejects new work', async t => {
  let releaseAuthorization;
  const authorizationGate = new Promise(resolve => {
    releaseAuthorization = resolve;
  });
  let authorizationStarted;
  const didStartAuthorization = new Promise(resolve => {
    authorizationStarted = resolve;
  });
  let userLookups = 0;
  let openCalls = 0;
  installTerminalMocks(t, {
    consume: async () => {
      authorizationStarted();
      await authorizationGate;
      return {
        userId: activeUser.id,
        sessionExpiresAt: Date.now() + 60_000,
      };
    },
    getUserById: async () => {
      userLookups += 1;
      return activeUser;
    },
    open: async () => {
      openCalls += 1;
      throw new Error('terminal open must not run during shutdown');
    },
  });

  const server = createWorkTerminalServer();
  const socket = new FakeWebSocket();
  server.emit('connection', socket, terminalRequest);
  await didStartAuthorization;

  let shutdownSettled = false;
  const shutdown = closeTerminalServer(server).then(() => {
    shutdownSettled = true;
  });
  await nextTurn();
  assert.equal(shutdownSettled, false);
  assert.equal(userLookups, 0);

  releaseAuthorization();
  await shutdown;
  assert.equal(userLookups, 0, 'shutdown must stop the next database lookup');
  assert.equal(openCalls, 0, 'shutdown must not open a new terminal');

  const lateSocket = new FakeWebSocket();
  server.emit('connection', lateSocket, terminalRequest);
  assert.equal(lateSocket.terminated, true);
});

test('terminal shutdown drains an in-flight open and its late cleanup failure', async t => {
  let releaseOpen;
  const openGate = new Promise(resolve => {
    releaseOpen = resolve;
  });
  let openStarted;
  const didStartOpen = new Promise(resolve => {
    openStarted = resolve;
  });
  let cleanupCalls = 0;
  installTerminalMocks(t, {
    open: async () => {
      openStarted();
      await openGate;
      return {
        stream: new PassThrough(),
        resize: async () => {},
        close: async () => {
          cleanupCalls += 1;
          throw new Error('late terminal cleanup failure');
        },
      };
    },
  });

  const unhandledRejections = [];
  const captureUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', captureUnhandledRejection);
  const server = createWorkTerminalServer();
  try {
    server.emit('connection', new FakeWebSocket(), terminalRequest);
    await didStartOpen;
    let shutdownSettled = false;
    const shutdown = closeTerminalServer(server).then(() => {
      shutdownSettled = true;
    });
    await nextTurn();
    assert.equal(shutdownSettled, false);

    releaseOpen();
    await shutdown;
    await nextTurn();
    assert.equal(cleanupCalls, 1);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', captureUnhandledRejection);
    releaseOpen?.();
  }
});

test('terminal shutdown drains input authorization and prevents a late shell write', async t => {
  let userLookupCount = 0;
  let releaseInputLookup;
  const inputLookupGate = new Promise((_, reject) => {
    releaseInputLookup = () => reject(new Error('late input lookup failure'));
  });
  let inputLookupStarted;
  const didStartInputLookup = new Promise(resolve => {
    inputLookupStarted = resolve;
  });
  let sessionCloseStarted;
  const didStartSessionClose = new Promise(resolve => {
    sessionCloseStarted = resolve;
  });
  let releaseSessionClose;
  const sessionCloseGate = new Promise(resolve => {
    releaseSessionClose = resolve;
  });
  const stream = new PassThrough();
  let writes = 0;
  const originalWrite = stream.write.bind(stream);
  stream.write = (...args) => {
    writes += 1;
    return originalWrite(...args);
  };
  installTerminalMocks(t, {
    getUserById: async () => {
      userLookupCount += 1;
      if (userLookupCount === 1) return activeUser;
      inputLookupStarted();
      return inputLookupGate;
    },
    open: async () => ({
      stream,
      resize: async () => {},
      close: async () => {
        sessionCloseStarted();
        await sessionCloseGate;
      },
    }),
  });

  const unhandledRejections = [];
  const captureUnhandledRejection = reason => unhandledRejections.push(reason);
  process.on('unhandledRejection', captureUnhandledRejection);
  const server = createWorkTerminalServer();
  const socket = new FakeWebSocket();
  try {
    server.emit('connection', socket, terminalRequest);
    await nextTurn();
    assert.ok(
      socket.sent.some(message => String(message).includes('"type":"ready"'))
    );
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ type: 'input', data: 'touch /tmp/late\n' })),
      false
    );
    await didStartInputLookup;

    let shutdownSettled = false;
    const shutdown = closeTerminalServer(server).then(() => {
      shutdownSettled = true;
    });
    socket.close();
    await didStartSessionClose;
    await nextTurn();
    assert.equal(shutdownSettled, false);

    releaseInputLookup();
    releaseSessionClose();
    await shutdown;
    await nextTurn();
    assert.equal(writes, 0);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.off('unhandledRejection', captureUnhandledRejection);
    releaseInputLookup?.();
    releaseSessionClose?.();
    stream.destroy();
  }
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
