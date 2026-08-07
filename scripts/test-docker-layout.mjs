import assert from 'node:assert/strict';
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
    'POST=1',
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
