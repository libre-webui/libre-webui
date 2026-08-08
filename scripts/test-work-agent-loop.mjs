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
  {
    default: workAgentService,
    normalizeToolCalls,
    restorePersistedWorkContext,
    WORK_TOOL_SCHEMAS,
  },
  { default: workEventService },
  {
    default: workModelProviderService,
    toOpenAIResponsesWorkInput,
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

replaceMethod(
  workModelProviderService,
  'getRoutingFingerprint',
  () => 'stable-work-routing'
);

after(async () => {
  for (const restore of restorers.reverse()) restore();
  workEventService.reset();
  closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

test('the tool registry covers full file management inside the sandbox', () => {
  const byName = new Map(
    WORK_TOOL_SCHEMAS.map(schema => [
      schema.function?.name ?? schema.name,
      schema,
    ])
  );
  for (const name of [
    'list_files',
    'read_file',
    'write_file',
    'delete_file',
    'move_file',
    'search_files',
    'run_command',
    'start_preview',
    'stop_preview',
  ]) {
    assert.ok(byName.has(name), `missing tool ${name}`);
  }

  const definition = schema => schema.function ?? schema;
  const deleteTool = definition(byName.get('delete_file'));
  assert.deepEqual(deleteTool.parameters.required, ['path']);
  assert.equal(deleteTool.parameters.properties.recursive.type, 'boolean');

  const moveTool = definition(byName.get('move_file'));
  assert.deepEqual(moveTool.parameters.required, ['from', 'to']);
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

test('Responses state and exact tool call IDs survive a persisted Work resume', async () => {
  const now = Date.now();
  const userId = 'agent-loop-responses-resume-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  const stateScope = 'responses-resume-state-scope';
  const reasoningItem = {
    id: 'reasoning-resume',
    type: 'reasoning',
    encrypted_content: 'opaque-resume-reasoning',
    summary: [],
  };
  const functionItem = {
    id: 'function-resume',
    type: 'function_call',
    call_id: 'call-resume',
    name: 'list_files',
    arguments: '{"path":"."}',
  };
  const finalMessageItem = {
    id: 'message-resume-final',
    type: 'message',
    role: 'assistant',
    phase: 'final_answer',
    content: [{ type: 'output_text', text: 'Initial run complete.' }],
  };
  const providerMetadata = outputItems => ({
    openAIResponsesOutputItems: outputItems,
    openAIResponsesStateScope: stateScope,
  });

  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => stateScope
  );

  let phase = 'initial';
  let initialRound = 0;
  let resumedRequest;
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      if (phase === 'resumed') {
        resumedRequest = request;
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: 'Resumed run complete.',
            providerMetadata: providerMetadata([
              {
                id: 'message-resumed',
                type: 'message',
                role: 'assistant',
                phase: 'final_answer',
                content: [
                  { type: 'output_text', text: 'Resumed run complete.' },
                ],
              },
            ]),
          },
          done: true,
        };
      }

      initialRound += 1;
      if (initialRound === 1) {
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            providerMetadata: providerMetadata([reasoningItem, functionItem]),
            tool_calls: [
              {
                id: 'call-resume',
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

      assert.equal(initialRound, 2);
      assert.equal(request.messages.at(-1).tool_call_id, 'call-resume');
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: 'Initial run complete.',
          providerMetadata: providerMetadata([finalMessageItem]),
        },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'List the workspace and finish.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const initialRunId = detail.activeRun?.id;
  assert.ok(initialRunId);
  await workAgentService.execute(detail.id, initialRunId, userId);
  assert.equal(workTaskService.getRun(initialRunId).status, 'completed');

  const hiddenRows = getDatabase()
    .prepare(
      `SELECT kind
       FROM work_messages
       WHERE task_id = ? AND kind = 'provider_state'`
    )
    .all(detail.id);
  assert.equal(hiddenRows.length, 1);
  assert.equal(
    workTaskService
      .getMessages(detail.id)
      .some(message => message.kind === 'provider_state'),
    false
  );
  assert.equal(
    workTaskService
      .getMessagePage(detail.id)
      .messages.some(message => message.kind === 'provider_state'),
    false
  );

  phase = 'resumed';
  const resumedDetail = workTaskService.createRun(
    detail.id,
    userId,
    'Continue from persisted state.'
  );
  const resumedRunId = resumedDetail.activeRun?.id;
  assert.ok(resumedRunId);
  await workAgentService.execute(detail.id, resumedRunId, userId);
  assert.equal(workTaskService.getRun(resumedRunId).status, 'completed');
  assert.ok(resumedRequest);

  const restoredToolResult = resumedRequest.messages.find(
    message => message.role === 'tool' && message.tool_call_id === 'call-resume'
  );
  assert.equal(restoredToolResult.content, '[]');
  const replayedInput = toOpenAIResponsesWorkInput(
    resumedRequest.messages,
    stateScope
  );
  const replayStart = replayedInput.findIndex(
    item => item.id === reasoningItem.id
  );
  assert.ok(replayStart >= 0);
  assert.deepEqual(replayedInput.slice(replayStart, replayStart + 4), [
    reasoningItem,
    functionItem,
    {
      type: 'function_call_output',
      call_id: 'call-resume',
      output: '[]',
    },
    finalMessageItem,
  ]);
  assert.deepEqual(replayedInput.at(-1), {
    role: 'user',
    content: 'Continue from persisted state.',
  });
  assert.equal(
    toOpenAIResponsesWorkInput(
      resumedRequest.messages,
      'different-provider-state-scope'
    ).some(item => item.id === reasoningItem.id),
    false
  );
});

test('truncated Work context drops orphaned provider state and tool results', () => {
  const now = Date.now();
  const userId = 'agent-loop-context-truncation-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Old prompt outside the retained row window.',
    'test-model',
    true
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  workTaskService.addMessage(
    detail.id,
    runId,
    'assistant',
    'provider_state',
    '',
    { workProviderState: { providerMetadata: {} } }
  );
  workTaskService.addMessage(
    detail.id,
    runId,
    'tool',
    'tool_result',
    'orphaned result',
    { name: 'list_files', toolCallId: 'orphan-call' }
  );
  workTaskService.addMessage(
    detail.id,
    runId,
    'assistant',
    'message',
    'Safe retained boundary.'
  );
  workTaskService.addMessage(
    detail.id,
    runId,
    'user',
    'message',
    'Follow-up one.'
  );
  workTaskService.addMessage(
    detail.id,
    runId,
    'assistant',
    'message',
    'Answer one.'
  );
  workTaskService.addMessage(
    detail.id,
    runId,
    'user',
    'message',
    'Follow-up two.'
  );

  const retained = workTaskService.getRecentModelContextMessages(detail.id, 1);
  assert.equal(retained[0].content, 'Safe retained boundary.');
  assert.equal(
    retained.some(
      message =>
        message.kind === 'provider_state' || message.kind === 'tool_result'
    ),
    false
  );
});

test('persisted Responses batches synthesize exact outputs for interrupted tools', () => {
  const scope = 'persisted-partial-batch-scope';
  const provider = {
    providerType: 'plugin',
    providerId: 'responses-provider',
    model: 'responses-model',
  };
  const metadata = {
    workProviderState: {
      ...provider,
      providerMetadata: {
        openAIResponsesStateScope: scope,
        openAIResponsesOutputItems: [
          {
            id: 'function-call-a',
            type: 'function_call',
            call_id: 'call-a',
            name: 'list_files',
            arguments: '{"path":"."}',
          },
          {
            id: 'function-call-b',
            type: 'function_call',
            call_id: 'call-b',
            name: 'read_file',
            arguments: '{"path":"README.md"}',
          },
        ],
      },
    },
  };

  const restored = restorePersistedWorkContext(
    [
      {
        role: 'assistant',
        kind: 'provider_state',
        content: '',
        metadata,
      },
      {
        role: 'tool',
        kind: 'tool_result',
        content: 'README contents',
        metadata: { name: 'read_file', toolCallId: 'call-b' },
      },
      {
        role: 'user',
        kind: 'message',
        content: 'Continue safely.',
      },
    ],
    provider,
    scope
  );

  assert.deepEqual(
    restored.slice(0, 4).map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id,
      content: message.content,
    })),
    [
      { role: 'assistant', toolCallId: undefined, content: '' },
      {
        role: 'tool',
        toolCallId: 'call-b',
        content: 'README contents',
      },
      {
        role: 'tool',
        toolCallId: 'call-a',
        content:
          'Tool execution was interrupted; outcome unknown. Inspect the workspace before retrying.',
      },
      {
        role: 'user',
        toolCallId: undefined,
        content: 'Continue safely.',
      },
    ]
  );
});

test('malformed persisted Responses calls fail closed to visible assistant text', () => {
  const scope = 'malformed-persisted-state-scope';
  const provider = {
    providerType: 'plugin',
    providerId: 'responses-provider',
    model: 'responses-model',
  };
  const providerState = outputItems => ({
    workProviderState: {
      ...provider,
      providerMetadata: {
        openAIResponsesStateScope: scope,
        openAIResponsesOutputItems: outputItems,
      },
    },
  });
  const malformedBatches = [
    [{ type: 'function_call', name: 'list_files', arguments: '{}' }],
    [
      {
        type: 'function_call',
        call_id: '',
        name: 'list_files',
        arguments: '{}',
      },
    ],
    [
      {
        type: 'function_call',
        call_id: 'duplicate',
        name: 'list_files',
        arguments: '{}',
      },
      {
        type: 'function_call',
        call_id: 'duplicate',
        name: 'read_file',
        arguments: '{}',
      },
    ],
  ];

  for (const outputItems of malformedBatches) {
    assert.deepEqual(
      restorePersistedWorkContext(
        [
          {
            role: 'assistant',
            kind: 'message',
            content: 'Visible safe answer.',
            metadata: providerState(outputItems),
          },
        ],
        provider,
        scope
      ),
      [{ role: 'assistant', content: 'Visible safe answer.' }]
    );
    assert.deepEqual(
      restorePersistedWorkContext(
        [
          {
            role: 'assistant',
            kind: 'provider_state',
            content: '',
            metadata: providerState(outputItems),
          },
        ],
        provider,
        scope
      ),
      []
    );
  }
});

test('Responses tool batches reject missing, blank, duplicate, and excessive IDs', () => {
  const response = toolCalls => ({
    message: {
      role: 'assistant',
      content: '',
      providerMetadata: {
        openAIResponsesStateScope: 'normalize-call-scope',
        openAIResponsesOutputItems: toolCalls.map(call => ({
          type: 'function_call',
          call_id: call.id,
          name: call.function?.name,
          arguments: '{}',
        })),
      },
      tool_calls: toolCalls,
    },
  });
  const call = id => ({
    ...(id === undefined ? {} : { id }),
    function: { name: 'list_files', arguments: {} },
  });

  for (const calls of [
    [call(undefined)],
    [call('')],
    [call('duplicate'), call('duplicate')],
    Array.from({ length: 17 }, (_, index) => call(`call-${index}`)),
  ]) {
    assert.throws(
      () => normalizeToolCalls(response(calls)),
      error =>
        error?.code === 'WORK_PROVIDER_INVALID_TOOL_CALLS' &&
        error?.status === 502
    );
  }

  assert.equal(
    normalizeToolCalls(response([call(' exact-id ')])).at(0).id,
    ' exact-id '
  );
});

test('oversized Responses tool state fails before Work performs a side effect', async () => {
  const now = Date.now();
  const userId = 'agent-loop-oversized-state-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  let sideEffects = 0;
  replaceMethod(workRuntimeService, 'prepare', async () => () => undefined);
  replaceMethod(workRuntimeService, 'isPreviewRunning', async () => false);
  replaceMethod(workRuntimeService, 'stopContainer', async () => undefined);
  replaceMethod(workRuntimeService, 'listFiles', async () => {
    sideEffects += 1;
    return { entries: [] };
  });
  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => 'oversized-state-scope'
  );
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => ({
      model: request.model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: '',
        providerMetadata: {
          openAIResponsesStateScope: 'oversized-state-scope',
          openAIResponsesStateDropped: true,
        },
        tool_calls: [
          {
            id: 'oversized-call',
            function: { name: 'list_files', arguments: { path: '.' } },
          },
        ],
      },
      done: true,
    })
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Do not execute an unpersistable call.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  assert.equal(sideEffects, 0);
  assert.equal(workTaskService.getRun(runId).status, 'failed');
  const events = workEventService.replay(detail.id, runId, 0).events;
  assert.equal(
    events.find(event => event.type === 'error')?.data.code,
    'WORK_PROVIDER_INVALID_TOOL_CALLS'
  );
});

