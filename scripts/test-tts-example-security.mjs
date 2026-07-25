import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const pythonCandidates =
  process.platform === 'win32'
    ? [
        { command: 'py', prefix: ['-3'] },
        { command: 'python', prefix: [] },
        { command: 'python3', prefix: [] },
      ]
    : [
        { command: 'python3', prefix: [] },
        { command: 'python', prefix: [] },
      ];

const python = pythonCandidates.find(({ command, prefix }) => {
  const result = spawnSync(command, [...prefix, '--version'], {
    encoding: 'utf8',
  });
  return result.status === 0;
});

const suites = [
  'examples/kyutai-tts-1.6b-server',
  'examples/kyutai-tts-server',
  'examples/qwen-tts-server',
];

test('TTS examples reject unsafe paths and process markup without ReDoS', () => {
  assert.ok(
    python,
    'Python 3 is required to run the TTS example security regression tests'
  );

  for (const suite of suites) {
    const result = spawnSync(
      python.command,
      [
        ...python.prefix,
        '-m',
        'unittest',
        'discover',
        '-s',
        suite,
        '-p',
        'test*_security.py',
        '-v',
      ],
      {
        encoding: 'utf8',
      }
    );

    assert.equal(
      result.status,
      0,
      [`Security tests failed in ${suite}.`, result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
    );
  }
});
