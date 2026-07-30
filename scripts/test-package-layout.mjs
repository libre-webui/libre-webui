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

async function signupPackedUser(baseUrl, username) {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'packed-test-password',
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(typeof payload.data?.token, 'string');
  return payload.data;
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

    const kimiPlugin = JSON.parse(
      fs.readFileSync(
        path.join(packedRoot, 'plugins', 'kimi-code.json'),
        'utf8'
      )
    );
    assert.equal(kimiPlugin.id, 'kimi-code');
    assert.equal(kimiPlugin.name, 'Kimi Code (Moonshot AI)');
    assert.equal(
      kimiPlugin.endpoint,
      'https://api.kimi.com/coding/v1/chat/completions'
    );
    assert.deepEqual(kimiPlugin.auth, {
      header: 'Authorization',
      prefix: 'Bearer ',
      key_env: 'KIMI_API_KEY',
    });
    assert.deepEqual(kimiPlugin.model_map, [
      'k3',
      'k3-256k',
      'kimi-for-coding',
      'kimi-for-coding-highspeed',
    ]);
    assert.deepEqual(
      kimiPlugin.variables.map(variable => variable.name),
      ['endpoint', 'max_tokens', 'stream']
    );

    const mlxPlugin = JSON.parse(
      fs.readFileSync(path.join(packedRoot, 'plugins', 'mlx-lm.json'), 'utf8')
    );
    assert.equal(mlxPlugin.id, 'mlx-lm');
    assert.equal(mlxPlugin.name, 'MLX LM (Apple Silicon)');
    assert.equal(
      mlxPlugin.endpoint,
      'http://127.0.0.1:8081/v1/chat/completions'
    );
    assert.deepEqual(mlxPlugin.auth, {
      header: '',
      prefix: '',
      key_env: '',
    });
    assert.ok(
      mlxPlugin.model_map.includes('prism-ml/Ternary-Bonsai-27B-mlx-2bit')
    );

    const anthropicPlugin = JSON.parse(
      fs.readFileSync(
        path.join(packedRoot, 'plugins', 'anthropic.json'),
        'utf8'
      )
    );
    assert.deepEqual(anthropicPlugin.model_map, [
      'claude-fable-5',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      'claude-opus-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-4-5-20250929',
      'claude-sonnet-4-6',
      'claude-sonnet-5',
    ]);
    const anthropicVariables = new Map(
      anthropicPlugin.variables.map(variable => [variable.name, variable])
    );
    assert.equal(anthropicVariables.get('temperature')?.max, 1);
    assert.equal(anthropicVariables.get('max_tokens')?.default, 16384);
    assert.equal(anthropicVariables.has('frequency_penalty'), false);
    assert.equal(anthropicVariables.has('presence_penalty'), false);

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
    assert.equal(
      helper.resolveBundledPluginsDir(
        backendEntryUrl,
        path.join(packedRoot, 'unrelated-caller')
      ),
      path.join(packedRoot, 'plugins')
    );
  });
});

