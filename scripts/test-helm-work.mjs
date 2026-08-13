import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const chartDir = path.join(repoRoot, 'helm', 'libre-webui');

const read = name =>
  fs.readFileSync(path.join(chartDir, 'templates', name), 'utf8');
const values = fs.readFileSync(path.join(chartDir, 'values.yaml'), 'utf8');
const valuesSchema = JSON.parse(
  fs.readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8')
);

test('Work stays fully disabled by default in the Helm chart', () => {
  assert.match(values, /^work:\n\s+enabled: false$/m);
  for (const template of [
    'work-namespace.yaml',
    'work-rbac.yaml',
    'work-networkpolicy.yaml',
  ]) {
    assert.match(
      read(template),
      /^\{\{- if (and )?\.Values\.work\.enabled/,
      `${template} must be gated on work.enabled`
    );
  }
});

test('the Work Role grants exactly the driver surface, nothing else', () => {
  const rbac = read('work-rbac.yaml');
  assert.match(
    rbac,
    /resources: \['pods'\]\n\s+verbs: \['get', 'list', 'create', 'delete'\]/
  );
  // WebSocket exec arrives as a get; SPDY exec is a create. Both, nothing more.
  assert.match(
    rbac,
    /resources: \['pods\/exec'\][\s\S]{0,200}verbs: \['get', 'create'\]/
  );
  assert.match(
    rbac,
    /resources: \['persistentvolumeclaims'\][\s\S]{0,300}verbs: \['get', 'list', 'create', 'delete'\]/
  );
  assert.doesNotMatch(
    rbac,
    /resources: \[[^\]]*(secrets|nodes|configmaps|deployments)/
  );
  assert.doesNotMatch(rbac, /kind: ClusterRole/);
  // Namespace-scoped: a Role bound in the sandbox namespace.
  assert.match(rbac, /kind: Role\n/);
  assert.match(rbac, /namespace: \{\{ \.Values\.work\.namespace \}\}/);
});

test('sandbox NetworkPolicies default-deny and carve out only preview and egress', () => {
  const netpol = read('work-networkpolicy.yaml');
  // Default deny both directions for every managed sandbox.
  assert.match(
    netpol,
    /-work-default-deny[\s\S]{0,400}policyTypes:\n\s+- Ingress\n\s+- Egress/
  );
  // Ingress only from the backend, only on the preview port.
  assert.match(netpol, /-work-preview-ingress[\s\S]{0,900}port: 4173/);
  assert.match(
    netpol,
    /kubernetes\.io\/metadata\.name: \{\{ \.Release\.Namespace \}\}/
  );
  // Egress only for network-enabled sandboxes, world minus blocked ranges.
  assert.match(netpol, /ai\.libre-webui\.network: 'true'/);
  assert.match(netpol, /cidr: 0\.0\.0\.0\/0/);
  // The blocked ranges must include the metadata/link-local range by default.
  assert.match(values, /- 169\.254\.0\.0\/16/);
  assert.match(values, /- 10\.0\.0\.0\/8/);
});

test('enabling Work switches the backend to the Kubernetes runtime', () => {
  const deployment = read('deployment.yaml');
  assert.match(
    deployment,
    /\{\{- if \.Values\.work\.enabled \}\}[\s\S]{0,200}WORK_RUNTIME_BACKEND\n\s+value: 'kubernetes'/
  );
  assert.match(deployment, /WORK_K8S_NAMESPACE/);
  assert.match(deployment, /WORK_K8S_WORKSPACE_SIZE/);
});

test('deployment probes separate process liveness from dependency readiness', () => {
  const deployment = read('deployment.yaml');
  assert.match(deployment, /startupProbe:[\s\S]{0,220}path: \/health\/live/);
  assert.match(deployment, /startupProbe:[\s\S]{0,300}failureThreshold: 120/);
  assert.match(deployment, /livenessProbe:[\s\S]{0,180}path: \/health\/live/);
  assert.match(deployment, /readinessProbe:[\s\S]{0,180}path: \/health\/ready/);
  assert.doesNotMatch(
    deployment,
    /(?:livenessProbe|readinessProbe):[\s\S]{0,120}path: \/health\s*$/m
  );
});

test('the chart renders platform selectors and secret connection material', t => {
  const deployment = read('deployment.yaml');
  for (const variable of [
    'LIBRE_PLATFORM_MODE',
    'DATABASE_BACKEND',
    'BLOB_STORE_BACKEND',
    'VECTOR_STORE_BACKEND',
    'COORDINATION_BACKEND',
    'REDIS_KEY_PREFIX',
    'REDIS_CONNECT_TIMEOUT_MS',
    'JOB_WORKER_MODE',
    'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
    'PLATFORM_PREFLIGHT_TMP_DIR',
  ]) {
    assert.match(deployment, new RegExp(`- name: ${variable}`));
  }
  for (const variable of [
    'DATABASE_URL',
    'REDIS_URL',
    'STORAGE_ENCRYPTION_KEYS',
  ]) {
    assert.match(deployment, new RegExp(`- name: ${variable}`));
  }

  try {
    execFileSync('helm', ['version', '--short'], { encoding: 'utf8' });
  } catch {
    t.skip('helm binary not available');
    return;
  }
  const rendered = execFileSync(
    'helm',
    [
      'template',
      'platform-test',
      chartDir,
      '--set-string',
      'env.COORDINATION_BACKEND=redis',
      '--set-string',
      'env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID=active',
      '--set-string',
      'secrets.redisUrl=redis://redis.example.test:6379/0',
      '--set-string',
      'secrets.storageEncryptionKeys=fixture-key-map',
    ],
    { encoding: 'utf8' }
  );
  assert.match(rendered, /- name: COORDINATION_BACKEND\n\s+value: "redis"/);
  assert.match(
    rendered,
    /- name: PLATFORM_PREFLIGHT_TMP_DIR\n\s+value: "\/app\/backend\/temp\/preflight"/
  );
  assert.match(
    rendered,
    /- name: temp\n\s+emptyDir: \{\}/,
    'startup inspection scratch must use the pod temp volume rather than the data PVC'
  );
  assert.match(rendered, /- name: REDIS_URL\n\s+valueFrom:/);
  assert.match(rendered, /- name: STORAGE_ENCRYPTION_KEYS\n\s+valueFrom:/);
  assert.match(
    rendered,
    /- name: STORAGE_ENCRYPTION_ACTIVE_KEY_ID\n\s+value: "active"/
  );
  assert.match(rendered, /redis-url:/);
  assert.match(rendered, /storage-encryption-keys:/);
});

test('the chart makes its data PVC writable by the non-root process', () => {
  assert.match(values, /podSecurityContext:[\s\S]*?fsGroup: 1001/);
  assert.match(values, /fsGroupChangePolicy: OnRootMismatch/);
  assert.match(values, /securityContext:\n\s+runAsNonRoot: true/);
  assert.match(values, /runAsUser: 1001/);
});

test('the chart rejects unsafe application replicas and autoscaling', t => {
  const deployment = read('deployment.yaml');
  assert.match(deployment, /requires replicaCount=0 or 1/);
  assert.match(deployment, /autoscaling is disabled/);
  assert.match(deployment, /strategy:\n\s+type: Recreate/);
  assert.match(values, /^replicaCount: 1$/m);
  assert.match(values, /autoscaling:\n[\s\S]*?enabled: false/);
  assert.match(values, /autoscaling:\n[\s\S]*?maxReplicas: 1/);
  assert.match(values, /ENABLE_SIGNUP: ['"]false['"]/);
  assert.equal(valuesSchema.properties.replicaCount.minimum, 0);
  assert.equal(valuesSchema.properties.replicaCount.maximum, 1);
  assert.equal(
    valuesSchema.properties.autoscaling.properties.enabled.const,
    false
  );
  assert.equal(
    valuesSchema.properties.autoscaling.properties.minReplicas.const,
    1
  );
  assert.equal(
    valuesSchema.properties.autoscaling.properties.maxReplicas.const,
    1
  );

  try {
    execFileSync('helm', ['version', '--short'], { encoding: 'utf8' });
  } catch {
    t.skip('helm binary not available');
    return;
  }

  const rendered = execFileSync('helm', ['template', 'render-test', chartDir], {
    encoding: 'utf8',
  });
  assert.match(rendered, /replicas: 1/);
  assert.match(rendered, /strategy:\n\s+type: Recreate/);
  assert.match(rendered, /- name: ENABLE_SIGNUP\n\s+value: "false"/);
  assert.doesNotMatch(rendered, /SINGLE_USER_MODE/);

  const suspended = execFileSync(
    'helm',
    ['template', 'render-test', chartDir, '--set', 'replicaCount=0'],
    { encoding: 'utf8' }
  );
  assert.match(suspended, /replicas: 0/);

  for (const unsafeReplicaCount of [-1, 2]) {
    assert.throws(
      () =>
        execFileSync(
          'helm',
          [
            'template',
            'render-test',
            chartDir,
            '--set',
            `replicaCount=${unsafeReplicaCount}`,
          ],
          { encoding: 'utf8', stdio: 'pipe' }
        ),
      /replicaCount|requires replicaCount=0 or 1/
    );
  }
  assert.throws(
    () =>
      execFileSync(
        'helm',
        ['template', 'render-test', chartDir, '--set', 'replicaCount=0.5'],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /replicaCount|integer/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [
          'template',
          'render-test',
          chartDir,
          '--set',
          'autoscaling.enabled=true',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /autoscaling|disabled/
  );
});

test('the chart renders cleanly with Work enabled when helm is available', t => {
  let helm;
  try {
    helm = execFileSync('helm', ['version', '--short'], { encoding: 'utf8' });
  } catch {
    t.skip('helm binary not available');
    return;
  }
  assert.ok(helm);
  const rendered = execFileSync(
    'helm',
    ['template', 'render-test', chartDir, '--set', 'work.enabled=true'],
    { encoding: 'utf8' }
  );
  const kinds = [...rendered.matchAll(/^kind: (.+)$/gm)].map(m => m[1]);
  assert.equal(kinds.filter(k => k === 'NetworkPolicy').length, 3);
  assert.equal(kinds.filter(k => k === 'Role').length, 1);
  assert.equal(kinds.filter(k => k === 'RoleBinding').length, 1);
  assert.equal(kinds.filter(k => k === 'Namespace').length, 1);

  const renderedDisabled = execFileSync(
    'helm',
    ['template', 'render-test', chartDir],
    { encoding: 'utf8' }
  );
  assert.doesNotMatch(
    renderedDisabled,
    /NetworkPolicy|RoleBinding|WORK_RUNTIME_BACKEND/
  );
});
