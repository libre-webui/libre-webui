/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import NativeAgents from '@deepseek-ai/dsh-agent';
import NativeTools from '@deepseek-ai/dsh-tools';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

const execFile = promisify(execFileCallback);
const file = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(file), '..');
const resume = process.argv[2] === '--resume';
const dataDir = resume
  ? process.env.DATA_DIR
  : await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-work-'));
assert.ok(dataDir && path.basename(dataDir).startsWith('libre-cordis-work-'));
process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY = '0'.repeat(64);
process.env.LIBRE_CORDIS_ENABLED = 'true';
process.env.WORK_MAX_AGENT_ROUNDS = '6';
const dockerEnabled = process.env.CORDIS_WORK_DOCKER === '1';
if (dockerEnabled) process.env.WORK_RUNTIME_IMAGE ||= 'node:22.22-bookworm';
const load = name =>
  import(pathToFileURL(path.join(repoRoot, 'backend/dist', name)).href);
const [
  { getDatabase },
  { default: workAgentService },
  { default: workTaskService },
  { default: workRuntimeService },
  { default: workModelProviderService },
  { default: workEventService },
  { workApprovalService },
] = await Promise.all([
  load('db.js'),
  load('services/workAgentService.js'),
  load('services/workTaskService.js'),
  load('services/workRuntimeService.js'),
  load('services/workModelProviderService.js'),
  load('services/workEventService.js'),
  load('services/workApprovalService.js'),
]);
const closePlatform = await initializeWorkTestPlatform(repoRoot);
const provider = { providerType: 'plugin', providerId: 'cordis-work-fixture' };
const model = 'dsh:fixture-model';

function harness({ realRuntime = false } = {}) {
  const restorers = [];
  const state = {
    nativeSessions: [],
    registeredTools: [],
    prepared: [],
    released: [],
    stopped: [],
    writes: [],
    commands: [],
    lists: [],
  };
  const patch = (target, name, replacement) => {
    const own = Object.hasOwn(target, name);
    const original = target[name];
    target[name] = replacement;
    restorers.push(() =>
      own ? (target[name] = original) : delete target[name]
    );
  };
  const nativeCreate = NativeAgents.prototype.create;
  patch(NativeAgents.prototype, 'create', async function (options) {
    state.nativeSessions.push(options.sessionId);
    return nativeCreate.call(this, options);
  });
  const nativeRegister = NativeTools.prototype.register;
  patch(NativeTools.prototype, 'register', function (tool) {
    state.registeredTools.push(tool.name);
    return nativeRegister.call(this, tool);
  });
  patch(
    workModelProviderService,
    'getRoutingFingerprint',
    () => 'cordis-work-fixture-routing'
  );
  patch(workModelProviderService, 'getResponsesStateScope', () => undefined);
  if (!realRuntime) {
    patch(workRuntimeService, 'prepare', async task => {
      state.prepared.push(task.id);
      return () => state.released.push(task.id);
    });
    patch(workRuntimeService, 'computerToolsAvailable', async () => false);
    patch(workRuntimeService, 'isPreviewRunning', async () => false);
    patch(workRuntimeService, 'stopContainer', async task => {
      state.stopped.push(task.id);
    });
    patch(workRuntimeService, 'listFiles', async (task, requestedPath) => {
      state.lists.push({ taskId: task.id, path: requestedPath });
      return {
        path: '/workspace',
        entries: [
          {
            name: 'input.txt',
            path: '/workspace/input.txt',
            type: 'file',
            size: 5,
          },
        ],
      };
    });
    patch(
      workRuntimeService,
      'writeFile',
      async (task, requestedPath, content) => {
        state.writes.push({ taskId: task.id, path: requestedPath, content });
        return {
          path: '/workspace/' + requestedPath,
          size: Buffer.byteLength(content),
        };
      }
    );
    patch(workRuntimeService, 'runCommand', async (task, command) => {
      state.commands.push({ taskId: task.id, command });
      return {
        stdout: 'sandbox-command-result',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        truncated: false,
      };
    });
  }
  return {
    state,
    patch,
    restore: () => {
      for (const restore of restorers.reverse()) restore();
    },
  };
}

