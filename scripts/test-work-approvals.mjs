import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeWorkTestPlatform } from './lib/work-test-platform.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-approvals-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const databaseModule = await import(dist('db.js'));
const approvalModule = await import(dist('services/workApprovalService.js'));
const policyModule = await import(dist('services/workPolicyService.js'));
const taskModule = await import(dist('services/workTaskService.js'));
const persistenceModule = await import(
  dist('platform/workPersistence/index.js')
);

const {
  workApprovalService,
  GATED_WORK_TOOLS,
  ruleCovers,
  deriveRulePattern,
  WORK_APPROVAL_TIMEOUT_MS,
} = approvalModule;
const { workPolicyService, validateWorkPolicyInput } = policyModule;
const closeWorkPlatform = await initializeWorkTestPlatform(repoRoot);

test.after(async () => {
  await closeWorkPlatform();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const service = new taskModule.WorkTaskService();
let taskId;

test.before(async () => {
  const db = databaseModule.getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES ('approval-user', 'approval-user', 'a@example.invalid', 'x', 'admin', ?, ?)`
  ).run(now, now);
  const detail = await service.createTaskWithRun(
    'approval-user',
    'do something risky',
    'test-model',
    false,
    { providerType: 'ollama' }
  );
  taskId = detail.id;
});

test('approval decisions gate side-effecting Work actions', async () => {
  // The gated set is exactly the side-effecting tools; read-only tools and
  // write_file (workspace-contained, high-frequency) stay ungated.
  assert.deepEqual(
    [...GATED_WORK_TOOLS].sort(),
    ['computer_act', 'delete_file', 'move_file', 'run_command']
  );

  const pending = await workApprovalService.createPending({
    taskId,
    runId: 'run-1',
    userId: 'approval-user',
    toolCallId: 'call-1',
    toolName: 'run_command',
    summary: { command: 'rm -rf ./build' },
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.expiresAt - pending.createdAt, WORK_APPROVAL_TIMEOUT_MS);

  const listed = await workApprovalService.listPending(taskId);
  assert.deepEqual(
    listed.map(item => item.approvalId),
    [pending.approvalId]
  );

  // Approve once: resolves exactly once; a second decision is refused.
  // (Persistence guards this via resolvePendingApproval's status=pending
  // predicate, so replicas cannot double-decide.)
  const approved = await workApprovalService.decide(
    taskId,
    pending.approvalId,
    'approval-user',
    { approve: true, scope: 'once' }
  );
  assert.equal(approved.status, 'approved');
  assert.equal(approved.scope, 'once');
  assert.equal(
    await workApprovalService.decide(taskId, pending.approvalId, 'approval-user', {
      approve: false,
      scope: 'once',
    }),
    null
  );
  // A once-approval persists no rule.
  assert.deepEqual(await workApprovalService.rulesForTask(taskId), []);

  // Deny: resolves as denied and never creates a rule, even at scope always.
  const denied0 = await workApprovalService.createPending({
    taskId,
    runId: 'run-1',
    userId: 'approval-user',
    toolCallId: 'call-2',
    toolName: 'delete_file',
    summary: { path: 'notes.md' },
  });
  const denied = await workApprovalService.decide(
    taskId,
    denied0.approvalId,
    'approval-user',
    { approve: false, scope: 'always' }
  );
  assert.equal(denied.status, 'denied');
  assert.equal(denied.scope, 'once');
  assert.deepEqual(await workApprovalService.rulesForTask(taskId), []);

  // ruleCovers semantics: run_command scopes to the command's first token,
  // every other tool matches tool-wide (null pattern).
  assert.equal(deriveRulePattern('run_command', { command: 'npm run build' }), 'npm');
  assert.equal(deriveRulePattern('delete_file', { path: 'x' }), null);
  assert.equal(
    ruleCovers(
      { tool_name: 'run_command', pattern: 'npm' },
      'run_command',
      { command: 'npm test' }
    ),
    true
  );
  assert.equal(
    ruleCovers(
      { tool_name: 'run_command', pattern: 'npm' },
      'run_command',
      { command: 'rm -rf /' }
    ),
    false
  );
  assert.equal(
    ruleCovers({ tool_name: 'computer_act', pattern: null }, 'computer_act', {}),
    true
  );
  assert.equal(
    ruleCovers({ tool_name: 'computer_act', pattern: null }, 'run_command', {
      command: 'ls',
    }),
    false
  );
});

test('always-allow decisions persist rules that pre-approve matching calls', async () => {
  const pending = await workApprovalService.createPending({
    taskId,
    runId: 'run-2',
    userId: 'approval-user',
    toolCallId: 'call-3',
    toolName: 'run_command',
    summary: { command: 'npm run lint' },
  });
  const approved = await workApprovalService.decide(
    taskId,
    pending.approvalId,
    'approval-user',
    { approve: true, scope: 'always' }
  );
  assert.equal(approved.scope, 'always');

  const rules = await workApprovalService.rulesForTask(taskId);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].toolName, 'run_command');
  assert.equal(rules[0].pattern, 'npm');

  // The very next matching call is pre-approved; a different program and a
  // different tool are not.
  assert.equal(
    await workApprovalService.callIsPreapproved(taskId, 'run_command', {
      command: 'npm test',
    }),
    true
  );
  assert.equal(
    await workApprovalService.callIsPreapproved(taskId, 'run_command', {
      command: 'curl https://example.invalid',
    }),
    false
  );
  assert.equal(
    await workApprovalService.callIsPreapproved(taskId, 'delete_file', {
      path: 'x',
    }),
    false
  );

  // Deleting the rule closes the gate again.
  assert.equal(
    await workApprovalService.deleteRule(taskId, rules[0].id, 'approval-user'),
    true
  );
  assert.equal(
    await workApprovalService.callIsPreapproved(taskId, 'run_command', {
      command: 'npm test',
    }),
    false
  );
  assert.equal(
    await workApprovalService.deleteRule(taskId, rules[0].id, 'approval-user'),
    false
  );
});

test('pending approvals expire and the waiter observes decisions', async () => {
  // A stale pending row (crashed worker, closed laptop) expires by time.
  const persistence = persistenceModule.getWorkPersistence();
  await persistence.insertApproval({
    id: 'stale-approval',
    task_id: taskId,
    run_id: 'run-3',
    user_id: 'approval-user',
    tool_call_id: 'call-4',
    tool_name: 'move_file',
    summary: null,
    status: 'pending',
    scope: 'once',
    created_at: Date.now() - 10_000,
    resolved_at: null,
    expires_at: Date.now() - 1_000,
  });
  assert.deepEqual(await workApprovalService.listPending(taskId), []);
  assert.equal(
    await workApprovalService.decide(taskId, 'stale-approval', 'approval-user', {
      approve: true,
      scope: 'once',
    }),
    null
  );

  // The in-process waiter resolves the moment a decision lands.
  const pending = await workApprovalService.createPending({
    taskId,
    runId: 'run-3',
    userId: 'approval-user',
    toolCallId: 'call-5',
    toolName: 'computer_act',
    summary: { actionCount: 3 },
  });
  const waiter = workApprovalService.waitForDecision(
    taskId,
    pending.approvalId
  );
  await workApprovalService.decide(taskId, pending.approvalId, 'approval-user', {
    approve: true,
    scope: 'once',
  });
  assert.equal((await waiter).status, 'approved');

  // Cancellation aborts the wait instead of leaving the run hanging.
  const cancelled = await workApprovalService.createPending({
    taskId,
    runId: 'run-3',
    userId: 'approval-user',
    toolCallId: 'call-6',
    toolName: 'run_command',
    summary: { command: 'ls' },
  });
  const controller = new AbortController();
  const aborted = workApprovalService.waitForDecision(
    taskId,
    cancelled.approvalId,
    controller.signal
  );
  controller.abort(new Error('run cancelled'));
  await assert.rejects(aborted, /run cancelled/);
});

test('the policy force-flag and per-task opt-in are tri-state', async () => {
  assert.equal(validateWorkPolicyInput({ name: 'a' }).approvalsRequired, null);
  assert.equal(
    validateWorkPolicyInput({ name: 'a', approvalsRequired: true })
      .approvalsRequired,
    true
  );
  assert.equal(
    validateWorkPolicyInput({ name: 'a', approvalsRequired: false })
      .approvalsRequired,
    false
  );

  const forced = await workPolicyService.create({
    name: 'reviewed-policy',
    approvalsRequired: true,
  });
  assert.equal(forced.approvalsRequired, true);
  assert.equal(
    (await workPolicyService.resolve(forced.id)).approvalsRequired,
    true
  );
  // Policy-less resolution never forces approvals.
  assert.notEqual(
    (await workPolicyService.resolve(null)).approvalsRequired,
    true
  );
  const relaxed = await workPolicyService.update(forced.id, {
    name: 'reviewed-policy',
    approvalsRequired: null,
  });
  assert.equal(relaxed.approvalsRequired, undefined);
  assert.equal(
    (await workPolicyService.resolve(forced.id)).approvalsRequired,
    false
  );
  await workPolicyService.remove(forced.id);

  // Per-task opt-in round-trips and null clears back to off.
  await service.setTaskApprovals(taskId, 'approval-user', true);
  assert.equal(
    (await service.getTaskRecord(taskId, 'approval-user')).approvalsEnabled,
    true
  );
  await service.setTaskApprovals(taskId, 'approval-user', null);
  assert.equal(
    (await service.getTaskRecord(taskId, 'approval-user')).approvalsEnabled,
    undefined
  );
  await assert.rejects(
    service.setTaskApprovals(taskId, 'someone-else', true)
  );
});

test('approval routes exist and the agent loop gates before execution', () => {
  const routeSource = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'work.ts'),
    'utf8'
  );
  assert.match(routeSource, /router\.get\(\s*'\/tasks\/:id\/approvals'/);
  assert.match(routeSource, /router\.put\(\s*'\/tasks\/:id\/approvals'/);
  assert.match(
    routeSource,
    /router\.post\(\s*'\/tasks\/:id\/approvals\/:approvalId'/
  );
  assert.match(
    routeSource,
    /router\.delete\(\s*'\/tasks\/:id\/approval-rules\/:ruleId'/
  );

  const agentSource = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'services', 'workAgentService.ts'),
    'utf8'
  );
  // The gate sits in the dispatch loop before executeTool, and an expired
  // approval hands the run off as needs_input instead of hanging.
  assert.match(agentSource, /GATED_WORK_TOOLS\.has\(call\.function\.name\)/);
  assert.match(agentSource, /awaitToolApproval/);
  assert.match(agentSource, /budgetReason = 'approval-timeout'/);
  // Denial reaches the model as a tool result, never silent execution.
  assert.match(agentSource, /The user denied this action\./);
});
