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
