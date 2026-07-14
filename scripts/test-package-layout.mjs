import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { x as extractTarball } from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function packProject(outputDir) {
  try {
    return JSON.parse(
      execFileSync(
        npmCommand,
        ['pack', '--json', '--pack-destination', outputDir],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          shell: process.platform === 'win32',
        }
      )
    );
  } catch (error) {
    if (!error.stdout?.includes('pack-destination')) {
      throw error;
    }

    const result = JSON.parse(
      execFileSync(npmCommand, ['pack', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
      })
    );

    const tarballName = result[0]?.filename;
    if (!tarballName) {
      throw new Error('npm pack did not produce a tarball name');
    }

    fs.renameSync(
      path.join(repoRoot, tarballName),
      path.join(outputDir, tarballName)
    );
    return result;
  }
}

async function extractPackedProject() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-webui-pack-'));
  const packResult = packProject(tempDir);
  const tarballName = packResult[0]?.filename;
  assert.ok(tarballName, 'npm pack should produce a tarball');

  const tarballPath = path.join(tempDir, tarballName);
  await extractTarball({
    file: tarballPath,
    cwd: tempDir,
  });

  return {
    tempDir,
    packedRoot: path.join(tempDir, 'package'),
  };
}

async function withTempPackedProject(run) {
  const { tempDir, packedRoot } = await extractPackedProject();

  try {
    await run({ tempDir, packedRoot });
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function linkInstalledDependencies(packedRoot) {
  const installedNodeModules = path.join(repoRoot, 'node_modules');
  assert.ok(
    fs.existsSync(installedNodeModules),
    'repo root node_modules must exist to boot the packed backend in tests'
  );

  fs.symlinkSync(
    installedNodeModules,
    path.join(packedRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
}

function startServer(server) {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      resolve(address.port);
    });
  });
}

async function waitForServer(url, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Packed backend exited early with code ${child.exitCode}`
      );
    }

    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {}

    await new Promise(resolve => setTimeout(resolve, 200));
  }

  throw new Error(`Timed out waiting for packed backend at ${url}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) {
    return;
  }

  const waitForExit = timeoutMs =>
    new Promise(resolve => {
      if (child.exitCode !== null) {
        resolve(true);
        return;
      }

      const timeout = setTimeout(() => {
        child.off('exit', onExit);
        resolve(false);
      }, timeoutMs);

      const onExit = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      child.once('exit', onExit);

      // Avoid missing an exit that occurs between the initial check and listener.
      if (child.exitCode !== null) {
        child.off('exit', onExit);
        clearTimeout(timeout);
        resolve(true);
      }
    });

  child.kill('SIGTERM');

  await waitForExit(5000);

  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await waitForExit(5000);
  }
}

test('packed npm artifact resolves package metadata and frontend dist', async () => {
  await withTempPackedProject(async ({ packedRoot }) => {
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'index.js');
    const backendPackageJson = path.join(packedRoot, 'backend', 'package.json');
    const frontendDist = path.join(packedRoot, 'frontend', 'dist');
    const helperPath = path.join(
      packedRoot,
      'backend',
      'dist',
      'utils',
      'packagePaths.js'
    );

    assert.ok(fs.existsSync(path.join(packedRoot, 'package.json')));
    assert.ok(fs.existsSync(backendPackageJson));
    assert.ok(fs.existsSync(backendEntry));
    assert.ok(fs.existsSync(path.join(frontendDist, 'index.html')));
    assert.ok(fs.existsSync(helperPath));
    assert.ok(
      fs.existsSync(path.join(packedRoot, 'scripts', 'postinstall.js'))
    );

    const pkg = JSON.parse(
      fs.readFileSync(path.join(packedRoot, 'package.json'), 'utf8')
    );
    assert.equal(pkg.bin?.['libre-webui'], 'bin/cli.js');
    assert.equal(pkg.scripts?.postinstall, 'node scripts/postinstall.js');
    const helper = await import(pathToFileURL(helperPath).href);
    const backendEntryUrl = pathToFileURL(backendEntry).href;

    assert.equal(helper.resolveAppPackageRoot(backendEntryUrl), packedRoot);
    assert.equal(helper.loadAppPackage(backendEntryUrl).version, pkg.version);
    assert.equal(helper.resolveFrontendDist(backendEntryUrl), frontendDist);
  });
});

