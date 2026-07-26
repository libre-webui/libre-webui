import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const guidanceModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workAgentGuidance.js')
  ).href
);

const {
  WORK_AGENT_SKILLS,
  buildWorkAgentSystemPrompt,
  buildWorkBudgetExhaustionPrompt,
  workToolCallBudget,
} = guidanceModule;

const guidanceContext = {
  networkEnabled: true,
  previewPort: 4173,
  roundBudget: 48,
  commandTimeoutMs: 120_000,
  maxOutputChars: 50_000,
};

test('built-in Work skills have stable unique identities', () => {
  assert.deepEqual(
    WORK_AGENT_SKILLS.map(skill => skill.id),
    [
      'workspace-discovery',
      'focused-implementation',
      'verification',
      'browser-preview',
      'budget-discipline',
    ]
  );
  assert.equal(
    new Set(WORK_AGENT_SKILLS.map(skill => skill.id)).size,
    WORK_AGENT_SKILLS.length
  );
  for (const skill of WORK_AGENT_SKILLS) {
    assert.ok(skill.title.length > 0);
    assert.ok(skill.instructions.length > 0);
    assert.ok(skill.instructions.every(instruction => instruction.length > 0));
  }
});

test('Work guidance exposes the real runtime contract and efficient workflow', () => {
  const prompt = buildWorkAgentSystemPrompt(guidanceContext);

  assert.match(prompt, /only durable filesystem location/);
  assert.match(prompt, /root filesystem is read-only/);
  assert.match(prompt, /unprivileged user without sudo/);
  assert.match(prompt, /Network access is enabled/);
  assert.match(prompt, /2,000,000 bytes/);
  assert.match(prompt, /120,000 ms/);
  assert.match(prompt, /600,000 ms/);
  assert.match(prompt, /50,000 characters/);
  assert.match(prompt, /48 model rounds and 384 tool calls/);
  assert.match(prompt, /0\.0\.0\.0:4173/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /batch independent/);
  assert.match(prompt, /preserve unrelated work/);
  assert.match(prompt, /Start the preview last/);
  assert.match(prompt, /do not stop after only describing a plan/);
});

test('Work guidance changes network policy without changing its core skills', () => {
  const prompt = buildWorkAgentSystemPrompt({
    ...guidanceContext,
    networkEnabled: false,
  });

  assert.match(prompt, /Network access is disabled/);
  assert.match(prompt, /do not repeatedly retry/);
  for (const skill of WORK_AGENT_SKILLS) {
    assert.match(prompt, new RegExp(escapeRegExp(skill.title)));
  }
});

test('tool-call safety budget scales with one unified round budget', () => {
  assert.equal(workToolCallBudget(1), 128);
  assert.equal(workToolCallBudget(16), 128);
  assert.equal(workToolCallBudget(17), 136);
  assert.equal(workToolCallBudget(48), 384);
  assert.equal(workToolCallBudget(100), 800);
});

test('guidance rejects invalid runtime facts before prompt interpolation', () => {
  for (const invalid of [
    { roundBudget: 0 },
    { roundBudget: Number.NaN },
    { commandTimeoutMs: -1 },
    { maxOutputChars: 1.5 },
    { previewPort: 0 },
    { previewPort: 65_536 },
  ]) {
    assert.throws(
      () => buildWorkAgentSystemPrompt({ ...guidanceContext, ...invalid }),
      RangeError
    );
  }
  assert.throws(() => workToolCallBudget(0), RangeError);
});

test('budget exhaustion asks for an honest no-tools handoff', () => {
  const prompt = buildWorkBudgetExhaustionPrompt();

  assert.match(prompt, /Do not call any more tools/);
  assert.match(prompt, /what was completed/);
  assert.match(prompt, /checks actually ran/);
  assert.match(prompt, /remaining work/);
  assert.match(prompt, /Do not claim completion or verification/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