test('Responses metadata cannot execute tools after a chat-completions scope race', async () => {
  const now = Date.now();
  const userId = 'agent-loop-mode-race-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  let sideEffects = 0;
  replaceMethod(workRuntimeService, 'prepare', async () => () => undefined);
  replaceMethod(workRuntimeService, 'isPreviewRunning', async () => false);
  replaceMethod(workRuntimeService, 'stopContainer', async () => undefined);
  replaceMethod(workRuntimeService, 'listFiles', async () => {
    sideEffects += 1;
    return { entries: [] };
  });
  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => undefined
  );
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => ({
      model: request.model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: '',
        providerMetadata: {
          openAIResponsesStateScope: 'new-responses-scope',
          openAIResponsesOutputItems: [
            {
              id: 'mode-race-function',
              type: 'function_call',
              call_id: 'mode-race-call',
              name: 'list_files',
              arguments: '{"path":"."}',
            },
          ],
        },
        tool_calls: [
          {
            id: 'mode-race-call',
            function: { name: 'list_files', arguments: { path: '.' } },
          },
        ],
      },
      done: true,
    })
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Reject tool calls from a newly selected Responses route.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  assert.equal(sideEffects, 0);
  assert.equal(workTaskService.getRun(runId).status, 'failed');
  assert.equal(
    workEventService
      .replay(detail.id, runId, 0)
      .events.find(event => event.type === 'error')?.data.code,
    'WORK_PROVIDER_INVALID_TOOL_CALLS'
  );
});

