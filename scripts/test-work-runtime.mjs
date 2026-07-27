import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);

const {
  PREVIEW_TARGET_SCRIPT,
  STATIC_PREVIEW_SERVER_SCRIPT,
  WORK_RUNTIME_ADMISSION_DEFAULTS,
  WORK_RUNTIME_DEFAULTS,
  WorkRuntimeService,
  buildWorkContainerRunArgs,
  parsePublishedPort,
  validateWorkspacePath,
} = runtimeModule;

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
  });
  assert.match(WORK_RUNTIME_DEFAULTS.image, /@sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(WORK_RUNTIME_DEFAULTS.image, /:latest(?:@|$)/);
  assert.deepEqual(WORK_RUNTIME_ADMISSION_DEFAULTS, {
    maxActiveRuntimesGlobal: 2,
    maxActiveRuntimesPerUser: 1,
  });
});

test('network-disabled containers use a non-root, least-privilege policy', () => {
  const image = 'example.invalid/work-runtime@sha256:test-only';
  const args = buildWorkContainerRunArgs(task, image);

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
    'example.invalid/work-runtime@sha256:test-only'
  );

  assert.equal(optionValue(args, '--network'), 'bridge');
  assert.equal(
    optionValue(args, '--publish'),
    `127.0.0.1::${WORK_RUNTIME_DEFAULTS.previewPort}`
  );
  assert.doesNotMatch(optionValue(args, '--publish'), /^0\.0\.0\.0:/);
  assert.doesNotMatch(optionValue(args, '--publish'), /^\d+:/);
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
    service.withLifecycleLock = async (_taskId, operation) => operation();
    service.docker = async args => {
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
    assert.equal(previewUrl, 'http://127.0.0.1:49173');
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
  service.withLifecycleLock = async (_taskId, operation) => operation();
  service.stopContainerWithLock = async () => {
    cleanupCalls += 1;
  };
  service.docker = async args => {
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
  const db = databaseModule.getDatabase();
  const userId = 'retirement-gate-user';
  const now = Date.now();

  t.after(() => {
    databaseModule.closeDatabase();
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

  const created = service.createTaskWithRun(
    userId,
    'Build a retirement gate',
    'local-tools-model',
    false
  );
  assert.equal(created.providerType, 'ollama');
  assert.equal(created.providerId, undefined);
  assert.equal(created.activeRun.providerType, 'ollama');
  assert.equal(created.activeRun.providerId, undefined);
  service.updateRun(created.activeRun.id, 'completed', { finished: true });
  service.updateTaskStatus(created.id, 'completed');

  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(userId);
  assert.throws(
    () =>
      service.updateTask(created.id, userId, { title: 'Stale admin write' }),
    error => error?.status === 403 && /Admin access/.test(error.message)
  );
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);

  const previewUrl = 'http://127.0.0.1:49173';
  service.updatePreview(created.id, 'running', previewUrl);
  const policyTask = service.beginNetworkPolicyChange(created.id, userId);
  assert.equal(policyTask.networkEnabled, false);
  assert.throws(
    () =>
      service.createRun(
        created.id,
        userId,
        'This must not start during a network transition.'
      ),
    error => error?.status === 409 && /network policy/.test(error.message)
  );
  assert.throws(
    () => service.beginTaskRetirement(created.id, userId),
    error => error?.status === 409 && /network policy/.test(error.message)
  );
  service.commitNetworkChange(created.id, userId, {
    title: 'Network transition serialized',
    networkEnabled: false,
  });
  service.releaseNetworkPolicyChange(created.id);
  const unchangedNetwork = service.requireTaskDetail(created.id, userId);
  assert.equal(unchangedNetwork.previewStatus, 'running');
  assert.equal(unchangedNetwork.previewUrl, previewUrl);

  service.beginNetworkPolicyChange(created.id, userId);
  service.commitNetworkChange(created.id, userId, {
    networkEnabled: true,
  });
  service.releaseNetworkPolicyChange(created.id);
  const changedNetwork = service.requireTaskDetail(created.id, userId);
  assert.equal(changedNetwork.networkEnabled, true);
  assert.equal(changedNetwork.previewStatus, 'stopped');
  assert.equal(changedNetwork.previewUrl, undefined);

  service.beginTaskRetirement(created.id, userId);
  assert.throws(
    () =>
      service.createRun(
        created.id,
        userId,
        'This must not be inserted during deletion.'
      ),
    error => error?.status === 409 && /being deleted/.test(error.message)
  );
  assert.throws(
    () => service.updateTask(created.id, userId, { title: 'Race won' }),
    error => error?.status === 409 && /being deleted/.test(error.message)
  );
  assert.throws(
    () => service.assertTaskMutationAllowed(created.id, userId),
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
    service.updateTask(created.id, userId, { title: 'Retry remains possible' })
      .title,
    'Retry remains possible'
  );

  const insertAdmin = id => {
    db.prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'admin', ?, ?)`
    ).run(
      id,
      id,
      `${id}@example.invalid`,
      'not-a-real-hash',
      now,
      now
    );
  };
  const capacityUserTwo = 'capacity-user-two';
  const capacityUserThree = 'capacity-user-three';
  insertAdmin(capacityUserTwo);
  insertAdmin(capacityUserThree);

  const capacityTaskOne = service.createTaskWithRun(
    userId,
    'Occupy the per-user Work runtime slot',
    'local-tools-model',
    false
  );
  assert.throws(
    () =>
      service.createTaskWithRun(
        userId,
        'This second runtime must be rejected',
        'local-tools-model',
        false
      ),
    error =>
      error?.status === 429 && error?.code === 'WORK_USER_RUNTIME_LIMIT'
  );
  const capacityTaskTwo = service.createTaskWithRun(
    capacityUserTwo,
    'Occupy the global Work runtime slot',
    'local-tools-model',
    false
  );
  assert.throws(
    () =>
      service.createTaskWithRun(
        capacityUserThree,
        'This global runtime must be rejected',
        'local-tools-model',
        false
      ),
    error =>
      error?.status === 429 && error?.code === 'WORK_GLOBAL_RUNTIME_LIMIT'
  );
  for (const detail of [capacityTaskOne, capacityTaskTwo]) {
    service.updateRun(detail.activeRun.id, 'completed', { finished: true });
    service.updateTaskStatus(detail.id, 'completed');
  }
  const capacityTaskThree = service.createTaskWithRun(
    capacityUserThree,
    'Create a third idle task after capacity is released',
    'local-tools-model',
    false
  );
  service.updateRun(capacityTaskThree.activeRun.id, 'completed', {
    finished: true,
  });
  service.updateTaskStatus(capacityTaskThree.id, 'completed');

  for (let index = 0; index < 209; index += 1) {
    service.addMessage(
      created.id,
      created.activeRun.id,
      'assistant',
      'message',
      `conversation-${index}`
    );
  }
  for (let index = 0; index < 15; index += 1) {
    service.addMessage(
      created.id,
      created.activeRun.id,
      'tool',
      'tool_result',
      `tool-${index}`
    );
  }

  const detail = service.requireTaskDetail(created.id, userId);
  assert.equal(detail.messages.length, 200);
  assert.equal(detail.messages[0].messageIndex, 25);
  assert.equal(detail.messageCursor, 25);
  assert.equal(detail.hasMoreMessages, true);

  const older = service.getMessagePage(created.id, detail.messageCursor);
  assert.equal(older.messages.length, 25);
  assert.equal(older.messages[0].messageIndex, 0);
  assert.equal(older.messages.at(-1).messageIndex, 24);
  assert.equal(older.cursor, undefined);
  assert.equal(older.hasMore, false);

  const expectedContext = service
    .getMessages(created.id)
    .filter(
      message =>
        message.kind === 'message' &&
        (message.role === 'user' || message.role === 'assistant')
    )
    .slice(-30);
  assert.deepEqual(
    service
      .getRecentConversationMessages(created.id)
      .map(message => message.messageIndex),
    expectedContext.map(message => message.messageIndex)
  );

  const bounded = service.addMessage(
    created.id,
    created.activeRun.id,
    'assistant',
    'message',
    '🙂'.repeat(60_000)
  );
  assert.ok(Buffer.byteLength(bounded.content, 'utf8') <= 100_000);
  assert.match(bounded.content, /message truncated/);
  assert.ok(
    service
      .getRecentConversationMessages(created.id)
      .reduce(
        (bytes, message) => bytes + Buffer.byteLength(message.content, 'utf8'),
        0
      ) <= 256_000
  );

  const pluginTask = service.updateTask(created.id, userId, {
    model: 'shared-model',
    providerType: 'plugin',
    providerId: 'remote-collision',
  });
  assert.equal(pluginTask.providerType, 'plugin');
  assert.equal(pluginTask.providerId, 'remote-collision');
  const pluginRunTask = service.createRun(
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
  service.updateRun(pluginRunTask.activeRun.id, 'completed', {
    finished: true,
  });
  service.updateTaskStatus(created.id, 'completed');

  const capacityRuntime = new runtimeModule.WorkRuntimeService();
  capacityRuntime.ensureImage = async () => {};
  capacityRuntime.withLifecycleLock = async (_taskId, operation) =>
    operation();
  capacityRuntime.prepareWithLock = async () => {};
  const taskOneRecord = service.requireTaskRecord(
    capacityTaskOne.id,
    userId
  );
  const taskTwoRecord = service.requireTaskRecord(
    capacityTaskTwo.id,
    capacityUserTwo
  );
  const taskThreeRecord = service.requireTaskRecord(
    capacityTaskThree.id,
    capacityUserThree
  );

  const releaseUserSlot = await capacityRuntime.prepare(taskOneRecord);
  await assert.rejects(
    capacityRuntime.prepare(service.requireTaskRecord(created.id, userId)),
    error =>
      error?.status === 429 && error?.code === 'WORK_USER_RUNTIME_LIMIT'
  );
  releaseUserSlot();

  const releaseGlobalOne = await capacityRuntime.prepare(taskOneRecord);
  const releaseGlobalTwo = await capacityRuntime.prepare(taskTwoRecord);
  await assert.rejects(
    capacityRuntime.prepare(taskThreeRecord),
    error =>
      error?.status === 429 && error?.code === 'WORK_GLOBAL_RUNTIME_LIMIT'
  );
  releaseGlobalOne();
  releaseGlobalTwo();

  const missingDocker = async args => {
    const kind = args[0] === 'volume' ? 'volume' : 'container';
    return {
      exitCode: 1,
      stdout: '',
      stderr: `Error: No such ${kind}`,
      truncated: false,
    };
  };
  const recoveredRuntime = new runtimeModule.WorkRuntimeService();
  recoveredRuntime.isDockerAvailable = async () => true;
  recoveredRuntime.docker = missingDocker;
  const recovered = await recoveredRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(recovered, { stopped: 1, failed: 0 });
  assert.equal(recoveredRuntime.recoveryPending, false);
  assert.doesNotThrow(() => recoveredRuntime.assertAcceptingWork());

  const teardownRuntime = new runtimeModule.WorkRuntimeService();
  teardownRuntime.isDockerAvailable = async () => true;
  let stopFails = true;
  teardownRuntime.docker = async args => {
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
    error =>
      error?.status === 503 && error?.code === 'WORK_RUNTIME_RECOVERING'
  );
  stopFails = false;
  const retriedTeardown = await teardownRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(retriedTeardown, { stopped: 1, failed: 0 });
  assert.equal(teardownRuntime.recoveryPending, false);
  teardownRuntime.beginShutdown();

  const blockedRuntime = new runtimeModule.WorkRuntimeService();
  blockedRuntime.isDockerAvailable = async () => false;
  const blocked = await blockedRuntime.beginRecovery([taskOneRecord]);
  assert.deepEqual(blocked, { stopped: 0, failed: 1 });
  assert.equal(blockedRuntime.recoveryPending, true);
  assert.throws(
    () => blockedRuntime.assertAcceptingWork(),
    error =>
      error?.status === 503 && error?.code === 'WORK_RUNTIME_RECOVERING'
  );
  blockedRuntime.beginShutdown();

  const retiredTask = service.createTaskWithRun(
    userId,
    'Delete resources after an administrator is demoted',
    'local-tools-model',
    false
  );
  service.updateRun(retiredTask.activeRun.id, 'completed', { finished: true });
  service.updateTaskStatus(retiredTask.id, 'completed');
  const retiredRecord = service.requireTaskRecord(retiredTask.id, userId);
  db.prepare(`UPDATE users SET role = 'user' WHERE id = ?`).run(userId);

  const cleanupRuntime = new runtimeModule.WorkRuntimeService();
  cleanupRuntime.docker = missingDocker;
  await assert.rejects(
    cleanupRuntime.removeTask(retiredRecord),
    error => error?.status === 403 && error?.code === 'WORK_ACCESS_REVOKED'
  );
  await cleanupRuntime.removeTask(retiredRecord, true);
  cleanupRuntime.finalizeTaskRemoval(retiredRecord.id);
  service.deleteTask(retiredRecord.id, userId);
  db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(userId);
});
