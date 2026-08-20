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
    'TRUST_PROXY',
    'DATABASE_BACKEND',
    'DATABASE_SSL_MODE',
    'POSTGRES_MIGRATION_MODE',
    'POSTGRES_POOL_MAX',
    'POSTGRES_CONNECT_TIMEOUT_MS',
    'POSTGRES_IDLE_TIMEOUT_MS',
    'POSTGRES_STATEMENT_TIMEOUT_MS',
    'POSTGRES_MIGRATION_LOCK_TIMEOUT_MS',
    'BLOB_STORE_BACKEND',
    'BLOB_QUOTA_BYTES_PER_USER',
    'BLOB_QUOTA_RESERVATION_TTL_MS',
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
  assert.match(rendered, /- name: DATABASE_SSL_MODE\n\s+value: "verify-full"/);
  assert.match(rendered, /- name: POSTGRES_MIGRATION_MODE\n\s+value: "apply"/);
  assert.match(rendered, /- name: TRUST_PROXY\n\s+value: "0"/);
  assert.doesNotMatch(read('worker-deployment.yaml'), /name: TRUST_PROXY/);
  assert.match(
    rendered,
    /- name: PLATFORM_PREFLIGHT_TMP_DIR\n\s+value: "\/app\/backend\/temp\/preflight"/
  );
  assert.match(
    rendered,
    /- name: temp\n\s+emptyDir:\n\s+sizeLimit: "1Gi"/,
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
  assert.match(values, /seccompProfile:\n\s+type: RuntimeDefault/);
  assert.match(values, /allowPrivilegeEscalation: false/);
  assert.match(values, /readOnlyRootFilesystem: true/);
  assert.match(values, /capabilities:\n\s+drop:\n\s+- ALL/);
});

