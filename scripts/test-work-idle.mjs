import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// Must be set before the dist modules load: the runtime config is read once
// at import time.
process.env.WORK_RUNTIME_IDLE_TIMEOUT_MS = '60000';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-idle-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const databaseModule = await import(
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', 'db.js')).href
);
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);
const sharedModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeShared.js')
  ).href
);
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

const { WorkRuntimeService, WORK_RUNTIME_DEFAULTS } = runtimeModule;
const IDLE_MS = 60_000;

test.after(async () => {
  await closeWorkPlatform();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const db = databaseModule.getDatabase();
const now = Date.now();
db.prepare(
  `INSERT INTO users (
    id, username, email, password_hash, role, created_at, updated_at
  ) VALUES ('idle-user', 'idle-user', 'i@example.invalid', 'x', 'admin', ?, ?)`
).run(now, now);

const makeTask = id => {
  const task = {
    id,
    userId: 'idle-user',
    title: `task ${id}`,
    model: 'test',
    status: 'idle',
    networkEnabled: true,
    volumeName: `vol-${id}`,
    containerName: `ctr-${id}`,
    previewStatus: 'stopped',
    createdAt: now,
    updatedAt: now,
  };
  db.prepare(
    `INSERT INTO work_tasks (
      id, user_id, title, model, volume_name, container_name,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    task.userId,
    task.title,
    task.model,
    task.volumeName,
    task.containerName,
    now,
    now
  );
  return task;
};

const stubDocker = (service, task, calls) => {
  service.driver.docker = async args => {
    calls.push(args);
    if (args[0] === 'ps') {
      return {
        exitCode: 0,
        stdout: `${task.containerName}\trunning\t${task.id}\n`,
        stderr: '',
        truncated: false,
      };
    }
    if (args[0] === 'inspect' || args[0] === 'container') {
      return {
        exitCode: 0,
        stdout: `${task.id}\n`,
        stderr: '',
        truncated: false,
      };
    }
    return { exitCode: 0, stdout: '', stderr: '', truncated: false };
  };
};

test('the idle sweep defaults to thirty minutes and is off while recovering', async () => {
  assert.equal(WORK_RUNTIME_DEFAULTS.idleTimeoutMs, 30 * 60_000);
  assert.equal(sharedModule.workRuntimeConfig.idleTimeoutMs, IDLE_MS);

  const service = new WorkRuntimeService();
  service.recoveryTasks.set('anything', {});
  const swept = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(swept, { stopped: 0 });
  service.beginShutdown();
});

test('an external-worker HTTP replica never owns the global idle sweep', async () => {
  const previousRole = process.env.LIBRE_PROCESS_ROLE;
  process.env.LIBRE_PROCESS_ROLE = 'app-external';
  const service = new WorkRuntimeService();
  let listed = 0;
  service.driver.listManaged = async () => {
    listed += 1;
    return [];
  };
  try {
    assert.equal(service.idleTimer, undefined);
    assert.deepEqual(
      await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10),
      { stopped: 0 }
    );
    assert.equal(
      listed,
      0,
      'an app replica must not inspect or stop worker-owned sandboxes'
    );
  } finally {
    service.beginShutdown();
    if (previousRole === undefined) delete process.env.LIBRE_PROCESS_ROLE;
    else process.env.LIBRE_PROCESS_ROLE = previousRole;
  }
});

test('a first-seen running sandbox starts its clock instead of stopping', async () => {
  const task = makeTask('idle-fresh');
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  const first = await service.sweepIdleRuntimes(now + IDLE_MS * 10);
  assert.deepEqual(first, { stopped: 0 });
  assert.ok(!calls.some(args => args[0] === 'stop'));

  // The primed clock now ages past the timeout: the sandbox is stopped.
  const second = await service.sweepIdleRuntimes(Date.now() + IDLE_MS + 1);
  assert.deepEqual(second, { stopped: 1 });
  assert.ok(
    calls.some(args => args[0] === 'stop' && args.includes(task.containerName))
  );
  service.beginShutdown();
});

test('busy sandboxes refresh their clock and are never stopped', async () => {
  const task = makeTask('idle-busy');
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  service.noteTaskActivity(task.id);
  service.activeCommands.add(task.id);
  const command = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(command, { stopped: 0 });
  service.activeCommands.delete(task.id);

  service.terminalHolds.set(task.id, 1);
  const terminal = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(terminal, { stopped: 0 });
  service.terminalHolds.delete(task.id);

  // A non-preview operation lease means work is in flight.
  service.runtimeLeases.set(task.id, { userId: task.userId, holders: 1 });
  const leased = await service.sweepIdleRuntimes(Date.now() + IDLE_MS * 10);
  assert.deepEqual(leased, { stopped: 0 });
  service.runtimeLeases.delete(task.id);

  assert.ok(!calls.some(args => args[0] === 'stop'));
  service.beginShutdown();
});

test('an idle preview is stopped through the preview path', async () => {
  const task = makeTask('idle-preview');
  db.prepare(
    `UPDATE work_tasks SET preview_status = 'running' WHERE id = ?`
  ).run(task.id);
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);

  // Simulate a held preview lease well past the idle deadline.
  service.runtimeLeases.set(task.id, { userId: task.userId, holders: 1 });
  service.previewLeaseReleases.set(task.id, () => {});
  const previewStops = [];
  service.stopPreviewPrepared = async candidate => {
    previewStops.push(candidate.id);
  };

  service.noteTaskActivity(task.id);
  const swept = await service.sweepIdleRuntimes(Date.now() + IDLE_MS + 1);
  assert.deepEqual(swept, { stopped: 1 });
  assert.deepEqual(previewStops, [task.id]);
  const row = db
    .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
    .get(task.id);
  assert.equal(row.preview_status, 'stopped');
  // The container itself was not force-stopped behind the preview's back.
  assert.ok(!calls.some(args => args[0] === 'stop'));
  service.beginShutdown();
});

test('a preview whose container is gone is marked stopped without idle-stop', async () => {
  const task = makeTask('stale-preview-absent');
  db.prepare(
    `UPDATE work_tasks SET preview_status = 'running' WHERE id = ?`
  ).run(task.id);
  const service = new WorkRuntimeService();
  const calls = [];
  // No labeled container exists any more: `docker ps` lists nothing.
  service.driver.docker = async args => {
    calls.push(args);
    return {
      exitCode: args[0] === 'container' ? 1 : 0,
      stdout: '',
      stderr: args[0] === 'container' ? 'No such container' : '',
      truncated: false,
    };
  };
  // No activity was ever noted and no lease is held: the idle sweep has
  // nothing to say, and this must not depend on it.
  const swept = await service.reconcileStalePreviews();
  assert.deepEqual(swept, { stopped: 1 });
  const row = db
    .prepare('SELECT preview_status, preview_url FROM work_tasks WHERE id = ?')
    .get(task.id);
  assert.equal(row.preview_status, 'stopped');
  assert.equal(row.preview_url, null);
  assert.ok(!calls.some(args => args[0] === 'stop'));
  // A second pass finds nothing left to do.
  assert.deepEqual(await service.reconcileStalePreviews(), { stopped: 0 });
  service.beginShutdown();
});

test('a running container with a dead preview process is reconciled, a held one is not', async () => {
  const held = makeTask('stale-preview-held');
  const dead = makeTask('stale-preview-dead');
  for (const task of [held, dead]) {
    db.prepare(
      `UPDATE work_tasks SET preview_status = 'running' WHERE id = ?`
    ).run(task.id);
  }
  const service = new WorkRuntimeService();
  service.driver.docker = async args => {
    if (args[0] === 'ps') {
      return {
        exitCode: 0,
        stdout: [held, dead]
          .map(task => `${task.containerName}\trunning\t${task.id}`)
          .join('\n'),
        stderr: '',
        truncated: false,
      };
    }
    return {
      exitCode: 0,
      stdout:
        args[0] === 'inspect'
          ? ([held, dead].find(task => task.containerName === args.at(-1))
              ?.id ?? '')
          : '',
      stderr: '',
      truncated: false,
    };
  };
  const probed = [];
  service.previewProcessCheckWithLock = async task => {
    probed.push(task.id);
    return 'dead';
  };
  // Someone is watching the first task's screen: it is in use, not stale.
  service.screenHolds.set(held.id, 1);

  const swept = await service.reconcileStalePreviews();
  assert.deepEqual(swept, { stopped: 1 });
  assert.deepEqual(probed, [dead.id]);
  const statuses = Object.fromEntries(
    [held, dead].map(task => [
      task.id,
      db
        .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
        .get(task.id).preview_status,
    ])
  );
  assert.equal(statuses[held.id], 'running');
  assert.equal(statuses[dead.id], 'stopped');
  service.beginShutdown();
  // Release the row for the next case, which runs a fresh service.
  db.prepare(
    `UPDATE work_tasks SET preview_status = 'stopped' WHERE id = ?`
  ).run(held.id);
});

test('usage recorded outside process memory keeps another process from reconciling a task', async () => {
  const usageModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workUsageService.js')
    ).href
  );
  const { workUsageService, decodeUsageMember, encodeUsageMember } =
    usageModule;
  // A separator inside the user id is sanitized so the member stays parseable.
  assert.equal(
    decodeUsageMember(
      encodeUsageMember({ kind: 'screen', userId: 'u|1', since: 42 }, 'p1')
    )?.userId,
    'u_1'
  );
  const decoded = decodeUsageMember(
    encodeUsageMember(
      { kind: 'terminal', userId: 'user-1', since: 42 },
      'proc-1'
    )
  );
  assert.deepEqual(decoded && { ...decoded, member: undefined }, {
    kind: 'terminal',
    userId: 'user-1',
    since: 42,
    member: undefined,
  });
  assert.equal(decodeUsageMember('bogus'), null);

  const task = makeTask('stale-preview-in-use');
  db.prepare(
    `UPDATE work_tasks SET preview_status = 'running' WHERE id = ?`
  ).run(task.id);
  // Another process holds a terminal on this task: only the registry knows.
  const release = await workUsageService.begin(
    task.id,
    'terminal',
    task.userId
  );
  assert.deepEqual(
    (await workUsageService.list(task.id)).map(entry => entry.kind),
    ['terminal']
  );
  const service = new WorkRuntimeService();
  service.driver.docker = async args => ({
    exitCode: args[0] === 'container' ? 1 : 0,
    stdout: '',
    stderr: args[0] === 'container' ? 'No such container' : '',
    truncated: false,
  });
  assert.deepEqual(await service.reconcileStalePreviews(), { stopped: 0 });
  release();
  assert.deepEqual(await workUsageService.list(task.id), []);
  assert.deepEqual(await service.reconcileStalePreviews(), { stopped: 1 });
  service.beginShutdown();
});

test('a finished task needs an explicit reopen before its preview or screen starts', async () => {
  const taskModule = await import(
    pathToFileURL(
      path.join(repoRoot, 'backend', 'dist', 'services', 'workTaskService.js')
    ).href
  );
  const { default: workTaskService, WorkConflictError } = taskModule;
  const task = makeTask('finished-reopen');
  db.prepare(`UPDATE work_tasks SET status = 'completed' WHERE id = ?`).run(
    task.id
  );
  await assert.rejects(
    workTaskService.requireStartableTaskRecord(task.id, task.userId),
    error =>
      error instanceof WorkConflictError && error.code === 'WORK_TASK_FINISHED'
  );
  const reopened = await workTaskService.requireStartableTaskRecord(
    task.id,
    task.userId,
    { reopen: true }
  );
  assert.equal(reopened.status, 'idle');
  assert.equal(
    db.prepare('SELECT status FROM work_tasks WHERE id = ?').get(task.id)
      .status,
    'idle'
  );
  // An idle task passes straight through.
  const again = await workTaskService.requireStartableTaskRecord(
    task.id,
    task.userId
  );
  assert.equal(again.status, 'idle');
});

test('a preview still starting gets a grace period before it counts as stale', async () => {
  const fresh = makeTask('stale-preview-starting');
  db.prepare(
    `UPDATE work_tasks SET preview_status = 'starting', updated_at = ? WHERE id = ?`
  ).run(Date.now(), fresh.id);
  const service = new WorkRuntimeService();
  service.driver.docker = async args => ({
    exitCode: args[0] === 'container' ? 1 : 0,
    stdout: '',
    stderr: args[0] === 'container' ? 'No such container' : '',
    truncated: false,
  });
  assert.deepEqual(await service.reconcileStalePreviews(), { stopped: 0 });
  assert.equal(
    db
      .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
      .get(fresh.id).preview_status,
    'starting'
  );
  // Ten minutes later nothing came up: the row is abandoned.
  const later = await service.reconcileStalePreviews(Date.now() + 10 * 60_000);
  assert.deepEqual(later, { stopped: 1 });
  assert.equal(
    db
      .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
      .get(fresh.id).preview_status,
    'stopped'
  );
  service.beginShutdown();
});

test('preview traffic through the signed proxy refreshes the idle clock', async () => {
  const proxyModule = await import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'services',
        'workPreviewProxyService.js'
      )
    ).href
  );
  const activity = [];
  const service = new proxyModule.WorkPreviewProxyService(
    'idle-test-secret',
    taskId =>
      taskId === taskRecordId
        ? {
            preview_status: 'running',
            preview_url: previewPath,
            preview_upstream_host: '127.0.0.1',
            preview_upstream_port: 4173,
          }
        : undefined
  );
  service.onPreviewActivity(taskId => activity.push(taskId));
  const taskRecordId = '9af1c9e2-58c8-4f6e-a9d1-2b7c40de9b12';
  const previewPath = service.createPreviewUrl(taskRecordId, 4173);

  // Resolving an authorized target is the activity signal.
  const target = await service.parseTarget(`${previewPath}index.html`);
  assert.ok(target);
  assert.deepEqual(activity, [taskRecordId]);

  // A tampered signature resolves to nothing and records no activity.
  const tampered = previewPath.replace(/.\/$/, 'x/');
  assert.equal(await service.parseTarget(`${tampered}index.html`), undefined);
  assert.deepEqual(activity, [taskRecordId]);
});

// Exercise team runtime coordination with the real local coordinator and test
// SQL adapters. Separate service instances model the app owner and worker;
// Docker and network services remain deterministic stubs.
const coordinationModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'platform',
      'coordination',
      'service.js'
    )
  ).href
);
const usageModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workUsageService.js')
  ).href
);

const withTeamRuntime = async operation => {
  const config = coordinationModule.getPlatformRuntimeConfig();
  const previousMode = config.mode;
  const previousRole = process.env.LIBRE_PROCESS_ROLE;
  const services = [];
  const previousTasks = new Set(
    db
      .prepare('SELECT id FROM work_tasks')
      .all()
      .map(row => row.id)
  );
  config.mode = 'team';
  const create = role => {
    process.env.LIBRE_PROCESS_ROLE = role;
    const service = new WorkRuntimeService();
    services.push(service);
    return service;
  };
  try {
    await operation(create, coordinationModule.getCoordinator());
  } finally {
    for (const service of services) service.beginShutdown();
    await Promise.all(
      services.flatMap(service => [...service.runtimePresenceTails.values()])
    );
    for (const row of db.prepare('SELECT id FROM work_tasks').all()) {
      if (!previousTasks.has(row.id)) {
        db.prepare(
          "UPDATE work_tasks SET preview_status = 'stopped' WHERE id = ?"
        ).run(row.id);
      }
    }
    config.mode = previousMode;
    if (previousRole === undefined) delete process.env.LIBRE_PROCESS_ROLE;
    else process.env.LIBRE_PROCESS_ROLE = previousRole;
  }
};

const holdPreview = async (service, task) => {
  db.prepare(
    "UPDATE work_tasks SET preview_status = 'running' WHERE id = ?"
  ).run(task.id);
  const release = await service.acquireRuntimeLease(task);
  service.previewLeaseReleases.set(task.id, release);
  service.previewUsageReleases.set(
    task.id,
    await usageModule.workUsageService.begin(task.id, 'preview', task.userId)
  );
  const lease = service.runtimeLeases.get(task.id);
  await service.refreshRuntimePresence(task, lease);
  return lease;
};

test('the team worker expires an app-owned idle preview and its owner releases capacity', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-idle-preview');
    const owner = create('app-external');
    const lease = await holdPreview(owner, task);
    const worker = create('external-worker');
    const calls = [];
    stubDocker(worker, task, calls);
    await coordinator.setCache(
      `work-task-activity:${task.id}`,
      Date.now() - IDLE_MS - 1,
      86_400_000
    );
    assert.deepEqual(
      await coordinator.listPresence(`work-task-active:${task.id}`),
      [`${owner.activityMemberId}:preview-only`]
    );
    assert.deepEqual(
      (await usageModule.workUsageService.list(task.id)).map(
        entry => entry.kind
      ),
      ['preview']
    );
    assert.deepEqual(await worker.sweepIdleRuntimes(), { stopped: 1 });
    assert.ok(calls.some(args => args[0] === 'stop'));
    assert.equal(
      db
        .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
        .get(task.id).preview_status,
      'stopped'
    );
    await owner.refreshRuntimePresence(task, lease, true);
    await lease.presenceTail;
    assert.equal(owner.runtimeLeases.has(task.id), false);
    assert.equal(owner.previewLeaseReleases.has(task.id), false);
    assert.deepEqual(
      await coordinator.listPresence(`work-task-active:${task.id}`),
      []
    );
    assert.deepEqual(await usageModule.workUsageService.list(task.id), []);
    const acquired = await coordinator.acquireLease(
      `work-task-runtime:${task.id}`,
      60_000
    );
    assert.ok(acquired, 'worker cleanup must free distributed ownership');
    await acquired.release();
  });
});

test('team idle cleanup protects active runs, viewers, usage and unknown members alongside a preview', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-preview-protected');
    const owner = create('app-external');
    const lease = await holdPreview(owner, task);
    const worker = create('external-worker');
    const calls = [];
    stubDocker(worker, task, calls);
    const expire = () =>
      coordinator.setCache(
        `work-task-activity:${task.id}`,
        Date.now() - IDLE_MS - 1,
        86_400_000
      );
    const releaseRun = await owner.acquireRuntimeLease(task);
    assert.equal(lease.holders, 2);
    assert.deepEqual(
      await coordinator.listPresence(`work-task-active:${task.id}`),
      [owner.activityMemberId]
    );
    await expire();
    assert.deepEqual(await worker.sweepIdleRuntimes(), { stopped: 0 });
    assert.equal(owner.hasLocalRuntimeActivity(task.id), true);
    releaseRun();
    await owner.refreshRuntimePresence(task, lease);
    for (const member of [
      `${owner.activityMemberId}:viewer`,
      'legacy-foreign-runtime',
      'unknown:preview-only',
    ]) {
      await coordinator.setPresence(
        `work-task-active:${task.id}`,
        member,
        30_000
      );
      await expire();
      assert.deepEqual(
        await worker.sweepIdleRuntimes(),
        { stopped: 0 },
        member
      );
      await coordinator.clearPresence(`work-task-active:${task.id}`, member);
    }
    for (const kind of ['command', 'screen', 'terminal']) {
      const release = await usageModule.workUsageService.begin(
        task.id,
        kind,
        task.userId
      );
      await expire();
      assert.deepEqual(await worker.sweepIdleRuntimes(), { stopped: 0 }, kind);
      release();
    }
    assert.ok(!calls.some(args => args[0] === 'stop'));
    // A persisted stop only releases the preview holder, never a concurrent run.
    const releaseAnotherRun = await owner.acquireRuntimeLease(task);
    db.prepare(
      "UPDATE work_tasks SET preview_status = 'stopped' WHERE id = ?"
    ).run(task.id);
    await owner.refreshRuntimePresence(task, lease, true);
    assert.equal(lease.holders, 1);
    assert.equal(owner.runtimeLeases.get(task.id), lease);
    assert.deepEqual(
      await coordinator.listPresence(`work-task-active:${task.id}`),
      [owner.activityMemberId]
    );
    releaseAnotherRun();
  });
});

test('the idle sweep rechecks a hold acquired while it waits for the lifecycle lock', async () => {
  const task = makeTask('idle-lifecycle-race');
  const service = new WorkRuntimeService();
  const calls = [];
  stubDocker(service, task, calls);
  service.taskActivity.set(task.id, Date.now() - IDLE_MS - 1);
  const lock = service.withLifecycleLock.bind(service);
  service.withLifecycleLock = async (...args) => {
    service.screenHolds.set(task.id, 1);
    return lock(...args);
  };
  assert.deepEqual(await service.sweepIdleRuntimes(), { stopped: 0 });
  assert.ok(!calls.some(args => args[0] === 'stop'));
  service.beginShutdown();
});

test('delayed old presence cleanup cannot erase a new runtime generation', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-presence-generation');
    const service = create('app-external');
    const release = await service.acquireRuntimeLease(task);
    let unblock;
    const blocked = new Promise(resolve => {
      unblock = resolve;
    });
    let entered;
    const clearing = new Promise(resolve => {
      entered = resolve;
    });
    const originalClear = coordinator.clearPresence.bind(coordinator);
    let delayed = false;
    coordinator.clearPresence = async (scope, member) => {
      if (
        !delayed &&
        scope === `work-task-active:${task.id}` &&
        member === service.activityMemberId
      ) {
        delayed = true;
        entered();
        await blocked;
      }
      return originalClear(scope, member);
    };
    try {
      release();
      await clearing;
      const next = service.acquireRuntimeLease(task);
      unblock();
      const releaseNext = await next;
      assert.deepEqual(
        await coordinator.listPresence(`work-task-active:${task.id}`),
        [service.activityMemberId]
      );
      releaseNext();
      await Promise.all([...service.runtimePresenceTails.values()]);
    } finally {
      unblock();
      coordinator.clearPresence = originalClear;
    }
  });
});

test('failed preview presence publication rolls back its registered holder', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-preview-publish-failed');
    const service = create('app-external');
    service.ensureImage = async () => {};
    service.prepareWithLock = async () => {};
    service.startPreviewPrepared = async () => ({
      url: '/preview',
      endpoint: { host: '127.0.0.1', port: 4173 },
    });
    service.driver.stopRuntime = async () => {};
    const originalSet = coordinator.setPresence.bind(coordinator);
    coordinator.setPresence = async (scope, member, ttl) => {
      if (member.endsWith(':preview-only'))
        throw new Error('publication unavailable');
      return originalSet(scope, member, ttl);
    };
    try {
      await assert.rejects(
        service.startPreview(task, 'npm run dev', {
          onRunning: () => {
            db.prepare(
              "UPDATE work_tasks SET preview_status = 'running' WHERE id = ?"
            ).run(task.id);
          },
        }),
        /publication unavailable/
      );
      assert.equal(service.previewLeaseReleases.has(task.id), false);
      assert.equal(service.previewUsageReleases.has(task.id), false);
      assert.equal(service.runtimeLeases.has(task.id), false);
      const release = await service.acquireRuntimeLease(task);
      assert.equal(service.hasLocalRuntimeActivity(task.id), true);
      assert.deepEqual(
        await coordinator.listPresence(`work-task-active:${task.id}`),
        [service.activityMemberId]
      );
      release();
    } finally {
      coordinator.setPresence = originalSet;
    }
  });
});

test('stale reconciliation rechecks a run that acquires ownership before its lifecycle lock', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-reconcile-race');
    const owner = create('app-external');
    await holdPreview(owner, task);
    const worker = create('external-worker');
    const calls = [];
    stubDocker(worker, task, calls);
    let releaseRun;
    const lock = worker.withLifecycleLock.bind(worker);
    worker.withLifecycleLock = async (...args) => {
      releaseRun = await owner.acquireRuntimeLease(task);
      return lock(...args);
    };
    worker.previewProcessCheckWithLock = async () => {
      throw new Error('must not probe an active run');
    };
    assert.deepEqual(await worker.reconcileStalePreviews(), { stopped: 0 });
    assert.ok(releaseRun);
    assert.equal(
      db
        .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
        .get(task.id).preview_status,
      'running'
    );
    assert.ok(!calls.some(args => args[0] === 'stop'));
    releaseRun();
  });
});

test('a remote Files helper holds the lifecycle while using an idle preview', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-files-idle-preview');
    const owner = create('app-external');
    await holdPreview(owner, task);
    const helper = create('app-external');
    const worker = create('external-worker');
    const calls = [];
    stubDocker(worker, task, calls);
    helper.driver.runtimeState = async () => 'running';
    await coordinator.setCache(
      `work-task-activity:${task.id}`,
      Date.now() - IDLE_MS - 1,
      86_400_000
    );
    const result = await helper.withWorkspaceHelperContainer(task, async () => {
      assert.ok(
        (
          await coordinator.listPresence(`work-task-active:${task.id}`)
        ).includes(`${helper.activityMemberId}:viewer`)
      );
      assert.deepEqual(await worker.sweepIdleRuntimes(), { stopped: 0 });
      const lease = await coordinator.acquireLease(
        `work-task-lifecycle:${task.id}`,
        60_000
      );
      assert.equal(lease, null, 'helper must serialize use with idle stop');
      return 'files';
    });
    assert.equal(result, 'files');
    assert.ok(!calls.some(args => args[0] === 'stop'));
  });
});

test('failed preview publication never rolls back a newly acquired operation holder', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const task = makeTask('team-preview-rollback-race');
    const service = create('app-external');
    service.ensureImage = async () => {};
    service.prepareWithLock = async () => {};
    service.startPreviewPrepared = async () => ({
      url: '/preview',
      endpoint: { host: '127.0.0.1', port: 4173 },
    });
    let stopped = 0;
    service.driver.stopRuntime = async () => {
      stopped += 1;
    };
    const originalSet = coordinator.setPresence.bind(coordinator);
    const originalRefresh = service.refreshRuntimePresence.bind(service);
    let registered;
    const holderRegistered = new Promise(resolve => {
      registered = resolve;
    });
    let nextHolder;
    service.refreshRuntimePresence = (...args) => {
      if (args[1].holders === 2) registered();
      return originalRefresh(...args);
    };
    coordinator.setPresence = async (scope, member, ttl) => {
      if (member.endsWith(':preview-only')) {
        nextHolder = service.acquireRuntimeLease(task);
        await holderRegistered;
        throw new Error('publication unavailable');
      }
      return originalSet(scope, member, ttl);
    };
    try {
      await assert.rejects(
        service.startPreview(task, 'npm run dev', {
          onRunning: () => {
            db.prepare(
              "UPDATE work_tasks SET preview_status = 'running' WHERE id = ?"
            ).run(task.id);
          },
        }),
        /publication unavailable/
      );
      const release = await nextHolder;
      assert.equal(
        stopped,
        0,
        'rollback must preserve the new operation holder'
      );
      assert.equal(service.runtimeLeases.get(task.id).holders, 1);
      assert.equal(service.previewLeaseReleases.has(task.id), false);
      assert.deepEqual(
        await coordinator.listPresence(`work-task-active:${task.id}`),
        [service.activityMemberId]
      );
      release();
    } finally {
      coordinator.setPresence = originalSet;
    }
  });
});

test('stale reconciliation retries a stopped preview after its first SQL update fails', async () => {
  await withTeamRuntime(async (create, coordinator) => {
    const persistenceModule = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'backend',
          'dist',
          'platform',
          'workPersistence',
          'index.js'
        )
      ).href
    );
    const persistence = persistenceModule.getWorkPersistence();
    const task = makeTask('team-preview-state-retry');
    const owner = create('app-external');
    const lease = await holdPreview(owner, task);
    const worker = create('external-worker');
    const calls = [];
    stubDocker(worker, task, calls);
    await coordinator.setCache(
      `work-task-activity:${task.id}`,
      Date.now() - IDLE_MS - 1,
      86_400_000
    );
    const originalUpdate = persistence.updatePreview.bind(persistence);
    let failed = false;
    persistence.updatePreview = async (...args) => {
      if (!failed && args[0] === task.id) {
        failed = true;
        throw new Error('temporary SQL outage');
      }
      return originalUpdate(...args);
    };
    try {
      assert.deepEqual(await worker.sweepIdleRuntimes(), { stopped: 1 });
      assert.equal(
        db
          .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
          .get(task.id).preview_status,
        'running'
      );
      worker.previewProcessCheckWithLock = async () => 'absent';
      assert.deepEqual(await worker.reconcileStalePreviews(), { stopped: 1 });
      assert.equal(
        db
          .prepare('SELECT preview_status FROM work_tasks WHERE id = ?')
          .get(task.id).preview_status,
        'stopped'
      );
      await owner.refreshRuntimePresence(task, lease, true);
      await lease.presenceTail;
      assert.equal(owner.runtimeLeases.has(task.id), false);
    } finally {
      persistence.updatePreview = originalUpdate;
    }
  });
});

test('a delayed stopped snapshot during preview restart cannot release the restarted preview', async () => {
  await withTeamRuntime(async create => {
    const persistenceModule = await import(
      pathToFileURL(
        path.join(
          repoRoot,
          'backend',
          'dist',
          'platform',
          'workPersistence',
          'index.js'
        )
      ).href
    );
    const persistence = persistenceModule.getWorkPersistence();
    const task = makeTask('team-preview-restart-snapshot');
    const owner = create('app-external');
    const lease = await holdPreview(owner, task);
    const retainedRelease = owner.previewLeaseReleases.get(task.id);
    db.prepare(
      "UPDATE work_tasks SET preview_status = 'stopped' WHERE id = ?"
    ).run(task.id);
    const stoppedRow = await persistence.findTask(task.id, task.userId);
    const originalFind = persistence.findTask.bind(persistence);
    let reading;
    const readStarted = new Promise(resolve => {
      reading = resolve;
    });
    let deliver;
    const delayedRead = new Promise(resolve => {
      deliver = resolve;
    });
    let heartbeat;
    let delayed = false;
    persistence.findTask = async (...args) => {
      if (!delayed && args[0] === task.id) {
        delayed = true;
        reading();
        await delayedRead;
        return stoppedRow;
      }
      return originalFind(...args);
    };
    owner.ensureImage = async () => {};
    owner.prepareWithLock = async () => {};
    owner.startPreviewPrepared = async () => ({
      url: '/restarted',
      endpoint: { host: '127.0.0.1', port: 4173 },
    });
    try {
      assert.equal(
        await owner.startPreview(task, 'npm run dev', {
          onStarting: async () => {
            heartbeat = owner.refreshRuntimePresence(task, lease, true);
            await readStarted;
          },
          onRunning: () => {
            db.prepare(
              "UPDATE work_tasks SET preview_status = 'running' WHERE id = ?"
            ).run(task.id);
            setImmediate(deliver);
          },
        }),
        '/restarted'
      );
      await heartbeat;
      assert.equal(owner.runtimeLeases.get(task.id), lease);
      assert.equal(lease.holders, 1);
      assert.equal(owner.previewLeaseReleases.get(task.id), retainedRelease);
    } finally {
      deliver();
      persistence.findTask = originalFind;
    }
  });
});
