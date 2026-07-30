import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-work-agent-loop-'));

process.env.DATA_DIR = dataDir;
process.env.WORK_MAX_AGENT_ROUNDS = '13';
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { closeDatabase, getDatabase },
  { default: workAgentService },
  { default: workEventService },
  {
    default: workModelProviderService,
    WORK_TOOL_ARGUMENTS_ERROR_MESSAGE,
    WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY,
  },
  { default: workRuntimeService },
  { default: workTaskService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/workAgentService.js'),
  distModule('services/workEventService.js'),
  distModule('services/workModelProviderService.js'),
  distModule('services/workRuntimeService.js'),
  distModule('services/workTaskService.js'),
]);

const restorers = [];
const replaceMethod = (target, key, replacement) => {
  const hadOwnProperty = Object.hasOwn(target, key);
  const previous = target[key];
  target[key] = replacement;
  restorers.push(() => {
    if (hadOwnProperty) target[key] = previous;
    else delete target[key];
  });
};

after(async () => {
  for (const restore of restorers.reverse()) restore();
  workEventService.reset();
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

test('plugin Work runs use the configured round budget and finish with a no-tools handoff', async () => {
  assert.equal(workRuntimeService.limits.maxRounds, 13);

  const now = Date.now();
  const userId = 'agent-loop-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  replaceMethod(workRuntimeService, 'prepare', async () => () => undefined);
  replaceMethod(workRuntimeService, 'isPreviewRunning', async () => false);
  replaceMethod(workRuntimeService, 'stopContainer', async () => undefined);
  replaceMethod(workRuntimeService, 'listFiles', async () => ({
    entries: [],
  }));

  const requests = [];
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async (request, provider, requestedUserId, observer) => {
      requests.push(request);
      assert.deepEqual(provider, {
        providerType: 'plugin',
        providerId: 'test-plugin',
      });
      assert.equal(requestedUserId, userId);

      if (request.tools.length > 0) {
        assert.equal(request.options, undefined);
        const round = requests.length;
        assert.ok(
          round <= 13,
          `expected the final request after 13 tool rounds, received tool round ${round}`
        );
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: `list-${round}`,
                function: {
                  name: 'list_files',
                  arguments: { path: '.' },
                },
              },
            ],
          },
          done: true,
        };
      }

      assert.equal(requests.length, 14);
      assert.match(
        request.messages.at(-1).content,
        /execution budget is exhausted/i
      );
      observer.onContent?.('Completed the configured-round handoff.');
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'Completed the configured-round handoff.',
        },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Exercise the complete agent budget.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);

  const events = [];
  const unsubscribe = workEventService.subscribe(detail.id, runId, event =>
    events.push(event)
  );
  try {
    await workAgentService.execute(detail.id, runId, userId);
  } finally {
    unsubscribe();
  }

  assert.equal(requests.length, 14);
  assert.ok(requests.slice(0, 13).every(request => request.tools.length > 0));
  assert.deepEqual(requests[13].tools, []);

  const run = workTaskService.getRun(runId);
  assert.equal(run.status, 'needs_input');
  assert.equal(run.error, undefined);
  const task = workTaskService.requireTaskRecord(detail.id, userId);
  assert.equal(task.status, 'needs_input');
  const done = events.findLast(event => event.type === 'done');
  assert.equal(done?.data.status, 'needs_input');
  assert.equal(done?.data.budgetReason, 'round');

  const messages = workTaskService.getMessages(detail.id);
  const handoff = messages.at(-1);
  assert.equal(handoff.kind, 'message');
  assert.equal(handoff.content, 'Completed the configured-round handoff.');
  assert.deepEqual(handoff.metadata, {
    budgetHandoff: true,
    budgetReason: 'round',
  });
  assert.equal(
    messages.filter(message => message.kind === 'tool_call').length,
    13
  );
  assert.equal(
    messages.filter(message => message.kind === 'tool_result').length,
    13
  );
});

test('invalid provider tool arguments prevent partial writes and guide a smaller retry', async () => {
  const now = Date.now();
  const userId = 'agent-loop-tool-recovery-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  const writes = [];
  replaceMethod(
    workRuntimeService,
    'writeFile',
    async (_task, filePath, content) => {
      writes.push({ path: filePath, content });
      return {
        path: filePath,
        content,
        size: Buffer.byteLength(content),
        updatedAt: Date.now(),
        modifiedAt: Date.now(),
      };
    }
  );

  const requests = [];
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      requests.push(request);
      assert.equal(request.options, undefined);

      if (requests.length === 1) {
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'valid-peer',
                function: {
                  name: 'write_file',
                  arguments: {
                    path: 'must-not-run.js',
                    content: 'partial mutation',
                  },
                },
              },
              {
                id: 'truncated-write',
                providerMetadata: {
                  [WORK_TOOL_ARGUMENTS_ERROR_METADATA_KEY]:
                    WORK_TOOL_ARGUMENTS_ERROR_MESSAGE,
                },
                function: {
                  name: 'write_file',
                  arguments: {},
                },
              },
            ],
          },
          done: true,
        };
      }

      if (requests.length === 2) {
        const results = request.messages
          .filter(message => message.role === 'tool')
          .slice(-2)
          .map(message => message.content);
        assert.match(results[0], /not executed/i);
        assert.match(results[1], /incomplete or invalid JSON/i);
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'small-retry',
                function: {
                  name: 'write_file',
                  arguments: {
                    path: 'safe.js',
                    content: 'ok',
                  },
                },
              },
            ],
          },
          done: true,
        };
      }

      assert.equal(requests.length, 3);
      assert.match(
        request.messages.at(-1).content,
        /Wrote 2 bytes to safe\.js/
      );
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'Recovered with a smaller write.',
        },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Recover from a truncated tool call.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);

  await workAgentService.execute(detail.id, runId, userId);

  assert.deepEqual(writes, [{ path: 'safe.js', content: 'ok' }]);
  assert.equal(workTaskService.getRun(runId).status, 'completed');
  assert.equal(
    workTaskService.getMessages(detail.id).at(-1).content,
    'Recovered with a smaller write.'
  );
});

test('incomplete provider responses fail Work with the provider reason', async () => {
  const now = Date.now();
  const userId = 'agent-loop-incomplete-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async (request, _provider, _requestedUserId, observer) => {
      observer.onContent?.('Partial response');
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'Partial response',
        },
        done: true,
        done_reason: 'incomplete:max_output_tokens',
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Do not accept truncated provider output.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);

  const events = [];
  const unsubscribe = workEventService.subscribe(detail.id, runId, event =>
    events.push(event)
  );
  try {
    await workAgentService.execute(detail.id, runId, userId);
  } finally {
    unsubscribe();
  }

  const run = workTaskService.getRun(runId);
  assert.equal(run.status, 'failed');
  assert.match(run.error, /incomplete response \(max_output_tokens\)/);
  const errorEvent = events.find(event => event.type === 'error');
  assert.equal(errorEvent?.data.code, 'WORK_PROVIDER_INCOMPLETE_RESPONSE');
});
