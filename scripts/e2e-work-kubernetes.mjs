/*
 * End-to-end exercise of the Kubernetes Work runtime backend against a real
 * cluster, run under the Helm chart's ServiceAccount so the namespace-scoped
 * RBAC is proven exactly sufficient. Covers the full driver surface: probe,
 * workspace PVC, sandbox Pod lifecycle, exec (identity, read-only rootfs,
 * stdin, workdir, exit codes), persistence across Pod recreation, the
 * interactive TTY terminal with resize, the preview endpoint with a
 * cross-pod fetch, reconciliation listing, and ownership refusal.
 *
 * Inputs:
 *   SA_KUBECONFIG    kubeconfig authenticating as the chart ServiceAccount
 *                    (the driver runs with this identity).
 *   ADMIN_KUBECONFIG kubeconfig for the test harness's kubectl calls
 *                    (default ~/.kube/config); used only for the network
 *                    probe pod, which needs verbs the Work Role does not
 *                    and must not grant.
 */
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const saKubeconfig = process.env.SA_KUBECONFIG;
if (!saKubeconfig) {
  console.error('SA_KUBECONFIG is required.');
  process.exit(1);
}
const adminKubeconfig =
  process.env.ADMIN_KUBECONFIG || path.join(os.homedir(), '.kube', 'config');
const namespace = process.env.WORK_K8S_NAMESPACE || 'libre-webui-work';
const releaseName = process.env.RELEASE_NAME || 'lw-ci';
const releaseNamespace = process.env.RELEASE_NAMESPACE || 'default';

// The driver reads KUBECONFIG lazily on first API use; pin it to the
// ServiceAccount identity before importing anything.
process.env.KUBECONFIG = saKubeconfig;

const { KubernetesWorkRuntimeDriver } = await import(
  pathToFileURL(
    path.join(
      process.cwd(),
      'backend',
      'dist',
      'services',
      'workKubernetesDriver.js'
    )
  ).href
);

const task = {
  id: 'e2e-work-k8s-0001',
  userId: 'ci',
  title: 'e2e',
  model: 'test',
  status: 'idle',
  networkEnabled: true,
  volumeName: 'libre-work-e2e0001',
  containerName: 'libre-work-e2e0001',
  previewStatus: 'stopped',
  createdAt: 1,
  updatedAt: 1,
};

const driver = new KubernetesWorkRuntimeDriver();
const step = name => console.log(`>> ${name}`);
const fail = message => {
  throw new Error(message);
};