test('packed npm artifact exposes provider-backed embedding models and requests', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
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

    const backendPortServer = http.createServer();
    const backendPort = await startServer(backendPortServer);
    await new Promise(resolve => backendPortServer.close(resolve));

    const callerDir = path.join(tempDir, 'embedding-caller');
    const dataDir = path.join(tempDir, 'embedding-runtime-data');
    fs.mkdirSync(callerDir, { recursive: true });
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'index.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: callerDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: dataDir,
        OPENAI_API_KEY: 'test-openai-key',
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        JWT_SECRET: 'test-jwt-secret',
        TURNSTILE_SITE_KEY: '',
        TURNSTILE_SECRET_KEY: '',
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

      const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
      const unauthenticatedPluginRead = await fetch(
        `${backendBaseUrl}/api/plugins`,
        { method: 'HEAD' }
      );
      assert.equal(unauthenticatedPluginRead.status, 401);

      const firstUser = await signupPackedUser(
        backendBaseUrl,
        'packed-plugin-admin'
      );
      assert.equal(firstUser.user.role, 'admin');
      const pluginHeaders = {
        Authorization: `Bearer ${firstUser.token}`,
      };
      const pluginJsonHeaders = {
        ...pluginHeaders,
        'Content-Type': 'application/json',
      };
      const endpointResponse = await fetch(
        `${backendBaseUrl}/api/plugins/openai/variables`,
        {
          method: 'PUT',
          headers: pluginJsonHeaders,
          body: JSON.stringify({
            variables: { endpoint: providerEndpoint },
          }),
        }
      );
      assert.equal(endpointResponse.status, 200);
      const credentialResponse = await fetch(
        `${backendBaseUrl}/api/plugins/openai/credentials`,
        {
          method: 'POST',
          headers: pluginJsonHeaders,
          body: JSON.stringify({ api_key: 'test-openai-key' }),
        }
      );
      assert.equal(credentialResponse.status, 200);
      const activationResponse = await fetch(
        `${backendBaseUrl}/api/plugins/activate/openai`,
        {
          method: 'POST',
          headers: pluginHeaders,
        }
      );
      assert.equal(activationResponse.status, 200);

      const pluginReadStatuses = [];
      for (let request = 0; request < 205; request++) {
        const pluginReadResponse = await fetch(
          `${backendBaseUrl}/api/plugins`,
          { method: 'HEAD', headers: pluginHeaders }
        );
        pluginReadStatuses.push(pluginReadResponse.status);
      }
      assert.deepEqual(
        [...new Set(pluginReadStatuses)],
        [200],
        'read-only plugin discovery must not exhaust the normal user quota'
      );

      const modelsResponse = await fetch(
        `${backendBaseUrl}/api/embeddings/models`,
        { headers: pluginHeaders }
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
          headers: {
            ...pluginHeaders,
            'Content-Type': 'application/json',
          },
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

      // Endpoint, credential, and activation setup consumed three requests
      // from this authenticated user's 1000-request plugin-router quota.
      for (let request = pluginReadStatuses.length; request < 997; request++) {
        const pluginReadResponse = await fetch(
          `${backendBaseUrl}/api/plugins`,
          { method: 'HEAD', headers: pluginHeaders }
        );
        assert.equal(pluginReadResponse.status, 200);
      }
      const limitedPluginRead = await fetch(`${backendBaseUrl}/api/plugins`, {
        headers: pluginHeaders,
      });
      assert.equal(
        limitedPluginRead.status,
        429,
        'plugin discovery must eventually reject an abusive request burst'
      );
      assert.match(limitedPluginRead.headers.get('retry-after') || '', /^\d+$/);
      assert.deepEqual(await limitedPluginRead.json(), {
        success: false,
        error: 'Too many plugin requests, please try again later.',
      });

      const secondUser = await signupPackedUser(
        backendBaseUrl,
        'packed-plugin-user'
      );
      const authenticatedPluginRead = await fetch(
        `${backendBaseUrl}/api/plugins`,
        {
          headers: { Authorization: `Bearer ${secondUser.token}` },
        }
      );
      assert.equal(
        authenticatedPluginRead.status,
        200,
        'authenticated users must not share another account’s exhausted quota'
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

test('packed npm artifact routes TTS through the selected plugin valve from any cwd', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
    linkInstalledDependencies(packedRoot);

    const targetRequests = [];
    const targetServer = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      targetRequests.push({ method: req.method, url: req.url, body });
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      res.end(Buffer.from('RIFFmock-wave-audio'));
    });
    const targetPort = await startServer(targetServer);
    const targetEndpoint = `http://127.0.0.1:${targetPort}/v1/audio/speech`;

    const wrongProviderRequests = [];
    const wrongProviderServer = http.createServer((req, res) => {
      wrongProviderRequests.push(req.url);
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'wrong TTS provider selected' }));
    });
    const wrongProviderPort = await startServer(wrongProviderServer);
    const wrongProviderEndpoint = `http://127.0.0.1:${wrongProviderPort}/v1/audio/speech`;

    fs.writeFileSync(
      path.join(packedRoot, 'plugins', 'aaa-shared-tts.json'),
      JSON.stringify(
        {
          id: 'aaa-shared-tts',
          name: 'Wrong shared-alias provider',
          type: 'tts',
          endpoint: wrongProviderEndpoint,
          auth: { header: '', key_env: '' },
          model_map: ['tts-1-hd'],
          capabilities: {
            tts: {
              endpoint: wrongProviderEndpoint,
              model_map: ['tts-1-hd'],
              config: {
                voices: ['wrong'],
                default_voice: 'wrong',
                formats: ['wav'],
                default_format: 'wav',
                no_auth_required: true,
              },
            },
          },
        },
        null,
        2
      )
    );

    const backendPortServer = http.createServer();
    const backendPort = await startServer(backendPortServer);
    await new Promise(resolve => backendPortServer.close(resolve));

    const callerDir = path.join(tempDir, 'unrelated-caller');
    const dataDir = path.join(tempDir, 'runtime-data');
    fs.mkdirSync(callerDir, { recursive: true });
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'index.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: callerDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: dataDir,
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        JWT_SECRET: 'test-jwt-secret',
        TURNSTILE_SITE_KEY: '',
        TURNSTILE_SECRET_KEY: '',
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
      const backendBaseUrl = `http://127.0.0.1:${backendPort}`;
      const admin = await signupPackedUser(backendBaseUrl, 'packed-tts-admin');
      assert.equal(admin.user.role, 'admin');
      const authenticatedHeaders = {
        Authorization: `Bearer ${admin.token}`,
      };
      const activationResponse = await fetch(
        `${backendBaseUrl}/api/plugins/activate/kyutai-tts-1.6b`,
        {
          method: 'POST',
          headers: authenticatedHeaders,
        }
      );
      assert.equal(activationResponse.status, 200);

      const modelsResponse = await fetch(`${backendBaseUrl}/api/tts/models`, {
        headers: authenticatedHeaders,
      });
      assert.equal(modelsResponse.status, 200);
      const modelsPayload = await modelsResponse.json();
      const kyutaiModels = modelsPayload.data
        .filter(model => model.plugin === 'kyutai-tts-1.6b')
        .map(model => model.model)
        .sort();
      assert.deepEqual(kyutaiModels, ['kyutai-tts-1.6b', 'tts-1-hd']);

      const pluginsResponse = await fetch(`${backendBaseUrl}/api/tts/plugins`, {
        headers: authenticatedHeaders,
      });
      assert.equal(pluginsResponse.status, 200);
      const pluginsPayload = await pluginsResponse.json();
      assert.ok(
        pluginsPayload.data.some(plugin => plugin.id === 'kyutai-tts-1.6b')
      );

      const valveResponse = await fetch(
        `http://127.0.0.1:${backendPort}/api/plugins/kyutai-tts-1.6b/variables`,
        {
          method: 'PUT',
          headers: {
            ...authenticatedHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            variables: { endpoint: targetEndpoint, speed: 1 },
          }),
        }
      );
      assert.equal(valveResponse.status, 200);

      const generateResponse = await fetch(
        `http://127.0.0.1:${backendPort}/api/tts/generate-base64`,
        {
          method: 'POST',
          headers: {
            ...authenticatedHeaders,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: 'tts-1-hd',
            pluginId: 'kyutai-tts-1.6b',
            input: 'hello from the selected Kyutai provider',
            voice: 'alba',
            response_format: 'wav',
          }),
        }
      );
      assert.equal(generateResponse.status, 200);
      const generatePayload = await generateResponse.json();
      assert.equal(generatePayload.success, true);
      assert.equal(generatePayload.data.format, 'wav');

      assert.equal(wrongProviderRequests.length, 0);
      assert.equal(targetRequests.length, 1);
      assert.equal(targetRequests[0].method, 'POST');
      assert.equal(targetRequests[0].url, '/v1/audio/speech');
      assert.deepEqual(JSON.parse(targetRequests[0].body), {
        model: 'tts-1-hd',
        input: 'hello from the selected Kyutai provider',
        voice: 'alba',
        response_format: 'wav',
        speed: 1,
      });
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nPacked backend logs:\n${backendLogs}`
      );
    } finally {
      await stopChild(backendProcess);
      await Promise.all([
        new Promise(resolve => targetServer.close(resolve)),
        new Promise(resolve => wrongProviderServer.close(resolve)),
      ]);
    }
  });
});
