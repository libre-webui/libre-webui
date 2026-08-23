import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

// Stateful production modules are imported below. Pin a test-only key before
// those imports so this suite can never generate or persist developer secrets.
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);
const gitModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'utils', 'workGit.js'))
    .href
);

const {
  PREVIEW_TARGET_SCRIPT,
  STATIC_PREVIEW_SERVER_SCRIPT,
  WORK_RUNTIME_ADMISSION_DEFAULTS,
  WORK_RUNTIME_DEFAULTS,
  WorkRuntimeService,
  buildWorkContainerRunArgs,
  describeDockerUnavailable,
  formatPreviewHost,
  parseDnsServers,
  parsePublishedPort,
  validateWorkspacePath,
} = runtimeModule;
const {
  buildWorkGitCommand,
  parseWorkGitLog,
  parseWorkGitStatus,
  validateWorkGitBranchName,
  validateWorkGitRepositoryPaths,
} = gitModule;

const detectPreview = workspace =>
  JSON.parse(
    execFileSync(
      process.execPath,
      ['-e', PREVIEW_TARGET_SCRIPT, '--', workspace],
      { encoding: 'utf8' }
    )
  );

const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => (error ? reject(error) : resolve(port)));
    });
  });

const task = {
  id: '1c95f122-0472-4b4c-ae88-0920de984cc8',
  userId: 'user-42',
  title: 'Isolated test workspace',
  model: 'llama3.2:3b',
  status: 'idle',
  networkEnabled: false,
  volumeName: 'libre-work-1c95f12204724b4cae880920de984cc8',
  containerName: 'libre-work-1c95f12204724b4cae880920de984cc8',
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

const optionValue = (args, option) => {
  const index = args.indexOf(option);
  assert.notEqual(index, -1, `missing Docker option ${option}`);
  assert.ok(
    index + 1 < args.length,
    `missing value for Docker option ${option}`
  );
  return args[index + 1];
};

const optionValues = (args, option) =>
  args.flatMap((value, index) =>
    value === option && index + 1 < args.length ? [args[index + 1]] : []
  );

const runWithHeldLifecycleLease = (_taskId, operation) =>
  operation(async () => {}, new AbortController().signal);

test('Work Git commands disable ambient config, prompts, hooks, and protocols', () => {
  const command = buildWorkGitCommand(['status', '--short']);
  assert.equal(command[0], 'env');
  assert.ok(command.includes('GIT_CONFIG_NOSYSTEM=1'));
  assert.ok(command.includes('GIT_CONFIG_GLOBAL=/dev/null'));
  assert.ok(command.includes('GIT_TERMINAL_PROMPT=0'));
  assert.ok(command.includes('core.hooksPath=/dev/null'));
  assert.ok(command.includes('credential.helper='));
  assert.ok(command.includes('protocol.allow=never'));
  assert.deepEqual(command.slice(-2), ['status', '--short']);
});

test('Work Git repository metadata must remain inside /workspace', () => {
  assert.doesNotThrow(() =>
    validateWorkGitRepositoryPaths(
      '/workspace\n/workspace/.git\n/workspace/.git\n'
    )
  );
  assert.throws(
    () =>
      validateWorkGitRepositoryPaths(
        '/workspace\n/tmp/borrowed.git\n/tmp/borrowed.git\n'
      ),
    /metadata must stay inside/
  );
  assert.throws(
    () =>
      validateWorkGitRepositoryPaths(
        '/workspace/project\n/workspace/.git\n/workspace/.git\n'
      ),
    /exactly \/workspace/
  );
});

test('Work Git parses porcelain status and bounded history without a shell', () => {
  const status = parseWorkGitStatus(
    [
      '# branch.oid abcdef123456',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 aaaaaa bbbbbb staged.txt',
      '2 R. N... 100644 100644 100644 aaaaaa bbbbbb R100 renamed file.txt',
      'old file.txt',
      '? new file.txt',
      '',
    ].join('\0')
  );
  assert.equal(status.branch, 'main');
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(
    status.changes.map(change => ({
      path: change.path,
      originalPath: change.originalPath,
      staged: change.staged,
    })),
    [
      { path: 'new file.txt', originalPath: undefined, staged: false },
      {
        path: 'renamed file.txt',
        originalPath: 'old file.txt',
        staged: true,
      },
      { path: 'staged.txt', originalPath: undefined, staged: true },
    ]
  );

  assert.deepEqual(
    parseWorkGitLog(
      [
        'abcdef',
        'abc123',
        'Robin',
        '2026-08-02T12:00:00Z',
        'Safe commit',
        '',
      ].join('\0')
    ),
    [
      {
        hash: 'abcdef',
        shortHash: 'abc123',
        author: 'Robin',
        authoredAt: '2026-08-02T12:00:00Z',
        subject: 'Safe commit',
      },
    ]
  );
});

test('Work Git rejects branch names that can be parsed as options', () => {
  assert.equal(validateWorkGitBranchName('feature/git-ui'), 'feature/git-ui');
  assert.throws(() => validateWorkGitBranchName('-force'), /invalid/);
  assert.throws(() => validateWorkGitBranchName('bad\nbranch'), /invalid/);
});

test('Work runtime defaults pin the image and bound resource use', () => {
  assert.deepEqual(WORK_RUNTIME_DEFAULTS, {
    image:
      'node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3',
    dockerCommand: 'docker',
    commandTimeoutMs: 120_000,
    maxOutputChars: 50_000,
    maxAgentRounds: 48,
    memoryLimit: '2g',
    cpuLimit: '2',
    pidsLimit: 256,
    previewPort: 4173,
    previewBind: '127.0.0.1',
    // Work Computer screen bridge (websockify) inside GUI-enabled sandboxes.
    screenPort: 6080,
    // Work Computer audio bridge (websockify → PulseAudio monitor).
    audioPort: 6081,
    networkName: 'libre-webui-work',
    // Idle-stop is opt-in: 0 keeps previews running until stopped.
    idleTimeoutMs: 0,
  });
  assert.match(WORK_RUNTIME_DEFAULTS.image, /@sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(WORK_RUNTIME_DEFAULTS.image, /:latest(?:@|$)/);
  assert.deepEqual(WORK_RUNTIME_ADMISSION_DEFAULTS, {
    maxActiveRuntimesGlobal: 3,
    maxActiveRuntimesPerUser: 2,
  });
});

test('workspace helpers attach to a running sandbox when the lease is held elsewhere', async () => {
  const sharedModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeShared.js')
    ).href
  );
  const service = new WorkRuntimeService();
  // In team mode the durable worker holds the per-task runtime lease for the
  // whole run. The Files pane must attach to the running sandbox instead of
  // reporting "active on another replica".
  service.acquireRuntimeLease = async () => {
    throw new sharedModule.WorkRuntimeError(
      'This Work task is active on another replica.',
      409,
      'WORK_RUNTIME_LEASE_CONFLICT'
    );
  };
  service.assertTaskIsActive = async () => {};
  let runtimeState = 'running';
  service.driver = { runtimeState: async () => runtimeState };
  service.exec = async () => ({
    stdout: JSON.stringify({ entries: [] }),
    stderr: '',
    exitCode: 0,
  });

  const task = {
    id: 'task-lease-attach',
    userId: 'admin-a',
    containerName: 'container-lease-attach',
    volumeName: 'volume-lease-attach',
  };
  const listed = await service.listFiles(task, '.');
  assert.deepEqual(listed.entries, []);

  // Without a reachable running sandbox the conflict still surfaces:
  // the holder really is another replica.
  runtimeState = 'stopped';
  await assert.rejects(
    () => service.listFiles(task, '.'),
    error => error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
  );
});