test('the chart keeps solo single-replica safety and admits only a complete team profile', t => {
  const deployment = read('deployment.yaml');
  assert.match(deployment, /Solo Libre WebUI requires replicaCount=0 or 1/);
  assert.match(deployment, /autoscaling requires the complete team profile/);
  assert.match(
    deployment,
    /Team mode requires PostgreSQL, S3, PGVector, Redis/
  );
  assert.match(deployment, /strategy:\n\s+type: Recreate/);
  assert.match(values, /^replicaCount: 1$/m);
  assert.match(values, /autoscaling:\n[\s\S]*?enabled: false/);
  assert.match(values, /autoscaling:\n[\s\S]*?maxReplicas: 1/);
  assert.match(values, /ENABLE_SIGNUP: ['"]false['"]/);
  assert.equal(valuesSchema.properties.replicaCount.minimum, 0);
  assert.equal(valuesSchema.properties.replicaCount.maximum, undefined);
  assert.equal(
    valuesSchema.properties.autoscaling.properties.minReplicas.minimum,
    1
  );
  assert.equal(
    valuesSchema.properties.autoscaling.properties.maxReplicas.minimum,
    1
  );
  const postgresSchema = valuesSchema.properties.env.properties;
  assert.deepEqual(
    [postgresSchema.TRUST_PROXY.minimum, postgresSchema.TRUST_PROXY.maximum],
    [0, 16]
  );
  assert.deepEqual(postgresSchema.DATABASE_SSL_MODE.enum, [
    'disable',
    'require',
    'verify-full',
  ]);
  assert.deepEqual(postgresSchema.POSTGRES_MIGRATION_MODE.enum, [
    'apply',
    'validate',
  ]);
  assert.deepEqual(
    [
      postgresSchema.POSTGRES_POOL_MAX.minimum,
      postgresSchema.POSTGRES_POOL_MAX.maximum,
    ],
    [1, 100]
  );
  for (const [name, maximum] of [
    ['POSTGRES_CONNECT_TIMEOUT_MS', 60_000],
    ['POSTGRES_IDLE_TIMEOUT_MS', 600_000],
    ['POSTGRES_STATEMENT_TIMEOUT_MS', 600_000],
    ['POSTGRES_MIGRATION_LOCK_TIMEOUT_MS', 600_000],
  ]) {
    assert.equal(postgresSchema[name].minimum, 1);
    assert.equal(postgresSchema[name].maximum, maximum);
  }
  assert.deepEqual(
    [
      postgresSchema.BLOB_QUOTA_BYTES_PER_USER.minimum,
      postgresSchema.BLOB_QUOTA_BYTES_PER_USER.maximum,
    ],
    [1, Number.MAX_SAFE_INTEGER]
  );
  assert.deepEqual(
    [
      postgresSchema.BLOB_QUOTA_RESERVATION_TTL_MS.minimum,
      postgresSchema.BLOB_QUOTA_RESERVATION_TTL_MS.maximum,
    ],
    [60_000, Number.MAX_SAFE_INTEGER]
  );
  for (const name of ['OLLAMA_TIMEOUT', 'OLLAMA_LONG_OPERATION_TIMEOUT']) {
    assert.deepEqual(
      [postgresSchema[name].minimum, postgresSchema[name].maximum],
      [1_000, 3_600_000]
    );
  }
  assert.deepEqual(
    [
      postgresSchema.OLLAMA_MAX_CONTEXT.minimum,
      postgresSchema.OLLAMA_MAX_CONTEXT.maximum,
    ],
    [128, 2_097_152]
  );
  assert.deepEqual(postgresSchema.AGENT_CLI_MODELS_ENABLED.enum, [
    'false',
    'true',
  ]);
  assert.deepEqual(postgresSchema.CODEX_OAUTH_MODELS_ENABLED.enum, [
    'false',
    'true',
  ]);

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
  assert.match(
    rendered,
    /- name: BLOB_QUOTA_BYTES_PER_USER\n\s+value: "10737418240"/
  );
  assert.match(
    rendered,
    /- name: BLOB_QUOTA_RESERVATION_TTL_MS\n\s+value: "3600000"/
  );
  assert.doesNotMatch(rendered, /SINGLE_USER_MODE/);

  for (const invalid of [
    'env.DATABASE_SSL_MODE=prefer',
    'env.POSTGRES_MIGRATION_MODE=unsafe',
    'env.POSTGRES_POOL_MAX=0',
    'env.POSTGRES_CONNECT_TIMEOUT_MS=60001',
    'env.POSTGRES_IDLE_TIMEOUT_MS=600001',
    'env.POSTGRES_STATEMENT_TIMEOUT_MS=0',
    'env.POSTGRES_MIGRATION_LOCK_TIMEOUT_MS=600001',
    'env.BLOB_QUOTA_BYTES_PER_USER=0',
    'env.BLOB_QUOTA_RESERVATION_TTL_MS=59999',
    'env.OLLAMA_TIMEOUT=999',
    'env.OLLAMA_LONG_OPERATION_TIMEOUT=3600001',
    'env.OLLAMA_MAX_CONTEXT=127',
    'env.OLLAMA_MAX_CONTEXT=2097153',
    'env.TRUST_PROXY=-1',
    'env.TRUST_PROXY=17',
  ]) {
    assert.throws(
      () =>
        execFileSync(
          'helm',
          ['template', 'render-test', chartDir, '--set', invalid],
          { encoding: 'utf8', stdio: 'pipe' }
        ),
      new RegExp(invalid.slice(4, invalid.indexOf('=')))
    );
  }
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [
          'template',
          'render-test',
          chartDir,
          '--set',
          'env.OLLAMA_TIMEOUT=3000000',
          '--set',
          'env.OLLAMA_LONG_OPERATION_TIMEOUT=2999999',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /OLLAMA_LONG_OPERATION_TIMEOUT/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [
          'template',
          'render-test',
          chartDir,
          '--set-string',
          'env.TRUST_PROXY=true',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /TRUST_PROXY|integer/
  );

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
    /autoscaling|complete team profile/
  );

  const teamArguments = [
    'template',
    'render-test',
    chartDir,
    '--set',
    'replicaCount=3',
    '--set',
    'env.LIBRE_PLATFORM_MODE=team',
    '--set',
    'env.DATABASE_BACKEND=postgres',
    '--set',
    'env.DATABASE_SSL_MODE=require',
    '--set',
    'env.POSTGRES_MIGRATION_MODE=validate',
    '--set',
    'env.POSTGRES_POOL_MAX=7',
    '--set',
    'env.POSTGRES_CONNECT_TIMEOUT_MS=4000',
    '--set',
    'env.POSTGRES_IDLE_TIMEOUT_MS=20000',
    '--set',
    'env.POSTGRES_STATEMENT_TIMEOUT_MS=25000',
    '--set',
    'env.POSTGRES_MIGRATION_LOCK_TIMEOUT_MS=45000',
    '--set',
    'env.BLOB_QUOTA_BYTES_PER_USER=8589934592',
    '--set',
    'env.BLOB_QUOTA_RESERVATION_TTL_MS=7200000',
    '--set',
    'env.OLLAMA_MAX_CONTEXT=65536',
    '--set',
    'env.TRUST_PROXY=2',
    '--set',
    'env.BLOB_STORE_BACKEND=s3',
    '--set',
    'env.VECTOR_STORE_BACKEND=pgvector',
    '--set',
    'env.COORDINATION_BACKEND=redis',
    '--set',
    'env.JOB_WORKER_MODE=external',
    '--set',
    'env.STORAGE_ENCRYPTION_ACTIVE_KEY_ID=active',
    '--set',
    'env.S3_BUCKET=libre-test',
    '--set',
    'env.S3_REGION=us-east-1',
    '--set',
    'ollama.bundled.enabled=false',
    '--set',
    'ollama.external.enabled=true',
    '--set-string',
    'ollama.external.url=http://ollama.shared.svc:11434',
    '--set',
    'work.enabled=true',
    '--set-string',
    'work.storageClass=fast-storage',
    '--set-string',
    'work.runtimeImage=registry.example.test/libre-work@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    '--set',
    'work.env.WORK_MAX_CONCURRENT_RUNS=7',
    '--set',
    'secrets.databaseUrl=postgresql://database/libre',
    '--set',
    'secrets.redisUrl=redis://redis:6379/0',
    '--set-string',
    'secrets.jwtSecret=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    '--set-string',
    'secrets.encryptionKey=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    '--set-literal',
    'secrets.storageEncryptionKeys={"legacy":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","active":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
  ];
  const team = execFileSync('helm', teamArguments, { encoding: 'utf8' });
  assert.match(team, /replicas: 3/);
  assert.equal(
    team.match(/strategy:\n\s+(?:#[^\n]*\n\s+)*type: Recreate/g)?.length,
    2,
    'each Deployment must prevent its own old/new pods from overlapping; the runbook coordinates the app and worker pre-drain'
  );
  assert.doesNotMatch(team, /type: RollingUpdate/);
  assert.match(team, /name: render-test-libre-webui-worker/);
  assert.match(
    team,
    /command:\s*(?:\["node", "backend\/dist\/worker\.js"\]|\n\s+- node\n\s+- backend\/dist\/worker\.js)/
  );
  assert.match(team, /- name: DATA_DIR\n\s+value: "?\/tmp\/libre-data"?/);
  assert.match(team, /- name: ENCRYPTION_KEY\n\s+valueFrom:/);
  assert.equal(
    team.match(/- name: JWT_SECRET\n\s+valueFrom:/g)?.length,
    2,
    'the same stable JWT Secret must reach every app and worker process'
  );
  assert.match(team, /emptyDir:\n\s+sizeLimit: "1Gi"/);
  assert.doesNotMatch(team, /mountPath: \/app\/backend\/data/);
  assert.doesNotMatch(team, /name: render-test-libre-webui-data/);
  assert.equal(
    team.match(/- name: TRUST_PROXY\n\s+value: "2"/g)?.length,
    1,
    'only the HTTP application receives the exact proxy-hop policy'
  );
  for (const name of [
    'AGENT_CLI_MODELS_ENABLED',
    'CODEX_OAUTH_MODELS_ENABLED',
  ]) {
    assert.equal(
      team.match(new RegExp(`- name: ${name}\\n\\s+value: "false"`, 'g'))
        ?.length,
      2,
      `${name} must be explicitly disabled in both team processes`
    );
  }
  for (const name of [
    'AGENT_CLI_MODELS_ENABLED',
    'CODEX_OAUTH_MODELS_ENABLED',
  ]) {
    assert.throws(
      () =>
        execFileSync(
          'helm',
          [...teamArguments, '--set-string', `env.${name}=true`],
          {
            encoding: 'utf8',
            stdio: 'pipe',
          }
        ),
      /node-local Agent CLI or Codex OAuth/
    );
  }
  for (const [name, value] of [
    ['DATABASE_SSL_MODE', 'require'],
    ['POSTGRES_MIGRATION_MODE', 'validate'],
    ['POSTGRES_POOL_MAX', '7'],
    ['POSTGRES_CONNECT_TIMEOUT_MS', '4000'],
    ['POSTGRES_IDLE_TIMEOUT_MS', '20000'],
    ['POSTGRES_STATEMENT_TIMEOUT_MS', '25000'],
    ['POSTGRES_MIGRATION_LOCK_TIMEOUT_MS', '45000'],
    ['BLOB_QUOTA_BYTES_PER_USER', '8589934592'],
    ['BLOB_QUOTA_RESERVATION_TTL_MS', '7200000'],
    ['OLLAMA_BASE_URL', 'http://ollama.shared.svc:11434'],
    ['OLLAMA_TIMEOUT', '300000'],
    ['OLLAMA_LONG_OPERATION_TIMEOUT', '900000'],
    ['OLLAMA_MAX_CONTEXT', '65536'],
    ['WORK_K8S_STORAGE_CLASS', 'fast-storage'],
    [
      'WORK_RUNTIME_IMAGE',
      'registry.example.test/libre-work@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    ],
    ['WORK_MAX_CONCURRENT_RUNS', '7'],
  ]) {
    const renderedInAppAndWorker = team.match(
      new RegExp(`- name: ${name}\\n\\s+value: ["']?${value}["']?`, 'g')
    );
    assert.equal(
      renderedInAppAndWorker?.length,
      2,
      `${name} must render identically in the app and external worker`
    );
  }
  assert.throws(
    () =>
      execFileSync(
        'helm',
        teamArguments.map(argument =>
          argument === 'env.DATABASE_BACKEND=postgres'
            ? 'env.DATABASE_BACKEND=sqlite'
            : argument
        ),
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /Team mode requires/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        teamArguments.map(argument =>
          argument.startsWith('secrets.jwtSecret=')
            ? 'secrets.jwtSecret='
            : argument
        ),
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /stable JWT|Team mode requires/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        teamArguments.map(argument =>
          argument.startsWith('secrets.jwtSecret=')
            ? 'secrets.jwtSecret=   '
            : argument
        ),
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /stable JWT|Team mode requires|values don't meet the specifications/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [...teamArguments, '--set', 'worker.replicaCount=0'],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /active team application requires worker\.replicaCount>=1/
  );
  assert.throws(
    () =>
      execFileSync(
        'helm',
        [
          ...teamArguments,
          '--set',
          'replicaCount=0',
          '--set',
          'autoscaling.enabled=true',
          '--set',
          'worker.replicaCount=0',
        ],
        { encoding: 'utf8', stdio: 'pipe' }
      ),
    /active team application requires worker\.replicaCount>=1/
  );
  const suspendedTeam = execFileSync(
    'helm',
    [
      ...teamArguments,
      '--set',
      'replicaCount=0',
      '--set',
      'worker.replicaCount=0',
    ],
    { encoding: 'utf8' }
  );
  assert.match(
    suspendedTeam,
    /name: render-test-libre-webui\n[\s\S]*?spec:\n[\s\S]*?replicas: 0/
  );
  assert.match(
    suspendedTeam,
    /name: render-test-libre-webui-worker\n[\s\S]*?spec:\n\s+replicas: 0/
  );
  const workerOnlyTeam = execFileSync(
    'helm',
    [...teamArguments, '--set', 'replicaCount=0'],
    { encoding: 'utf8' }
  );
  assert.match(
    workerOnlyTeam,
    /name: render-test-libre-webui-worker\n[\s\S]*?spec:\n\s+replicas: 1/
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

test('an operator-managed existing secret replaces the rendered Secret', () => {
  const secrets = read('secrets.yaml');
  assert.match(
    secrets,
    /^\{\{- if not \.Values\.secrets\.existingSecret \}\}/,
    'the chart must not render a Secret when one is referenced'
  );
  const helpers = read('_helpers.tpl');
  assert.match(helpers, /define "libre-webui\.secretName"/);
  assert.match(helpers, /\.Values\.secrets\.existingSecret/);
  for (const template of ['deployment.yaml', 'worker-deployment.yaml']) {
    const rendered = read(template);
    assert.doesNotMatch(
      rendered,
      /fullname" \. \}\}-secrets/,
      `${template} must resolve the secret name through the helper`
    );
    assert.match(rendered, /libre-webui\.secretName/);
  }
  const deployment = read('deployment.yaml');
  assert.match(
    deployment,
    /Team mode with secrets\.existingSecret still requires/,
    'team prerequisites stay fail-closed with an external secret'
  );
  assert.match(values, /^\s+existingSecret: ''$/m);
  assert.equal(
    typeof valuesSchema.properties.secrets.properties.existingSecret,
    'object'
  );
});

test('application NetworkPolicies default-deny ingress beyond the app port', () => {
  const policy = read('app-networkpolicy.yaml');
  assert.match(policy, /^\{\{- if \.Values\.networkPolicy\.enabled \}\}/);
  assert.match(policy, /policyTypes:\n\s+- Ingress/);
  assert.match(policy, /port: 3001/);
  assert.match(
    policy,
    /ingress: \[\]/,
    'the durable worker accepts no ingress at all'
  );
  assert.match(values, /^networkPolicy:\n\s+enabled: false$/m);
});
