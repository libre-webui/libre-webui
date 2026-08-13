import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const kubernetesModule = await import(
  pathToFileURL(
    path.join(
      repoRoot,
      'backend',
      'dist',
      'services',
      'workKubernetesDriver.js'
    )
  ).href
);
const runtimeModule = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
  ).href
);

const {
  KubernetesWorkRuntimeDriver,
  WORK_KUBERNETES_DEFAULTS,
  buildWorkPodManifest,
  buildWorkspaceClaimManifest,
  dockerCpusToKubernetes,
  dockerMemoryToKubernetes,
  mapPodPhase,
  statusToExitCode,
  wrapCommandWithWorkdir,
  describeKubernetesUnavailable,
} = kubernetesModule;

const task = {
  id: '1c95f122-0472-4b4c-ae88-0920de984cc8',
  userId: 'user-42',
  title: 'Isolated test workspace',
  model: 'llama3.2:3b',
  status: 'idle',
  networkEnabled: true,
  volumeName: 'libre-work-1c95f12204724b4cae880920de984cc8',
  containerName: 'libre-work-1c95f12204724b4cae880920de984cc8',
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

test('sandbox Pods carry the full non-root, least-privilege policy', () => {
  const pod = buildWorkPodManifest(task, {
    policyId: null,
    image: 'example.invalid/work@sha256:test',
    memoryLimit: '2g',
    cpuLimit: '2',
    pidsLimit: 256,
    idleTimeoutMs: 0,
  });

  assert.equal(pod.metadata.name, task.containerName);
  assert.equal(pod.metadata.labels['ai.libre-webui.managed'], 'true');
  assert.equal(pod.metadata.labels['ai.libre-webui.task'], task.id);
  assert.equal(pod.metadata.labels['ai.libre-webui.network'], 'true');
  // The policy fingerprint is a sha256 hex digest: valid as an annotation,
  // too long for a label value.
  assert.match(
    pod.metadata.annotations['ai.libre-webui.policy'],
    /^[a-f0-9]{64}$/
  );

  const spec = pod.spec;
  assert.equal(spec.restartPolicy, 'Never');
  assert.equal(spec.automountServiceAccountToken, false);
  assert.equal(spec.enableServiceLinks, false);
  assert.deepEqual(spec.securityContext, {
    runAsUser: 1000,
    runAsGroup: 1000,
    runAsNonRoot: true,
    fsGroup: 1000,
    fsGroupChangePolicy: 'OnRootMismatch',
    seccompProfile: { type: 'RuntimeDefault' },
  });

  const container = spec.containers[0];
  assert.equal(container.image, 'example.invalid/work@sha256:test');
  assert.deepEqual(container.command, ['tail', '-f', '/dev/null']);
  assert.equal(container.workingDir, '/workspace');
  assert.deepEqual(container.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  });
  assert.ok(container.resources.limits.memory);
  assert.ok(container.resources.limits.cpu);
  assert.ok(
    container.env.some(e => e.name === 'HOME' && e.value === '/tmp') &&
      container.env.some(e => e.name === 'NPM_CONFIG_CACHE')
  );

  const workspace = spec.volumes.find(v => v.name === 'workspace');
  assert.equal(workspace.persistentVolumeClaim.claimName, task.volumeName);
  const tmp = spec.volumes.find(v => v.name === 'tmp');
  assert.equal(tmp.emptyDir.sizeLimit, '512Mi');

  const serialized = JSON.stringify(pod);
  assert.doesNotMatch(serialized, /privileged|hostPath|hostNetwork|"root"/i);
});

test('host-folder workspaces are refused on the Kubernetes backend', () => {
  assert.throws(
    () => buildWorkPodManifest({ ...task, hostPath: '/Users/someone/code' }),
    error => error?.code === 'WORK_HOST_WORKSPACE_UNSUPPORTED'
  );
});

test('workspace claims are labeled for ownership and sized', () => {
  const claim = buildWorkspaceClaimManifest(task);
  assert.equal(claim.metadata.name, task.volumeName);
  assert.equal(claim.metadata.labels['ai.libre-webui.task'], task.id);
  assert.deepEqual(claim.spec.accessModes, ['ReadWriteOnce']);
  assert.equal(
    claim.spec.resources.requests.storage,
    WORK_KUBERNETES_DEFAULTS.workspaceSize
  );
});