test('computer_act validates focus assertions and expectation declarations', () => {
  const { validateWorkComputerActions, validateWorkComputerExpectation } =
    runtimeModule;

  // Focus assertions ride on keyboard actions only and are trimmed.
  const validated = validateWorkComputerActions([
    { type: 'type', text: 'hello', focus: ' input#email ' },
    { type: 'key', keys: 'Return', focus: 'Sign in' },
    { type: 'click', x: 1, y: 2 },
  ]);
  assert.deepEqual(validated, [
    { type: 'type', text: 'hello', focus: 'input#email' },
    { type: 'key', keys: 'Return', focus: 'Sign in' },
    { type: 'click', x: 1, y: 2 },
  ]);
  for (const focus of ['', '   ', 'x'.repeat(201), 42]) {
    assert.throws(
      () => validateWorkComputerActions([{ type: 'type', text: 'a', focus }]),
      error => error.code === 'WORK_COMPUTER_INVALID_ACTION'
    );
  }

  // Expectations: absent stays absent, valid shapes normalize, and every
  // malformed field names itself.
  assert.equal(validateWorkComputerExpectation(undefined), undefined);
  assert.equal(validateWorkComputerExpectation(null), undefined);
  assert.deepEqual(
    validateWorkComputerExpectation({
      titleContains: ' Dashboard ',
      urlContains: 'example.test',
      regionChanged: { x: 0, y: 0, width: 100, height: 50 },
      withinMs: 8000,
    }),
    {
      titleContains: 'Dashboard',
      urlContains: 'example.test',
      regionChanged: { x: 0, y: 0, width: 100, height: 50 },
      withinMs: 8000,
    }
  );
  const rejected = [
    'not-an-object',
    {},
    { withinMs: 8000 },
    { titleContains: '' },
    { titleContains: 'x'.repeat(301) },
    { urlContains: 7 },
    { regionChanged: { x: 0, y: 0, width: 0, height: 50 } },
    { regionChanged: { x: -1, y: 0, width: 10, height: 10 } },
    { regionChanged: { x: 0, y: 0, width: 10 } },
    { titleContains: 'ok', withinMs: 0 },
    { titleContains: 'ok', withinMs: 20_000 },
  ];
  for (const value of rejected) {
    assert.throws(
      () => validateWorkComputerExpectation(value),
      error => error.code === 'WORK_COMPUTER_INVALID_ACTION'
    );
  }
});

test('the Work Computer and screen viewers survive a lease held elsewhere', async () => {
  const sharedModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeShared.js')
    ).href
  );
  const policyModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workPolicyService.js')
    ).href
  );
  const originalResolve = policyModule.default.resolve;
  policyModule.default.resolve = async () => ({
    guiEnabled: true,
    idleTimeoutMs: 0,
  });
  try {
    const service = new WorkRuntimeService();
    // In team mode the durable worker holds the per-task runtime lease for
    // the whole run — exactly when a human opens the Screen tab. The
    // session must attach to the running sandbox instead of failing with
    // "active on another replica".
    service.acquireRuntimeLease = async () => {
      throw new sharedModule.WorkRuntimeError(
        'This Work task is active on another replica.',
        409,
        'WORK_RUNTIME_LEASE_CONFLICT'
      );
    };
    service.assertTaskIsActive = async () => {};
    service.stopContainerIfIdleWithLock = async () => false;
    let runtimeState = 'running';
    const execCommands = [];
    service.driver = {
      runtimeState: async () => runtimeState,
      exec: async (_task, command) => {
        execCommands.push(command.join(' '));
        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
    const task = {
      id: 'task-computer-lease-attach',
      userId: 'admin-a',
      networkEnabled: true,
      containerName: 'container-computer-lease-attach',
      volumeName: 'volume-computer-lease-attach',
    };
    await service.startComputer(task);
    assert.ok(
      execCommands.some(command => command.includes('start-computer'))
    );

    // A viewer never takes the runtime lease at all: watching must neither
    // fail against an active run nor block the next run from starting.
    const release = await service.beginScreenSession(task);
    assert.equal(service.screenSessionCount(task.id), 1);
    await release();
    assert.equal(service.screenSessionCount(task.id), 0);

    // Without a running sandbox the conflict still surfaces: the holder
    // really is another replica mid-lifecycle.
    runtimeState = 'stopped';
    await assert.rejects(
      () => service.startComputer(task),
      error => error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
    );
  } finally {
    policyModule.default.resolve = originalResolve;
  }
});

test('a run waits out a transient shared-lease holder instead of failing', async () => {
  const { acquireSharedRuntimeLeaseWithWait } = runtimeModule;

  // A racing Files helper (or task-creation prepare) holds the lease for a
  // moment at run start; the run must poll through it and then proceed.
  let attempts = 0;
  let retries = 0;
  const lease = await acquireSharedRuntimeLeaseWithWait(
    async () => {
      attempts += 1;
      return attempts < 3 ? null : { token: 'acquired' };
    },
    {
      waitMs: 10_000,
      beforeRetry: async () => {
        retries += 1;
      },
    }
  );
  assert.deepEqual(lease, { token: 'acquired' });
  assert.equal(attempts, 3);
  assert.equal(retries, 2);

  // Callers without a wait budget (helpers, previews, stop) conflict at once.
  await assert.rejects(
    () => acquireSharedRuntimeLeaseWithWait(async () => null, { waitMs: 0 }),
    error => error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
  );

  // A holder that outlives the deadline is a genuine replica conflict.
  await assert.rejects(
    () => acquireSharedRuntimeLeaseWithWait(async () => null, { waitMs: 120 }),
    error => error.code === 'WORK_RUNTIME_LEASE_CONFLICT'
  );

  // An aborted run stops waiting instead of holding its poll loop.
  const controller = new AbortController();
  const aborting = assert.rejects(
    () =>
      acquireSharedRuntimeLeaseWithWait(async () => null, {
        waitMs: 10_000,
        signal: controller.signal,
      }),
    error => error.code !== 'WORK_RUNTIME_LEASE_CONFLICT'
  );
  controller.abort(new Error('run cancelled'));
  await aborting;

  // The run executor is the caller that opts into the wait.
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'services', 'workRuntimeService.ts'),
    'utf8'
  );
  assert.match(source, /sharedWaitMs: runLeaseWaitMs\(\)/);
});

test('runtime limits expose admission capacity and live occupancy', () => {
  const service = new WorkRuntimeService();
  assert.equal(
    service.limits.maxActiveRuntimesGlobal,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesGlobal
  );
  assert.equal(
    service.limits.maxActiveRuntimesPerUser,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesPerUser
  );
  // With no leases held, occupancy reports zero for the instance and the user.
  assert.deepEqual(service.activeRuntimeCounts('some-admin'), {
    global: 0,
    user: 0,
  });
  assert.deepEqual(service.activeRuntimeCounts(), { global: 0, user: 0 });
});

