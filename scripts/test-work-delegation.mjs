import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-work-delegation-'));

process.env.DATA_DIR = dataDir;
process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
// Deterministic provider scripting: agent status blurbs would otherwise
// consume scripted turns with their extra no-tools model request.
process.env.WORK_STATUS_BLURB_MODEL = '0';

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );
const [
  { getDatabase },
  {
    default: workAgentService,
    delegationSourceOf,
    workToolSchemasForTask,
    WORK_MESSAGE_AGENT_TOOL_SCHEMA,
  },
  { buildWorkAgentSystemPrompt },
  { default: workEventService },
  { default: workModelProviderService },
  { default: workRuntimeService },
  { default: workTaskService },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/workAgentService.js'),
  distModule('services/workAgentGuidance.js'),
  distModule('services/workEventService.js'),
  distModule('services/workModelProviderService.js'),
  distModule('services/workRuntimeService.js'),
  distModule('services/workTaskService.js'),
]);
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

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
replaceMethod(workRuntimeService, 'prepare', async () => () => undefined);
replaceMethod(workRuntimeService, 'isPreviewRunning', async () => false);
replaceMethod(workRuntimeService, 'stopContainer', async () => undefined);

after(async () => {
  for (const restore of restorers.reverse()) restore();
  workEventService.reset();
  await closeWorkPlatform();
  await rm(dataDir, { recursive: true, force: true });
});

const userId = 'delegation-admin';
const provider = { providerType: 'plugin', providerId: 'test-plugin' };

/** Queue of scripted provider turns; each entry produces one response. */
const providerScript = [];
replaceMethod(
  workModelProviderService,
  'generateChatStreamResponse',
  async (request, _provider, _userId, observer) => {
    const step = providerScript.shift();
    assert.ok(step, 'provider was called with no scripted turn left');
    return step(request, observer);
  }
);

const textTurn = content => (request, observer) => {
  observer?.onContent?.(content);
  return {
    model: request.model,
    created_at: new Date().toISOString(),
    message: { role: 'assistant', content },
    done: true,
  };
};
const toolTurn = (id, name, args) => request => ({
  model: request.model,
  created_at: new Date().toISOString(),
  message: {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, function: { name, arguments: args } }],
  },
  done: true,
});

const runToCompletion = async (taskId, runId) => {
  await workAgentService.execute(taskId, runId, userId);
  return workTaskService.getRun(runId);
};