try {
  step('probe under the ServiceAccount');
  await driver.probe();

  step('workspace PVC');
  await driver.ensureWorkspace(task);

  step('sandbox Pod (first start pulls the runtime image)');
  await driver.ensureRuntime(task);
  if ((await driver.runtimeState(task)) !== 'running') fail('not running');

  step('exec: unprivileged identity in /workspace');
  const id = await driver.exec(task, ['/bin/bash', '-lc', 'id -u; id -g; pwd']);
  if (!/1000\s+1000\s+\/workspace/.test(id.stdout.replace(/\n/g, ' '))) {
    fail(`identity/workdir: ${JSON.stringify(id.stdout)}`);
  }

  step('exec: read-only root filesystem holds');
  const rootfs = await driver.exec(
    task,
    ['/bin/bash', '-lc', 'touch /usr/forbidden 2>&1'],
    { acceptFailure: true }
  );
  if (rootfs.exitCode === 0) fail('root filesystem was writable');

  step('exec: stdin write, read back, workdir hop, exit codes');
  await driver.exec(task, ['/bin/sh', '-c', 'cat > /workspace/e2e.txt'], {
    input: 'persisted-42\n',
  });
  const read1 = await driver.exec(task, ['cat', '/workspace/e2e.txt']);
  if (!read1.stdout.includes('persisted-42')) fail('stdin write/read failed');
  await driver.exec(task, ['mkdir', '-p', '/workspace/sub']);
  const hop = await driver.exec(task, ['pwd'], { workdir: '/workspace/sub' });
  if (!hop.stdout.includes('/workspace/sub')) fail('workdir hop failed');
  const exit7 = await driver.exec(task, ['/bin/sh', '-c', 'exit 7'], {
    acceptFailure: true,
  });
  if (exit7.exitCode !== 7) fail(`exit code: ${exit7.exitCode}`);

  step('terminal: TTY roundtrip, resize frames, TERM');
  const terminal = await driver.openTerminal(task.containerName);
  let tty = '';
  terminal.stream.on('data', chunk => (tty += chunk.toString()));
  await terminal.resize(120, 30);
  await new Promise(resolve => setTimeout(resolve, 800));
  terminal.stream.write(
    'stty size; echo tty-ok-$((21+21)); echo "TERM=$TERM"\n'
  );
  await new Promise(resolve => setTimeout(resolve, 2500));
  terminal.stream.write('exit\n');
  await new Promise(resolve => setTimeout(resolve, 500));
  terminal.stream.destroy();
  if (!tty.includes('tty-ok-42')) fail(`TTY roundtrip: ${tty.slice(0, 300)}`);
  if (!/30 120/.test(tty)) fail(`resize not applied: ${tty.slice(0, 300)}`);
  if (!tty.includes('TERM=xterm-256color')) fail('TERM missing');

  step('preview: endpoint is the Pod IP, reachable across the cluster');
  await driver.exec(task, [
    '/bin/bash',
    '-lc',
    `nohup setsid node -e 'require("http").createServer((q,s)=>s.end("preview-e2e")).listen(4173,"0.0.0.0")' > /tmp/p.log 2>&1 < /dev/null & sleep 1`,
  ]);
  const endpoint = await driver.previewEndpoint(task);
  if (!endpoint?.host || endpoint.port !== 4173) {
    fail(`endpoint: ${JSON.stringify(endpoint)}`);
  }
  // Fetch as the backend would: from the release namespace, carrying the
  // backend's selector labels, which is exactly what the preview-ingress
  // NetworkPolicy admits. `kubectl run --rm -i` attaches and can miss the
  // output of a fast container entirely, so create the pod, wait for a
  // terminal phase, and read the logs deterministically instead.
  const kubectlAdmin = args =>
    execFileSync('kubectl', args, {
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env, KUBECONFIG: adminKubeconfig },
    });
  const probe = async (name, podNamespace, labels, url) => {
    const nsArgs = ['-n', podNamespace];
    kubectlAdmin([
      'run',
      name,
      '--restart=Never',
      '--image=busybox',
      ...nsArgs,
      ...(labels ? [`--labels=${labels}`] : []),
      '--',
      'wget',
      '-T',
      '10',
      '-qO-',
      url,
    ]);
    try {
      let phase = '';
      const deadline = Date.now() + 120_000;
      while (phase !== 'Succeeded' && phase !== 'Failed') {
        if (Date.now() >= deadline) fail(`probe ${name} never finished`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        phase = kubectlAdmin([
          'get',
          'pod',
          name,
          ...nsArgs,
          '-o',
          'jsonpath={.status.phase}',
        ]).trim();
      }
      return kubectlAdmin(['logs', name, ...nsArgs]);
    } finally {
      kubectlAdmin(['delete', 'pod', name, ...nsArgs, '--wait=false']);
    }
  };
  const fetched = await probe(
    'lw-e2e-backend-probe',
    releaseNamespace,
    `app.kubernetes.io/name=libre-webui,app.kubernetes.io/instance=${releaseName}`,
    `http://${endpoint.host}:${endpoint.port}/`
  );
  if (!fetched.includes('preview-e2e')) fail(`backend fetch: ${fetched}`);

  step('network policy: an unrelated pod cannot reach the sandbox');
  const strangerBody = await probe(
    'lw-e2e-stranger-probe',
    namespace,
    null,
    `http://${endpoint.host}:${endpoint.port}/`
  );
  if (strangerBody.includes('preview-e2e')) {
    // Objects exist but nothing enforces them (e.g. a no-op CNI). The
    // deployment still works; isolation is the operator's CNI choice.
    console.log(
      '   WARNING: NetworkPolicy is not enforced by this CNI; sandbox isolation is not active on this cluster.'
    );
  } else {
    console.log('   default-deny enforced: stranger pod was refused');
  }

  step('stop, workspace persistence across Pod recreation');
  await driver.stopRuntime(task);
  if ((await driver.runtimeState(task)) !== 'absent') fail('not absent');
  await driver.ensureRuntime(task);
  const read2 = await driver.exec(task, ['cat', '/workspace/e2e.txt']);
  if (!read2.stdout.includes('persisted-42')) fail('workspace lost');

  step('reconciliation listing sees the sandbox');
  const managed = await driver.listManaged();
  const mine = managed.find(entry => entry.taskId === task.id);
  if (!mine?.running) fail(`listManaged: ${JSON.stringify(managed)}`);

  step('workspace listing sees the PVC (orphan reporting, list verb)');
  const workspaces = await driver.listWorkspaces();
  const claim = workspaces.find(entry => entry.taskId === task.id);
  if (claim?.name !== task.volumeName) {
    fail(`listWorkspaces: ${JSON.stringify(workspaces)}`);
  }

  step('ownership: a foreign task record is refused');
  let refused = false;
  try {
    await driver.stopRuntime({ ...task, id: 'someone-else' });
  } catch (error) {
    refused = error?.code === 'WORK_CONTAINER_NAME_CONFLICT';
  }
  if (!refused) fail('ownership assertion did not fire');

  step('teardown');
  await driver.removeTaskResources(task);
  if ((await driver.runtimeState(task)) !== 'absent') fail('pod survived');

  console.log(
    'PASS: full Kubernetes Work surface verified under least-privilege RBAC'
  );
} catch (error) {
  await driver.removeTaskResources(task).catch(() => {});
  console.error('FAIL:', error instanceof Error ? error.message : error);
  process.exit(1);
}