test('run command keeps the lifecycle lease through exec and teardown', async () => {
  const service = new WorkRuntimeService();
  let lifecycleHeld = false;
  let lifecycleEntries = 0;
  let lifecycleSignal;
  let execSignal;
  let stopSignal;
  let heldWhenExecStarted = false;
  let heldWhenContainerStopped = false;
  let releaseCalls = 0;
  let stopCalls = 0;
  let resolveExecStarted;
  let resolveExec;
  const execStarted = new Promise(resolve => {
    resolveExecStarted = resolve;
  });
  const execResult = new Promise(resolve => {
    resolveExec = resolve;
  });

  service.acquireRuntimeLease = async () => () => {
    releaseCalls += 1;
  };
  service.ensureImage = async () => {};
  service.assertTaskIsActive = async () => {};
  service.prepareWithLock = async (_task, signal) => {
    assert.equal(signal, lifecycleSignal);
  };
  service.previewProcessCheckWithLock = async (_task, signal) => {
    assert.equal(signal, lifecycleSignal);
    return 'dead';
  };
  service.withLifecycleLock = async (_taskId, operation) => {
    assert.equal(lifecycleHeld, false);
    lifecycleEntries += 1;
    lifecycleHeld = true;
    const controller = new AbortController();
    lifecycleSignal = controller.signal;
    try {
      return await operation(
        async () => assert.equal(lifecycleHeld, true),
        controller.signal
      );
    } finally {
      lifecycleHeld = false;
    }
  };
  service.driver.exec = async (_task, _command, options) => {
    heldWhenExecStarted = lifecycleHeld;
    execSignal = options.abortSignal;
    resolveExecStarted();
    return execResult;
  };
  service.stopContainerWithLock = async (_task, signal) => {
    stopCalls += 1;
    heldWhenContainerStopped = lifecycleHeld;
    stopSignal = signal;
  };
  service.releasePreviewLease = () => {};
  service.markPreviewStopped = async () => {};
  service.completeRecoveryTask = () => {};

  const commandResult = service.runCommand(task, 'printf ready', 10_000);
  await execStarted;
  const heldWhileExecPending = lifecycleHeld;
  resolveExec({
    exitCode: 0,
    stdout: 'ready',
    stderr: '',
    truncated: false,
  });

  assert.deepEqual(await commandResult, {
    exitCode: 0,
    stdout: 'ready',
    stderr: '',
    truncated: false,
  });
  assert.equal(heldWhenExecStarted, true);
  assert.equal(heldWhileExecPending, true);
  assert.equal(heldWhenContainerStopped, true);
  assert.equal(execSignal, lifecycleSignal);
  assert.equal(stopSignal, lifecycleSignal);
  assert.equal(lifecycleEntries, 1);
  assert.equal(stopCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.equal(lifecycleHeld, false);
  assert.equal(service.activeCommands.size, 0);
});

test('network-disabled containers use a non-root, least-privilege policy', () => {
  const image = 'example.invalid/work-runtime@sha256:test-only';
  const args = buildWorkContainerRunArgs(task, {
    policyId: null,
    image,
    memoryLimit: '2g',
    cpuLimit: '2',
    pidsLimit: 256,
    idleTimeoutMs: 0,
  });

  assert.deepEqual(args.slice(0, 2), ['run', '--detach']);
  assert.equal(optionValue(args, '--name'), task.containerName);
  assert.equal(optionValue(args, '--user'), '1000:1000');
  assert.equal(optionValue(args, '--workdir'), '/workspace');
  assert.equal(optionValue(args, '--network'), 'none');
  assert.equal(optionValue(args, '--cap-drop'), 'ALL');
  assert.equal(optionValue(args, '--security-opt'), 'no-new-privileges');
  const labels = optionValues(args, '--label');
  assert.ok(labels.includes('ai.libre-webui.managed=true'));
  assert.ok(labels.includes(`ai.libre-webui.task=${task.id}`));
  assert.match(
    labels.find(label => label.startsWith('ai.libre-webui.policy=')) || '',
    /^ai\.libre-webui\.policy=[a-f0-9]{64}$/
  );
  assert.match(optionValue(args, '--tmpfs'), /^\/tmp:rw,/);
  assert.match(optionValue(args, '--tmpfs'), /(?:^|,)nosuid(?:,|$)/);
  assert.match(optionValue(args, '--tmpfs'), /(?:^|,)size=\d+m(?:,|$)/);
  assert.ok(args.includes('--init'));
  assert.ok(args.includes('HOME=/tmp'));
  assert.ok(args.includes('NPM_CONFIG_CACHE=/tmp/npm-cache'));
  assert.ok(args.includes('--read-only'));
  assert.ok(Number(optionValue(args, '--pids-limit')) > 0);
  assert.ok(optionValue(args, '--memory'));
  // Swap is pinned to the memory cap so the limit cannot be sidestepped.
  assert.equal(
    optionValue(args, '--memory-swap'),
    optionValue(args, '--memory')
  );
  assert.ok(optionValue(args, '--cpus'));
  assert.equal(
    optionValue(args, '--mount'),
    `type=volume,src=${task.volumeName},dst=/workspace,volume-nocopy`
  );
  assert.deepEqual(args.slice(-4), [image, 'tail', '-f', '/dev/null']);
  assert.ok(!args.includes('--publish'));
  assert.ok(!args.includes('--privileged'));
  assert.ok(!args.includes('--volume'));
  assert.doesNotMatch(args.join('\n'), /docker\.sock|\/Users\/|\/home\//);
});

test('network-enabled containers publish only a dynamic loopback preview port', () => {
  const args = buildWorkContainerRunArgs(
    { ...task, networkEnabled: true },
    {
      policyId: null,
      image: 'example.invalid/work-runtime@sha256:test-only',
      memoryLimit: '2g',
      cpuLimit: '2',
      pidsLimit: 256,
      idleTimeoutMs: 0,
    }
  );

  // A dedicated managed bridge, never Docker's shared default bridge: task
  // containers must not be able to reach each other or the deployment's own
  // containers.
  assert.equal(
    optionValue(args, '--network'),
    WORK_RUNTIME_DEFAULTS.networkName
  );
  assert.notEqual(optionValue(args, '--network'), 'bridge');
  assert.equal(
    optionValue(args, '--publish'),
    `127.0.0.1::${WORK_RUNTIME_DEFAULTS.previewPort}`
  );
  assert.doesNotMatch(optionValue(args, '--publish'), /^0\.0\.0\.0:/);
  assert.doesNotMatch(optionValue(args, '--publish'), /^\d+:/);
});

test('egress resolvers are pinned only from validated WORK_RUNTIME_DNS entries', () => {
  assert.deepEqual(parseDnsServers(undefined), []);
  assert.deepEqual(parseDnsServers(''), []);
  assert.deepEqual(parseDnsServers('10.0.0.53, 10.0.0.54'), [
    '10.0.0.53',
    '10.0.0.54',
  ]);
  assert.deepEqual(parseDnsServers('fd00::53'), ['fd00::53']);
  // A hostname or injected flag never reaches the docker argument list.
  assert.deepEqual(parseDnsServers('resolver.example.com'), []);
  assert.deepEqual(parseDnsServers('--privileged'), []);
  assert.deepEqual(parseDnsServers('10.0.0.53,bad host'), ['10.0.0.53']);
});

test('an unreachable Docker daemon names the deployment change to make', () => {
  // A containerized backend fails one of exactly these three ways; each needs a
  // different fix, so none of them may collapse into "Docker is not available".
  const noCli = describeDockerUnavailable(
    new Error('spawn docker ENOENT'),
    'docker'
  );
  assert.match(noCli, /CLI is not installed/);
  assert.match(noCli, /"docker"/);

  const noPermission = describeDockerUnavailable(
    new Error(
      'permission denied while trying to connect to the docker API at unix:///var/run/docker.sock'
    )
  );
  assert.match(noPermission, /cannot open it/);
  assert.match(noPermission, /group_add/);

  const noDaemon = describeDockerUnavailable(
    new Error(
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock'
    )
  );
  assert.match(noDaemon, /No Docker daemon is reachable/);
  assert.match(noDaemon, /docker\.sock:\/var\/run\/docker\.sock/);

  assert.equal(
    describeDockerUnavailable(new Error('some other docker failure')),
    'some other docker failure'
  );
});

test('preview publishing follows the configured bind address', () => {
  // Default deployments stay on loopback; only an explicit bind opens it up.
  assert.equal(WORK_RUNTIME_DEFAULTS.previewBind, '127.0.0.1');
  assert.equal(parsePublishedPort('127.0.0.1:49173', 4173, '127.0.0.1'), 49173);
  assert.equal(parsePublishedPort('[::1]:49174', 4173, '127.0.0.1'), 49174);
  assert.equal(
    parsePublishedPort('0.0.0.0:49173', 4173, '127.0.0.1'),
    undefined
  );

  // A deployment that binds elsewhere accepts that address and nothing else.
  assert.equal(parsePublishedPort('0.0.0.0:49173', 4173, '0.0.0.0'), 49173);
  assert.equal(
    parsePublishedPort('127.0.0.1:49173', 4173, '0.0.0.0'),
    undefined
  );

  assert.equal(formatPreviewHost('127.0.0.1'), '127.0.0.1');
  assert.equal(formatPreviewHost('work.example.test'), 'work.example.test');
  assert.equal(formatPreviewHost('::1'), '[::1]');
  assert.equal(formatPreviewHost('[::1]'), '[::1]');
});

test('workspace path validation normalizes contained paths', () => {
  assert.equal(validateWorkspacePath('.'), '.');
  assert.equal(validateWorkspacePath('./src/main.ts', false), 'src/main.ts');
  assert.equal(
    validateWorkspacePath('src//components/main.ts', false),
    'src/components/main.ts'
  );
});

test('workspace path validation accepts contained names and rejects unsafe forms', () => {
  assert.equal(
    validateWorkspacePath('src/.../main.ts', false),
    'src/.../main.ts'
  );
  assert.equal(
    validateWorkspacePath('a folder/file.txt', false),
    'a folder/file.txt'
  );
  assert.equal(validateWorkspacePath('--help', false), '--help');

  for (const value of [
    '',
    '.',
    './',
    '../secret',
    'src/../../secret',
    'src/../secret',
    '/etc/passwd',
    String.raw`C:\Users\secret`,
    'src\0secret',
    'a'.repeat(1025),
  ]) {
    assert.throws(
      () => validateWorkspacePath(value, false),
      error =>
        error?.code === 'WORK_INVALID_PATH' &&
        error?.status === 400 &&
        /workspace/.test(error.message),
      `expected "${value}" to be rejected`
    );
  }
});

test('published preview ports are parsed only from loopback bindings', () => {
  assert.equal(parsePublishedPort('127.0.0.1:49173', 4173), 49173);
  assert.equal(parsePublishedPort('[::1]:49174', 4173), 49174);
  assert.equal(parsePublishedPort('0.0.0.0:49173', 4173), undefined);
  assert.equal(parsePublishedPort('192.168.1.10:49173', 4173), undefined);
  assert.equal(parsePublishedPort('127.0.0.1:0', 4173), undefined);
  assert.equal(parsePublishedPort('127.0.0.1:65536', 4173), undefined);
  assert.equal(parsePublishedPort('not a Docker port', 4173), undefined);
});

test('preview discovery selects static sites without requiring package.json', t => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-static-preview-')
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(path.join(workspace, 'index.html'), '<h1>Static app</h1>');

  assert.deepEqual(detectPreview(workspace), {
    kind: 'static',
    workdir: realpathSync(workspace),
  });
});

test('preview discovery prefers a root dev script and finds nested apps', t => {
  const rootWorkspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-root-preview-')
  );
  const nestedWorkspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-nested-preview-')
  );
  t.after(() => {
    rmSync(rootWorkspace, { recursive: true, force: true });
    rmSync(nestedWorkspace, { recursive: true, force: true });
  });

  writeFileSync(path.join(rootWorkspace, 'index.html'), 'static fallback');
  writeFileSync(
    path.join(rootWorkspace, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite' } })
  );
  assert.deepEqual(detectPreview(rootWorkspace), {
    kind: 'npm',
    workdir: realpathSync(rootWorkspace),
    runner: 'standard',
  });

  const nestedApp = path.join(nestedWorkspace, 'apps', 'web client');
  mkdirSync(nestedApp, { recursive: true });
  writeFileSync(
    path.join(nestedApp, 'package.json'),
    JSON.stringify({ scripts: { dev: 'vite' } })
  );
  assert.deepEqual(detectPreview(nestedWorkspace), {
    kind: 'npm',
    workdir: realpathSync(nestedApp),
    runner: 'standard',
  });
});