test.before(() => {
  const now = Date.now();
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, avatar, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'admin', NULL, ?, ?)`
    )
    .run(userId, userId, now, now);
});

test('the delegation tool is offered by option and the roster reaches the prompt', async () => {
  const shape = { networkEnabled: false, userId, policyId: null };
  const base = await workToolSchemasForTask(shape);
  assert.equal(
    base.some(schema => schema.function?.name === 'message_agent'),
    false
  );
  const withPeers = await workToolSchemasForTask(shape, { messageAgent: true });
  assert.equal(
    withPeers.some(schema => schema.function?.name === 'message_agent'),
    true
  );
  assert.equal(
    WORK_MESSAGE_AGENT_TOOL_SCHEMA.function?.parameters?.required?.includes(
      'agent'
    ),
    true
  );

  // The delegation marker parses only from a complete, well-formed source.
  const marker = {
    runId: 'run-b',
    role: 'user',
    metadata: {
      delegation: { fromTaskId: 't-a', fromRunId: 'r-a', fromAgent: 'Ada' },
    },
  };
  assert.deepEqual(delegationSourceOf([marker], 'run-b'), {
    fromTaskId: 't-a',
    fromRunId: 'r-a',
    fromAgent: 'Ada',
  });
  assert.equal(delegationSourceOf([marker], 'other-run'), undefined);
  assert.equal(
    delegationSourceOf(
      [{ runId: 'run-b', role: 'user', metadata: { delegation: { x: 1 } } }],
      'run-b'
    ),
    undefined
  );

  // The prompt carries the roster for delegators and the report contract
  // for delegated runs.
  const common = {
    networkEnabled: false,
    computerAvailable: false,
    previewPort: 4173,
    roundBudget: 8,
    commandTimeoutMs: 60_000,
    maxOutputChars: 10_000,
  };
  const rosterPrompt = buildWorkAgentSystemPrompt({
    ...common,
    peerAgents: [{ name: 'Researcher duties', status: 'Idle.' }],
  });
  assert.match(rosterPrompt, /Working with other agents/);
  assert.match(rosterPrompt, /Researcher duties — Idle\./);
  assert.match(rosterPrompt, /message_agent/);
  const delegatedPrompt = buildWorkAgentSystemPrompt({
    ...common,
    delegatedBy: 'Chief of Staff',
  });
  assert.match(delegatedPrompt, /delegated by the agent "Chief of Staff"/);
  assert.match(delegatedPrompt, /delegating further is disabled/);
  assert.doesNotMatch(delegatedPrompt, /Working with other agents/);
});

test('an agent delegates to a peer and the report returns to its conversation', async () => {
  // Two hired agents; their titles are their names.
  const chief = await workTaskService.createTaskWithRun(
    userId,
    'Chief duties',
    'test-model',
    false,
    provider,
    undefined,
    undefined,
    { isAgent: true }
  );
  const researcher = await workTaskService.createTaskWithRun(
    userId,
    'Researcher duties',
    'test-model',
    false,
    provider,
    undefined,
    undefined,
    { isAgent: true }
  );
  // Settle both hiring runs so the agents are idle.
  providerScript.push(textTurn('Chief ready.'), textTurn('Researcher ready.'));
  assert.equal(
    (await runToCompletion(chief.id, chief.activeRun.id)).status,
    'completed'
  );
  assert.equal(
    (await runToCompletion(researcher.id, researcher.activeRun.id)).status,
    'completed'
  );

  // The chief's run: one bad name, then a real delegation, then wrap up.
  providerScript.push(
    toolTurn('call-1', 'message_agent', {
      agent: 'Nobody',
      message: 'hello?',
    }),
    toolTurn('call-2', 'message_agent', {
      agent: 'researcher DUTIES',
      message: 'Please research the market and report the top number.',
    }),
    textTurn('Delegated the research; standing by.')
  );
  const chiefRun = await workTaskService.createRun(
    chief.id,
    userId,
    'Have the researcher find the top market number.'
  );
  assert.equal(
    (await runToCompletion(chief.id, chiefRun.activeRun.id)).status,
    'completed'
  );

  const chiefMessages = await workTaskService.getMessages(chief.id);
  const toolResults = chiefMessages.filter(
    message => message.kind === 'tool_result'
  );
  assert.match(toolResults.at(-2).content, /No hired agent is named "Nobody"/);
  assert.match(toolResults.at(-2).content, /Researcher duties/);
  assert.match(toolResults.at(-1).content, /Delegated to Researcher duties/);

  // The researcher received a queued run whose initiating message carries
  // the delegation marker and the full request text.
  const delegatedRun = await workTaskService.getActiveRun(researcher.id);
  assert.ok(delegatedRun, 'the delegated run must be queued on the peer');
  const researcherMessages = await workTaskService.getMessages(researcher.id);
  const initiating = researcherMessages.find(
    message =>
      message.runId === delegatedRun.id &&
      message.role === 'user' &&
      message.metadata?.delegation
  );
  assert.equal(
    initiating.content,
    'Please research the market and report the top number.'
  );
  assert.equal(initiating.metadata.delegation.fromTaskId, chief.id);
  assert.equal(initiating.metadata.delegation.fromAgent, 'Chief duties');

  // While the researcher is busy, another delegation fails honestly.
  providerScript.push(
    toolTurn('call-3', 'message_agent', {
      agent: 'Researcher duties',
      message: 'One more thing.',
    }),
    textTurn('The researcher is busy; noted.')
  );
  const secondChiefRun = await workTaskService.createRun(
    chief.id,
    userId,
    'Also ask for a second number.'
  );
  await runToCompletion(chief.id, secondChiefRun.activeRun.id);
  assert.match(
    (await workTaskService.getMessages(chief.id))
      .filter(message => message.kind === 'tool_result')
      .at(-1).content,
    /busy with another run/
  );

  // The researcher finishes; its report lands in the idle chief's
  // conversation as a labeled message, without auto-starting a run.
  providerScript.push(textTurn('Research finished: the top number is 42.'));
  assert.equal(
    (await runToCompletion(researcher.id, delegatedRun.id)).status,
    'completed'
  );
  const report = (await workTaskService.getMessages(chief.id)).at(-1);
  assert.equal(report.role, 'user');
  assert.match(report.content, /Report from Researcher duties/);
  assert.match(report.content, /finished/);
  assert.match(report.content, /the top number is 42/);
  assert.equal(report.metadata.delegationReport.fromTaskId, researcher.id);
  assert.equal(report.metadata.delegationReport.status, 'completed');
  assert.equal(report.metadata.midRun, undefined);
  assert.equal(await workTaskService.getActiveRun(chief.id), undefined);
});

test('a delegated run cannot delegate further', async () => {
  const chief = (await workTaskService.listTaskRecords(userId)).find(
    record => record.title === 'Chief duties'
  );
  const researcher = (await workTaskService.listTaskRecords(userId)).find(
    record => record.title === 'Researcher duties'
  );
  const chained = await workTaskService.createRun(
    researcher.id,
    userId,
    'Chase a sub-question.',
    undefined,
    undefined,
    {
      delegation: {
        fromTaskId: chief.id,
        fromRunId: 'run-x',
        fromAgent: 'Chief duties',
      },
    }
  );
  providerScript.push(
    toolTurn('call-4', 'message_agent', {
      agent: 'Chief duties',
      message: 'You do it.',
    }),
    textTurn('Understood; doing it myself.')
  );
  assert.equal(
    (await runToCompletion(researcher.id, chained.activeRun.id)).status,
    'completed'
  );
  const results = (await workTaskService.getMessages(researcher.id)).filter(
    message => message.kind === 'tool_result'
  );
  assert.match(results.at(-1).content, /cannot delegate further/);
  // The chief got the chained run's report but no new run of its own.
  assert.equal(await workTaskService.getActiveRun(chief.id), undefined);
  const report = (await workTaskService.getMessages(chief.id)).at(-1);
  assert.match(report.content, /Report from Researcher duties/);
  assert.match(report.content, /doing it myself/);
});
