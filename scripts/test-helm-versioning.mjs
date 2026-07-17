import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { ReleaseManager, releaseFiles } = require('./release.js');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');

function readVersion(content, key) {
  const match = content.match(
    new RegExp(`^${key}:\\s*["']?([^"'\\s#]+)["']?`, 'm')
  );
  assert.ok(match, `expected ${key} in Helm chart`);
  return match[1];
}

function createTempProject(chart) {
  const projectRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'libre-webui-helm-version-')
  );
  const chartDir = path.join(projectRoot, 'helm', 'libre-webui');
  fs.mkdirSync(chartDir, { recursive: true });
  fs.writeFileSync(path.join(chartDir, 'Chart.yaml'), chart);
  return projectRoot;
}

test('checked-in Helm versions match the application version', () => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  );
  const chart = fs.readFileSync(
    path.join(repoRoot, 'helm', 'libre-webui', 'Chart.yaml'),
    'utf8'
  );

  assert.equal(readVersion(chart, 'version'), packageJson.version);
  assert.equal(readVersion(chart, 'appVersion'), packageJson.version);
  assert.ok(releaseFiles.includes('helm/libre-webui/Chart.yaml'));
});

test('Helm defaults Libre WebUI to appVersion without changing Ollama latest', () => {
  const values = fs.readFileSync(
    path.join(repoRoot, 'helm', 'libre-webui', 'values.yaml'),
    'utf8'
  );
  const deployment = fs.readFileSync(
    path.join(repoRoot, 'helm', 'libre-webui', 'templates', 'deployment.yaml'),
    'utf8'
  );
  const topLevelImage = values.match(/^image:\n(?:  .*\n)*/m)?.[0] || '';

  assert.match(topLevelImage, /^  tag:\s*['"]{2}\s*$/m);
  assert.match(
    deployment,
    /\.Values\.image\.tag \| default \.Chart\.AppVersion/
  );
  assert.match(
    values,
    /ollama:[\s\S]*?bundled:[\s\S]*?image:[\s\S]*?tag: latest/
  );
});

test('Helm workflow validates main and publishes only matching release tags', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'helm-publish.yml'),
    'utf8'
  );

  assert.match(workflow, /branches: \[main\]/);
  assert.match(workflow, /tags: \['v\*'\]/);
  assert.match(workflow, /Release tag .* must match package and Helm version/);
  assert.match(workflow, /if: startsWith\(github\.ref, 'refs\/tags\/v'\)/);
  assert.doesNotMatch(workflow, /sed -i .*appVersion/);
});

test('release manager advances the chart and app versions together', t => {
  const projectRoot = createTempProject(`apiVersion: v2
name: libre-webui
description: Keep this content unchanged
version: 0.14.1
appVersion: "0.14.1"
`);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const manager = new ReleaseManager({ projectRoot });
  manager.updateHelmChartVersions('0.14.1', '0.14.2');

  const chart = fs.readFileSync(manager.helmChartPath, 'utf8');
  assert.equal(readVersion(chart, 'version'), '0.14.2');
  assert.equal(readVersion(chart, 'appVersion'), '0.14.2');
  assert.match(chart, /description: Keep this content unchanged/);
});

test('release manager refuses to reuse a mismatched chart version', t => {
  const projectRoot = createTempProject(`apiVersion: v2
name: libre-webui
version: 0.1.0
appVersion: "0.3.2"
`);
  t.after(() => fs.rmSync(projectRoot, { recursive: true, force: true }));

  const manager = new ReleaseManager({ projectRoot });
  assert.throws(
    () => manager.updateHelmChartVersions('0.14.1', '0.14.2'),
    /requires chart version and appVersion to both match/
  );
});