test('preview discovery ignores dependencies and rejects ambiguous roots', t => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-ambiguous-preview-')
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (const relative of ['apps/alpha', 'apps/beta', 'node_modules/example']) {
    const directory = path.join(workspace, relative);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'package.json'),
      JSON.stringify({ scripts: { dev: 'vite' } })
    );
  }

  assert.deepEqual(detectPreview(workspace), {
    kind: 'ambiguous',
    candidates: ['apps/alpha', 'apps/beta'],
  });

  rmSync(path.join(workspace, 'apps'), { recursive: true, force: true });
  assert.deepEqual(detectPreview(workspace), { kind: 'none' });
});

test('preview discovery identifies Next.js and searches shallow apps first', t => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-bounded-preview-')
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));

  const noisyDirectory = path.join(workspace, 'a-noisy-subtree');
  mkdirSync(noisyDirectory);
  for (let index = 0; index < 520; index += 1) {
    mkdirSync(path.join(noisyDirectory, `directory-${index}`));
  }
  const appDirectory = path.join(workspace, 'web');
  mkdirSync(appDirectory);
  writeFileSync(
    path.join(appDirectory, 'package.json'),
    JSON.stringify({
      scripts: { dev: 'next dev --turbopack' },
      dependencies: { next: '^15.0.0' },
    })
  );

  assert.deepEqual(detectPreview(workspace), {
    kind: 'npm',
    workdir: realpathSync(appDirectory),
    runner: 'next',
  });
});

test('preview discovery keeps entry points beyond the child traversal cap', t => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-large-preview-')
  );
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  for (let index = 0; index < 1_010; index += 1) {
    writeFileSync(
      path.join(workspace, `asset-${String(index).padStart(4, '0')}.txt`),
      ''
    );
  }
  writeFileSync(path.join(workspace, 'index.html'), '<h1>Large app</h1>');

  assert.deepEqual(detectPreview(workspace), {
    kind: 'static',
    workdir: realpathSync(workspace),
  });
});

