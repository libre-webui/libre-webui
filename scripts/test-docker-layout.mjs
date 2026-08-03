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
