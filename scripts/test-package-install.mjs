/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Install the built npm package into a fresh consumer and exercise its HTTP API.
 * Run through npm so npm_execpath identifies the same npm CLI on every platform.
 * An optional argument selects a .tgz file or a directory containing one .tgz.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const installTimeout = 10 * 60_000;
const startupTimeout = 60_000;
const maxLogCharacters = 128 * 1024;

// Keep platform/toolchain discovery, but do not forward provider credentials,
// NODE_PATH/NODE_OPTIONS, application settings, or inherited npm configuration.
const platformEnvironment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(path|pathext|systemroot|windir|comspec|temp|tmp|tmpdir|home|userprofile|homedrive|homepath|localappdata|appdata|user|username|logname|lang|lc_all|lc_ctype|number_of_processors|processor_architecture|cc|cxx|python)$/i.test(
        key
      )
    )
  );

function inside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function archiveIn(candidate) {
  const absolute = path.resolve(candidate);
  const stat = await fs.lstat(absolute);
  if (stat.isFile() && absolute.endsWith('.tgz')) return absolute;
  assert.ok(stat.isDirectory(), 'Expected a regular .tgz file or a directory');
  const files = (await fs.readdir(absolute, { withFileTypes: true })).filter(
    entry => entry.isFile() && entry.name.endsWith('.tgz')
  );
  assert.equal(
    files.length,
    1,
    'The artifact directory must contain exactly one .tgz'
  );
  return path.join(absolute, files[0].name);
}