test('packed npm artifact exposes provider-backed embedding models and requests', async () => {
  await withTempPackedProject(async ({ packedRoot }) => {
    linkInstalledDependencies(packedRoot);

    const providerRequests = [];
    const providerServer = http.createServer(async (req, res) => {
      providerRequests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
      });

      if (req.method === 'GET' && req.url === '/openai/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ id: 'text-embedding-3-small' }, { id: 'gpt-4o-mini' }],
          })
        );
        return;
      }

      if (req.method === 'POST' && req.url === '/openai/v1/embeddings') {
        let body = '';
        for await (const chunk of req) {
          body += chunk;
        }

        const payload = JSON.parse(body);
        assert.equal(payload.model, 'text-embedding-3-small');
        assert.equal(payload.input, 'hello from packed npx');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [{ embedding: [0.11, 0.22, 0.33] }],
          })
        );
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    const providerPort = await startServer(providerServer);
    const providerEndpoint = `http://127.0.0.1:${providerPort}/openai/v1/chat/completions`;
    const openAiPluginPath = path.join(packedRoot, 'plugins', 'openai.json');
    const openAiPlugin = JSON.parse(fs.readFileSync(openAiPluginPath, 'utf8'));
    openAiPlugin.endpoint = providerEndpoint;
    const endpointVariable = openAiPlugin.variables?.find(
      variable => variable.name === 'endpoint'
    );
    if (endpointVariable) {
      endpointVariable.default = providerEndpoint;
    }
    fs.writeFileSync(openAiPluginPath, JSON.stringify(openAiPlugin, null, 2));

    const backendPortServer = http.createServer();
    const backendPort = await startServer(backendPortServer);
    await new Promise(resolve => backendPortServer.close(resolve));

    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'index.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: packedRoot,
      env: {
        ...process.env,
        PORT: String(backendPort),
        OPENAI_API_KEY: 'test-openai-key',
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        JWT_SECRET: 'test-jwt-secret',
        ENCRYPTION_KEY:
          '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      },
      stdio: 'pipe',
    });

    let backendLogs = '';
    backendProcess.stdout.on('data', chunk => {
      backendLogs += chunk.toString();
    });
    backendProcess.stderr.on('data', chunk => {
      backendLogs += chunk.toString();
    });

    try {
      await waitForServer(
        `http://127.0.0.1:${backendPort}/health`,
        backendProcess
      );

      const modelsResponse = await fetch(
        `http://127.0.0.1:${backendPort}/api/embeddings/models`
      );
      assert.equal(modelsResponse.status, 200);
      const modelsPayload = await modelsResponse.json();

      assert.equal(modelsPayload.success, true);
      assert.ok(Array.isArray(modelsPayload.data));
      const modelIds = modelsPayload.data.map(model => model.id);
      assert.ok(modelIds.includes('plugin:openai:text-embedding-3-small'));
      assert.ok(!modelIds.includes('plugin:openai:gpt-4o-mini'));

      const embedResponse = await fetch(
        `http://127.0.0.1:${backendPort}/api/ollama/embed`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'plugin:openai:text-embedding-3-small',
            input: 'hello from packed npx',
          }),
        }
      );
      assert.equal(embedResponse.status, 200);
      const embedPayload = await embedResponse.json();

      assert.equal(embedPayload.success, true);
      assert.deepEqual(embedPayload.data.embeddings, [[0.11, 0.22, 0.33]]);

      const providerUrls = providerRequests.map(request => request.url);
      assert.ok(providerUrls.includes('/openai/v1/models'));
      assert.ok(providerUrls.includes('/openai/v1/embeddings'));
      assert.ok(
        providerRequests.every(
          request => request.authorization === 'Bearer test-openai-key'
        )
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nPacked backend logs:\n${backendLogs}`
      );
    } finally {
      await stopChild(backendProcess);
      await new Promise(resolve => providerServer.close(resolve));
    }
  });
});
