import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
const dockerWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'docker-build.yml'),
  'utf8'
);
const formatWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'format.yml'),
  'utf8'
);
const releaseWorkflow = fs.readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);
const teamCompose = fs.readFileSync(
  path.join(repoRoot, 'docker-compose.team.yml'),
  'utf8'
);
const teamWorkCompose = fs.readFileSync(
  path.join(repoRoot, 'docker-compose.team.work.yml'),
  'utf8'
);
const teamEnvironmentExample = fs.readFileSync(
  path.join(repoRoot, 'deploy', 'team', '.env.example'),
  'utf8'
);
const teamTestCompose = fs.readFileSync(
  path.join(repoRoot, 'docker-compose.team.test.yml'),
  'utf8'
);
const teamPlatformTest = fs.readFileSync(
  path.join(repoRoot, 'scripts', 'test-team-platform.mjs'),
  'utf8'
);
const composeFiles = [
  'docker-compose.yml',
  'docker-compose.gpu.yml',
  'docker-compose.external-ollama.yml',
  'docker-compose.socket-proxy.yml',
  'docker-compose.dev.yml',
  'docker-compose.dev.gpu.yml',
  'docker-compose.dev.external-ollama.yml',
];

test('Docker install stages include the root postinstall script before npm ci', () => {
  const installStages = dockerfile
    .split(/^FROM /m)
    .slice(1)
    .filter(stage => stage.includes('RUN npm ci'));

  assert.equal(installStages.length, 4);

  for (const stage of installStages) {
    const copyIndex = stage.indexOf(
      'COPY scripts/postinstall.js ./scripts/postinstall.js'
    );
    const installIndex = stage.indexOf('RUN npm ci');

    assert.ok(copyIndex >= 0, 'install stage must copy scripts/postinstall.js');
    assert.ok(
      copyIndex < installIndex,
      'install stage must copy scripts/postinstall.js before npm ci'
    );
  }
});

test('Docker runtime includes non-hoisted backend workspace dependencies', () => {
  assert.match(
    dockerfile,
    /COPY --from=prod-deps \/app\/node_modules \.\/node_modules/
  );
  assert.match(
    dockerfile,
    /COPY --from=prod-deps \/app\/backend\/node_modules \.\/backend\/node_modules/
  );
});

test('Docker runtime exposes the packaged Libre maintenance CLI', () => {
  const runtimeStage = dockerfile.split(/^FROM /m).at(-1);
  assert.match(
    runtimeStage,
    /COPY bin\/cli\.js bin\/runtime-paths\.js \.\/bin\//
  );
  assert.match(runtimeStage, /chmod 0755 \/app\/bin\/cli\.js/);
  assert.match(
    runtimeStage,
    /ln -s \/app\/bin\/cli\.js \/usr\/local\/bin\/libre-webui/
  );
});

test('bare Docker image uses externally persistent runtime paths', () => {
  const runtimeStage = dockerfile.split(/^FROM /m).at(-1);
  assert.match(runtimeStage, /^ENV DOCKER_ENV=true$/m);
  assert.match(runtimeStage, /^ENV DATA_DIR=\/app\/backend\/data$/m);
  assert.match(
    runtimeStage,
    /^ENV PLATFORM_PREFLIGHT_TMP_DIR=\/app\/backend\/temp\/preflight$/m
  );
  assert.notEqual(
    path
      .relative('/app/backend/data', '/app/backend/temp/preflight')
      .split(path.sep)[0],
    '',
    'preflight scratch must not be the data directory'
  );
  assert.ok(
    path
      .relative('/app/backend/data', '/app/backend/temp/preflight')
      .startsWith('..'),
    'preflight scratch must remain outside DATA_DIR'
  );
});

test('Compose files expose only implemented signup behavior', () => {
  for (const filename of composeFiles) {
    const compose = fs.readFileSync(path.join(repoRoot, filename), 'utf8');
    assert.match(
      compose,
      /ENABLE_SIGNUP=\$\{ENABLE_SIGNUP:-false\}/,
      `${filename} must default signup closed`
    );
    assert.doesNotMatch(
      compose,
      /SINGLE_USER_MODE/,
      `${filename} must not advertise the removed unauthenticated mode`
    );
  }
});

