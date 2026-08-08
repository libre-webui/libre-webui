import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-work-policies-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const databaseModule = await import(dist('db.js'));
const policyModule = await import(dist('services/workPolicyService.js'));
const sharedModule = await import(dist('services/workRuntimeShared.js'));
const driverModule = await import(dist('services/workRuntimeDriver.js'));
const kubernetesModule = await import(dist('services/workKubernetesDriver.js'));
const taskModule = await import(dist('services/workTaskService.js'));

const { workPolicyService, validateWorkPolicyInput } = policyModule;
const {
  computePolicyFingerprint,
  defaultRuntimePolicy,
  runtimePolicyFingerprint,
  workRuntimeConfig,
} = sharedModule;
const { buildWorkContainerRunArgs } = driverModule;
const { buildWorkPodManifest, buildWorkspaceClaimManifest } = kubernetesModule;

test.after(() => {
  databaseModule.closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const task = {
  id: 'policy-task-1',
  userId: 'policy-user',
  title: 'policy test',
  model: 'test',
  status: 'idle',
  networkEnabled: false,
  volumeName: 'libre-work-policy0001',
  containerName: 'libre-work-policy0001',
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

const optionValue = (args, flag) => args[args.indexOf(flag) + 1];

test('policy input validation accepts sane values and rejects the rest', () => {
  const valid = validateWorkPolicyInput({
    name: '  Heavy build  ',
    image: `example.invalid/build@sha256:${'ab'.repeat(32)}`,
    memoryLimit: '4g',
    cpuLimit: '3.5',
    pidsLimit: 512,
    networkDefault: false,
    workspaceSize: '20Gi',
    idleTimeoutMs: 600000,
  });
  assert.equal(valid.name, 'Heavy build');
  assert.equal(valid.memoryLimit, '4g');

  // Empty optional fields resolve to null (= inherit the global default).
  const sparse = validateWorkPolicyInput({ name: 'sparse' });
  assert.equal(sparse.image, null);
  assert.equal(sparse.networkDefault, null);

  // The image charset admits real-world references: bare names, tags,
  // private registries with ports, and pinned digests.
  for (const good of [
    'node',
    'node:22-bookworm',
    'localhost:5000/team/app:1.2',
    `ghcr.io/org/app@sha256:${'0'.repeat(64)}`,
  ]) {
    assert.equal(
      validateWorkPolicyInput({ name: 'ok', image: good }).image,
      good
    );
  }

  for (const bad of [
    { name: '' },
    { name: 'x'.repeat(101) },
    { name: 'ok', image: 'two words' },
    // A reference is anchored to the registry/repo charset, so nothing
    // flag-shaped can reach the container runtime.
    { name: 'ok', image: '--privileged' },
    { name: 'ok', image: '-rm' },
    { name: 'ok', image: 'node:22@sha256:abc' },
    { name: 'ok', memoryLimit: 'lots' },
    { name: 'ok', cpuLimit: '-1' },
    { name: 'ok', cpuLimit: '1000' },
    { name: 'ok', pidsLimit: 4 },
    { name: 'ok', workspaceSize: '5 gigs' },
    { name: 'ok', idleTimeoutMs: -5 },
  ]) {
    assert.throws(
      () => validateWorkPolicyInput(bad),
      error => error?.code === 'WORK_POLICY_INVALID',
      JSON.stringify(bad)
    );
  }
});

test('policies are created, listed, updated, and name-unique', () => {
  const created = workPolicyService.create({
    name: 'heavy',
    memoryLimit: '4g',
    cpuLimit: '4',
    idleTimeoutMs: 300000,
  });
  assert.equal(created.memoryLimit, '4g');
  assert.equal(created.image, undefined);

  assert.throws(
    () => workPolicyService.create({ name: 'heavy' }),
    error => error?.code === 'WORK_POLICY_NAME_CONFLICT'
  );

  const updated = workPolicyService.update(created.id, {
    name: 'heavy',
    memoryLimit: '8g',
  });
  assert.equal(updated.memoryLimit, '8g');
  // Fields omitted from the update are cleared back to inherit.
  assert.equal(updated.cpuLimit, undefined);

  workPolicyService.create({ name: 'light', cpuLimit: '1' });
  assert.deepEqual(
    workPolicyService.list().map(policy => policy.name),
    ['heavy', 'light']
  );
});

test('resolution merges policy overrides onto the global defaults', () => {
  assert.deepEqual(workPolicyService.resolve(undefined), defaultRuntimePolicy);
  assert.deepEqual(workPolicyService.resolve(null), defaultRuntimePolicy);
  // An unknown id resolves to the hardened defaults, never a failure.
  assert.deepEqual(
    workPolicyService.resolve('never-existed'),
    defaultRuntimePolicy
  );

  const heavy = workPolicyService.list().find(p => p.name === 'heavy');
  const resolved = workPolicyService.resolve(heavy.id);
  assert.equal(resolved.policyId, heavy.id);
  assert.equal(resolved.memoryLimit, '8g');
  // Unset fields inherit the global configuration.
  assert.equal(resolved.cpuLimit, workRuntimeConfig.cpuLimit);
  assert.equal(resolved.image, workRuntimeConfig.image);

  assert.equal(workPolicyService.anyIdleTimeoutConfigured(), false);
  workPolicyService.update(heavy.id, {
    name: 'heavy',
    memoryLimit: '8g',
    idleTimeoutMs: 60000,
  });
  assert.equal(workPolicyService.anyIdleTimeoutConfigured(), true);
});

test('the default-policy fingerprint is unchanged by the policy feature', () => {
  // Upgrade safety: tasks without a policy keep their exact pre-policy
  // fingerprint, so existing sandboxes are not recreated.
  assert.equal(
    computePolicyFingerprint(defaultRuntimePolicy),
    runtimePolicyFingerprint
  );
  assert.notEqual(
    computePolicyFingerprint({ ...defaultRuntimePolicy, memoryLimit: '8g' }),
    runtimePolicyFingerprint
  );
});

test('container args and Pod manifests are built from the resolved policy', () => {
  const policy = {
    policyId: 'p1',
    image: 'example.invalid/heavy@sha256:test',
    memoryLimit: '8g',
    cpuLimit: '4',
    pidsLimit: 512,
    idleTimeoutMs: 0,
    workspaceSize: '20Gi',
  };

  const args = buildWorkContainerRunArgs(task, policy);
  assert.equal(optionValue(args, '--memory'), '8g');
  assert.equal(optionValue(args, '--memory-swap'), '8g');
  assert.equal(optionValue(args, '--cpus'), '4');
  assert.equal(optionValue(args, '--pids-limit'), '512');
  assert.ok(args.includes(policy.image));
  assert.ok(
    args.includes(`ai.libre-webui.policy=${computePolicyFingerprint(policy)}`)
  );
  assert.ok(!args.includes(runtimePolicyFingerprint));

  const pod = buildWorkPodManifest(task, policy);
  assert.equal(pod.spec.containers[0].image, policy.image);
  assert.equal(pod.spec.containers[0].resources.limits.memory, '8Gi');
  assert.equal(pod.spec.containers[0].resources.limits.cpu, '4');
  assert.equal(
    pod.metadata.annotations['ai.libre-webui.policy'],
    computePolicyFingerprint(policy)
  );

  const claim = buildWorkspaceClaimManifest(task, policy.workspaceSize);
  assert.equal(claim.spec.resources.requests.storage, '20Gi');
});

test('tasks store their policy and fall back when it is deleted', () => {
  const db = databaseModule.getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO users (
      id, username, email, password_hash, role, created_at, updated_at
    ) VALUES ('policy-user', 'policy-user', 'p@example.invalid', 'x', 'admin', ?, ?)`
  ).run(now, now);

  const light = workPolicyService.list().find(p => p.name === 'light');
  const service = new taskModule.WorkTaskService();
  const detail = service.createTaskWithRun(
    'policy-user',
    'build something',
    'test-model',
    false,
    { providerType: 'ollama' },
    undefined,
    light.id
  );
  assert.equal(detail.policyId, light.id);
  const record = service.getTaskRecord(detail.id, 'policy-user');
  assert.equal(record.policyId, light.id);

  // Deleting the policy clears the reference (SET NULL semantics) and the
  // task resolves back to the global defaults.
  workPolicyService.remove(light.id);
  const after = service.getTaskRecord(detail.id, 'policy-user');
  assert.equal(after.policyId, undefined);
  assert.deepEqual(
    workPolicyService.resolve(after.policyId),
    defaultRuntimePolicy
  );
});

test('policy routes gate mutations behind admin and honor networkDefault', () => {
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'work.ts'),
    'utf8'
  );
  // Reading is open to Work users; every mutation requires admin.
  assert.match(source, /router\.get\(\s*'\/policies',\s*\(/);
  assert.match(source, /router\.post\(\s*'\/policies',\s*requireAdmin/);
  assert.match(source, /router\.put\(\s*'\/policies\/:id',\s*requireAdmin/);
  assert.match(source, /router\.delete\(\s*'\/policies\/:id',\s*requireAdmin/);
  // Task creation validates the policy and applies its network default.
  assert.match(source, /policy\?\.networkDefault \?\? true/);
  assert.match(source, /The selected Work policy no longer exists\./);
});
