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
 * Runs one Work turn with an agent CLI inside the task's sandbox.
 *
 * The CLI works in /workspace as the sandbox user, with its own tools
 * approved: the container is the security boundary, exactly as it is for
 * Work's built-in agent. It is signed in with a copy of the login it uses
 * on this server in which every token is a placeholder, and its API
 * traffic leaves through the egress relay to the backend proxy, which
 * injects the real token only for that login's own hosts.
 *
 * The CLI starts under a small Node supervisor in a new process group, so
 * a cancel or timeout stops the CLI and every command it started, even when
 * the container itself stays up for a live preview.
 */

import { createLogger } from '../utils/logger.js';
import { agentCliTokenUsage } from './agentCliUsage.js';
import type { ProviderTokenUsage } from './pluginUsageService.js';
import type { WorkTaskRecord } from '../types/work.js';
import type { WorkAgentCliSpec } from './workAgentCatalog.js';
import {
  WorkAgentLoginError,
  type WorkAgentHostLogin,
  type WorkAgentLogin,
} from './workAgentHostLogins.js';
import type { EgressEvent, WorkEgressProxy } from './workEgressProxy.js';
import { RELAY_SCRIPT, RelayMultiplexer } from './workEgressRelay.js';
import {
  WORK_AGENT_NODE,
  workAgentExecutable,
  workAgentSandboxPath,
  type WorkAgentToolchainService,
} from './workAgentToolchainService.js';
import {
  createWorkAgentStreamState,
  parseWorkAgentLine,
  type WorkAgentStreamEvent,
} from './workAgentStream.js';
import type {
  WorkRuntimeDriver,
  WorkSandboxProcess,
} from './workRuntimeDriver.js';
import { WorkRuntimeError, positiveInteger } from './workRuntimeShared.js';

const logger = createLogger('services:work-agent-cli');

const AGENT_DIR = '/tmp/libre-agent';
const DEFAULT_RUN_TIMEOUT_MS = 60 * 60_000;
const MAX_STDOUT_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STDERR_CHARS = 16_000;
const MAX_CHANGED_FILES = 50;
const MAX_RECORDED_EGRESS_EVENTS = 20;
const STOP_GRACE_SECONDS = 3;
/** How often a running agent's real login is checked for expiry. */
const LOGIN_REFRESH_INTERVAL_MS = 4 * 60_000;

/**
 * Writes the authority's certificate (stdin) and a bundle with the image's
 * own roots, creates the agent home, and marks the run start for the
 * changed-files scan.
 */
const PREPARE_SCRIPT = String.raw`set -e
umask 022
mkdir -p "${AGENT_DIR}/home"
cat > "${AGENT_DIR}/ca.pem"
{ cat /etc/ssl/certs/ca-certificates.crt 2>/dev/null || true; cat "${AGENT_DIR}/ca.pem"; } > "${AGENT_DIR}/ca-bundle.pem"
touch "$1"
`;

/**
 * Starts the CLI as the leader of a new process group, records the group id
 * for out-of-band stops, and mirrors the CLI's exit status.
 */
const SUPERVISOR_SCRIPT = String.raw`'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const [pidFile, command, ...args] = process.argv.slice(1);
const child = spawn(command, args, { detached: true, stdio: 'inherit' });
child.on('error', error => {
  process.stderr.write('Could not start ' + command + ': ' + error.message + '\n');
  process.exit(127);
});
if (child.pid) fs.writeFileSync(pidFile, String(child.pid));
const stop = signal => {
  try { process.kill(-child.pid, signal); } catch {}
};
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => stop(signal));
child.on('exit', (code, signal) => {
  try { fs.unlinkSync(pidFile); } catch {}
  process.exit(code === null ? (signal ? 137 : 1) : code);
});
`;

/**
 * Writes the run's login files into the agent home: a JSON list of
 * { path, content (base64) } on stdin, paths relative to the home given as
 * the first argument. Owner-only, like the CLIs keep them.
 */
const LOGIN_FILES_SCRIPT = String.raw`'use strict';
const fs = require('fs');
const path = require('path');
const home = path.resolve(process.argv[1]);
let input = '';
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
  for (const file of JSON.parse(input)) {
    const target = path.resolve(home, file.path);
    if (!target.startsWith(home + path.sep)) throw new Error('Refusing ' + file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    for (const stale of [target, target + '-wal', target + '-shm', target + '-journal']) {
      fs.rmSync(stale, { force: true });
    }
    fs.writeFileSync(target, Buffer.from(file.content, 'base64'), { mode: 0o600 });
  }
});
`;