test('Responses tool state must fit the exact persisted metadata wrapper', async () => {
  const now = Date.now();
  const userId = 'agent-loop-wrapper-limit-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  const stateScope = 'wrapper-limit-scope';
  let sideEffects = 0;
  replaceMethod(workRuntimeService, 'listFiles', async () => {
    sideEffects += 1;
    return { entries: [] };
  });
  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => stateScope
  );
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => ({
      model: request.model,
      created_at: new Date().toISOString(),
      message: {
        role: 'assistant',
        content: '',
        providerMetadata: {
          openAIResponsesStateScope: stateScope,
          openAIResponsesOutputItems: [
            {
              id: 'wrapper-limit-function',
              type: 'function_call',
              call_id: 'wrapper-limit-call',
              name: 'list_files',
              arguments: '{"path":"."}',
            },
            {
              id: 'wrapper-limit-message',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'x'.repeat(88_000) }],
            },
          ],
        },
        tool_calls: [
          {
            id: 'wrapper-limit-call',
            function: { name: 'list_files', arguments: { path: '.' } },
          },
        ],
      },
      done: true,
    })
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Do not execute state that the database cannot preserve.',
    `model-${'m'.repeat(15_000)}`,
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  assert.equal(sideEffects, 0);
  assert.equal(workTaskService.getRun(runId).status, 'failed');
  assert.equal(
    workEventService
      .replay(detail.id, runId, 0)
      .events.find(event => event.type === 'error')?.data.code,
    'WORK_PROVIDER_INVALID_TOOL_CALLS'
  );
});

