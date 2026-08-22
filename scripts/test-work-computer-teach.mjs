import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const teachModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'workComputerTeachService.js'
    )
  ).href
);
const {
  buildWorkComputerPlaybook,
  isSecretLikeText,
  validateWorkTeachEvents,
  WORK_TEACH_MAX_EVENTS,
} = teachModule;

const click = (t, x, y, button = 0) => [
  { t, kind: 'down', x, y, button },
  { t: t + 60, kind: 'up', x, y, button },
];
const typeText = (t, text) =>
  [...text].map((key, index) => ({ t: t + index * 40, kind: 'key', key }));
const build = events =>
  buildWorkComputerPlaybook(validateWorkTeachEvents(events), {
    name: 'Test procedure',
  });

test('clicks, double-clicks, and drags are distinguished deterministically', () => {
  const playbook = build([
    ...click(0, 100, 100),
    // Two fast clicks in place collapse into a double-click.
    ...click(500, 300, 300),
    ...click(700, 302, 301),
    // A ≥8px down/up displacement is a drag.
    { t: 1200, kind: 'down', x: 400, y: 400, button: 0 },
    { t: 1500, kind: 'up', x: 460, y: 440, button: 0 },
    // Right button is preserved.
    ...click(2000, 50, 60, 2),
  ]);
  assert.equal(playbook.steps.length, 4);
  assert.match(playbook.steps[0], /^1\. Click at about \(100, 100\)\./);
  assert.match(playbook.steps[1], /^2\. Double-click at about \(30\d, 30\d\)\./);
  assert.match(
    playbook.steps[2],
    /^3\. Drag from about \(400, 400\) to \(460, 440\)\./
  );
  assert.match(playbook.steps[3], /^4\. Right-click at about \(50, 60\)\./);
});

test('keystrokes batch into typed text; chords and specials flush the run', () => {
  const playbook = build([
    ...click(0, 640, 60),
    ...typeText(200, 'hello world'),
    { t: 900, kind: 'key', key: 'Enter' },
    { t: 1000, kind: 'key', key: 'l', ctrl: true },
    { t: 1100, kind: 'key', key: 'Shift' }, // bare modifier dropped
    ...typeText(1200, 'next'),
  ]);
  assert.deepEqual(
    playbook.steps.map(step => step.replace(/^\d+\. /, '')),
    [
      'Click at about (640, 60).',
      'Type "hello world" into the focused field.',
      'Press Return.',
      'Press ctrl+l.',
      'Type "next" into the focused field.',
    ]
  );
  assert.deepEqual(playbook.typedInputs, ['hello world', 'next']);
});

test('wheel events coalesce into scroll steps and long pauses become waits', () => {
  const playbook = build([
    { t: 0, kind: 'wheel', x: 640, y: 400, dy: 1 },
    { t: 300, kind: 'wheel', x: 640, y: 405, dy: 1 },
    { t: 600, kind: 'wheel', x: 640, y: 410, dy: -1 },
    // 5s pause before the next action becomes an explicit wait step.
    ...click(5600, 100, 100),
  ]);
  assert.deepEqual(
    playbook.steps.map(step => step.replace(/^\d+\. /, '')),
    [
      'Scroll down around (640, 400).',
      'Scroll up around (640, 410).',
      'Wait for the screen to settle (about 5s in the demonstration).',
      'Click at about (100, 100).',
    ]
  );
});

test('secret-looking typed text is redacted and flips the approval boundary', () => {
  assert.equal(isSecretLikeText('my password here'), true);
  assert.equal(isSecretLikeText('Tr0ub4dor&3'), true); // credential-shaped
  assert.equal(isSecretLikeText('hello world'), false);
  assert.equal(isSecretLikeText('short'), false);

  const playbook = build([
    ...click(0, 640, 300),
    ...typeText(100, 'robin@example.com'),
    ...click(1200, 640, 360),
    ...typeText(1300, 'S3cr3t!Pass'),
    { t: 2000, kind: 'key', key: 'Enter' },
  ]);
  assert.equal(playbook.redactions, 1);
  assert.ok(!playbook.instructions.includes('S3cr3t!Pass'));
  assert.match(playbook.instructions, /REDACTED — never type this value/);
  assert.match(playbook.instructions, /redacted secret input at the marked step/);
  // The e-mail (two character classes) stays: it is a legitimate input the
  // replay substitutes, not credential-shaped material.
  assert.ok(playbook.typedInputs.includes('robin@example.com'));
});

test('the playbook carries every rakazo section and the coordinates-are-hints framing', () => {
  const playbook = build([...click(0, 10, 10), ...typeText(100, 'notes')]);
  for (const section of [
    '## When to use',
    '## Inputs',
    '## Steps',
    '## How to check',
    '## Approval boundaries',
    '## What to return',
    '## Failure handling',
  ]) {
    assert.ok(
      playbook.instructions.includes(section),
      `missing section ${section}`
    );
  }
  assert.match(playbook.instructions, /Test procedure/);
  assert.match(playbook.instructions, /Coordinates are hints/);
  assert.match(playbook.instructions, /request_takeover/);
  assert.match(playbook.instructions, /stop and ask the user/);
  assert.match(
    playbook.instructions,
    /substitute the value the current request calls for/
  );
});

test('malformed and oversized recordings are rejected with clear errors', () => {
  for (const events of [
    [],
    'nope',
    [{ t: -1, kind: 'key', key: 'a' }],
    [{ t: 0, kind: 'down' }],
    [{ t: 0, kind: 'wheel' }],
    [{ t: 0, kind: 'key' }],
    [{ t: 0, kind: 'dance' }],
  ]) {
    assert.throws(
      () => validateWorkTeachEvents(events),
      error => error.code === 'WORK_TEACH_INVALID_RECORDING'
    );
  }
  assert.throws(
    () =>
      validateWorkTeachEvents(
        Array.from({ length: WORK_TEACH_MAX_EVENTS + 1 }, (_, index) => ({
          t: index,
          kind: 'key',
          key: 'a',
        }))
      ),
    error => error.code === 'WORK_TEACH_INVALID_RECORDING'
  );
  // A recording with only ignorable events builds no steps.
  assert.throws(
    () =>
      buildWorkComputerPlaybook(
        validateWorkTeachEvents([{ t: 0, kind: 'key', key: 'Shift' }]),
        { name: 'noop' }
      ),
    error => error.code === 'WORK_TEACH_INVALID_RECORDING'
  );
});

test('events are ordered by timestamp before building', () => {
  const playbook = build([
    { t: 500, kind: 'up', x: 100, y: 100, button: 0 },
    { t: 440, kind: 'down', x: 100, y: 100, button: 0 },
  ]);
  assert.match(playbook.steps[0], /Click at about \(100, 100\)/);
});