/** Stops a recorded process group: TERM, a short grace, then KILL. */
const STOP_SCRIPT = String.raw`pid=$(cat "$1" 2>/dev/null) || exit 0
case "$pid" in ''|*[!0-9]*) exit 0 ;; esac
kill -TERM -"$pid" 2>/dev/null || exit 0
i=0
while [ "$i" -lt "${STOP_GRACE_SECONDS}" ] && kill -0 -"$pid" 2>/dev/null; do
  sleep 1
  i=$((i + 1))
done
kill -KILL -"$pid" 2>/dev/null
exit 0
`;

/** Files this run created or modified, newest first is not guaranteed. */
const CHANGED_FILES_SCRIPT = String.raw`find . -path ./.git -prune -o -type f -newer "$1" -print 2>/dev/null | head -n ${MAX_CHANGED_FILES}`;

/** Where a run's activity goes: Work's events, transcript, and status. */
export interface WorkAgentRunSink {
  phase(phase: 'installing' | 'starting' | 'running'): Promise<void>;
  text(delta: string): void;
  reasoning(delta: string): void;
  toolStart(call: {
    id: string;
    name: string;
    input?: Record<string, unknown>;
  }): Promise<void>;
  toolEnd(result: {
    id: string;
    name: string;
    output: string;
    isError: boolean;
  }): Promise<void>;
  usage(usage: ProviderTokenUsage): void;
}

export interface WorkAgentRunRequest {
  task: WorkTaskRecord;
  runId: string;
  cli: WorkAgentCliSpec;
  model: string | undefined;
  /** The CLI's login on this server; the run gets a placeholder copy. */
  login: WorkAgentHostLogin;
  prompt: string;
  signal: AbortSignal;
}

export interface WorkAgentRunResult {
  /** The CLI's answer, or '' when it reported none. */
  finalText: string;
  changedFiles: string[];
  usage?: ProviderTokenUsage;
}

export interface WorkAgentCliRunnerDependencies {
  driver: () => WorkRuntimeDriver;
  proxy: WorkEgressProxy;
  toolchain: WorkAgentToolchainService;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('The Work run was cancelled.');
}