test('Work stops before a second provider request after credential rotation', async () => {
  const now = Date.now();
  const userId = 'agent-loop-routing-freeze-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  const stateScope = 'routing-freeze-scope';
  let credentialRevision = 'old-credential';
  let requests = 0;
  let sideEffects = 0;
  replaceMethod(workRuntimeService, 'listFiles', async () => {
    sideEffects += 1;
    return { entries: [] };
  });
  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => stateScope
  );
  replaceMethod(
    workModelProviderService,
    'getRoutingFingerprint',
    () => `routing:${credentialRevision}`
  );
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      requests += 1;
      credentialRevision = 'new-credential';
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: {
          role: 'assistant',
          content: '',
          providerMetadata: {
            openAIResponsesStateScope: stateScope,
            openAIResponsesOutputItems: [
              {
                id: 'routing-freeze-function',
                type: 'function_call',
                call_id: 'routing-freeze-call',
                name: 'list_files',
                arguments: '{"path":"."}',
              },
            ],
          },
          tool_calls: [
            {
              id: 'routing-freeze-call',
              function: { name: 'list_files', arguments: { path: '.' } },
            },
          ],
        },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Stop before sending state to changed provider routing.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  assert.equal(requests, 1);
  assert.equal(sideEffects, 1);
  assert.equal(workTaskService.getRun(runId).status, 'failed');
  assert.equal(
    workEventService
      .replay(detail.id, runId, 0)
      .events.find(event => event.type === 'error')?.data.code,
    'WORK_PROVIDER_ROUTING_CHANGED'
  );
});

