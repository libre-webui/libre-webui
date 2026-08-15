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
  {
    directory: 'examples/kyutai-tts-1.6b-server',
    pattern: 'test*_security.py',
  },
  {
    directory: 'examples/kyutai-tts-server',
    pattern: 'test*_security.py',
  },
  {
    directory: 'examples/longcat-audiodit-server',
    pattern: 'test_server.py',
  },
  {
    directory: 'examples/mlx-lm-server',
    pattern: 'test_server.py',
  },
  {
    directory: 'examples/qwen-tts-server',
    pattern: 'test*_security.py',
  },
];

test('Python examples pass their isolated regression suites', () => {
  assert.ok(python, 'Python 3 is required to run the example regression tests');

  for (const suite of suites) {
    const result = spawnSync(
      python.command,
      [
        ...python.prefix,
        '-m',
        'unittest',
        'discover',
        '-s',
        suite.directory,
        '-p',
        suite.pattern,
        '-v',
      ],
      {
        encoding: 'utf8',
      }
    );

    assert.equal(
      result.status,
      0,
      [
        `Python example tests failed in ${suite.directory}.`,
        result.stdout,
        result.stderr,
      ]
        .filter(Boolean)
        .join('\n')
    );
  }
});
