import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { x as extractTarball } from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const requireFromTest = createRequire(import.meta.url);

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
      password: 'Packed-Test-Password-123',
    }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.success, true);
  assert.equal(typeof payload.data?.token, 'string');
  return payload.data;
}

async function signupAndApprovePackedUser(baseUrl, username, adminToken) {
  const password = 'Packed-Test-Password-123';
  const signupResponse = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(signupResponse.status, 202);
  const signupPayload = await signupResponse.json();
  assert.equal(signupPayload.success, true);
  assert.equal(signupPayload.data?.user?.status, 'pending');

  const approvalResponse = await fetch(
    `${baseUrl}/api/users/${signupPayload.data.user.id}/approve`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${adminToken}` },
    }
  );
  assert.equal(approvalResponse.status, 200);

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(loginResponse.status, 200);
  const loginPayload = await loginResponse.json();
  assert.equal(loginPayload.success, true);
  assert.equal(typeof loginPayload.data?.token, 'string');
  return loginPayload.data;
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

function makeInstallTreeReadOnly(root) {
  if (process.platform === 'win32') return () => undefined;
  const originalModes = [];
  const visit = candidate => {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink()) return;
    originalModes.push([candidate, stat.mode & 0o777]);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(candidate)) {
        visit(path.join(candidate, entry));
      }
      fs.chmodSync(candidate, 0o555);
    } else {
      fs.chmodSync(candidate, 0o444);
    }
  };
  visit(root);
  return () => {
    for (const [candidate, mode] of originalModes) {
      fs.chmodSync(candidate, mode);
    }
  };
}

test('packed npm artifact resolves package metadata and frontend dist', async () => {
  await withTempPackedProject(async ({ packedRoot }) => {
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'main.js');
    const backendPackageJson = path.join(packedRoot, 'backend', 'package.json');
    const frontendDist = path.join(packedRoot, 'frontend', 'dist');
    const helperPath = path.join(
      packedRoot,
      'backend',
      'dist',
      'utils',
      'packagePaths.js'
    );
    const runtimePathsHelper = path.join(packedRoot, 'bin', 'runtime-paths.js');
    const postgresMigrationCli = path.join(
      packedRoot,
      'backend',
      'dist',
      'cli',
      'migrateSqliteToPostgres.js'
    );
    const recoveryBackupCli = path.join(
      packedRoot,
      'backend',
      'dist',
      'cli',
      'recoveryBackup.js'
    );

    assert.ok(fs.existsSync(path.join(packedRoot, 'package.json')));
    assert.ok(fs.existsSync(backendPackageJson));
    assert.ok(fs.existsSync(backendEntry));
    assert.ok(fs.existsSync(path.join(frontendDist, 'index.html')));
    assert.ok(fs.existsSync(helperPath));
    assert.ok(fs.existsSync(runtimePathsHelper));
    assert.ok(fs.existsSync(postgresMigrationCli));
    assert.ok(fs.existsSync(recoveryBackupCli));
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
    assert.equal(
      pkg.scripts?.['migrate:postgres'],
      'node backend/dist/cli/migrateSqliteToPostgres.js',
      'the published migration command must execute shipped dist without rebuilding absent source files'
    );
    const helper = await import(pathToFileURL(helperPath).href);
    const { resolveCliRuntimePaths } = requireFromTest(runtimePathsHelper);
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

    const callerDirectory = path.join(packedRoot, 'caller');
    const fakeHome = path.join(packedRoot, 'home');
    assert.equal(fs.existsSync(callerDirectory), false);
    assert.equal(fs.existsSync(fakeHome), false);
    const linuxPaths = resolveCliRuntimePaths(
      { XDG_CACHE_HOME: path.join(fakeHome, 'cache') },
      {
        cwd: callerDirectory,
        homeDirectory: fakeHome,
        platform: 'linux',
        tempDirectory: path.join(packedRoot, 'tmp'),
        uid: 123,
      }
    );
    assert.equal(linuxPaths.dataDirectory, path.join(fakeHome, '.libre-webui'));
    assert.equal(
      linuxPaths.preflightDirectory,
      path.join(fakeHome, 'cache', 'libre-webui', 'preflight')
    );
    assert.equal(
      linuxPaths.pluginsDirectory,
      path.join(fakeHome, '.libre-webui', 'plugins')
    );
    assert.equal(fs.existsSync(callerDirectory), false);
    assert.equal(fs.existsSync(fakeHome), false);

    const configuredPaths = resolveCliRuntimePaths(
      {
        DATA_DIR: './state',
        PLUGINS_DIR: './plugins',
        PLATFORM_PREFLIGHT_TMP_DIR: './scratch',
      },
      { cwd: callerDirectory, homeDirectory: fakeHome, platform: 'linux' }
    );
    assert.equal(
      configuredPaths.dataDirectory,
      path.join(callerDirectory, 'state')
    );
    assert.equal(
      configuredPaths.preflightDirectory,
      path.join(callerDirectory, 'scratch')
    );
    assert.equal(
      configuredPaths.pluginsDirectory,
      path.join(callerDirectory, 'plugins')
    );
    assert.equal(fs.existsSync(callerDirectory), false);
    assert.equal(fs.existsSync(fakeHome), false);
  });
});

test('packed CLI rejects malformed provider limits without creating its default state', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
    linkInstalledDependencies(packedRoot);
    const callerDirectory = path.join(tempDir, 'invalid-provider-caller');
    const fakeHome = path.join(tempDir, 'invalid-provider-home');
    fs.mkdirSync(callerDirectory, { recursive: true });
    const launchEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      OPEN_BROWSER: 'false',
      OLLAMA_TIMEOUT: '300000ms',
    };
    for (const key of [
      'DATA_DIR',
      'PLUGINS_DIR',
      'PLATFORM_PREFLIGHT_TMP_DIR',
      'ENCRYPTION_KEY',
      'STORAGE_ENCRYPTION_KEYS',
      'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
    ]) {
      delete launchEnv[key];
    }
    const result = spawnSync(
      process.execPath,
      [path.join(packedRoot, 'bin', 'cli.js'), '--port', '31991'],
      {
        cwd: callerDirectory,
        env: launchEnv,
        encoding: 'utf8',
        timeout: 15_000,
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /Invalid Ollama configuration[\s\S]*OLLAMA_TIMEOUT/
    );
    assert.equal(
      fs.existsSync(fakeHome),
      false,
      'validation must happen before the packaged default data root is created'
    );
  });
});

test('packed CLI survives two starts and ignores unrelated caller plugins', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
    linkInstalledDependencies(packedRoot);
    const restoreInstallModes = makeInstallTreeReadOnly(packedRoot);
    const callerDirectory = path.join(tempDir, 'cli-caller');
    const fakeHome = path.join(tempDir, 'cli-home');
    const xdgCache = path.join(tempDir, 'cli-cache');
    const localAppData = path.join(tempDir, 'cli-local-app-data');
    fs.mkdirSync(callerDirectory, { recursive: true });
    fs.mkdirSync(fakeHome, { recursive: true });
    const unrelatedCallerPlugin = path.join(
      callerDirectory,
      'plugins',
      'unrelated.json'
    );
    fs.mkdirSync(path.dirname(unrelatedCallerPlugin), { recursive: true });
    fs.writeFileSync(unrelatedCallerPlugin, '{}\n');
    const unrelatedCallerPluginBefore = fs.readFileSync(unrelatedCallerPlugin);

    const launchEnv = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      XDG_CACHE_HOME: xdgCache,
      LOCALAPPDATA: localAppData,
      OPEN_BROWSER: 'false',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      JWT_SECRET: 'packed-cli-jwt-secret-packed-cli-jwt-secret',
      SESSION_SECRET: 'packed-cli-session-secret',
      TURNSTILE_SITE_KEY: '',
      TURNSTILE_SECRET_KEY: '',
      TURNSTILE_EXPECTED_HOSTNAME: '',
      LOG_LEVEL: 'warn',
    };
    for (const key of [
      'DATA_DIR',
      'PLUGINS_DIR',
      'PLATFORM_PREFLIGHT_TMP_DIR',
      'ENCRYPTION_KEY',
      'STORAGE_ENCRYPTION_KEYS',
      'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
    ]) {
      delete launchEnv[key];
    }

    const cliPath = path.join(packedRoot, 'bin', 'cli.js');
    const runningChildren = new Set();
    const launch = async () => {
      const portProbe = http.createServer();
      const port = await startServer(portProbe);
      await new Promise(resolve => portProbe.close(resolve));
      const child = spawn(process.execPath, [cliPath, '--port', String(port)], {
        cwd: callerDirectory,
        env: launchEnv,
        stdio: 'pipe',
      });
      runningChildren.add(child);
      let logs = '';
      child.stdout.on('data', chunk => {
        logs += chunk.toString();
      });
      child.stderr.on('data', chunk => {
        logs += chunk.toString();
      });
      try {
        await waitForServer(`http://127.0.0.1:${port}/health/ready`, child);
      } catch (error) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}\n\nPacked CLI logs:\n${logs}`
        );
      }
      return { child, port, logs: () => logs };
    };

    try {
      const first = await launch();
      try {
        const signup = await signupPackedUser(
          `http://127.0.0.1:${first.port}`,
          'packed-cli-admin'
        );
        assert.equal(signup.user.username, 'packed-cli-admin');
      } finally {
        await stopChild(first.child);
        runningChildren.delete(first.child);
      }

      const dataDirectory = path.join(fakeHome, '.libre-webui');
      assert.ok(fs.existsSync(path.join(dataDirectory, 'data.sqlite')));
      assert.ok(fs.existsSync(path.join(dataDirectory, '.encryption_key')));
      assert.deepEqual(
        fs.readFileSync(unrelatedCallerPlugin),
        unrelatedCallerPluginBefore,
        'the packaged launcher must neither import nor mutate caller plugins'
      );
      assert.equal(
        fs.existsSync(path.join(dataDirectory, 'plugins', 'unrelated.json')),
        false
      );

      // Installs created before the 0600 key write carry a 0644 key file. A
      // relaunch must tighten it in place instead of refusing to start.
      const persistentKeyPath = path.join(dataDirectory, '.encryption_key');
      fs.chmodSync(persistentKeyPath, 0o644);
      const legacyPermissions = await launch();
      try {
        assert.equal(
          fs.statSync(persistentKeyPath).mode & 0o777,
          0o600,
          'a loose owned key file must be tightened to 0600 on startup'
        );
      } finally {
        await stopChild(legacyPermissions.child);
        runningChildren.delete(legacyPermissions.child);
      }

      const recoveryInventory = JSON.parse(
        execFileSync(process.execPath, [cliPath, 'recovery-check', '--json'], {
          cwd: callerDirectory,
          env: launchEnv,
          encoding: 'utf8',
        })
      );
      assert.equal(recoveryInventory.restoreReady, true);
      assert.equal(recoveryInventory.storage.dataDirectory.path, dataDirectory);
      assert.equal(
        recoveryInventory.database.path,
        path.join(dataDirectory, 'data.sqlite')
      );

      const backupKeys = path.join(tempDir, 'backup-keys');
      const backupArchive = path.join(tempDir, 'packed-home.lwbackup');
      const keygen = JSON.parse(
        execFileSync(
          process.execPath,
          [cliPath, 'backup', 'keygen', '--directory', backupKeys],
          {
            cwd: callerDirectory,
            env: launchEnv,
            encoding: 'utf8',
          }
        )
      );
      assert.equal(
        keygen.encryptionKeyPath,
        path.join(backupKeys, 'backup-encryption.key')
      );
      const backup = JSON.parse(
        execFileSync(
          process.execPath,
          [
            cliPath,
            'backup',
            'create',
            '--offline',
            '--output',
            backupArchive,
            '--encryption-key',
            path.join(backupKeys, 'backup-encryption.key'),
            '--signing-private-key',
            path.join(backupKeys, 'backup-signing-private.pem'),
          ],
          {
            cwd: callerDirectory,
            env: launchEnv,
            encoding: 'utf8',
          }
        )
      );
      assert.equal(backup.created, true);
      assert.equal(backup.signatureVerified, true);
      assert.equal(backup.payloadVerified, true);
      assert.ok(fs.existsSync(backupArchive));
      assert.equal(
        fs.existsSync(path.join(callerDirectory, 'data.sqlite')),
        false,
        'maintenance must use the packaged fake-HOME data root, not caller cwd'
      );

      // The first start recorded a preflight verification marker, which
      // would let the second start skip the deep preflight entirely.
      // Removing it forces a real preflight so this test still proves the
      // packaged launcher puts preflight scratch in the OS cache location.
      fs.rmSync(path.join(dataDirectory, '.preflight-verification.json'), {
        force: true,
      });

      const second = await launch();
      try {
        const login = await fetch(
          `http://127.0.0.1:${second.port}/api/auth/login`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: 'packed-cli-admin',
              password: 'Packed-Test-Password-123',
            }),
          }
        );
        assert.equal(login.status, 200, second.logs());
        const payload = await login.json();
        assert.equal(payload.data?.user?.username, 'packed-cli-admin');
      } finally {
        await stopChild(second.child);
        runningChildren.delete(second.child);
      }

      const expectedPreflight =
        process.platform === 'win32'
          ? path.join(localAppData, 'libre-webui', 'preflight')
          : process.platform === 'darwin'
            ? path.join(
                fakeHome,
                'Library',
                'Caches',
                'libre-webui',
                'preflight'
              )
            : path.join(xdgCache, 'libre-webui', 'preflight');
      assert.ok(fs.existsSync(expectedPreflight));
      assert.equal(
        fs.existsSync(path.join(packedRoot, 'backend', 'temp')),
        false
      );
    } finally {
      for (const child of runningChildren) await stopChild(child);
      restoreInstallModes();
    }
  });
});