test('built-in static preview serves app files and blocks symlink escapes', async t => {
  const workspace = mkdtempSync(
    path.join(tmpdir(), 'libre-work-static-server-')
  );
  const outside = mkdtempSync(path.join(tmpdir(), 'libre-work-outside-'));
  const port = await availablePort();
  writeFileSync(path.join(workspace, 'index.html'), '<h1>Preview ready</h1>');
  writeFileSync(path.join(workspace, 'app.js'), 'window.previewReady = true;');
  writeFileSync(path.join(outside, 'secret.txt'), 'must stay private');
  symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'secret'));

  const child = spawn(
    process.execPath,
    ['-e', STATIC_PREVIEW_SERVER_SCRIPT, '--', String(port)],
    { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  t.after(() => {
    child.kill('SIGTERM');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    let diagnostics = '';
    const timeout = setTimeout(
      () => reject(new Error(`Static preview did not start: ${diagnostics}`)),
      5_000
    );
    child.stdout.on('data', chunk => {
      diagnostics += chunk;
      if (diagnostics.includes('Static preview listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child.stderr.on('data', chunk => {
      diagnostics += chunk;
    });
    child.once('exit', code => {
      clearTimeout(timeout);
      reject(
        new Error(`Static preview exited with code ${code}: ${diagnostics}`)
      );
    });
  });

  const rootResponse = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(rootResponse.status, 200);
  assert.equal(await rootResponse.text(), '<h1>Preview ready</h1>');
  assert.match(rootResponse.headers.get('content-type') || '', /^text\/html/);

  const scriptResponse = await fetch(`http://127.0.0.1:${port}/app.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(
    scriptResponse.headers.get('content-type') || '',
    /^text\/javascript/
  );

  const spaResponse = await fetch(`http://127.0.0.1:${port}/city/overview`, {
    headers: { Accept: 'text/html' },
  });
  assert.equal(spaResponse.status, 200);
  assert.equal(await spaResponse.text(), '<h1>Preview ready</h1>');

  assert.equal((await fetch(`http://127.0.0.1:${port}/secret`)).status, 404);
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/`, {
        method: 'POST',
      })
    ).status,
    405
  );
});

test('preview startup wires detected targets into safe Docker launch arguments', async () => {
  const detectedTask = { ...task, networkEnabled: true };
  const runHarness = async detection => {
    const service = new WorkRuntimeService();
    const dockerCalls = [];
    let releaseCalls = 0;
    service.acquireRuntimeLease = () => () => {
      releaseCalls += 1;
    };
    service.ensureImage = async () => {};
    service.assertTaskIsActive = () => {};
    service.assertCurrentNetworkPolicy = () => {};
    service.prepareWithLock = async () => {};
    service.withLifecycleLock = runWithHeldLifecycleLease;
    service.driver.docker = async args => {
      dockerCalls.push(args);
      if (args.includes(PREVIEW_TARGET_SCRIPT)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify(detection),
          stderr: '',
          truncated: false,
        };
      }
      if (args[0] === 'exec' && args.includes('/bin/bash')) {
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      }
      if (args[0] === 'exec' && args.includes('node')) {
        return { exitCode: 0, stdout: '', stderr: '', truncated: false };
      }
      if (args[0] === 'port') {
        return {
          exitCode: 0,
          stdout: '127.0.0.1:49173',
          stderr: '',
          truncated: false,
        };
      }
      throw new Error(`Unexpected Docker call: ${args.join(' ')}`);
    };

    const previewUrl = await service.startPreview(detectedTask);
    assert.match(
      previewUrl,
      new RegExp(
        `^/api/work/previews/${detectedTask.id}/49173\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}/$`
      )
    );
    assert.equal(releaseCalls, 0);
    service.finalizeTaskRemoval(detectedTask.id);
    assert.equal(releaseCalls, 1);
    return dockerCalls;
  };

  const staticCalls = await runHarness({
    kind: 'static',
    workdir: '/workspace',
  });
  const staticLaunch = staticCalls.find(
    args => args[0] === 'exec' && args.includes('/bin/bash')
  );
  assert.ok(staticLaunch);
  assert.equal(optionValue(staticLaunch, '--workdir'), '/workspace');
  assert.deepEqual(staticLaunch.slice(-3), [
    'static',
    STATIC_PREVIEW_SERVER_SCRIPT,
    String(WORK_RUNTIME_DEFAULTS.previewPort),
  ]);

  const nextCalls = await runHarness({
    kind: 'npm',
    workdir: '/workspace/apps/web',
    runner: 'next',
  });
  const nextLaunch = nextCalls.find(
    args => args[0] === 'exec' && args.includes('/bin/bash')
  );
  assert.ok(nextLaunch);
  assert.equal(optionValue(nextLaunch, '--workdir'), '/workspace/apps/web');
  assert.deepEqual(nextLaunch.slice(-3), [
    'shell',
    `npm run dev -- --hostname 0.0.0.0 --port ${WORK_RUNTIME_DEFAULTS.previewPort}`,
    String(WORK_RUNTIME_DEFAULTS.previewPort),
  ]);
});

test('failed preview discovery stops the container and releases its lease', async () => {
  const service = new WorkRuntimeService();
  let failedCalls = 0;
  let cleanupCalls = 0;
  let releaseCalls = 0;
  service.acquireRuntimeLease = () => () => {
    releaseCalls += 1;
  };
  service.ensureImage = async () => {};
  service.assertTaskIsActive = () => {};
  service.assertCurrentNetworkPolicy = () => {};
  service.prepareWithLock = async () => {};
  service.withLifecycleLock = runWithHeldLifecycleLease;
  service.stopContainerWithLock = async () => {
    cleanupCalls += 1;
  };
  service.driver.docker = async args => {
    assert.ok(args.includes(PREVIEW_TARGET_SCRIPT));
    return {
      exitCode: 0,
      stdout: JSON.stringify({ kind: 'none' }),
      stderr: '',
      truncated: false,
    };
  };

  await assert.rejects(
    service.startPreview({ ...task, networkEnabled: true }, undefined, {
      onFailed: () => {
        failedCalls += 1;
      },
    }),
    error => error?.status === 422 && error?.code === 'WORK_PREVIEW_NOT_FOUND'
  );
  assert.equal(failedCalls, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(releaseCalls, 1);
  assert.equal(service.previewLeaseReleases.has(task.id), false);
});

test('preview lease release validates callbacks selected by task ID', () => {
  const service = new WorkRuntimeService();
  let releaseCalls = 0;

  service.previewLeaseReleases.set(task.id, () => {
    releaseCalls += 1;
  });
  assert.doesNotThrow(() => service.finalizeTaskRemoval(task.id));
  assert.equal(releaseCalls, 1);
  assert.equal(service.previewLeaseReleases.has(task.id), false);

  const malformedTaskId = '__proto__';
  service.previewLeaseReleases.set(malformedTaskId, { invalid: true });
  assert.doesNotThrow(() => service.finalizeTaskRemoval(malformedTaskId));
  assert.equal(releaseCalls, 1);
  assert.equal(service.previewLeaseReleases.has(malformedTaskId), false);
});

test('task retirement gates every new mutation before cleanup', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-gate-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const databaseModule = await import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
  );
  const taskServiceModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workTaskService.js')
    ).href
  );
  const service = new taskServiceModule.WorkTaskService();
  const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);
  const db = databaseModule.getDatabase();
  const userId = 'retirement-gate-user';
  const now = Date.now();

  t.after(async () => {
    await closeWorkPlatform();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'admin', ?, ?)`
  ).run(
    userId,
    userId,
    `${userId}@example.invalid`,
    'not-a-real-hash',
    now,
    now
  );

  const authMiddlewareModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'middleware', 'auth.js')
    ).href
  );
  const staleAdminRequest = {
    user: { userId, username: userId, role: 'admin' },
  };
  let adminNextCalls = 0;
  const allowedResponse = {
    status: () => allowedResponse,
    json: () => allowedResponse,
  };
  await authMiddlewareModule.requireAdmin(
    staleAdminRequest,
    allowedResponse,
    () => {
      adminNextCalls += 1;
    }
  );
  assert.equal(adminNextCalls, 1);

  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(userId);
  let deniedStatus;
  let deniedPayload;
  const deniedResponse = {
    status: status => {
      deniedStatus = status;
      return deniedResponse;
    },
    json: payload => {
      deniedPayload = payload;
      return deniedResponse;
    },
  };
  await authMiddlewareModule.requireAdmin(
    staleAdminRequest,
    deniedResponse,
    () => {
      adminNextCalls += 1;
    }
  );
  assert.equal(adminNextCalls, 1);
  assert.equal(deniedStatus, 403);
  assert.equal(deniedPayload?.message, 'Admin access required');
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);

  const created = await service.createTaskWithRun(
    userId,
    'Build a retirement\u0000 gate',
    'local-tools-model',
    false
  );
  assert.equal(created.title, 'Build a retirement\uFFFD gate');
  assert.equal(
    (await service.getMessages(created.id))[0].content,
    'Build a retirement\u0000 gate',
    'derived-title sanitizing must not change the logical Work message'
  );
  assert.equal(created.providerType, 'ollama');
  assert.equal(created.providerId, undefined);
  assert.equal(created.activeRun.providerType, 'ollama');
  assert.equal(created.activeRun.providerId, undefined);
  await service.updateRun(created.activeRun.id, 'completed', {
    error: 'plugin\u0000diagnostic',
    finished: true,
  });
  assert.equal(
    (await service.getRun(created.activeRun.id)).error,
    'plugin\uFFFDdiagnostic'
  );
  assert.equal(
    db
      .prepare('SELECT error FROM work_runs WHERE id = ?')
      .get(created.activeRun.id).error,
    'plugin\uFFFDdiagnostic'
  );
  await service.updateTaskStatus(created.id, 'completed');
  assert.equal(
    (
      await service.updateTask(created.id, userId, {
        title: 'visible\u0000replacement',
      })
    ).title,
    'visible\uFFFDreplacement'
  );
  await assert.rejects(
    service.updateTask(created.id, userId, { model: 'invalid\u0000model' }),
    error => error?.status === 400 && /model.*U\+0000/i.test(error.message)
  );

  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(userId);
  await assert.rejects(
    service.updateTask(created.id, userId, { title: 'Stale admin write' }),
    error => error?.status === 403 && /Admin access/.test(error.message)
  );
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);

  const previewUrl = 'http://127.0.0.1:49173';
  await service.updatePreview(created.id, 'running', previewUrl);
  const policyTask = await service.beginNetworkPolicyChange(created.id, userId);
  assert.equal(policyTask.networkEnabled, false);
  await assert.rejects(
    service.createRun(
      created.id,
      userId,
      'This must not start during a network transition.'
    ),
    error => error?.status === 409 && /network policy/.test(error.message)
  );
  await assert.rejects(
    service.beginTaskRetirement(created.id, userId),
    error => error?.status === 409 && /network policy/.test(error.message)
  );
  await service.commitNetworkChange(created.id, userId, {
    title: 'Network transition serialized',
    networkEnabled: false,
  });
  service.releaseNetworkPolicyChange(created.id);
  const unchangedNetwork = await service.requireTaskDetail(created.id, userId);
  assert.equal(unchangedNetwork.previewStatus, 'running');
  assert.equal(unchangedNetwork.previewUrl, previewUrl);

  await service.beginNetworkPolicyChange(created.id, userId);
  await service.commitNetworkChange(created.id, userId, {
    networkEnabled: true,
  });
  service.releaseNetworkPolicyChange(created.id);
  const changedNetwork = await service.requireTaskDetail(created.id, userId);
  assert.equal(changedNetwork.networkEnabled, true);
  assert.equal(changedNetwork.previewStatus, 'stopped');
  assert.equal(changedNetwork.previewUrl, undefined);

  await service.beginTaskRetirement(created.id, userId);
  await assert.rejects(
    service.createRun(
      created.id,
      userId,
      'This must not be inserted during deletion.'
    ),
    error => error?.status === 409 && /being deleted/.test(error.message)
  );
  await assert.rejects(
    service.updateTask(created.id, userId, { title: 'Race won' }),
    error => error?.status === 409 && /being deleted/.test(error.message)
  );
  await assert.rejects(
    service.assertTaskMutationAllowed(created.id, userId),
    error => error?.status === 409 && /being deleted/.test(error.message)
  );
  assert.equal(
    db
      .prepare('SELECT COUNT(*) AS count FROM work_runs WHERE task_id = ?')
      .get(created.id).count,
    1
  );

  service.releaseTaskRetirement(created.id);
  assert.equal(
    (
      await service.updateTask(created.id, userId, {
        title: 'Retry remains possible',
      })
    ).title,
    'Retry remains possible'
  );

  const insertAdmin = id => {
    db.prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'admin', ?, ?)`
    ).run(id, id, `${id}@example.invalid`, 'not-a-real-hash', now, now);
  };
  const capacityUserTwo = 'capacity-user-two';
  const capacityUserThree = 'capacity-user-three';
  insertAdmin(capacityUserTwo);
  insertAdmin(capacityUserThree);

  // Two concurrent runtimes per administrator are admitted; the third is not.
  const capacityTaskOne = await service.createTaskWithRun(
    userId,
    'Occupy the first per-user Work runtime slot',
    'local-tools-model',
    false
  );
  const capacityTaskOneB = await service.createTaskWithRun(
    userId,
    'Occupy the second per-user Work runtime slot',
    'local-tools-model',
    false
  );
  await assert.rejects(
    service.createTaskWithRun(
      userId,
      'This third per-user runtime must be rejected',
      'local-tools-model',
      false
    ),
    error => error?.status === 429 && error?.code === 'WORK_USER_RUNTIME_LIMIT'
  );
  // A third administrator is refused once three runtimes are active globally.
  const capacityTaskTwo = await service.createTaskWithRun(
    capacityUserTwo,
    'Occupy the last global Work runtime slot',
    'local-tools-model',
    false
  );
  await assert.rejects(
    service.createTaskWithRun(
      capacityUserThree,
      'This global runtime must be rejected',
      'local-tools-model',
      false
    ),
    error =>
      error?.status === 429 && error?.code === 'WORK_GLOBAL_RUNTIME_LIMIT'
  );
  for (const detail of [capacityTaskOne, capacityTaskOneB, capacityTaskTwo]) {
    await service.updateRun(detail.activeRun.id, 'completed', {
      finished: true,
    });
    await service.updateTaskStatus(detail.id, 'completed');
  }
  const capacityTaskThree = await service.createTaskWithRun(
    capacityUserThree,
    'Create a third idle task after capacity is released',
    'local-tools-model',
    false
  );
  await service.updateRun(capacityTaskThree.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(capacityTaskThree.id, 'completed');

  for (let index = 0; index < 209; index += 1) {
    await service.addMessage(
      created.id,
      created.activeRun.id,
      'assistant',
      'message',
      `conversation-${index}`
    );
  }
  for (let index = 0; index < 15; index += 1) {
    await service.addMessage(
      created.id,
      created.activeRun.id,
      'tool',
      'tool_result',
      `tool-${index}`
    );
  }

  const detail = await service.requireTaskDetail(created.id, userId);
  assert.equal(detail.messages.length, 200);
  assert.equal(detail.messages[0].messageIndex, 25);
  assert.equal(detail.messageCursor, 25);
  assert.equal(detail.hasMoreMessages, true);

  const older = await service.getMessagePage(created.id, detail.messageCursor);
  assert.equal(older.messages.length, 25);
  assert.equal(older.messages[0].messageIndex, 0);
  assert.equal(older.messages.at(-1).messageIndex, 24);
  assert.equal(older.cursor, undefined);
  assert.equal(older.hasMore, false);

  const expectedContext = (await service.getMessages(created.id))
    .filter(
      message =>
        message.kind === 'message' &&
        (message.role === 'user' || message.role === 'assistant')
    )
    .slice(-30);
  assert.deepEqual(
    (await service.getRecentConversationMessages(created.id)).map(
      message => message.messageIndex
    ),
    expectedContext.map(message => message.messageIndex)
  );

  const bounded = await service.addMessage(
    created.id,
    created.activeRun.id,
    'assistant',
    'message',
    '🙂'.repeat(60_000)
  );
  assert.ok(Buffer.byteLength(bounded.content, 'utf8') <= 100_000);
  assert.match(bounded.content, /message truncated/);
  assert.ok(
    (await service.getRecentConversationMessages(created.id)).reduce(
      (bytes, message) => bytes + Buffer.byteLength(message.content, 'utf8'),
      0
    ) <= 256_000
  );

  const pluginTask = await service.updateTask(created.id, userId, {
    model: 'shared-model',
    providerType: 'plugin',
    providerId: 'remote-collision',
  });
  assert.equal(pluginTask.providerType, 'plugin');
  assert.equal(pluginTask.providerId, 'remote-collision');
  const pluginRunTask = await service.createRun(
    created.id,
    userId,
    'Keep the exact remote route.',
    'shared-model',
    { providerType: 'plugin', providerId: 'remote-collision' }
  );
  assert.equal(pluginRunTask.activeRun.providerType, 'plugin');
  assert.equal(pluginRunTask.activeRun.providerId, 'remote-collision');
  const persistedRoute = db
    .prepare(
      `SELECT provider_type, provider_id
       FROM work_runs WHERE id = ?`
    )
    .get(pluginRunTask.activeRun.id);
  assert.deepEqual(persistedRoute, {
    provider_type: 'plugin',
    provider_id: 'remote-collision',
  });
  await service.updateRun(pluginRunTask.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(created.id, 'completed');

  const capacityRuntime = new runtimeModule.WorkRuntimeService();
  capacityRuntime.ensureImage = async () => {};
  capacityRuntime.withLifecycleLock = runWithHeldLifecycleLease;
  capacityRuntime.prepareWithLock = async () => {};
  const taskOneRecord = await service.requireTaskRecord(
    capacityTaskOne.id,
    userId
  );
  const taskTwoRecord = await service.requireTaskRecord(
    capacityTaskTwo.id,
    capacityUserTwo
  );
  const taskThreeRecord = await service.requireTaskRecord(
    capacityTaskThree.id,
    capacityUserThree
  );

  const extraUserTask = await service.createTaskWithRun(
    userId,
    'Provide a third task for lease-capacity checks',
    'local-tools-model',
    false
  );
  await service.updateRun(extraUserTask.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(extraUserTask.id, 'completed');
  const extraUserRecord = await service.requireTaskRecord(
    extraUserTask.id,
    userId
  );

  // Two leases for one administrator are admitted; the third is refused.
  const releaseUserSlot = await capacityRuntime.prepare(taskOneRecord);
  const releaseUserSlotTwo = await capacityRuntime.prepare(
    await service.requireTaskRecord(created.id, userId)
  );
  await assert.rejects(
    capacityRuntime.prepare(extraUserRecord),
    error => error?.status === 429 && error?.code === 'WORK_USER_RUNTIME_LIMIT'
  );
  assert.deepEqual(capacityRuntime.activeRuntimeCounts(userId), {
    global: 2,
    user: 2,
  });
  releaseUserSlotTwo();

  // A third distinct lease fills the instance; the fourth is refused globally.
  const releaseGlobalTwo = await capacityRuntime.prepare(taskTwoRecord);
  const releaseGlobalThree = await capacityRuntime.prepare(taskThreeRecord);
  await assert.rejects(
    capacityRuntime.prepare(extraUserRecord),
    error =>
      error?.status === 429 && error?.code === 'WORK_GLOBAL_RUNTIME_LIMIT'
  );
  releaseUserSlot();
  releaseGlobalTwo();
  releaseGlobalThree();
  assert.deepEqual(capacityRuntime.activeRuntimeCounts(userId), {
    global: 0,
    user: 0,
  });

  const missingDocker = async args => {
    const kind = args[0] === 'volume' ? 'volume' : 'container';
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Error: No such ${kind}`,
      truncated: false,
    };
  };
  // Reconciliation asks Docker once which labeled containers exist. A task
  // whose container is already gone needs no stop call at all.
  const restedRuntime = new runtimeModule.WorkRuntimeService();
  restedRuntime.isRuntimeAvailable = async () => true;
  restedRuntime.driver.docker = async args => {
    assert.equal(args[0], 'ps');
    return { exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
  const rested = await restedRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(rested, { stopped: 0, failed: 0 });
  assert.equal(restedRuntime.recoveryPending, false);
  assert.doesNotThrow(() => restedRuntime.assertAcceptingWork());

  // A running container of a known task is stopped; a managed container
  // whose task row is gone is force-removed as an orphan.
  const recoveredRuntime = new runtimeModule.WorkRuntimeService();
  recoveredRuntime.isRuntimeAvailable = async () => true;
  const recoveryCalls = [];
  recoveredRuntime.driver.docker = async args => {
    recoveryCalls.push(args);
    if (args[0] === 'ps') {
      return {
        exitCode: 0,
        stdout:
          `${taskOneRecord.containerName}\trunning\t${taskOneRecord.id}\n` +
          'work-orphan\trunning\ttask-gone\n',
        stderr: '',
        truncated: false,
      };
    }
    if (args[0] === 'inspect') {
      return {
        exitCode: 0,
        stdout: `${taskOneRecord.id}\n`,
        stderr: '',
        truncated: false,
      };
    }
    return { exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
  const recovered = await recoveredRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(recovered, { stopped: 2, failed: 0 });
  assert.equal(recoveredRuntime.recoveryPending, false);
  assert.doesNotThrow(() => recoveredRuntime.assertAcceptingWork());
  assert.ok(
    recoveryCalls.some(
      args => args[0] === 'stop' && args.includes(taskOneRecord.containerName)
    ),
    'the running owned container must be stopped'
  );
  assert.ok(
    recoveryCalls.some(
      args => args[0] === 'rm' && args.includes('work-orphan')
    ),
    'the orphaned container must be removed'
  );

  const teardownRuntime = new runtimeModule.WorkRuntimeService();
  teardownRuntime.isRuntimeAvailable = async () => true;
  let stopFails = true;
  teardownRuntime.driver.docker = async args => {
    if (args[0] === 'container') {
      return {
        exitCode: 0,
        stdout: '{}',
        stderr: '',
        truncated: false,
      };
    }
    if (args[0] === 'inspect') {
      return {
        exitCode: 0,
        stdout: taskOneRecord.id,
        stderr: '',
        truncated: false,
      };
    }
    if (args[0] === 'stop' && stopFails) {
      throw new Error('transient Docker stop failure');
    }
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      truncated: false,
    };
  };
  await assert.rejects(
    teardownRuntime.stopContainer(taskOneRecord),
    /transient Docker stop failure/
  );
  assert.equal(teardownRuntime.recoveryPending, true);
  assert.throws(
    () => teardownRuntime.assertAcceptingWork(),
    error => error?.status === 503 && error?.code === 'WORK_RUNTIME_RECOVERING'
  );
  stopFails = false;
  const retriedTeardown = await teardownRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(retriedTeardown, { stopped: 1, failed: 0 });
  assert.equal(teardownRuntime.recoveryPending, false);
  teardownRuntime.beginShutdown();

  const blockedRuntime = new runtimeModule.WorkRuntimeService();
  blockedRuntime.isRuntimeAvailable = async () => false;
  const blocked = await blockedRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(blocked, { stopped: 0, failed: 1 });
  assert.equal(blockedRuntime.recoveryPending, true);
  assert.throws(
    () => blockedRuntime.assertAcceptingWork(),
    error => error?.status === 503 && error?.code === 'WORK_RUNTIME_RECOVERING'
  );
  blockedRuntime.beginShutdown();

  const retiredTask = await service.createTaskWithRun(
    userId,
    'Delete resources after an administrator is demoted',
    'local-tools-model',
    false
  );
  await service.updateRun(retiredTask.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(retiredTask.id, 'completed');
  const retiredRecord = await service.requireTaskRecord(retiredTask.id, userId);
  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(userId);

  const cleanupRuntime = new runtimeModule.WorkRuntimeService();
  cleanupRuntime.driver.docker = missingDocker;
  await assert.rejects(
    cleanupRuntime.removeTask(retiredRecord),
    error => error?.status === 403 && error?.code === 'WORK_ACCESS_REVOKED'
  );
  await cleanupRuntime.removeTask(retiredRecord, true);
  cleanupRuntime.finalizeTaskRemoval(retiredRecord.id);
  await service.deleteTask(retiredRecord.id, userId);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);
});

test('Work message metadata and model context enforce exact byte bounds', async t => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-messages-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const databaseModule = await import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
  );
  const taskServiceModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workTaskService.js')
    ).href
  );
  const service = new taskServiceModule.WorkTaskService();
  const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);
  const db = databaseModule.getDatabase();
  const userId = 'message-bounds-user';
  const now = Date.now();

  t.after(async () => {
    await closeWorkPlatform();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'admin', ?, ?)`
  ).run(
    userId,
    userId,
    `${userId}@example.invalid`,
    'not-a-real-hash',
    now,
    now
  );

  const persistenceTask = await service.createTaskWithRun(
    userId,
    'Preserve exact provider response items',
    'local-tools-model',
    false
  );
  const exactMetadata = {
    openAIResponsesOutputItems: [
      {
        type: 'reasoning',
        id: 'reasoning-exact',
        encrypted_content: 'e'.repeat(90_000),
      },
    ],
  };
  assert.ok(
    Buffer.byteLength(JSON.stringify(exactMetadata), 'utf8') <
      taskServiceModule.WORK_MESSAGE_METADATA_MAX_BYTES
  );
  const exactMessage = await service.addMessage(
    persistenceTask.id,
    persistenceTask.activeRun.id,
    'assistant',
    'provider_state',
    '',
    exactMetadata
  );
  assert.deepEqual(exactMessage.metadata, exactMetadata);
  const storedExactMetadata = db
    .prepare('SELECT metadata FROM work_messages WHERE id = ?')
    .get(exactMessage.id).metadata;
  assert.equal(storedExactMetadata, JSON.stringify(exactMetadata));
  assert.deepEqual(
    (await service.getRecentModelContextMessages(persistenceTask.id)).find(
      message => message.id === exactMessage.id
    )?.metadata,
    exactMetadata
  );

  const oversizedMetadata = {
    openAIResponsesOutputItems: [
      {
        type: 'reasoning',
        id: 'reasoning-oversized',
        encrypted_content: 'o'.repeat(110_000),
      },
    ],
  };
  const droppedMessage = await service.addMessage(
    persistenceTask.id,
    persistenceTask.activeRun.id,
    'assistant',
    'provider_state',
    '',
    oversizedMetadata
  );
  assert.equal(droppedMessage.metadata, undefined);
  assert.equal(
    db
      .prepare('SELECT metadata FROM work_messages WHERE id = ?')
      .get(droppedMessage.id).metadata,
    null
  );
  await service.updateRun(persistenceTask.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(persistenceTask.id, 'completed');

  const pageMetadata = { exact: 'p'.repeat(80_000) };
  const pageMessages = await Promise.all(
    Array.from({ length: 13 }, (_, index) =>
      service.addMessage(
        persistenceTask.id,
        persistenceTask.activeRun.id,
        'assistant',
        'message',
        `page-${index}`,
        pageMetadata
      )
    )
  );
  const boundedPage = await service.getMessagePage(persistenceTask.id);
  assert.equal(boundedPage.messages.length, 12);
  assert.equal(boundedPage.hasMore, true);
  assert.ok(
    boundedPage.messages.reduce(
      (bytes, message) =>
        bytes +
        Buffer.byteLength(message.content, 'utf8') +
        Buffer.byteLength(JSON.stringify(message.metadata || {}), 'utf8'),
      0
    ) <= 1_000_000
  );
  assert.ok(
    boundedPage.messages.every(
      message => message.metadata?.exact === pageMetadata.exact
    )
  );
  assert.equal(
    boundedPage.messages.some(message => message.id === pageMessages[0].id),
    false
  );

  const invalidPageTask = await service.createTaskWithRun(
    userId,
    'Advance past an entirely oversized legacy page',
    'local-tools-model',
    false
  );
  for (let index = 0; index < 201; index += 1) {
    await service.addMessage(
      invalidPageTask.id,
      invalidPageTask.activeRun.id,
      'assistant',
      'message',
      `legacy-page-${index}`
    );
  }
  db.prepare(`UPDATE work_messages SET content = ? WHERE task_id = ?`).run(
    'x'.repeat(100_001),
    invalidPageTask.id
  );
  const invalidFirstPage = await service.getMessagePage(invalidPageTask.id);
  assert.deepEqual(invalidFirstPage.messages, []);
  assert.equal(invalidFirstPage.hasMore, true);
  assert.equal(typeof invalidFirstPage.cursor, 'number');
  const invalidSecondPage = await service.getMessagePage(
    invalidPageTask.id,
    invalidFirstPage.cursor
  );
  assert.deepEqual(invalidSecondPage.messages, []);
  assert.equal(invalidSecondPage.hasMore, false);
  assert.equal(invalidSecondPage.cursor, undefined);
  await service.updateRun(invalidPageTask.activeRun.id, 'completed', {
    finished: true,
  });
  await service.updateTaskStatus(invalidPageTask.id, 'completed');

  const contextTask = await service.createTaskWithRun(
    userId,
    'Skip oversized historical context rows',
    'local-tools-model',
    false
  );
  const budgetMetadata = {
    openAIResponsesOutputItems: [
      {
        type: 'reasoning',
        id: 'reasoning-within-cap',
        encrypted_content: 'b'.repeat(70_000),
      },
    ],
  };
  const firstBudgetMessage = await service.addMessage(
    contextTask.id,
    contextTask.activeRun.id,
    'assistant',
    'message',
    'a'.repeat(90_000),
    budgetMetadata
  );
  const latestBudgetMessage = await service.addMessage(
    contextTask.id,
    contextTask.activeRun.id,
    'assistant',
    'message',
    'z'.repeat(90_000),
    budgetMetadata
  );

  const legacyOversizedMetadata = JSON.stringify({
    openAIResponsesOutputItems: [
      {
        type: 'reasoning',
        id: 'legacy-oversized',
        encrypted_content: 'l'.repeat(110_000),
      },
    ],
  });
  db.prepare(
    `INSERT INTO work_messages (
      id, task_id, run_id, role, kind, content, metadata,
      message_index, created_at
    ) VALUES (?, ?, ?, 'assistant', 'message', ?, ?, ?, ?)`
  ).run(
    'legacy-oversized-metadata',
    contextTask.id,
    contextTask.activeRun.id,
    'legacy metadata must be dropped',
    legacyOversizedMetadata,
    3,
    now + 3
  );
  db.prepare(
    `INSERT INTO work_messages (
      id, task_id, run_id, role, kind, content, metadata,
      message_index, created_at
    ) VALUES (?, ?, ?, 'assistant', 'message', ?, NULL, ?, ?)`
  ).run(
    'legacy-oversized-first-row',
    contextTask.id,
    contextTask.activeRun.id,
    'x'.repeat(300_000),
    4,
    now + 4
  );

  const legacyMessage = (await service.getMessages(contextTask.id)).find(
    message => message.id === 'legacy-oversized-metadata'
  );
  assert.ok(legacyMessage);
  assert.equal(legacyMessage.metadata, undefined);

  const retainedContext = await service.getRecentModelContextMessages(
    contextTask.id
  );
  assert.deepEqual(
    retainedContext.map(message => message.id),
    [latestBudgetMessage.id]
  );
  assert.ok(
    retainedContext.every(
      message =>
        Buffer.byteLength(message.content, 'utf8') <=
          taskServiceModule.WORK_MESSAGE_MAX_BYTES &&
        Buffer.byteLength(JSON.stringify(message.metadata || {}), 'utf8') <=
          taskServiceModule.WORK_MESSAGE_METADATA_MAX_BYTES
    )
  );
  assert.ok(
    retainedContext.reduce(
      (bytes, message) =>
        bytes +
        Buffer.byteLength(message.content, 'utf8') +
        Buffer.byteLength(JSON.stringify(message.metadata || {}), 'utf8'),
      0
    ) <= 256_000
  );
  assert.deepEqual(
    (await service.getRecentConversationMessages(contextTask.id)).map(
      message => message.id
    ),
    [latestBudgetMessage.id]
  );
  assert.notEqual(firstBudgetMessage.id, latestBudgetMessage.id);
});

test('startup reconciliation stops only what is running and owned', () => {
  const { parseManagedContainerList, planStartupReconciliation } =
    runtimeModule;

  const containers = parseManagedContainerList(
    [
      'work-a\trunning\ttask-a',
      'work-b\texited\ttask-b',
      'work-c\tpaused\ttask-c',
      'work-ghost\trunning\ttask-deleted',
      'work-stale\texited\ttask-deleted-too',
      'work-unlabeled\trunning\t',
      'work-idle-no-container\trunning\ttask-someone-else',
      '',
      'garbage-line-without-tabs',
    ].join('\n')
  );

  // paused/restarting containers still hold execution state; exited ones
  // are at rest. A missing task label parses as an empty owner.
  assert.deepEqual(
    containers.map(c => [c.name, c.running]),
    [
      ['work-a', true],
      ['work-b', false],
      ['work-c', true],
      ['work-ghost', true],
      ['work-stale', false],
      ['work-unlabeled', true],
      ['work-idle-no-container', true],
    ]
  );

  const tasks = [
    { id: 'task-a', containerName: 'work-a' },
    { id: 'task-b', containerName: 'work-b' },
    { id: 'task-c', containerName: 'work-c' },
    { id: 'task-idle', containerName: 'work-idle-no-container' },
  ];
  const plan = planStartupReconciliation(tasks, containers);

  // Only running containers of known tasks are stopped; the task with no
  // container at all needs zero docker calls.
  assert.deepEqual(plan.stop.map(task => task.id).sort(), ['task-a', 'task-c']);
  // Ownership is by task label alone: an unknown or missing label makes the
  // managed container an orphan, running or not — including a name that
  // matches a known task, which the ownership assertion would refuse anyway.
  assert.deepEqual(plan.removeOrphans.map(c => c.name).sort(), [
    'work-ghost',
    'work-idle-no-container',
    'work-stale',
    'work-unlabeled',
  ]);
  assert.equal(plan.atRest, 1);

  // A restored-database scenario: no task rows, leftover containers are all
  // orphans and an empty inventory plans no task stops.
  const restorePlan = planStartupReconciliation([], containers);
  assert.equal(restorePlan.stop.length, 0);
  assert.equal(restorePlan.removeOrphans.length, containers.length);
});