function launch(command, args, options, children) {
  const child = spawn(command, args, {
    ...options,
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const record = { child, output: '', done: false, error: undefined };
  children.add(record);
  const capture = data => {
    record.output = (record.output + data.toString()).slice(-maxLogCharacters);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', error => {
    record.error = error;
  });
  record.closed = new Promise(resolve => {
    child.once('close', (code, signal) => {
      record.done = true;
      resolve({ code, signal });
    });
  });
  return record;
}

async function settlesWithin(record, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      record.closed.then(() => true),
      new Promise(resolve => {
        timer = setTimeout(() => resolve(false), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopTree(record, children) {
  if (!record.done && record.child.pid) {
    if (process.platform === 'win32') {
      // Killing the CLI alone can leave its backend (or npm build children) alive.
      spawnSync(
        'taskkill.exe',
        ['/PID', String(record.child.pid), '/T', '/F'],
        {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 10_000,
        }
      );
    } else {
      try {
        process.kill(-record.child.pid, 'SIGTERM');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    }
    if (!(await settlesWithin(record, 5000))) {
      if (process.platform !== 'win32') {
        try {
          process.kill(-record.child.pid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
      assert.ok(
        await settlesWithin(record, 5000),
        'Child process tree did not stop'
      );
    }
  }
  children.delete(record);
}

async function run(command, args, options, children, signal, timeout = 60_000) {
  signal.throwIfAborted();
  const record = launch(command, args, options, children);
  let timer;
  let onAbort;
  try {
    const result = await Promise.race([
      record.closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Command timed out: ${command}`)),
          timeout
        );
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
    assert.equal(
      result.code,
      0,
      `${record.error?.message ?? command}\n${record.output}`
    );
    return record.output;
  } finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    await stopTree(record, children);
  }
}

async function unusedPort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close(error => (error ? reject(error) : resolve()))
  );
  return port;
}

test(
  'a clean production tarball install boots and preserves user data',
  {
    timeout: 15 * 60_000,
  },
  async t => {
    assert.ok(
      process.env.npm_execpath,
      'Run with npm run test:package-install'
    );
    assert.ok(
      process.argv.length <= 3,
      'Pass at most one tarball file or directory'
    );
    const npmCli = await fs.realpath(process.env.npm_execpath);
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'libre-package-install-')
    );
    const consumer = path.join(root, 'consumer');
    const state = path.join(root, 'state');
    const artifacts = path.join(root, 'artifacts');
    const children = new Set();
    const interrupted = new AbortController();
    const signal = AbortSignal.any([t.signal, interrupted.signal]);
    const interrupt = () =>
      interrupted.abort(new Error('Package smoke interrupted'));
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    t.after(async () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      const stopped = await Promise.allSettled(
        [...children].map(child => stopTree(child, children))
      );
      await fs.rm(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
      });
      const failed = stopped.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    });

    for (const directory of [consumer, state, artifacts])
      await fs.mkdir(directory);
    const userConfig = path.join(root, 'npm-user.npmrc');
    const globalConfig = path.join(root, 'npm-global.npmrc');
    await fs.writeFile(userConfig, 'registry=https://registry.npmjs.org/\n');
    await fs.writeFile(globalConfig, '');
    await fs.writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify({
        name: 'libre-package-install-smoke',
        version: '1.0.0',
        private: true,
      })
    );
    const environment = {
      ...platformEnvironment(),
      NPM_CONFIG_USERCONFIG: userConfig,
      NPM_CONFIG_GLOBALCONFIG: globalConfig,
      NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
      NPM_CONFIG_DEVDIR: path.join(root, 'node-gyp'),
      NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      NPM_CONFIG_UPDATE_NOTIFIER: 'false',
      DATA_DIR: state,
      PLUGINS_DIR: path.join(state, 'plugins'),
      PLATFORM_PREFLIGHT_TMP_DIR: path.join(root, 'preflight'),
      JWT_SECRET: randomBytes(48).toString('hex'),
      SESSION_SECRET: randomBytes(48).toString('hex'),
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      NODE_ENV: 'production',
      WEBUI_HOST: '127.0.0.1',
      OPEN_BROWSER: 'false',
      ENABLE_SIGNUP: 'true',
      SINGLE_USER_MODE: 'false',
      OLLAMA_ENABLED: 'false',
      OLLAMA_BASE_URL: 'http://127.0.0.1:9',
      CODEX_OAUTH_MODELS_ENABLED: 'false',
      AGENT_CLI_MODELS_ENABLED: 'false',
      LIBRE_CLAW_ENABLED: 'false',
      LIBRE_CORDIS_ENABLED: 'false',
    };
    if (!process.argv[2]) {
      await fs.access(path.join(repoRoot, 'backend/dist/main.js'));
      await fs.access(path.join(repoRoot, 'frontend/dist/index.html'));
      await run(
        process.execPath,
        [npmCli, 'pack', '--pack-destination', artifacts],
        { cwd: repoRoot, env: environment },
        children,
        signal,
        120_000
      );
    }
    const archive = await archiveIn(process.argv[2] ?? artifacts);
    console.log(
      'Installing the tarball with production dependencies and lifecycle scripts.'
    );
    await run(
      process.execPath,
      [
        npmCli,
        'install',
        '--omit=dev',
        '--ignore-scripts=false',
        '--no-audit',
        '--no-fund',
        archive,
      ],
      { cwd: consumer, env: environment },
      children,
      signal,
      installTimeout
    );

    const installation = path.join(consumer, 'node_modules/libre-webui');
    assert.ok(
      !(await fs.lstat(installation)).isSymbolicLink(),
      'The package must be installed, not linked'
    );
    const consumerReal = await fs.realpath(consumer);
    for (const artifact of [
      'package.json',
      'bin/cli.js',
      'backend/dist/main.js',
      'frontend/dist/index.html',
    ]) {
      assert.ok(
        inside(
          consumerReal,
          await fs.realpath(path.join(installation, artifact))
        ),
        `${artifact} escaped the clean installation`
      );
    }
    for (const directory of [
      consumer,
      installation,
      path.join(installation, 'backend'),
    ]) {
      await assert.rejects(fs.lstat(path.join(directory, '.env')), {
        code: 'ENOENT',
      });
    }
    const installedRequire = createRequire(
      path.join(installation, 'backend/dist/main.js')
    );
    for (const dependency of [
      'better-sqlite3',
      'express',
      'ws',
      'undici',
      '@aws-sdk/client-s3',
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-agent-loop',
      '@deepseek-ai/dsh-session-persistence-jsonl',
    ]) {
      const resolved = await fs.realpath(installedRequire.resolve(dependency));
      assert.ok(
        inside(consumerReal, resolved),
        `${dependency} resolved outside the clean installation: ${resolved}`
      );
    }
    const manifest = JSON.parse(
      await fs.readFile(path.join(installation, 'package.json'), 'utf8')
    );
    const cli = path.join(installation, 'bin/cli.js');
    const version = await run(
      process.execPath,
      [cli, '--version'],
      { cwd: consumer, env: environment },
      children,
      signal
    );
    assert.equal(version.trim(), `libre-webui v${manifest.version}`);

    const request = async (
      base,
      endpoint,
      { token, body, method = 'GET' } = {}
    ) => {
      signal.throwIfAborted();
      return fetch(`${base}${endpoint}`, {
        method,
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    };
    const jsonRequest = async (base, endpoint, options) => {
      const response = await request(base, endpoint, options);
      assert.equal(
        response.status,
        200,
        `${endpoint} returned ${response.status}`
      );
      const payload = await response.json();
      assert.equal(payload.success, true, `${endpoint} did not succeed`);
      return payload.data;
    };
    const start = async () => {
      const port = await unusedPort();
      const base = `http://127.0.0.1:${port}`;
      const processRecord = launch(
        process.execPath,
        [cli, '--port', String(port), '--no-open'],
        { cwd: consumer, env: environment },
        children
      );
      const deadline = Date.now() + startupTimeout;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        assert.ok(
          !processRecord.done,
          `Installed CLI exited before readiness:\n${processRecord.output}`
        );
        let ready = false;
        try {
          const response = await request(base, '/health/ready');
          ready = response.ok && (await response.json()).status === 'ready';
        } catch (error) {
          if (signal.aborted) throw error;
        }
        if (ready) {
          const live = await request(base, '/health/live');
          assert.equal(live.status, 200);
          const liveness = await live.json();
          assert.equal(liveness.status, 'alive');
          assert.equal(liveness.version, manifest.version);
          return { base, processRecord };
        }
        await delay(150, undefined, { signal });
      }
      throw new Error(
        `Installed backend did not become ready:\n${processRecord.output}`
      );
    };

    const first = await start();
    const frontend = await request(first.base, '/');
    assert.equal(frontend.status, 200);
    assert.match(frontend.headers.get('content-type') ?? '', /text\/html/);
    const html = await frontend.text();
    assert.match(html, /<div[^>]+id="root"/);
    const asset = html.match(/src="([^"]+\.js)"/);
    assert.ok(
      asset,
      'The installed frontend must reference its built JavaScript'
    );
    const assetUrl = new URL(asset[1], first.base);
    assert.equal(assetUrl.origin, first.base);
    const assetResponse = await request(first.base, assetUrl.pathname);
    assert.equal(assetResponse.status, 200);
    assert.match(assetResponse.headers.get('content-type') ?? '', /javascript/);
    assert.ok((await assetResponse.arrayBuffer()).byteLength > 0);

    const username = 'package_install_admin';
    const password = `Install-Smoke-${randomBytes(12).toString('hex')}!`;
    const signup = await jsonRequest(first.base, '/api/auth/signup', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(signup.user.username, username);
    assert.equal(signup.user.role, 'admin');
    assert.equal(typeof signup.token, 'string');
    const content = `persisted production install ${randomBytes(12).toString('hex')}`;
    const note = await jsonRequest(first.base, '/api/notes', {
      method: 'POST',
      token: signup.token,
      body: { title: 'Package install smoke', content },
    });
    assert.equal(note.content, content);
    await stopTree(first.processRecord, children);
    await fs.access(path.join(state, 'data.sqlite'));

    const second = await start();
    const login = await jsonRequest(second.base, '/api/auth/login', {
      method: 'POST',
      body: { username, password },
    });
    assert.equal(login.user.id, signup.user.id);
    const persisted = await jsonRequest(
      second.base,
      `/api/notes/${encodeURIComponent(note.id)}`,
      {
        token: login.token,
      }
    );
    assert.equal(persisted.id, note.id);
    assert.equal(persisted.title, 'Package install smoke');
    assert.equal(persisted.content, content);
    await stopTree(second.processRecord, children);
    console.log(
      `Production installation verified: libre-webui ${manifest.version}, ${process.platform}, Node ${process.version}.`
    );
  }
);