test('packed maintenance help creates no runtime state', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
    linkInstalledDependencies(packedRoot);
    const callerDirectory = path.join(tempDir, 'maintenance-caller');
    const fakeHome = path.join(tempDir, 'maintenance-home');
    const xdgCache = path.join(tempDir, 'maintenance-cache');
    fs.mkdirSync(callerDirectory, { recursive: true });
    const env = {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      XDG_CACHE_HOME: xdgCache,
    };
    for (const key of [
      'DATA_DIR',
      'PLUGINS_DIR',
      'PLATFORM_PREFLIGHT_TMP_DIR',
    ]) {
      delete env[key];
    }
    const cliPath = path.join(packedRoot, 'bin', 'cli.js');
    const recoveryHelp = execFileSync(
      process.execPath,
      [cliPath, 'recovery-check', '--help'],
      { cwd: callerDirectory, env, encoding: 'utf8' }
    );
    const backupHelp = execFileSync(
      process.execPath,
      [cliPath, 'backup', '--help'],
      { cwd: callerDirectory, env, encoding: 'utf8' }
    );
    const migrationHelp = execFileSync(
      process.execPath,
      [cliPath, 'migrate-postgres', '--help'],
      { cwd: callerDirectory, env, encoding: 'utf8' }
    );
    assert.match(recoveryHelp, /libre-webui recovery-check \[--json\]/);
    assert.match(backupHelp, /libre-webui backup create/);
    assert.match(migrationHelp, /libre-webui migrate-postgres --source/);

    const blocked = spawnSync(
      process.execPath,
      [cliPath, 'recovery-check', '--json'],
      { cwd: callerDirectory, env, encoding: 'utf8' }
    );
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).restoreReady, false);

    const invalid = spawnSync(
      process.execPath,
      [cliPath, 'recovery-check', '--unknown-option'],
      { cwd: callerDirectory, env, encoding: 'utf8' }
    );
    assert.equal(invalid.status, 2);
    assert.match(invalid.stderr, /Unknown option: --unknown-option/);
    assert.equal(fs.existsSync(fakeHome), false);
    assert.equal(fs.existsSync(xdgCache), false);
    assert.equal(fs.readdirSync(callerDirectory).length, 0);
    assert.equal(
      fs.existsSync(path.join(packedRoot, 'backend', 'data')),
      false
    );
    assert.equal(
      fs.existsSync(path.join(packedRoot, 'backend', 'temp')),
      false
    );
  });
});

