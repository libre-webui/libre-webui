import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const diagnosticsModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'systemDiagnosticsService.js'
    )
  ).href
);

test('system diagnostics only accepts a local Docker Unix socket', () => {
  assert.equal(
    diagnosticsModule.resolveSystemDockerSocketPath(
      '/custom/docker.sock',
      undefined
    ),
    '/custom/docker.sock'
  );
  assert.equal(
    diagnosticsModule.resolveSystemDockerSocketPath(
      undefined,
      'unix:///run/user/1000/docker.sock'
    ),
    '/run/user/1000/docker.sock'
  );
  assert.equal(
    diagnosticsModule.resolveSystemDockerSocketPath(
      undefined,
      'tcp://docker.example.test:2375'
    ),
    null
  );
});

test('Linux network counters are parsed without reading interface metadata', () => {
  const counters = diagnosticsModule.parseNetworkCounters(`
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
  eth0: 12345 10 0 0 0 0 0 0 67890 20 0 0 0 0 0 0
    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
`);
  assert.deepEqual(counters.get('eth0'), {
    receivedBytes: 12345,
    transmittedBytes: 67890,
  });
  assert.deepEqual(counters.get('lo'), {
    receivedBytes: 100,
    transmittedBytes: 100,
  });
});

test('Docker diagnostics expose a reduced operational summary only', () => {
  const summary = diagnosticsModule.summarizeDockerPayloads(
    { Version: '28.3.0', ApiVersion: '1.51' },
    {
      OperatingSystem: 'Linux',
      Architecture: 'x86_64',
      KernelVersion: '6.8.0',
      NCPU: 8,
      MemTotal: 16_000_000_000,
      Containers: 2,
      ContainersRunning: 1,
      ContainersStopped: 1,
      ContainersPaused: 0,
      DriverStatus: [['Pool Name', 'secret-pool']],
    },
    [
      {
        Id: 'abcdef0123456789',
        Names: ['/libre-webui'],
        Image: 'libre-webui/libre-webui:dev',
        State: 'running',
        Status: 'Up 5 minutes',
        Created: 1_700_000_000,
        Labels: { password: 'must-not-leak' },
        Mounts: [{ Source: '/host/private' }],
        Command: 'node backend/dist/index.js --secret value',
      },
    ]
  );

  assert.equal(summary.available, true);
  assert.equal(summary.runningContainers, 1);
  assert.deepEqual(summary.containers, [
    {
      id: 'abcdef012345',
      name: 'libre-webui',
      image: 'libre-webui/libre-webui:dev',
      state: 'running',
      status: 'Up 5 minutes',
      createdAt: 1_700_000_000_000,
    },
  ]);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(
    serialized,
    /must-not-leak|host\/private|--secret|Pool Name/
  );
  assert.doesNotMatch(serialized, /Labels|Mounts|Command|DriverStatus/);
});

test('system route requires both authentication and current administrator status', () => {
  const routeSource = fs.readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'systemDiagnostics.ts'),
    'utf8'
  );
  assert.match(routeSource, /router\.use\(authenticate\)/);
  assert.match(routeSource, /router\.use\(requireAdmin\)/);
  assert.match(routeSource, /Cache-Control['"], ['"]no-store/);
});

test('Docker diagnostics stay read-only and never invoke a command shell', () => {
  const source = fs.readFileSync(
    path.join(
      repoRoot,
      'backend',
      'src',
      'services',
      'systemDiagnosticsService.ts'
    ),
    'utf8'
  );
  assert.doesNotMatch(source, /child_process|exec\(|spawn\(/);
  assert.match(source, /method: ['"]GET['"]/);
  assert.doesNotMatch(source, /method: ['"](?:POST|PUT|PATCH|DELETE)['"]/);
});