function addUser(id) {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO users (
    id, username, email, password_hash, role, avatar, created_at, updated_at
  ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(id, id, now, now);
}
const answer = (content, calls, thinking) => ({
  model,
  created_at: new Date().toISOString(),
  done: true,
  message: {
    role: 'assistant',
    content,
    ...(calls ? { tool_calls: calls } : {}),
    ...(thinking ? { thinking } : {}),
  },
});
const toolCall = (id, name, args) => ({
  id,
  function: { name, arguments: args },
});
const create = async userId => {
  addUser(userId);
  const detail = await workTaskService.createTaskWithRun(
    userId,
    'Exercise the sandboxed engine.',
    model,
    false,
    provider
  );
  assert.ok(detail.activeRun?.id);
  return { detail, runId: detail.activeRun.id };
};
const assertCompleted = async (taskId, runId, userId) => {
  const run = await workTaskService.getRun(runId);
  assert.equal(run.status, 'completed', run.error);
  assert.equal(
    (await workTaskService.requireTaskRecord(taskId, userId)).status,
    'completed'
  );
};

if (resume) {
  const fixture = harness();
  try {
    const [, , , taskId, userId] = process.argv;
    let requested = 0;
    fixture.patch(
      workModelProviderService,
      'generateChatStreamResponse',
      async request => {
        requested += 1;
        const priorTool = request.messages.find(
          message =>
            message.role === 'tool' && message.tool_call_id === 'resume-write'
        );
        assert.ok(
          priorTool,
          'fresh process restores the prior tool result from SQL'
        );
        assert.match(priorTool.content, /Wrote/);
        assert.ok(
          request.messages.some(
            message =>
              message.role === 'assistant' &&
              message.tool_calls?.some(call => call.id === 'resume-write')
          )
        );
        assert.ok(
          request.messages.some(
            message =>
              message.role === 'assistant' &&
              message.content === 'Persisted the first run.'
          )
        );
        return answer('Resumed from SQL without another write.');
      }
    );
    const detail = await workTaskService.createRun(
      taskId,
      userId,
      'Continue after restart.'
    );
    await workAgentService.execute(taskId, detail.activeRun.id, userId);
    await assertCompleted(taskId, detail.activeRun.id, userId);
    assert.equal(requested, 1);
    assert.equal(fixture.state.nativeSessions.length, 1);
    assert.equal(
      fixture.state.writes.length,
      0,
      'replayed history never executes a prior side effect'
    );
  } finally {
    fixture.restore();
    workEventService.reset();
    await closePlatform();
  }
} else {
  after(async () => {
    workEventService.reset();
    await closePlatform();
    await rm(dataDir, { recursive: true, force: true });
  });

  test(
    'native DSH performs tool rounds through Work and persists one transcript',
    { timeout: 15000 },
    async t => {
      const fixture = harness();
      t.after(fixture.restore);
      const userId = 'cordis-work-rounds';
      const { detail, runId } = await create(userId);
      const requests = [];
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async (request, selectedProvider, selectedUser, observer) => {
          requests.push(structuredClone(request));
          assert.deepEqual(selectedProvider, provider);
          assert.equal(selectedUser, userId);
          assert.equal(request.model, model);
          assert.ok(
            request.tools.some(tool => tool.function.name === 'write_file')
          );
          if (requests.length === 1) {
            observer.onReasoning?.('Inspect the approved workspace.');
            return answer(
              '',
              [toolCall('list-1', 'list_files', { path: '.' })],
              'Inspect the approved workspace.'
            );
          }
          if (requests.length === 2) {
            assert.match(
              request.messages.find(
                message => message.tool_call_id === 'list-1'
              ).content,
              /input.txt/
            );
            return answer('', [
              toolCall('write-1', 'write_file', {
                path: 'output.txt',
                content: 'sandbox output',
              }),
            ]);
          }
          assert.equal(requests.length, 3);
          assert.match(
            request.messages.find(message => message.tool_call_id === 'write-1')
              .content,
            /Wrote 14 bytes/
          );
          observer.onContent?.('Written once.');
          return answer('Written once.');
        }
      );
      await workAgentService.execute(detail.id, runId, userId);
      await assertCompleted(detail.id, runId, userId);
      assert.equal(requests.length, 3);
      assert.equal(
        fixture.state.nativeSessions.length,
        1,
        'the native DSH agent ran'
      );
      assert.ok(fixture.state.registeredTools.includes('write_file'));
      assert.ok(
        !fixture.state.registeredTools.some(name =>
          ['read', 'write', 'bash', 'edit'].includes(name)
        ),
        'host filesystem tools are never mounted'
      );
      assert.deepEqual(fixture.state.prepared, [detail.id]);
      assert.deepEqual(fixture.state.released, [detail.id]);
      assert.equal(fixture.state.writes.length, 1);
      assert.equal(fixture.state.writes[0].taskId, detail.id);
      const messages = await workTaskService.getMessages(detail.id);
      assert.equal(
        messages.filter(message => message.kind === 'tool_call').length,
        2
      );
      assert.equal(
        messages.filter(message => message.kind === 'tool_result').length,
        2
      );
      assert.equal(
        messages.filter(
          message =>
            message.kind === 'message' && message.content === 'Written once.'
        ).length,
        1
      );
      const events = workEventService.replay(detail.id, runId, 0).events;
      assert.ok(
        events.some(
          event =>
            event.type === 'reasoning_delta' &&
            event.data.total === 'Inspect the approved workspace.'
        )
      );
      assert.equal(events.filter(event => event.type === 'done').length, 1);
    }
  );

  for (const approve of [false, true]) {
    test(
      `native DSH respects Work ${approve ? 'approval' : 'denial'} before a command`,
      { timeout: 15000 },
      async t => {
        const fixture = harness();
        t.after(fixture.restore);
        const userId = `cordis-work-approval-${approve}`;
        const { detail, runId } = await create(userId);
        await workTaskService.setTaskApprovals(detail.id, userId, true);
        let round = 0;
        fixture.patch(
          workModelProviderService,
          'generateChatStreamResponse',
          async request => {
            if (++round === 1)
              return answer('', [
                toolCall('command-1', 'run_command', {
                  command: 'echo sandbox-command-result',
                }),
              ]);
            assert.equal(round, 2);
            const result = request.messages.find(
              message => message.tool_call_id === 'command-1'
            );
            assert.ok(result);
            assert.match(
              result.content,
              approve ? /sandbox-command-result/ : /denied/i
            );
            return answer(
              approve
                ? 'Approved command finished.'
                : 'Denied command was not run.'
            );
          }
        );
        const decisions = [];
        const unsubscribe = workEventService.subscribe(
          detail.id,
          runId,
          event => {
            if (event.type !== 'approval' || event.data.status !== 'pending')
              return;
            assert.equal(
              fixture.state.commands.length,
              0,
              'command waits for its durable approval'
            );
            decisions.push(
              workApprovalService.decide(
                detail.id,
                event.data.approvalId,
                userId,
                { approve, scope: 'once' }
              )
            );
          }
        );
        t.after(unsubscribe);
        await workAgentService.execute(detail.id, runId, userId);
        await assertCompleted(detail.id, runId, userId);
        const outcomes = await Promise.all(decisions);
        assert.equal(outcomes.length, 1);
        assert.equal(outcomes[0].status, approve ? 'approved' : 'denied');
        assert.equal(fixture.state.commands.length, approve ? 1 : 0);
        assert.equal(fixture.state.nativeSessions.length, 1);
        assert.deepEqual(await workApprovalService.listPending(detail.id), []);
      }
    );
  }

  test(
    'native DSH cannot execute a host filesystem tool outside Work dispatch',
    { timeout: 15000 },
    async t => {
      const fixture = harness();
      t.after(fixture.restore);
      const userId = 'cordis-work-no-host-tools';
      const { detail, runId } = await create(userId);
      const canary = path.join(dataDir, 'no-host-write.txt');
      await writeFile(canary, 'host unchanged');
      let round = 0;
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async request => {
          if (++round === 1)
            return answer('', [
              toolCall('host-write', 'write', {
                path: canary,
                content: 'must not execute',
              }),
            ]);
          assert.equal(round, 2);
          const result = request.messages.find(
            message => message.tool_call_id === 'host-write'
          );
          assert.match(result.content, /unknown|unsupported|not.*available/i);
          return answer('The host tool is unavailable.');
        }
      );
      await workAgentService.execute(detail.id, runId, userId);
      await assertCompleted(detail.id, runId, userId);
      assert.equal(await readFile(canary, 'utf8'), 'host unchanged');
      assert.equal(fixture.state.writes.length, 0);
      assert.ok(!fixture.state.registeredTools.includes('write'));
      assert.equal(fixture.state.nativeSessions.length, 1);
    }
  );

  test(
    'cancelling Work aborts native DSH generation and never revives the SQL run',
    { timeout: 15000 },
    async t => {
      const fixture = harness();
      t.after(fixture.restore);
      const userId = 'cordis-work-cancel';
      const { detail, runId } = await create(userId);
      let started;
      const start = new Promise(resolve => {
        started = resolve;
      });
      let providerSignal;
      let requests = 0;
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async (_request, _provider, _user, _observer, signal) => {
          requests += 1;
          providerSignal = signal;
          started();
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        }
      );
      const executing = workAgentService.execute(detail.id, runId, userId);
      await start;
      await workAgentService.cancel(detail.id, userId);
      await executing;
      assert.equal(providerSignal.aborted, true);
      assert.equal((await workTaskService.getRun(runId)).status, 'cancelled');
      assert.ok(fixture.state.stopped.includes(detail.id));
      assert.deepEqual(fixture.state.released, [detail.id]);
      await workAgentService.execute(detail.id, runId, userId);
      assert.equal(requests, 1, 'a terminal run is not re-executed');
      assert.equal(fixture.state.nativeSessions.length, 1);
    }
  );

  test(
    'a new process restores SQL history without repeating prior native DSH side effects',
    { timeout: 20000 },
    async t => {
      const fixture = harness();
      t.after(fixture.restore);
      const userId = 'cordis-work-restart';
      const { detail, runId } = await create(userId);
      let round = 0;
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async () =>
          ++round === 1
            ? answer('', [
                toolCall('resume-write', 'write_file', {
                  path: 'persisted.txt',
                  content: 'persist once',
                }),
              ])
            : answer('Persisted the first run.')
      );
      await workAgentService.execute(detail.id, runId, userId);
      await assertCompleted(detail.id, runId, userId);
      assert.equal(fixture.state.writes.length, 1);
      await execFile(process.execPath, [file, '--resume', detail.id, userId], {
        cwd: repoRoot,
        env: process.env,
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const runs = await workTaskService.listRuns(detail.id, 20);
      assert.equal(runs.length, 2);
      assert.ok(runs.every(run => run.status === 'completed'));
      const messages = await workTaskService.getMessages(detail.id);
      assert.equal(
        messages.filter(
          message =>
            message.kind === 'tool_call' &&
            message.metadata?.toolCallId === 'resume-write'
        ).length,
        1
      );
      assert.equal(
        messages.filter(
          message =>
            message.content === 'Resumed from SQL without another write.'
        ).length,
        1
      );
    }
  );

  test(
    'native DSH writes only into a fresh real Work Docker sandbox',
    {
      skip:
        !dockerEnabled &&
        'Set CORDIS_WORK_DOCKER=1 to exercise the local Docker runtime.',
      timeout: 90000,
    },
    async t => {
      // Refuse an implicit image download: operators choose an already installed image.
      await execFile('docker', [
        'image',
        'inspect',
        process.env.WORK_RUNTIME_IMAGE,
      ]);
      const fixture = harness({ realRuntime: true });
      t.after(fixture.restore);
      const userId = 'cordis-work-docker';
      const { detail, runId } = await create(userId);
      const task = await workTaskService.requireTaskRecord(detail.id, userId);
      t.after(async () => {
        await workRuntimeService.removeTask(task);
        workRuntimeService.finalizeTaskRemoval(task.id);
        await assert.rejects(
          execFile('docker', ['container', 'inspect', task.containerName])
        );
        await assert.rejects(
          execFile('docker', ['volume', 'inspect', task.volumeName])
        );
      });
      const canary = path.join(dataDir, 'host-canary.txt');
      await writeFile(canary, 'host unchanged');
      let round = 0;
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async request => {
          if (++round === 1)
            return answer('', [
              toolCall('docker-write', 'write_file', {
                path: 'proof.txt',
                content: 'DSH sandbox proof',
              }),
            ]);
          if (round === 2)
            return answer('', [
              toolCall('docker-read', 'run_command', {
                command: 'cat /workspace/proof.txt',
              }),
            ]);
          assert.equal(round, 3);
          assert.match(
            request.messages.find(
              message => message.tool_call_id === 'docker-read'
            ).content,
            /DSH sandbox proof/
          );
          const inspection = JSON.parse(
            (
              await execFile('docker', [
                'container',
                'inspect',
                task.containerName,
              ])
            ).stdout
          )[0];
          assert.equal(inspection.Config.User, '1000:1000');
          assert.equal(inspection.HostConfig.NetworkMode, 'none');
          assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
          assert.equal(inspection.HostConfig.Privileged, false);
          assert.ok(
            inspection.Mounts.some(
              mount =>
                mount.Type === 'volume' &&
                mount.Name === task.volumeName &&
                mount.Destination === '/workspace'
            )
          );
          assert.ok(!inspection.Mounts.some(mount => mount.Type === 'bind'));
          return answer('Verified the real sandbox.');
        }
      );
      await workAgentService.execute(detail.id, runId, userId);
      await assertCompleted(detail.id, runId, userId);
      assert.equal(fixture.state.nativeSessions.length, 1);
      assert.equal(await readFile(canary, 'utf8'), 'host unchanged');
      const inspected = JSON.parse(
        (await execFile('docker', ['volume', 'inspect', task.volumeName]))
          .stdout
      )[0];
      assert.equal(inspected.Name, task.volumeName);
      await assert.rejects(readFile(path.join(dataDir, 'proof.txt')), {
        code: 'ENOENT',
      });
    }
  );

  test(
    'native provider Work selections keep raw model identity, sandbox tools and reasoning across runs and database restart',
    { timeout: 20000 },
    async t => {
      const fixture = harness();
      t.after(fixture.restore);
      const userId = 'native-provider-work-admin';
      addUser(userId);
      const nativeProvider = {
        providerType: 'dsh',
        providerId: 'deepseek-native',
      };
      const nativeModel = 'flash';
      const nativeThinking =
        'Native reasoning required by the subsequent tool result.';
      const nativeMetadata = {
        nativeDsh: {
          provider: nativeProvider.providerId,
          model: nativeModel,
          instanceId: 'native-generation',
          replayState: { response: { signature: 'opaque-native-signature' } },
        },
      };
      const checked = [];
      fixture.patch(
        workModelProviderService,
        'assertModelSupportsTools',
        async (model, provider, actor) => {
          checked.push({ model, provider, actor });
          assert.equal(
            fixture.state.prepared.length,
            checked.length - 1,
            'native eligibility is checked before allocating each sandbox'
          );
        }
      );
      let requests = 0;
      fixture.patch(
        workModelProviderService,
        'generateChatStreamResponse',
        async (request, provider, actor) => {
          requests += 1;
          assert.equal(request.model, nativeModel);
          assert.deepEqual(provider, nativeProvider);
          assert.equal(actor, userId);
          if (requests === 1) {
            const response = answer(
              '',
              [
                toolCall('native-write', 'write_file', {
                  path: 'native.txt',
                  content: 'native output',
                }),
              ],
              nativeThinking
            );
            return {
              ...response,
              model: nativeModel,
              message: {
                ...response.message,
                providerMetadata: nativeMetadata,
              },
            };
          }
          const previous = request.messages.find(
            message =>
              message.role === 'assistant' &&
              message.tool_calls?.some(call => call.id === 'native-write')
          );
          assert.equal(
            previous?.thinking,
            nativeThinking,
            'native reasoning survives both the immediate tool result and SQL context recovery'
          );
          assert.deepEqual(
            previous.providerMetadata,
            nativeMetadata,
            'signed native replay state survives immediate and SQL-restored tool context'
          );
          assert.ok(
            request.messages.some(
              message => message.tool_call_id === 'native-write'
            )
          );
          return {
            ...answer(
              requests === 2
                ? 'Native provider wrote the file.'
                : 'Recovered without repeating the write.'
            ),
            model: nativeModel,
          };
        }
      );
      const task = await workTaskService.createTaskWithRun(
        userId,
        'Use the native configured model.',
        nativeModel,
        false,
        nativeProvider
      );
      assert.equal(task.providerType, 'dsh');
      assert.equal(task.providerId, nativeProvider.providerId);
      assert.equal(task.activeRun.model, nativeModel);
      await workAgentService.execute(task.id, task.activeRun.id, userId);
      await assertCompleted(task.id, task.activeRun.id, userId);
      const resumed = await workTaskService.createRun(
        task.id,
        userId,
        'Continue the saved native task.'
      );
      await workAgentService.execute(task.id, resumed.activeRun.id, userId);
      await assertCompleted(task.id, resumed.activeRun.id, userId);
      assert.equal(requests, 3);
      assert.equal(
        fixture.state.nativeSessions.length,
        2,
        'raw native provider selections still use the isolated DSH Work driver'
      );
      assert.equal(fixture.state.writes.length, 1);
      assert.ok(
        !fixture.state.registeredTools.some(name =>
          ['read', 'write', 'bash', 'edit'].includes(name)
        )
      );
      const dbUrl = pathToFileURL(
        path.join(repoRoot, 'backend/dist/db.js')
      ).href;
      const inspected = await execFile(
        process.execPath,
        [
          '--import',
          'tsx',
          '--input-type=module',
          '-e',
          `
      const {getDatabase, closeDatabase} = await import(${JSON.stringify(dbUrl)});
      const db = getDatabase();
      const task = db.prepare('SELECT model, provider_type, provider_id FROM work_tasks WHERE id = ?').get(${JSON.stringify(task.id)});
      const run = db.prepare('SELECT model, provider_type, provider_id FROM work_runs WHERE id = ?').get(${JSON.stringify(resumed.activeRun.id)});
      console.log('NATIVE_RECORD:' + JSON.stringify({task, run}));
      closeDatabase();
    `,
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, DATA_DIR: dataDir },
          timeout: 10000,
        }
      );
      const retained = JSON.parse(
        inspected.stdout.match(/^NATIVE_RECORD:(.*)$/m)[1]
      );
      for (const record of [retained.task, retained.run])
        assert.deepEqual(record, {
          model: nativeModel,
          provider_type: 'dsh',
          provider_id: nativeProvider.providerId,
        });
    }
  );
}