test('packed npm artifact serves SPA routes from a dot-directory install', async () => {
  await withTempPackedProject(async ({ tempDir, packedRoot }) => {
    // npx runs the package from ~/.npm/_npx/<hash>/node_modules/… — a path
    // with a dot-segment in it. send() refuses absolute file paths that
    // contain dot-segments, so the SPA fallback must resolve index.html
    // against a root option. Recreate the npx layout and prove deep links
    // survive it; only "/" works when this regresses.
    const dotRoot = path.join(tempDir, '.npx-cache', 'node_modules');
    fs.mkdirSync(dotRoot, { recursive: true });
    const movedRoot = path.join(dotRoot, 'libre-webui');
    fs.renameSync(packedRoot, movedRoot);
    linkInstalledDependencies(movedRoot);

    const packedAssets = path.join(movedRoot, 'frontend', 'dist', 'assets');
    const workAudioAssets = fs
      .readdirSync(packedAssets)
      .filter(file => /^workAudioProcessor-[\w-]+\.js$/.test(file));
    assert.equal(
      workAudioAssets.length,
      1,
      'the production build must emit one external Work audio processor'
    );
    const workAudioAsset = workAudioAssets[0];
    assert.match(
      fs.readFileSync(path.join(packedAssets, workAudioAsset), 'utf8'),
      /registerProcessor\(['"]libre-work-audio['"]/
    );
    const packedScripts = [
      ...fs
        .readdirSync(packedAssets)
        .filter(file => file.endsWith('.js') && file !== workAudioAsset)
        .map(file => path.join(packedAssets, file)),
      ...fs
        .readdirSync(path.join(movedRoot, 'frontend', 'dist', 'js'))
        .filter(file => file.endsWith('.js'))
        .map(file => path.join(movedRoot, 'frontend', 'dist', 'js', file)),
    ];
    assert.ok(
      packedScripts.some(file =>
        fs.readFileSync(file, 'utf8').includes(workAudioAsset)
      ),
      'an application chunk must reference the external Work audio processor'
    );

    const portProbe = http.createServer();
    const backendPort = await startServer(portProbe);
    await new Promise(resolve => portProbe.close(resolve));

    const backendEntry = path.join(movedRoot, 'backend', 'dist', 'main.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: tempDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: path.join(tempDir, 'spa-runtime-data'),
        SERVE_FRONTEND: 'true',
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

      const rootResponse = await fetch(`http://127.0.0.1:${backendPort}/`);
      assert.equal(rootResponse.status, 200);
      const contentSecurityPolicy =
        rootResponse.headers.get('content-security-policy') ?? '';
      const scriptSources =
        contentSecurityPolicy
          .split(';')
          .map(directive => directive.trim())
          .find(directive => directive.startsWith('script-src ')) ?? '';
      assert.match(scriptSources, /'self'/);
      assert.doesNotMatch(scriptSources, /(?:^|\s)(?:blob:|data:)(?:\s|$)/);
      assert.match(await rootResponse.text(), /id="root"/);

      const workletResponse = await fetch(
        `http://127.0.0.1:${backendPort}/assets/${workAudioAsset}`
      );
      assert.equal(workletResponse.status, 200);
      assert.match(
        workletResponse.headers.get('content-type') ?? '',
        /javascript/
      );
      assert.match(
        await workletResponse.text(),
        /registerProcessor\(['"]libre-work-audio['"]/
      );

      for (const route of ['/login', '/c/some-session-id']) {
        const response = await fetch(`http://127.0.0.1:${backendPort}${route}`);
        assert.equal(
          response.status,
          200,
          `${route} must serve the SPA from a dot-directory install`
        );
        assert.match(await response.text(), /id="root"/);
      }
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nPacked backend logs:\n${backendLogs}`
      );
    } finally {
      await stopChild(backendProcess);
    }
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
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'main.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: callerDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: dataDir,
        OPENAI_API_KEY: 'test-openai-key',
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        JWT_SECRET: 'test-jwt-secret',
        ENABLE_SIGNUP: 'true',
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

      const adminUsageResponse = await fetch(
        `${backendBaseUrl}/api/plugins/usage?days=30`,
        { headers: pluginHeaders }
      );
      assert.equal(adminUsageResponse.status, 200);
      const adminUsagePayload = await adminUsageResponse.json();
      assert.equal(adminUsagePayload.success, true);
      assert.equal(adminUsagePayload.data?.range?.days, 30);

      const adminSystemResponse = await fetch(`${backendBaseUrl}/api/system`, {
        headers: pluginHeaders,
      });
      assert.equal(adminSystemResponse.status, 200);
      assert.equal(
        adminSystemResponse.headers.get('cache-control'),
        'no-store'
      );
      const adminSystemPayload = await adminSystemResponse.json();
      assert.equal(adminSystemPayload.success, true);
      assert.equal(
        typeof adminSystemPayload.data?.host?.uptimeSeconds,
        'number'
      );
      assert.equal(typeof adminSystemPayload.data?.memory?.freeBytes, 'number');
      assert.ok(Array.isArray(adminSystemPayload.data?.docker?.containers));

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

      // Endpoint, credential, activation, and usage setup consumed four
      // requests from this authenticated user's 1000-request plugin quota.
      for (let request = pluginReadStatuses.length; request < 996; request++) {
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

      const secondUser = await signupAndApprovePackedUser(
        backendBaseUrl,
        'packed-plugin-user',
        firstUser.token
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
      const forbiddenUsageRead = await fetch(
        `${backendBaseUrl}/api/plugins/usage?days=30`,
        {
          headers: { Authorization: `Bearer ${secondUser.token}` },
        }
      );
      assert.equal(
        forbiddenUsageRead.status,
        403,
        'only administrators may inspect instance-wide provider consumption'
      );
      const forbiddenSystemRead = await fetch(`${backendBaseUrl}/api/system`, {
        headers: { Authorization: `Bearer ${secondUser.token}` },
      });
      assert.equal(
        forbiddenSystemRead.status,
        403,
        'only administrators may inspect host and Docker diagnostics'
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
    const backendEntry = path.join(packedRoot, 'backend', 'dist', 'main.js');
    const backendProcess = spawn(process.execPath, [backendEntry], {
      cwd: callerDir,
      env: {
        ...process.env,
        PORT: String(backendPort),
        DATA_DIR: dataDir,
        OLLAMA_BASE_URL: 'http://127.0.0.1:9',
        JWT_SECRET: 'test-jwt-secret',
        ENABLE_SIGNUP: 'true',
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

test('every external import in the packed backend is a declared dependency', async () => {
  // The npx install gets only the root manifest's dependencies; a runtime
  // import satisfied by a workspace manifest alone crashes the CLI at boot
  // (0.19.5 shipped without parse5 this way).
  const rootManifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
  );
  const declared = new Set(Object.keys(rootManifest.dependencies ?? {}));
  const distRoot = path.join(repoRoot, 'backend', 'dist');
  assert.ok(fs.existsSync(distRoot), 'backend/dist must be built first');

  const importPattern =
    /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"]([^'"./][^'"]*)['"]/g;
  const missing = new Map();

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = fs.readFileSync(full, 'utf8');
      for (const match of source.matchAll(importPattern)) {
        const specifier = match[1];
        if (specifier.startsWith('node:')) continue;
        const parts = specifier.split('/');
        const name = specifier.startsWith('@')
          ? parts.slice(0, 2).join('/')
          : parts[0];
        if (declared.has(name)) continue;
        // Bare specifiers that are Node built-ins without the node: prefix.
        if (process.getBuiltinModule?.(name)) continue;
        if (!missing.has(name))
          missing.set(name, path.relative(repoRoot, full));
      }
    }
  };
  walk(distRoot);

  assert.deepEqual(
    Object.fromEntries(missing),
    {},
    'backend/dist imports packages the published manifest does not declare'
  );
});