test('Compose files forward every operable platform selector', () => {
  const platformVariables = [
    'LIBRE_PLATFORM_MODE',
    'DATABASE_BACKEND',
    'DATABASE_URL',
    'BLOB_STORE_BACKEND',
    'VECTOR_STORE_BACKEND',
    'COORDINATION_BACKEND',
    'REDIS_URL',
    'REDIS_KEY_PREFIX',
    'REDIS_CONNECT_TIMEOUT_MS',
    'JOB_WORKER_MODE',
    'STORAGE_ENCRYPTION_KEYS',
    'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
  ];
  for (const filename of composeFiles) {
    const compose = fs.readFileSync(path.join(repoRoot, filename), 'utf8');
    for (const variable of platformVariables) {
      assert.ok(
        compose.includes(`- ${variable}=\${${variable}`),
        `${filename} must forward ${variable}`
      );
    }
    assert.match(
      compose,
      /PLATFORM_PREFLIGHT_TMP_DIR=\/app\/backend\/temp\/preflight/,
      `${filename} must place startup inspection copies on the temp volume`
    );
  }

  const privateCompose = fs.readFileSync(
    path.join(repoRoot, 'deploy', 'private', 'docker-compose.yml'),
    'utf8'
  );
  for (const variable of platformVariables) {
    assert.match(
      privateCompose,
      new RegExp(`^\\s+${variable}: \\$\\{${variable}(?::[-?][^}]*)?\\}$`, 'm'),
      `private Compose must forward ${variable}`
    );
  }
  assert.match(
    privateCompose,
    /PLATFORM_PREFLIGHT_TMP_DIR: \/app\/backend\/temp\/preflight/
  );
  assert.match(privateCompose, /libre-webui-preflight:\/app\/backend\/temp/);
  assert.doesNotMatch(
    privateCompose,
    /\/app\/backend\/temp:rw,nosuid,nodev,noexec,size=512m/,
    'a valid database larger than 512 MiB must still be able to restart'
  );
  assert.match(
    dockerfile,
    /ENV PLATFORM_PREFLIGHT_TMP_DIR=\/app\/backend\/temp\/preflight/
  );
});

test('Dockerfile describes the repository socket default accurately', () => {
  assert.match(dockerfile, /default Compose file does mount the socket/);
  assert.doesNotMatch(dockerfile, /socket is never mounted by default/i);
});

test('team Compose forwards platform and provider tuning identically to app and worker', () => {
  const rendered = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        'libre-team-render-test',
        '-f',
        'docker-compose.team.yml',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          POSTGRES_PASSWORD: 'render-postgres-password',
          MINIO_ROOT_USER: 'render-minio-user',
          MINIO_ROOT_PASSWORD: 'render-minio-password',
          JWT_SECRET: '53'.repeat(32),
          ENCRYPTION_KEY: '31'.repeat(32),
          STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
          STORAGE_ENCRYPTION_KEYS: JSON.stringify({
            legacy: '31'.repeat(32),
            active: '42'.repeat(32),
          }),
          POSTGRES_MIGRATION_MODE: 'validate',
          POSTGRES_POOL_MAX: '7',
          POSTGRES_CONNECT_TIMEOUT_MS: '4000',
          POSTGRES_IDLE_TIMEOUT_MS: '20000',
          POSTGRES_STATEMENT_TIMEOUT_MS: '25000',
          POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: '45000',
          REDIS_CONNECT_TIMEOUT_MS: '3500',
          BLOB_QUOTA_BYTES_PER_USER: '8589934592',
          BLOB_QUOTA_RESERVATION_TTL_MS: '7200000',
          OLLAMA_TIMEOUT: '210000',
          OLLAMA_LONG_OPERATION_TIMEOUT: '610000',
          OLLAMA_MAX_CONTEXT: '65536',
        },
      }
    )
  );
  const expected = {
    POSTGRES_MIGRATION_MODE: 'validate',
    POSTGRES_POOL_MAX: '7',
    POSTGRES_CONNECT_TIMEOUT_MS: '4000',
    POSTGRES_IDLE_TIMEOUT_MS: '20000',
    POSTGRES_STATEMENT_TIMEOUT_MS: '25000',
    POSTGRES_MIGRATION_LOCK_TIMEOUT_MS: '45000',
    REDIS_CONNECT_TIMEOUT_MS: '3500',
    BLOB_QUOTA_BYTES_PER_USER: '8589934592',
    BLOB_QUOTA_RESERVATION_TTL_MS: '7200000',
    OLLAMA_TIMEOUT: '210000',
    OLLAMA_LONG_OPERATION_TIMEOUT: '610000',
    OLLAMA_MAX_CONTEXT: '65536',
    AGENT_CLI_MODELS_ENABLED: 'false',
    CODEX_OAUTH_MODELS_ENABLED: 'false',
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expected).map(name => [
        name,
        rendered.services['libre-webui'].environment[name],
      ])
    ),
    expected
  );
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(expected).map(name => [
        name,
        rendered.services['durable-worker'].environment[name],
      ])
    ),
    expected
  );
});