test('chat-mode tool history survives a persisted Work resume', async () => {
  const now = Date.now();
  const userId = 'agent-loop-chat-resume-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => undefined
  );
  replaceMethod(
    workModelProviderService,
    'getRoutingFingerprint',
    () => 'chat-resume-routing'
  );
  replaceMethod(workRuntimeService, 'listFiles', async () => ({
    entries: [],
  }));

  let phase = 'initial';
  let initialRound = 0;
  let resumedRequest;
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      if (phase === 'resumed') {
        resumedRequest = request;
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: 'Resumed with full history.',
          },
          done: true,
        };
      }

      initialRound += 1;
      if (initialRound === 1) {
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'chat-call-1',
                function: { name: 'list_files', arguments: { path: '.' } },
              },
            ],
          },
          done: true,
        };
      }
      assert.equal(initialRound, 2);
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Wrote the road files.' },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Build the road.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const initialRunId = detail.activeRun?.id;
  assert.ok(initialRunId);
  await workAgentService.execute(detail.id, initialRunId, userId);
  assert.equal(workTaskService.getRun(initialRunId).status, 'completed');

  // The chat round persisted its tool calls for cross-run replay.
  const persistedState = workTaskService
    .getRecentModelContextMessages(detail.id, 30)
    .find(message => message.kind === 'provider_state');
  assert.ok(persistedState);
  assert.deepEqual(persistedState.metadata.workProviderState.toolCalls, [
    { id: 'chat-call-1', name: 'list_files', arguments: '{"path":"."}' },
  ]);

  phase = 'resumed';
  const resumedDetail = workTaskService.createRun(
    detail.id,
    userId,
    'Continue the road.'
  );
  const resumedRunId = resumedDetail.activeRun?.id;
  assert.ok(resumedRunId);
  await workAgentService.execute(detail.id, resumedRunId, userId);
  assert.equal(workTaskService.getRun(resumedRunId).status, 'completed');
  assert.ok(resumedRequest);

  // The resumed request replays the assistant tool-call turn and its result,
  // so the model keeps the evidence of its own prior work.
  const replayedAssistant = resumedRequest.messages.find(
    message =>
      message.role === 'assistant' &&
      Array.isArray(message.tool_calls) &&
      message.tool_calls.length > 0
  );
  assert.ok(replayedAssistant);
  assert.deepEqual(replayedAssistant.tool_calls, [
    {
      id: 'chat-call-1',
      type: 'function',
      function: { name: 'list_files', arguments: '{"path":"."}' },
    },
  ]);
  const replayedResult = resumedRequest.messages.find(
    message => message.role === 'tool' && message.tool_call_id === 'chat-call-1'
  );
  assert.equal(replayedResult.content, '[]');
  assert.ok(
    resumedRequest.messages.some(
      message =>
        message.role === 'assistant' &&
        message.content === 'Wrote the road files.'
    )
  );
});

