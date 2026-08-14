import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflowPath = '.github/workflows/security.yml';
const workflow = fs.readFileSync(path.join(repoRoot, workflowPath), 'utf8');

function getJob(jobName) {
  const marker = `  ${jobName}:\n`;
  const start = workflow.indexOf(marker, workflow.indexOf('\njobs:\n'));
  assert.notEqual(start, -1, `${workflowPath} must define ${jobName}`);
  const remainder = workflow.slice(start + marker.length);
  const nextJobOffset = remainder.search(/\n  [a-z0-9-]+:\n/);
  return nextJobOffset === -1
    ? workflow.slice(start)
    : workflow.slice(start, start + marker.length + nextJobOffset);
}

test('security workflow runs on normal pushes and every pull request', () => {
  const triggers = workflow.slice(
    workflow.indexOf('\non:\n'),
    workflow.indexOf('\njobs:\n')
  );
  assert.match(triggers, /push:\n\s+branches: \[dev, main\]/);
  assert.match(triggers, /^  pull_request:\s*$/m);
  assert.doesNotMatch(triggers, /pull_request_target:/);
  assert.doesNotMatch(
    triggers.slice(triggers.indexOf('  pull_request:')),
    /^\s+branches:/m
  );
});

test('security workflow covers dependency, SAST, secret, SBOM, and image gates', () => {
  const dependency = getJob('dependency-and-sbom');
  const codeql = getJob('codeql-default-setup');
  const secrets = getJob('secret-scan');
  const container = getJob('container-scan');

  assert.match(dependency, /npm audit --audit-level=moderate --json/);
  assert.match(dependency, /uses: anchore\/sbom-action@v0/);
  assert.match(dependency, /format: cyclonedx-json/);
  assert.match(codeql, /security-events: read/);
  assert.match(codeql, /code-scanning\/default-setup/);
  assert.match(codeql, /\.state == "configured"/);
  assert.match(codeql, /index\("javascript-typescript"\)/);
  assert.doesNotMatch(codeql, /github\/codeql-action\/(?:init|analyze)@/);
  assert.match(secrets, /uses: aquasecurity\/trivy-action@v0\.36\.0/);
  assert.match(secrets, /scanners: secret/);
  assert.match(container, /uses: docker\/build-push-action@v7/);
  assert.match(container, /push: false/);
  assert.match(container, /image: libre-webui:security-/);
  assert.match(container, /scanners: vuln/);
  assert.match(container, /severity: HIGH,CRITICAL/);
});

test('scanner reports are retained and tolerated scans are re-enforced', () => {
  const dependency = getJob('dependency-and-sbom');
  const secrets = getJob('secret-scan');
  const container = getJob('container-scan');

  for (const [name, job] of Object.entries({
    dependency,
    secrets,
    container,
  })) {
    assert.match(job, /retention-days: 30|upload-artifact-retention: 30/);
    assert.match(job, /if: always\(\)/);
    assert.match(job, /if-no-files-found: error/);
    assert.match(job, /exit 1/, `${name} must end with a failing gate`);
  }

  assert.match(dependency, /if: steps\.dependency-audit\.outcome == 'failure'/);
  assert.match(secrets, /if: steps\.trivy-secrets\.outcome == 'failure'/);
  assert.match(container, /if: steps\.trivy-container\.outcome == 'failure'/);
  assert.match(secrets, /uses: github\/codeql-action\/upload-sarif@v4/);
  assert.match(container, /uses: github\/codeql-action\/upload-sarif@v4/);
});