test('resource quantities translate from Docker to Kubernetes forms', () => {
  assert.equal(dockerMemoryToKubernetes('2g'), '2Gi');
  assert.equal(dockerMemoryToKubernetes('1536m'), '1536Mi');
  assert.equal(dockerMemoryToKubernetes('512k'), '512Ki');
  // Docker's two-letter suffix spellings mean the same binary quantity.
  assert.equal(dockerMemoryToKubernetes('2gb'), '2Gi');
  assert.equal(dockerMemoryToKubernetes('2GB'), '2Gi');
  assert.equal(dockerMemoryToKubernetes('512mib'), '512Mi');
  // Already-Kubernetes values pass through untouched.
  assert.equal(dockerMemoryToKubernetes('2Gi'), '2Gi');
  assert.equal(dockerCpusToKubernetes('2'), '2');
  assert.equal(dockerCpusToKubernetes('0.5'), '500m');
  assert.equal(dockerCpusToKubernetes('1.5'), '1500m');
});

test('exec runs in /workspace natively and hops shells elsewhere', () => {
  assert.deepEqual(wrapCommandWithWorkdir(['ls', '-la']), ['ls', '-la']);
  assert.deepEqual(wrapCommandWithWorkdir(['ls'], '/workspace'), ['ls']);
  assert.deepEqual(
    wrapCommandWithWorkdir(['npm', 'run', 'dev'], '/workspace/app'),
    [
      '/bin/sh',
      '-c',
      'cd -- "$0" && exec "$@"',
      '/workspace/app',
      'npm',
      'run',
      'dev',
    ]
  );
});

test('pod phases map onto conservative runtime states', () => {
  assert.equal(mapPodPhase('Running'), 'running');
  // Pending and Unknown still hold execution intent: reconciliation and
  // stop must treat them as live, never as safely at rest.
  assert.equal(mapPodPhase('Pending'), 'running');
  assert.equal(mapPodPhase('Unknown'), 'running');
  assert.equal(mapPodPhase('Succeeded'), 'stopped');
  assert.equal(mapPodPhase('Failed'), 'stopped');
  assert.equal(mapPodPhase(undefined), 'absent');
});

test('exec status frames decode into process exit codes', () => {
  assert.equal(statusToExitCode({ status: 'Success' }), 0);
  assert.equal(
    statusToExitCode({
      status: 'Failure',
      reason: 'NonZeroExitCode',
      details: { causes: [{ reason: 'ExitCode', message: '42' }] },
    }),
    42
  );
  assert.equal(statusToExitCode(undefined), -1);
  assert.equal(statusToExitCode({ status: 'Failure' }), -1);
});

test('unavailability reasons are operator-actionable', () => {
  assert.match(
    describeKubernetesUnavailable({ code: 404 }, 'libre-webui-work'),
    /namespace "libre-webui-work" does not exist/
  );
  assert.match(
    describeKubernetesUnavailable({ code: 403 }, 'libre-webui-work'),
    /pods, pods\/exec, and persistentvolumeclaims/
  );
  assert.match(
    describeKubernetesUnavailable(
      new Error('connect ECONNREFUSED 10.0.0.1:6443'),
      'x'
    ),
    /No Kubernetes API server is reachable/
  );
});

test('the runtime backend is selected explicitly and fails loudly', () => {
  const {
    createWorkRuntimeDriver,
    DockerWorkRuntimeDriver,
    WorkRuntimeService,
  } = runtimeModule;
  const defaultDriver = createWorkRuntimeDriver(undefined);
  const dockerDriver = createWorkRuntimeDriver('docker');
  const kubernetesDriver = createWorkRuntimeDriver('kubernetes');
  assert.ok(defaultDriver instanceof DockerWorkRuntimeDriver);
  assert.ok(dockerDriver instanceof DockerWorkRuntimeDriver);
  assert.ok(kubernetesDriver instanceof KubernetesWorkRuntimeDriver);
  assert.equal(defaultDriver.kind, 'docker');
  assert.equal(dockerDriver.kind, 'docker');
  assert.equal(kubernetesDriver.kind, 'kubernetes');

  const dockerRuntime = new WorkRuntimeService(dockerDriver);
  const kubernetesRuntime = new WorkRuntimeService(kubernetesDriver);
  assert.equal(dockerRuntime.runtimeKind, 'docker');
  assert.equal(kubernetesRuntime.runtimeKind, 'kubernetes');
  dockerRuntime.beginShutdown();
  kubernetesRuntime.beginShutdown();

  assert.throws(
    () => createWorkRuntimeDriver('podman'),
    error => error?.code === 'WORK_RUNTIME_BACKEND_INVALID'
  );
});

test('terminal transport is available on the Kubernetes backend', () => {
  const driver = new KubernetesWorkRuntimeDriver();
  assert.equal(driver.terminalUnavailableReason(), null);
});