/** Resolve with the promise, or reject as soon as the signal aborts. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', abort);
        reject(error);
      }
    );
  });
}

function collectTail(stream: NodeJS.ReadableStream): () => string {
  let tail = '';
  stream.on('data', (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-MAX_STDERR_CHARS);
  });
  stream.on('error', () => undefined);
  return () => tail;
}

export class WorkAgentCliRunner {
  constructor(private readonly deps: WorkAgentCliRunnerDependencies) {}

  get timeoutMs(): number {
    return positiveInteger(
      process.env.WORK_AGENT_RUN_TIMEOUT_MS,
      DEFAULT_RUN_TIMEOUT_MS
    );
  }

  async run(
    request: WorkAgentRunRequest,
    sink: WorkAgentRunSink
  ): Promise<WorkAgentRunResult> {
    const { task, cli, signal } = request;
    signal.throwIfAborted();
    if (!this.deps.toolchain.isCurrent(cli)) await sink.phase('installing');
    await this.deps.toolchain.ensureInstalled(cli, signal);
    signal.throwIfAborted();
    await sink.phase('starting');

    let login: WorkAgentLogin;
    try {
      login = await request.login.prepare(request.model, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof WorkAgentLoginError) {
        throw new WorkRuntimeError(error.message, error.status, error.code);
      }
      throw error;
    }
    const model = request.model ?? login.model;

    const driver = this.deps.driver();
    const runKey = request.runId.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64);
    const pidFile = `${AGENT_DIR}/run-${runKey}.pid`;
    const startMarker = `${AGENT_DIR}/run-${runKey}.start`;
    const egressProblems: EgressEvent[] = [];
    const { session, certificateAuthorityPem } = this.deps.proxy.createSession({
      credentials: login.credentials,
      allowOtherHosts: task.networkEnabled,
      supportHosts: cli.supportHosts,
      onEvent: event => {
        if (event.type !== 'deny' && event.type !== 'error') return;
        if (egressProblems.length < MAX_RECORDED_EGRESS_EVENTS) {
          egressProblems.push(event);
        }
        logger.info(
          `Work agent egress ${event.type} for task ${task.id}: ${event.host}`
        );
      },
    });

    let relayProcess: WorkSandboxProcess | undefined;
    let relay: RelayMultiplexer | undefined;
    let agent: WorkSandboxProcess | undefined;
    let agentRunning = false;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    try {
      await driver.exec(task, ['sh', '-c', PREPARE_SCRIPT, 'sh', startMarker], {
        input: certificateAuthorityPem,
        timeoutMs: 30_000,
        abortSignal: signal,
      });
      if (login.files.length > 0) {
        await driver.exec(
          task,
          [WORK_AGENT_NODE, '-e', LOGIN_FILES_SCRIPT, `${AGENT_DIR}/home`],
          {
            input: JSON.stringify(
              login.files.map(file => ({
                path: file.path,
                content: file.content.toString('base64'),
              }))
            ),
            timeoutMs: 30_000,
            abortSignal: signal,
          }
        );
      }
      if (login.refresh) {
        const refresh = login.refresh;
        refreshTimer = setInterval(() => {
          refresh(signal).catch(error =>
            logger.warn(
              `Could not refresh the ${cli.name} login during task ${task.id}:`,
              error
            )
          );
        }, LOGIN_REFRESH_INTERVAL_MS);
        refreshTimer.unref?.();
      }

      relayProcess = await driver.openProcess(
        task,
        [WORK_AGENT_NODE, '-e', RELAY_SCRIPT],
        { workdir: '/tmp' }
      );
      const relayErrors = collectTail(relayProcess.stderr);
      relay = new RelayMultiplexer(relayProcess.stdout, relayProcess.stdin);
      relay.on('connection', stream => session.accept(stream));
      let port: number;
      try {
        port = await untilAborted(relay.ready, signal);
      } catch (error) {
        signal.throwIfAborted();
        const detail =
          relayErrors().trim() || (error instanceof Error ? error.message : '');
        throw new WorkRuntimeError(
          `The sandbox egress relay did not start${detail ? `: ${detail}` : '.'}`,
          503,
          'WORK_AGENT_RELAY_FAILED'
        );
      }

      const proxyUrl = `http://127.0.0.1:${port}`;
      const bundle = `${AGENT_DIR}/ca-bundle.pem`;
      const env: Record<string, string> = {
        ...cli.env,
        ...login.env,
        HOME: `${AGENT_DIR}/home`,
        PATH: workAgentSandboxPath(cli.id),
        HTTPS_PROXY: proxyUrl,
        HTTP_PROXY: proxyUrl,
        https_proxy: proxyUrl,
        http_proxy: proxyUrl,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        no_proxy: 'localhost,127.0.0.1,::1',
        NODE_USE_ENV_PROXY: '1',
        NODE_EXTRA_CA_CERTS: `${AGENT_DIR}/ca.pem`,
        SSL_CERT_FILE: bundle,
        REQUESTS_CA_BUNDLE: bundle,
        CURL_CA_BUNDLE: bundle,
        GIT_SSL_CAINFO: bundle,
      };
      agent = await driver.openProcess(
        task,
        [
          WORK_AGENT_NODE,
          '-e',
          SUPERVISOR_SCRIPT,
          '--',
          pidFile,
          workAgentExecutable(cli),
          ...cli.buildArgs(model),
        ],
        { env, workdir: '/workspace' }
      );
      agentRunning = true;
      await sink.phase('running');
      const agentErrors = collectTail(agent.stderr);
      agent.stdin.end(request.prompt);

      const state = createWorkAgentStreamState();
      let finalText = '';
      let failure: string | undefined;
      let stdoutBytes = 0;
      let pending = '';
      let overflow: string | undefined;
      let delivery = Promise.resolve();
      const deliver = (events: WorkAgentStreamEvent[]): void => {
        for (const event of events) {
          if (event.type === 'text') sink.text(event.text);
          else if (event.type === 'reasoning') sink.reasoning(event.text);
          else if (event.type === 'final') finalText = event.text;
          else if (event.type === 'failure') failure ??= event.message;
          else if (event.type === 'tool_start') {
            const { id, name, input } = event;
            delivery = delivery.then(() =>
              sink.toolStart({ id, name, ...(input ? { input } : {}) })
            );
          } else {
            const { id, name, output, isError } = event;
            delivery = delivery.then(() =>
              sink.toolEnd({ id, name, output, isError })
            );
          }
        }
        const usage = agentCliTokenUsage(state.usage);
        if (usage) sink.usage(usage);
      };
      const stopForOverflow = (reason: string): void => {
        overflow ??= reason;
        void this.stopAgent(driver, task, pidFile);
      };
      agent.stdout.on('data', (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT_BYTES) {
          stopForOverflow(
            'The agent produced more output than a Work run allows.'
          );
          return;
        }
        pending += chunk.toString('utf8');
        let newline = pending.indexOf('\n');
        while (newline !== -1) {
          deliver(parseWorkAgentLine(cli.id, pending.slice(0, newline), state));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf('\n');
        }
        if (pending.length > MAX_LINE_BYTES) pending = '';
      });
      agent.stdout.on('error', () => undefined);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<'timeout'>(resolve => {
        timer = setTimeout(() => resolve('timeout'), this.timeoutMs);
        timer.unref?.();
      });
      let outcome: number | null | 'timeout';
      try {
        outcome = await untilAborted(
          Promise.race([agent.exited, timedOut]),
          signal
        );
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (outcome === 'timeout') {
        await this.stopAgent(driver, task, pidFile);
        throw new WorkRuntimeError(
          `${cli.name} did not finish within ${Math.round(this.timeoutMs / 60_000)} minutes.`,
          504,
          'WORK_AGENT_TIMEOUT'
        );
      }
      agentRunning = false;
      if (pending) deliver(parseWorkAgentLine(cli.id, pending, state));
      await delivery;
      if (overflow) {
        throw new WorkRuntimeError(overflow, 413, 'WORK_AGENT_OUTPUT_LIMIT');
      }
      if (failure) {
        throw new WorkRuntimeError(failure, 502, 'WORK_AGENT_FAILED');
      }
      const answer = finalText || state.trailingText.trim();
      if (outcome !== 0 && !answer) {
        throw new WorkRuntimeError(
          this.describeFailure(cli, outcome, agentErrors(), egressProblems),
          502,
          'WORK_AGENT_FAILED'
        );
      }
      const changedFiles = await this.changedFiles(driver, task, startMarker);
      const usage = agentCliTokenUsage(state.usage);
      return { finalText: answer, changedFiles, ...(usage ? { usage } : {}) };
    } finally {
      if (refreshTimer) clearInterval(refreshTimer);
      if (agentRunning) await this.stopAgent(driver, task, pidFile);
      agent?.kill();
      relay?.close();
      relayProcess?.kill();
      session.close();
    }
  }

  private describeFailure(
    cli: WorkAgentCliSpec,
    exitCode: number | null,
    stderr: string,
    egress: readonly EgressEvent[]
  ): string {
    const lines = stderr
      .split('\n')
      .map(line => line.trim())
      .filter(
        line =>
          line && !/Warning: EnvHttpProxyAgent|--trace-warnings/.test(line)
      );
    const detail = lines.slice(-6).join('\n');
    const denied = egress.find(event => event.type === 'deny');
    const hint = denied
      ? ` Network access to ${denied.host} was refused: this task has no network.`
      : '';
    return `${cli.name} exited unsuccessfully (${exitCode ?? 'killed'}).${hint}${detail ? `\n${detail}` : ''}`;
  }

  private async stopAgent(
    driver: WorkRuntimeDriver,
    task: WorkTaskRecord,
    pidFile: string
  ): Promise<void> {
    try {
      await driver.exec(task, ['sh', '-c', STOP_SCRIPT, 'sh', pidFile], {
        timeoutMs: (STOP_GRACE_SECONDS + 10) * 1000,
        acceptFailure: true,
      });
    } catch (error) {
      logger.warn(`Could not stop the agent CLI in task ${task.id}:`, error);
    }
  }

  private async changedFiles(
    driver: WorkRuntimeDriver,
    task: WorkTaskRecord,
    startMarker: string
  ): Promise<string[]> {
    try {
      const result = await driver.exec(
        task,
        ['sh', '-c', CHANGED_FILES_SCRIPT, 'sh', startMarker],
        { timeoutMs: 30_000, acceptFailure: true }
      );
      return result.stdout
        .split('\n')
        .map(line => line.trim().replace(/^\.\//, ''))
        .filter(Boolean)
        .slice(0, MAX_CHANGED_FILES);
    } catch {
      return [];
    }
  }
}