test('team environment example renders the shipped PostgreSQL and Work profiles', () => {
  const values = Object.fromEntries(
    teamEnvironmentExample
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const separator = line.indexOf('=');
        assert.ok(separator > 0, `invalid team environment line: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );
  for (const name of [
    'POSTGRES_PASSWORD',
    'MINIO_ROOT_USER',
    'MINIO_ROOT_PASSWORD',
    'JWT_SECRET',
    'ENCRYPTION_KEY',
    'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
    'STORAGE_ENCRYPTION_KEYS',
  ]) {
    assert.ok(values[name], `team environment example is missing ${name}`);
  }
  assert.match(values.POSTGRES_PASSWORD, /^REPLACE_WITH_[A-Z0-9_]+$/);
  assert.match(values.JWT_SECRET, /^REPLACE_WITH_[A-Z0-9_]+$/);
  assert.match(values.ENCRYPTION_KEY, /^REPLACE_WITH_[A-Z0-9_]+$/);
  const keyring = JSON.parse(values.STORAGE_ENCRYPTION_KEYS);
  assert.equal(keyring.legacy, values.ENCRYPTION_KEY);
  assert.equal(
    keyring[values.STORAGE_ENCRYPTION_ACTIVE_KEY_ID],
    'REPLACE_WITH_DIFFERENT_64_HEX_ACTIVE_KEY'
  );

  const rendered = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        'libre-team-example-render-test',
        '--env-file',
        'deploy/team/.env.example',
        '-f',
        'docker-compose.team.yml',
        '-f',
        'docker-compose.team.work.yml',
        'config',
        '--format',
        'json',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
  );
  for (const name of ['libre-webui', 'durable-worker']) {
    const environment = rendered.services[name].environment;
    assert.equal(environment.LIBRE_PLATFORM_MODE, 'team');
    assert.equal(environment.DATABASE_BACKEND, 'postgres');
    assert.equal(environment.BLOB_STORE_BACKEND, 's3');
    assert.equal(environment.VECTOR_STORE_BACKEND, 'pgvector');
    assert.equal(environment.COORDINATION_BACKEND, 'redis');
    assert.equal(environment.JOB_WORKER_MODE, 'external');
    assert.equal(environment.ENCRYPTION_KEY, values.ENCRYPTION_KEY);
    assert.equal(
      environment.STORAGE_ENCRYPTION_KEYS,
      values.STORAGE_ENCRYPTION_KEYS
    );
  }
  assert.equal(
    rendered.services.postgres.environment.POSTGRES_PASSWORD,
    values.POSTGRES_PASSWORD
  );
  assert.equal(
    rendered.services.minio.environment.MINIO_ROOT_USER,
    values.MINIO_ROOT_USER
  );
  assert.equal(
    rendered.services['docker-socket-proxy'].volumes[0].read_only,
    true
  );
});

test('team Work overlay gives only app and worker the filtered Docker endpoint', () => {
  const rendered = JSON.parse(
    execFileSync(
      'docker',
      [
        'compose',
        '--project-name',
        'libre-team-work-render-test',
        '-f',
        'docker-compose.team.yml',
        '-f',
        'docker-compose.team.work.yml',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
          ...process.env,
          POSTGRES_PASSWORD: 'render-postgres-password',
          MINIO_ROOT_USER: 'render-minio-user',
          MINIO_ROOT_PASSWORD: 'render-minio-password',
          JWT_SECRET: '53'.repeat(32),
          ENCRYPTION_KEY: '31'.repeat(32),
          STORAGE_ENCRYPTION_ACTIVE_KEY_ID: 'active',
          STORAGE_ENCRYPTION_KEYS: JSON.stringify({
            legacy: '31'.repeat(32),
            active: '42'.repeat(32),
          }),
        },
      }
    )
  );
  const app = rendered.services['libre-webui'];
  const worker = rendered.services['durable-worker'];
  const proxy = rendered.services['docker-socket-proxy'];
  const endpoint = 'tcp://docker-socket-proxy:2375';

  for (const [name, service] of [
    ['application', app],
    ['external worker', worker],
  ]) {
    assert.equal(service.environment.DOCKER_HOST, endpoint);
    assert.equal(service.environment.WORK_HOST_WORKSPACES_ENABLED, 'false');
    assert.doesNotMatch(
      JSON.stringify(service),
      /\/var\/run\/docker\.sock|group_add/,
      `${name} must receive neither the raw socket nor socket-group membership`
    );
  }

  const proxyNetworkUsers = Object.entries(rendered.services)
    .filter(([, service]) =>
      Object.keys(service.networks || {}).includes('docker-proxy')
    )
    .map(([name]) => name)
    .sort();
  assert.deepEqual(proxyNetworkUsers, [
    'docker-socket-proxy',
    'durable-worker',
    'libre-webui',
  ]);
  assert.equal(rendered.networks['docker-proxy'].internal, true);
  assert.equal(proxy.ports, undefined, 'proxy must publish no host port');
  assert.match(
    JSON.stringify(proxy.volumes),
    /\/var\/run\/docker\.sock.*\/var\/run\/docker\.sock.*read_only.*true/
  );

  const allowed = {
    CONTAINERS: '1',
    IMAGES: '1',
    VOLUMES: '1',
    NETWORKS: '1',
    EXEC: '1',
    INFO: '1',
    PING: '1',
    VERSION: '1',
    POST: '1',
  };
  assert.deepEqual(
    Object.fromEntries(
      Object.keys(allowed).map(name => [name, proxy.environment[name]])
    ),
    allowed
  );
  for (const denied of [
    'AUTH',
    'BUILD',
    'COMMIT',
    'CONFIGS',
    'DISTRIBUTION',
    'NODES',
    'PLUGINS',
    'SECRETS',
    'SERVICES',
    'SESSION',
    'SWARM',
    'SYSTEM',
    'TASKS',
  ]) {
    assert.equal(
      proxy.environment[denied],
      undefined,
      `proxy must not enable ${denied}`
    );
  }
  assert.equal(proxy.environment.EVENTS, '0');
  assert.match(
    teamWorkCompose,
    /image: tecnativa\/docker-socket-proxy:v0\.4\.2/
  );
  assert.match(
    teamWorkCompose,
    /API-surface reduction, not a tenant or host-security boundary/
  );
  assert.match(teamWorkCompose, /equivalent to control of the Docker host/);

  assert.doesNotMatch(teamTestCompose, /docker\.sock|group_add|TEST_DOCKER_/);
  assert.match(
    teamPlatformTest,
    /'docker-compose\.team\.yml',[\s\S]*'docker-compose\.team\.work\.yml',[\s\S]*'docker-compose\.team\.test\.yml'/,
    'real team drill must compose the exact shipped Work overlay'
  );
});

test('real-service CI uses the exact shipped team dependency image tags', () => {
  const composePostgres = teamCompose.match(
    /^  postgres:\n    image: (\S+)$/m
  )?.[1];
  const composeRedis = teamCompose.match(/^  redis:\n    image: (\S+)$/m)?.[1];
  const composeMinio = teamCompose.match(/^  minio:\n    image: (\S+)$/m)?.[1];
  const ciPostgres = formatWorkflow.match(
    /^      postgres:\n        image: (\S+)$/m
  )?.[1];
  const ciRedis = formatWorkflow.match(
    /^      redis:\n        image: (\S+)$/m
  )?.[1];
  const ciMinio = formatWorkflow.match(
    /^\s+minio\/(?:minio):([^\s]+) server \/data$/m
  )?.[1];
  const releasePreflight = releaseWorkflow.slice(
    releaseWorkflow.indexOf('  release-preflight:'),
    releaseWorkflow.indexOf('  create-release:')
  );
  const releasePostgres = releasePreflight.match(
    /^      postgres:\n        image: (\S+)$/m
  )?.[1];
  const releaseRedis = releasePreflight.match(
    /^      redis:\n        image: (\S+)$/m
  )?.[1];
  const releaseMinio = releasePreflight.match(
    /^\s+minio\/(?:minio):([^\s]+) server \/data$/m
  )?.[1];

  assert.equal(ciPostgres, composePostgres);
  assert.equal(ciRedis, composeRedis);
  assert.equal(ciMinio ? `minio/minio:${ciMinio}` : undefined, composeMinio);
  assert.equal(releasePostgres, composePostgres);
  assert.equal(releaseRedis, composeRedis);
  assert.equal(
    releaseMinio ? `minio/minio:${releaseMinio}` : undefined,
    composeMinio
  );
  const testStorageKey = '91'.repeat(32);
  for (const workflow of [formatWorkflow, releasePreflight]) {
    assert.match(
      workflow,
      new RegExp(`^\\s+TEST_STORAGE_ENCRYPTION_KEY: '${testStorageKey}'$`, 'm'),
      'workflow test key must remain a quoted YAML string'
    );
  }
});

test('tag release creation depends on real-service and three-replica preflight', () => {
  const preflightStart = releaseWorkflow.indexOf('  release-preflight:');
  const createStart = releaseWorkflow.indexOf('  create-release:');
  const dispatchStart = releaseWorkflow.indexOf('  dispatch-desktop-build:');
  assert.ok(preflightStart >= 0 && createStart > preflightStart);
  assert.ok(dispatchStart > createStart);
  const preflight = releaseWorkflow.slice(preflightStart, createStart);
  const createRelease = releaseWorkflow.slice(createStart, dispatchStart);

  assert.match(preflight, /run: npm run release:check/);
  assert.match(preflight, /run: npm run test:team-platform/);
  for (const name of [
    'TEST_POSTGRES_URL',
    'TEST_REDIS_URL',
    'TEST_S3_ENDPOINT',
    'TEST_S3_BUCKET',
    'TEST_S3_REGION',
    'TEST_S3_ACCESS_KEY_ID',
    'TEST_S3_SECRET_ACCESS_KEY',
    'TEST_STORAGE_ENCRYPTION_KEY',
    'TEST_TEAM_PLATFORM',
  ]) {
    assert.match(preflight, new RegExp(`^\\s+${name}:`, 'm'));
  }
  assert.match(createRelease, /^    needs: release-preflight$/m);
  assert.doesNotMatch(createRelease, /npm run release:check/);
});

test('Docker runtime exposes the injected development version to backend APIs', () => {
  const runtimeStage = dockerfile.split(/^FROM /m).at(-1);

  assert.match(runtimeStage, /ARG APP_VERSION/);
  assert.match(runtimeStage, /\.\/package\.json/);
  assert.match(runtimeStage, /\.\/backend\/package\.json/);
  assert.match(runtimeStage, /p\.version='\$APP_VERSION'/);
});

test('Docker workflow publishes semantic version tags from release tags', () => {
  assert.match(dockerWorkflow, /tags: \['v\*'\]/);
  assert.match(dockerWorkflow, /type=semver,pattern=\{\{version\}\}/);
  assert.match(
    dockerWorkflow,
    /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/
  );
  assert.match(dockerWorkflow, /Release tag .* does not match package version/);
});

test('Docker builds gate pull requests into every branch without publishing', () => {
  const triggerStart = dockerWorkflow.indexOf('\non:\n');
  const environmentStart = dockerWorkflow.indexOf('\nenv:\n');
  assert.notEqual(triggerStart, -1);
  assert.notEqual(environmentStart, -1);

  const triggers = dockerWorkflow.slice(triggerStart, environmentStart);
  const pullRequestStart = triggers.indexOf('  pull_request:\n');
  assert.notEqual(pullRequestStart, -1);
  assert.match(triggers.slice(pullRequestStart), /^  pull_request:\s*$/m);
  assert.doesNotMatch(
    triggers.slice(pullRequestStart),
    /^\s+branches:/m,
    'Docker builds must cover stacked pull requests'
  );

  assert.match(
    dockerWorkflow,
    /name: Log in to GitHub Container Registry\s+if: github\.event_name != 'pull_request'/
  );
  assert.match(
    dockerWorkflow,
    /push=\$\{\{ github\.event_name != 'pull_request' \}\}/
  );
  assert.match(
    dockerWorkflow,
    /merge:\s+if: github\.event_name != 'pull_request'/
  );
  assert.doesNotMatch(dockerWorkflow, /pull_request_target:/);
});

test('socket-proxy Compose variant keeps the Docker socket out of the app', () => {
  const compose = fs.readFileSync(
    path.join(repoRoot, 'docker-compose.socket-proxy.yml'),
    'utf8'
  );

  const services = compose.split(/^  (?=\S+:$)/m);
  const app = services.find(block => block.startsWith('libre-webui:'));
  const proxy = services.find(block =>
    block.startsWith('docker-socket-proxy:')
  );
  assert.ok(app, 'variant must define the libre-webui service');
  assert.ok(proxy, 'variant must define the docker-socket-proxy service');

  // The whole point: the app container gets a filtered tcp endpoint, never
  // the socket itself and never socket-group membership.
  assert.match(app, /DOCKER_HOST=tcp:\/\/docker-socket-proxy:2375/);
  assert.doesNotMatch(app, /docker\.sock/);
  assert.doesNotMatch(app, /group_add/);

  // The proxy holds the socket read-only, publishes no host ports, and
  // enables exactly the API sections Work uses.
  assert.match(proxy, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock:ro/);
  assert.doesNotMatch(proxy, /^\s+ports:/m);
  for (const section of [
    'CONTAINERS=1',
    'IMAGES=1',
    'VOLUMES=1',
    'NETWORKS=1',
    'EXEC=1',
    'INFO=1',
    'PING=1',
    'VERSION=1',
    'POST=1',
    'EVENTS=0',
  ]) {
    assert.ok(proxy.includes(section), `proxy must enable ${section}`);
  }
  for (const denied of [
    'SWARM=1',
    'SECRETS=1',
    'CONFIGS=1',
    'SERVICES=1',
    'BUILD=1',
    'COMMIT=1',
    'SYSTEM=1',
    'SESSION=1',
    'PLUGINS=1',
  ]) {
    assert.ok(!proxy.includes(denied), `proxy must not enable ${denied}`);
  }
  assert.match(proxy, /image: tecnativa\/docker-socket-proxy:v\d/);

  // The proxy network is internal: reachable from the app, not the host.
  assert.match(compose, /^  docker-proxy:\n(?:.*\n)*?\s+internal: true/m);
});
