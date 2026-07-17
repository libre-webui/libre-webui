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

test('Docker workflow publishes semantic version tags from release tags', () => {
  assert.match(dockerWorkflow, /tags: \['v\*'\]/);
  assert.match(dockerWorkflow, /type=semver,pattern=\{\{version\}\}/);
  assert.match(
    dockerWorkflow,
    /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\}/
  );
  assert.match(dockerWorkflow, /Release tag .* does not match package version/);
});