test('chat-persisted tool calls restore for chat providers and fail closed for Responses', () => {
  const provider = {
    providerType: 'plugin',
    providerId: 'chat-provider',
    model: 'chat-model',
  };
  const chatState = {
    workProviderState: {
      providerType: 'plugin',
      providerId: 'chat-provider',
      model: 'chat-model',
      toolCalls: [
        { id: 'call-a', name: 'write_file', arguments: '{"path":"road.js"}' },
        { id: 'call-b', name: 'read_file', arguments: '{"path":"game.js"}' },
      ],
    },
  };
  const rows = [
    {
      role: 'assistant',
      kind: 'provider_state',
      content: '',
      metadata: chatState,
    },
    {
      role: 'tool',
      kind: 'tool_result',
      content: 'Wrote 120 bytes to road.js.',
      metadata: { name: 'write_file', toolCallId: 'call-a' },
    },
    { role: 'user', kind: 'message', content: 'Continue.' },
  ];

  const restored = restorePersistedWorkContext(rows, provider, undefined);
  assert.deepEqual(
    restored.map(message => ({
      role: message.role,
      toolCallId: message.tool_call_id,
      calls: message.tool_calls?.length,
    })),
    [
      { role: 'assistant', toolCallId: undefined, calls: 2 },
      { role: 'tool', toolCallId: 'call-a', calls: undefined },
      { role: 'tool', toolCallId: 'call-b', calls: undefined },
      { role: 'user', toolCallId: undefined, calls: undefined },
    ]
  );
  // The interrupted second call synthesizes an explicit unknown outcome.
  assert.match(restored[2].content, /interrupted/i);

  // A Responses-mode provider must never replay tool calls without durable
  // Responses state: the chat rows fail closed to the user message alone.
  assert.deepEqual(
    restorePersistedWorkContext(rows, provider, 'some-responses-scope'),
    [{ role: 'user', content: 'Continue.' }]
  );

  // A malformed persisted call drops the whole batch rather than replaying
  // a partial tool history.
  const malformed = structuredClone(rows);
  delete malformed[0].metadata.workProviderState.toolCalls[1].id;
  assert.deepEqual(
    restorePersistedWorkContext(malformed, provider, undefined),
    [{ role: 'user', content: 'Continue.' }]
  );
});

test('empty rounds are nudged back to work instead of completing', async () => {
  const now = Date.now();
  const userId = 'agent-loop-empty-nudge-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => undefined
  );

  let requests = 0;
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      requests += 1;
      if (requests > 1) {
        assert.match(
          request.messages.at(-1).content,
          /no reply and no tool calls/i
        );
      }
      if (requests < 3) {
        // A reasoning-only round: thinking, no content, no tool calls.
        return {
          model: request.model,
          created_at: new Date().toISOString(),
          message: {
            role: 'assistant',
            content: '',
            thinking: 'Considering the road geometry.',
          },
          done: true,
        };
      }
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: 'Recovered final answer.' },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Diagnose the missing road.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  assert.equal(requests, 3);
  assert.equal(workTaskService.getRun(runId).status, 'completed');
  const persisted = workTaskService.getMessages(detail.id);
  assert.ok(
    persisted.some(message => message.content === 'Recovered final answer.')
  );
  assert.equal(
    persisted.some(message =>
      message.content.includes('without returning a text response')
    ),
    false
  );
});

test('a run that stays empty completes with a placeholder hidden from replay', async () => {
  const now = Date.now();
  const userId = 'agent-loop-empty-exhausted-admin';
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);

  replaceMethod(
    workModelProviderService,
    'getResponsesStateScope',
    () => undefined
  );

  let requests = 0;
  replaceMethod(
    workModelProviderService,
    'generateChatStreamResponse',
    async request => {
      requests += 1;
      return {
        model: request.model,
        created_at: new Date().toISOString(),
        message: { role: 'assistant', content: '' },
        done: true,
      };
    }
  );

  const detail = workTaskService.createTaskWithRun(
    userId,
    'Say something.',
    'test-model',
    true,
    { providerType: 'plugin', providerId: 'test-plugin' }
  );
  const runId = detail.activeRun?.id;
  assert.ok(runId);
  await workAgentService.execute(detail.id, runId, userId);

  // Initial round plus the two bounded nudges, then an honest completion.
  assert.equal(requests, 3);
  assert.equal(workTaskService.getRun(runId).status, 'completed');
  const placeholder = workTaskService
    .getMessages(detail.id)
    .find(message =>
      message.content.includes('without returning a text response')
    );
  assert.ok(placeholder);
  assert.equal(placeholder.metadata.emptyModelResponse, true);

  // The placeholder stays user-visible but never re-enters model context.
  const restored = restorePersistedWorkContext(
    workTaskService.getRecentModelContextMessages(detail.id, 30),
    { providerType: 'plugin', providerId: 'test-plugin', model: 'test-model' },
    undefined
  );
  assert.equal(
    restored.some(message =>
      message.content.includes('without returning a text response')
    ),
    false
  );
});
