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

import { spawn } from 'node:child_process';
import http from 'node:http';
import type { Duplex } from 'node:stream';

import type { WorkTaskRecord } from '../types/work.js';
import {
  dockerEndpointRequestOptions,
  resolveDockerEndpoint,
} from '../utils/dockerEndpoint.js';
import { createLogger } from '../utils/logger.js';
import workPolicyService from './workPolicyService.js';
import {
  ProcessOptions,
  ProcessResult,
  ResolvedWorkRuntimePolicy,
  WorkRuntimeError,
  WORK_RUNTIME_DEFAULTS,
  computePolicyFingerprint,
  defaultRuntimePolicy,
  workRuntimeConfig as config,
} from './workRuntimeShared.js';

const logger = createLogger('services:work-runtime');
const activeDockerProcesses = new Set<ReturnType<typeof spawn>>();

export interface WorkExecOptions extends ProcessOptions {
  /** Working directory inside the sandbox. Defaults to /workspace. */
  workdir?: string;
}

export interface DiscoveredWorkContainer {
  name: string;
  taskId: string;
  running: boolean;
}

export type WorkRuntimeState = 'absent' | 'stopped' | 'running';

/**
 * A raw interactive TTY attached to the sandbox: bidirectional terminal
 * bytes plus a resize control channel. Session policy (per-task limits,
 * holds, idle timeouts) lives with the terminal service, not here.
 */
export interface WorkTerminalTransport {
  stream: Duplex;
  resize: (cols: number, rows: number) => Promise<void>;
}

/**
 * The mechanics of running one task sandbox, behind which the Docker and
 * Kubernetes runtime backends are interchangeable. The runtime service
 * owns every policy decision — admission, leases, lifecycle locks, task
 * ownership rules, output budgets — and calls a driver only to make the
 * sandbox world match what policy already decided. Drivers verify resource
 * ownership labels before every destructive operation; they never decide
 * whether an operation should happen.
 */
export interface WorkRuntimeDriver {
  /** Stable identity reported through the Work capability contract. */
  readonly kind: 'docker' | 'kubernetes';
  /** Reject with an operator-actionable reason when the backend is down. */
  probe(): Promise<void>;
  /** Kill in-flight backend processes during shutdown. */
  shutdown(): void;
  /** Make a runtime image available. No cross-call deduplication. */
  ensureImage(image?: string): Promise<void>;
  /** Create the task workspace if needed; verify ownership if it exists. */
  ensureWorkspace(task: WorkTaskRecord): Promise<void>;
  /**
   * Bring the sandbox to a running state with a policy-fresh configuration,
   * recreating it when its recorded policy is stale.
   */
  ensureRuntime(task: WorkTaskRecord): Promise<void>;
  /** Current sandbox state; verifies ownership when the sandbox exists. */
  runtimeState(task: WorkTaskRecord): Promise<WorkRuntimeState>;
  /** Stop the sandbox if it exists. Ownership-checked; absent is a no-op. */
  stopRuntime(task: WorkTaskRecord): Promise<void>;
  /** Remove the sandbox if it exists. Ownership-checked; absent is a no-op. */
  removeRuntime(task: WorkTaskRecord): Promise<void>;
  /**
   * Remove the sandbox and workspace together. Every destructive target is
   * ownership-validated before either is removed, so a conflicting unmanaged
   * resource cannot cause partial cleanup.
   */
  removeTaskResources(task: WorkTaskRecord): Promise<void>;
  /** Run a command inside the sandbox as the unprivileged sandbox user. */
  exec(
    task: WorkTaskRecord,
    command: string[],
    options?: WorkExecOptions
  ): Promise<ProcessResult>;
  /**
   * Endpoint the backend can reach the task's preview server on, if any.
   * A missing host means the proxy's configured upstream host (the Docker
   * publish interface); Kubernetes returns the sandbox Pod IP.
   */
  previewEndpoint(
    task: WorkTaskRecord
  ): Promise<{ host?: string; port: number } | undefined>;
  /** Every sandbox this runtime has ever created, by ownership label. */
  listManaged(): Promise<DiscoveredWorkContainer[]>;
  /** Force-remove a managed sandbox whose task record no longer exists. */
  removeOrphan(name: string): Promise<void>;
  /**
   * Every workspace this runtime has created, by ownership label, so
   * reconciliation can report workspaces whose task record no longer
   * exists. Orphaned workspaces are only reported, never auto-deleted.
   */
  listWorkspaces?(): Promise<{ name: string; taskId: string }[]>;
  /** Why interactive terminals are unavailable on this backend, if so. */
  terminalUnavailableReason(): string | null;
  /** Open an interactive TTY inside the sandbox as the unprivileged user. */
  openTerminal(containerName: string): Promise<WorkTerminalTransport>;
}

export class DockerWorkRuntimeDriver implements WorkRuntimeDriver {
  readonly kind = 'docker' as const;
  readonly image = config.image;

  async probe(): Promise<void> {
    try {
      await this.docker(['info', '--format', '{{.ServerVersion}}'], {
        timeoutMs: 5_000,
      });
    } catch (error) {
      throw new WorkRuntimeError(
        describeDockerUnavailable(error, config.dockerCommand),
        503,
        'WORK_DOCKER_UNAVAILABLE'
      );
    }
  }

  shutdown(): void {
    for (const child of activeDockerProcesses) {
      child.kill('SIGKILL');
    }
  }

  async ensureImage(image = config.image): Promise<void> {
    const inspected = await this.docker(['image', 'inspect', image], {
      timeoutMs: 10_000,
      acceptFailure: true,
    });
    if (inspected.exitCode === 0) return;
    logger.info(`Pulling Work runtime image ${image}`);
    await this.docker(['pull', image], { timeoutMs: 900_000 });
  }

  async ensureWorkspace(task: WorkTaskRecord): Promise<void> {
    if (await this.volumeExists(task.volumeName)) {
      await this.assertManagedVolume(task);
      return;
    }
    await this.docker([
      'volume',
      'create',
      '--label',
      'ai.libre-webui.managed=true',
      '--label',
      `ai.libre-webui.task=${task.id}`,
      task.volumeName,
    ]);
    // Docker returns an existing volume from `volume create` if another
    // process wins the name race, so prove ownership before mounting it.
    await this.assertManagedVolume(task);
    try {
      await this.initializeVolume(
        task,
        workPolicyService.resolve(task.policyId).image
      );
    } catch (error) {
      await this.docker(['volume', 'rm', task.volumeName], {
        acceptFailure: true,
      });
      throw error;
    }
  }

  async ensureRuntime(task: WorkTaskRecord): Promise<void> {
    const policy = workPolicyService.resolve(task.policyId);
    await this.ensureWorkNetwork(task);
    if (await this.containerExists(task.containerName)) {
      await this.assertManagedContainer(task);
      if (!(await this.containerMatchesTaskPolicy(task, policy))) {
        logger.warn(
          `Recreating Work container ${task.containerName} because its isolation policy is stale.`
        );
        await this.docker(['rm', '-f', task.containerName]);
        await this.docker(buildWorkContainerRunArgs(task, policy));
        return;
      }
      const state = await this.docker([
        'inspect',
        '--format',
        '{{.State.Running}}',
        task.containerName,
      ]);
      if (state.stdout.trim() !== 'true') {
        await this.docker(['start', task.containerName]);
      }
      return;
    }
    await this.docker(buildWorkContainerRunArgs(task, policy));
  }

  async runtimeState(task: WorkTaskRecord): Promise<WorkRuntimeState> {
    if (!(await this.containerExists(task.containerName))) return 'absent';
    await this.assertManagedContainer(task);
    return (await this.containerIsRunning(task.containerName))
      ? 'running'
      : 'stopped';
  }

  async stopRuntime(task: WorkTaskRecord): Promise<void> {
    if (!(await this.containerExists(task.containerName))) return;
    await this.assertManagedContainer(task);
    await this.docker(['stop', '--time', '1', task.containerName], {
      timeoutMs: 10_000,
    });
  }

  async removeRuntime(task: WorkTaskRecord): Promise<void> {
    if (!(await this.containerExists(task.containerName))) return;
    await this.assertManagedContainer(task);
    await this.docker(['rm', '-f', task.containerName]);
  }

  async removeTaskResources(task: WorkTaskRecord): Promise<void> {
    const [hasContainer, hasVolume] = await Promise.all([
      this.containerExists(task.containerName),
      this.volumeExists(task.volumeName),
    ]);
    // Validate every destructive target before removing either one, so a
    // conflicting unmanaged Docker resource cannot cause partial cleanup.
    if (hasContainer) {
      await this.assertManagedContainer(task);
    }
    if (hasVolume) {
      await this.assertManagedVolume(task);
    }
    if (hasContainer) {
      await this.docker(['rm', '-f', task.containerName], {
        timeoutMs: 15_000,
      });
    }
    if (hasVolume) {
      await this.docker(['volume', 'rm', task.volumeName], {
        timeoutMs: 15_000,
      });
    }
  }

  async exec(
    task: WorkTaskRecord,
    command: string[],
    options: WorkExecOptions = {}
  ): Promise<ProcessResult> {
    const args = [
      'exec',
      ...(options.input !== undefined ? ['--interactive'] : []),
      '--user',
      '1000:1000',
      '--workdir',
      options.workdir ?? '/workspace',
      task.containerName,
      ...command,
    ];
    return this.docker(args, options);
  }

  async previewEndpoint(
    task: WorkTaskRecord
  ): Promise<{ host?: string; port: number } | undefined> {
    const portResult = await this.docker([
      'port',
      task.containerName,
      `${config.previewPort}/tcp`,
    ]);
    const port = parsePublishedPort(portResult.stdout, config.previewPort);
    // No host: the proxy targets its configured upstream (publish) interface.
    return port === undefined ? undefined : { port };
  }

  /**
   * Every container the Work runtime has ever created, in one daemon query,
   * identified by the managed label stamped at `docker run` time.
   */
  async listManaged(): Promise<DiscoveredWorkContainer[]> {
    const result = await this.docker(
      [
        'ps',
        '--all',
        '--no-trunc',
        '--filter',
        'label=ai.libre-webui.managed=true',
        '--format',
        '{{.Names}}\t{{.State}}\t{{.Label "ai.libre-webui.task"}}',
      ],
      { timeoutMs: 15_000 }
    );
    return parseManagedContainerList(result.stdout);
  }

  async removeOrphan(name: string): Promise<void> {
    await this.docker(['rm', '--force', name], { timeoutMs: 15_000 });
  }

  /**
   * The terminal talks to the Docker Engine API directly because a TTY exec
   * needs a hijacked bidirectional stream, which the docker CLI only offers
   * to an interactive controlling terminal. The connection is the resolved
   * Docker endpoint: the Unix socket, or a plain-HTTP tcp:// endpoint such
   * as a socket proxy holding the socket on the app's behalf — the hijacked
   * stream survives an HTTP-aware proxy because it rides a standard
   * Connection: Upgrade tunnel. Endpoints this client cannot speak to
   * (ssh://, TLS-verified tcp) make the terminal report itself unavailable
   * instead of guessing.
   */
  private readonly terminalEndpoint = resolveDockerEndpoint(
    process.env.WORK_DOCKER_SOCKET,
    process.env.DOCKER_HOST,
    process.env.DOCKER_TLS_VERIFY
  );

  terminalUnavailableReason(): string | null {
    if (!this.terminalEndpoint) {
      return 'The Work terminal needs a reachable Docker Engine API. Set WORK_DOCKER_SOCKET to the Unix socket path, or point DOCKER_HOST at a plain-HTTP tcp:// endpoint such as a socket proxy (DOCKER_HOST currently names an endpoint this client cannot speak to).';
    }
    return null;
  }

  async openTerminal(containerName: string): Promise<WorkTerminalTransport> {
    const created = await this.terminalApi(
      'POST',
      `/containers/${encodeURIComponent(containerName)}/exec`,
      buildExecCreatePayload()
    );
    const execId = parseExecId(created);
    const stream = await this.startExecStream(execId);
    return {
      stream,
      resize: async (cols: number, rows: number) => {
        await this.terminalApi(
          'POST',
          `/exec/${encodeURIComponent(execId)}/resize?w=${cols}&h=${rows}`
        );
      },
    };
  }

  /**
   * Transport options for the resolved endpoint. A Unix socket needs an
   * explicit Host header (there is no authority in the request target); a
   * tcp endpoint gets the real host:port so an HTTP-aware proxy can route
   * on it.
   */
  private terminalTransport(): {
    options: { socketPath: string } | { host: string; port: number };
    hostHeader: Record<string, string>;
  } {
    const endpoint = this.terminalEndpoint;
    if (!endpoint) {
      throw new WorkRuntimeError(
        this.terminalUnavailableReason() ?? 'The Work terminal is unavailable.',
        503,
        'WORK_TERMINAL_UNAVAILABLE'
      );
    }
    return {
      options: dockerEndpointRequestOptions(endpoint),
      hostHeader: endpoint.kind === 'unix' ? { Host: 'docker' } : {},
    };
  }

  private terminalApi(
    method: 'GET' | 'POST',
    path: string,
    payload?: unknown
  ): Promise<DockerApiResponse> {
    return new Promise((resolve, reject) => {
      const body = payload === undefined ? undefined : JSON.stringify(payload);
      const { options, hostHeader } = this.terminalTransport();
      const request = http.request(
        {
          ...options,
          method,
          path,
          headers: {
            ...hostHeader,
            'Content-Type': 'application/json',
            'Content-Length': body ? Buffer.byteLength(body) : 0,
          },
        },
        response => {
          const chunks: Buffer[] = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
            });
          });
        }
      );
      request.setTimeout(10_000, () => {
        request.destroy(new Error('Docker Engine API request timed out.'));
      });
      request.on('error', error => {
        reject(
          new WorkRuntimeError(
            `Could not reach the Docker Engine socket for the terminal: ${error.message}`,
            503,
            'WORK_TERMINAL_UNAVAILABLE'
          )
        );
      });
      if (body) request.write(body);
      request.end();
    });
  }

  private startExecStream(execId: string): Promise<Duplex> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ Detach: false, Tty: true });
      const { options, hostHeader } = this.terminalTransport();
      const request = http.request({
        ...options,
        method: 'POST',
        path: `/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          ...hostHeader,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          Connection: 'Upgrade',
          Upgrade: 'tcp',
        },
      });
      request.on('upgrade', (_response, socket, head) => {
        // With Tty:true the hijacked stream is raw terminal bytes in both
        // directions; no stream-multiplexing frames to parse.
        if (head.length > 0) socket.unshift(head);
        resolve(socket);
      });
      request.on('response', response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          reject(
            new WorkRuntimeError(
              `The Docker Engine refused the terminal stream (HTTP ${response.statusCode}): ${Buffer.concat(chunks).toString('utf8').trim()}`,
              503,
              'WORK_TERMINAL_UNAVAILABLE'
            )
          );
        });
      });
      request.on('error', error => {
        reject(
          new WorkRuntimeError(
            `Could not open the terminal stream: ${error.message}`,
            503,
            'WORK_TERMINAL_UNAVAILABLE'
          )
        );
      });
      request.write(body);
      request.end();
    });
  }

  private async ensureWorkNetwork(task: WorkTaskRecord): Promise<void> {
    if (!task.networkEnabled) return;
    const inspect = await this.docker(
      [
        'network',
        'inspect',
        '--format',
        '{{index .Labels "ai.libre-webui.managed"}} {{index .Options "com.docker.network.bridge.enable_icc"}}',
        config.networkName,
      ],
      { acceptFailure: true }
    );
    if (inspect.exitCode === 0) {
      const [managed, icc] = inspect.stdout.trim().split(' ');
      if (managed !== 'true' || icc !== 'false') {
        throw new WorkRuntimeError(
          `Docker network "${config.networkName}" exists but is not the managed Work sandbox network (label ai.libre-webui.managed=true with inter-container communication disabled). Remove it or point WORK_NETWORK_NAME at an unused name.`,
          503,
          'WORK_NETWORK_CONFLICT'
        );
      }
      return;
    }
    const created = await this.docker(
      [
        'network',
        'create',
        '--label',
        'ai.libre-webui.managed=true',
        '--opt',
        'com.docker.network.bridge.enable_icc=false',
        config.networkName,
      ],
      { acceptFailure: true }
    );
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      throw new WorkRuntimeError(
        `Could not create the Work sandbox network "${config.networkName}": ${created.stderr.trim()}`,
        503,
        'WORK_NETWORK_UNAVAILABLE'
      );
    }
  }

  private async initializeVolume(
    task: WorkTaskRecord,
    image = this.image
  ): Promise<void> {
    await this.docker([
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--tmpfs',
      '/tmp:rw,noexec,nosuid,size=64m',
      '--cap-drop',
      'ALL',
      '--cap-add',
      'CHOWN',
      '--mount',
      `type=volume,src=${task.volumeName},dst=/workspace`,
      image,
      'chown',
      '-R',
      '1000:1000',
      '/workspace',
    ]);
  }

  private async volumeExists(name: string): Promise<boolean> {
    const result = await this.docker(['volume', 'inspect', name], {
      timeoutMs: 5_000,
      acceptFailure: true,
    });
    if (result.exitCode === 0) return true;
    if (/no such volume/i.test(`${result.stderr}\n${result.stdout}`)) {
      return false;
    }
    throw new WorkRuntimeError(
      `Could not inspect Work volume "${name}": ${result.stderr.trim() || result.stdout.trim() || `Docker exited with code ${result.exitCode}.`}`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async containerExists(name: string): Promise<boolean> {
    const result = await this.docker(['container', 'inspect', name], {
      timeoutMs: 5_000,
      acceptFailure: true,
    });
    if (result.exitCode === 0) return true;
    if (
      /no such (?:container|object)/i.test(`${result.stderr}\n${result.stdout}`)
    ) {
      return false;
    }
    throw new WorkRuntimeError(
      `Could not inspect Work container "${name}": ${result.stderr.trim() || result.stdout.trim() || `Docker exited with code ${result.exitCode}.`}`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async containerIsRunning(name: string): Promise<boolean> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{.State.Running}}',
      name,
    ]);
    const state = result.stdout.trim();
    if (state === 'true') return true;
    if (state === 'false') return false;
    throw new WorkRuntimeError(
      `Docker returned an invalid state for Work container "${name}".`,
      503,
      'WORK_DOCKER_INSPECT_FAILED'
    );
  }

  private async assertManagedContainer(task: WorkTaskRecord): Promise<void> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{ index .Config.Labels "ai.libre-webui.task" }}',
      task.containerName,
    ]);
    if (result.stdout.trim() !== task.id) {
      throw new WorkRuntimeError(
        `Refusing to operate unmanaged container "${task.containerName}".`,
        409,
        'WORK_CONTAINER_NAME_CONFLICT'
      );
    }
  }

  private async containerMatchesTaskPolicy(
    task: WorkTaskRecord,
    policy: ResolvedWorkRuntimePolicy = defaultRuntimePolicy
  ): Promise<boolean> {
    const result = await this.docker([
      'inspect',
      '--format',
      '{{json .}}',
      task.containerName,
    ]);
    let inspected: Record<string, unknown>;
    try {
      inspected = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return false;
    }
    const containerConfig = objectRecord(inspected.Config);
    const hostConfig = objectRecord(inspected.HostConfig);
    const labels = objectRecord(containerConfig.Labels);
    const env = stringArray(containerConfig.Env);
    const capDrop = stringArray(hostConfig.CapDrop);
    const securityOpt = stringArray(hostConfig.SecurityOpt);
    const command = stringArray(containerConfig.Cmd);
    const mounts = Array.isArray(inspected.Mounts)
      ? inspected.Mounts.map(objectRecord)
      : [];
    const workspaceMount = mounts.find(
      mount => mount.Destination === '/workspace'
    );
    const expectedNetwork = task.networkEnabled ? config.networkName : 'none';
    const portBindings = objectRecord(hostConfig.PortBindings);
    const previewBindings = Array.isArray(
      portBindings[`${config.previewPort}/tcp`]
    )
      ? (portBindings[`${config.previewPort}/tcp`] as unknown[]).map(
          objectRecord
        )
      : [];
    const portPolicyMatches = task.networkEnabled
      ? Object.keys(portBindings).length === 1 &&
        previewBindings.length === 1 &&
        previewBindings[0]?.HostIp === config.previewBind
      : Object.keys(portBindings).length === 0;
    return (
      labels['ai.libre-webui.managed'] === 'true' &&
      labels['ai.libre-webui.task'] === task.id &&
      labels['ai.libre-webui.policy'] === computePolicyFingerprint(policy) &&
      containerConfig.Image === policy.image &&
      containerConfig.User === '1000:1000' &&
      containerConfig.WorkingDir === '/workspace' &&
      command.join('\0') === ['tail', '-f', '/dev/null'].join('\0') &&
      env.includes('HOME=/tmp') &&
      env.includes('NPM_CONFIG_CACHE=/tmp/npm-cache') &&
      hostConfig.ReadonlyRootfs === true &&
      hostConfig.Privileged === false &&
      capDrop.includes('ALL') &&
      securityOpt.includes('no-new-privileges') &&
      Number(hostConfig.PidsLimit) === policy.pidsLimit &&
      Number(hostConfig.Memory) > 0 &&
      Number(hostConfig.MemorySwap) === Number(hostConfig.Memory) &&
      Number(hostConfig.NanoCpus) > 0 &&
      hostConfig.NetworkMode === expectedNetwork &&
      portPolicyMatches &&
      workspaceMount?.Type === 'volume' &&
      workspaceMount.Name === task.volumeName &&
      workspaceMount.RW === true
    );
  }

  private async assertManagedVolume(task: WorkTaskRecord): Promise<void> {
    const result = await this.docker([
      'volume',
      'inspect',
      '--format',
      '{{ index .Labels "ai.libre-webui.task" }}',
      task.volumeName,
    ]);
    if (result.stdout.trim() !== task.id) {
      throw new WorkRuntimeError(
        `Refusing to operate unmanaged volume "${task.volumeName}".`,
        409,
        'WORK_VOLUME_NAME_CONFLICT'
      );
    }
  }

  async docker(
    args: string[],
    options: ProcessOptions = {}
  ): Promise<ProcessResult> {
    try {
      return await runProcess(config.dockerCommand, args, options);
    } catch (error) {
      if (error instanceof WorkRuntimeError) throw error;
      throw new WorkRuntimeError(
        error instanceof Error ? error.message : 'Docker command failed.'
      );
    }
  }
}

export interface ExecCreatePayload {
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  Tty: boolean;
  User: string;
  WorkingDir: string;
  Env: string[];
  Cmd: string[];
}

export function buildExecCreatePayload(
  shell: readonly string[] = ['/bin/bash', '-l']
): ExecCreatePayload {
  // Mirrors the container policy: the shell runs as the same unprivileged
  // user, in the workspace, inside the already-hardened container. Nothing
  // about the sandbox weakens because a human is typing instead of the model.
  return {
    AttachStdin: true,
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    User: '1000:1000',
    WorkingDir: '/workspace',
    Env: ['TERM=xterm-256color'],
    Cmd: [...shell],
  };
}

interface DockerApiResponse {
  status: number;
  body: string;
}

function parseExecId(response: DockerApiResponse): string {
  if (response.status < 200 || response.status >= 300) {
    throw new WorkRuntimeError(
      `The Docker Engine rejected the terminal exec (HTTP ${response.status}): ${response.body.trim()}`,
      503,
      'WORK_TERMINAL_UNAVAILABLE'
    );
  }
  try {
    const parsed = JSON.parse(response.body) as { Id?: unknown };
    if (typeof parsed.Id === 'string' && parsed.Id) return parsed.Id;
  } catch {
    // Fall through to the error below.
  }
  throw new WorkRuntimeError(
    'The Docker Engine returned an unexpected exec-create response.',
    503,
    'WORK_TERMINAL_UNAVAILABLE'
  );
}

/** Parse `docker ps` lines of `name\tstate\ttask-label` into containers. */
export function parseManagedContainerList(
  stdout: string
): DiscoveredWorkContainer[] {
  const containers: DiscoveredWorkContainer[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [name = '', state = '', taskId = ''] = line
      .split('\t')
      .map(field => field.trim());
    if (!name || !state) continue;
    containers.push({
      name,
      taskId,
      // paused and restarting containers still hold execution state; only
      // created/exited/dead containers are safely at rest.
      running:
        state === 'running' || state === 'restarting' || state === 'paused',
    });
  }
  return containers;
}

/** Bracket a bare IPv6 literal so it can carry a port in a URL. */
export function formatPreviewHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Turn a failed `docker info` into the change an operator has to make. These
 * are the three ways a containerized Libre WebUI fails to reach the daemon:
 * the image has no CLI, the bind-mounted socket is owned by a group the
 * backend user is not in, or no daemon is listening.
 */
export function describeDockerUnavailable(
  error: unknown,
  dockerCommand = config.dockerCommand
): string {
  const message = error instanceof Error ? error.message : String(error);

  if (/ENOENT/.test(message)) {
    return `The "${dockerCommand}" CLI is not installed in the Libre WebUI runtime. Run an image that ships the Docker CLI and mount the host Docker socket, or point WORK_DOCKER_COMMAND at the CLI path.`;
  }
  if (/EACCES/.test(message) || /permission denied/i.test(message)) {
    return 'The Docker socket is mounted but the Libre WebUI user cannot open it. Add the backend user to the group that owns /var/run/docker.sock (Compose: group_add with the socket GID).';
  }
  if (
    /cannot connect to the docker daemon/i.test(message) ||
    /is the docker daemon running/i.test(message) ||
    /no such file or directory/i.test(message)
  ) {
    return 'No Docker daemon is reachable. Start Docker, mount the host socket into the Libre WebUI container with -v /var/run/docker.sock:/var/run/docker.sock, or point DOCKER_HOST at a reachable Docker API endpoint such as a socket proxy.';
  }

  return message;
}

export function buildWorkContainerRunArgs(
  task: WorkTaskRecord,
  policy: ResolvedWorkRuntimePolicy = defaultRuntimePolicy
): string[] {
  const args = [
    'run',
    '--detach',
    '--name',
    task.containerName,
    '--init',
    '--label',
    'ai.libre-webui.managed=true',
    '--label',
    `ai.libre-webui.task=${task.id}`,
    '--label',
    `ai.libre-webui.policy=${computePolicyFingerprint(policy)}`,
    '--user',
    '1000:1000',
    '--workdir',
    '/workspace',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,size=512m',
    '--env',
    'HOME=/tmp',
    '--env',
    'NPM_CONFIG_CACHE=/tmp/npm-cache',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(policy.pidsLimit),
    '--memory',
    policy.memoryLimit,
    // Same value as --memory: the memory cap cannot be sidestepped via swap.
    '--memory-swap',
    policy.memoryLimit,
    '--cpus',
    policy.cpuLimit,
    '--network',
    task.networkEnabled ? config.networkName : 'none',
  ];
  if (task.networkEnabled) {
    args.push('--publish', `${config.previewBind}::${config.previewPort}`);
    for (const server of config.dnsServers) {
      args.push('--dns', server);
    }
  }
  args.push(
    '--mount',
    task.hostPath
      ? // Host-folder workspaces are opt-in per deployment and validated
        // against an allowlist before ever reaching this point.
        `type=bind,src=${task.hostPath},dst=/workspace`
      : `type=volume,src=${task.volumeName},dst=/workspace,volume-nocopy`,
    policy.image,
    'tail',
    '-f',
    '/dev/null'
  );
  return args;
}

export function parsePublishedPort(
  output: string,
  _containerPort = config.previewPort,
  bindAddress = config.previewBind
): number | undefined {
  // Only a binding on the interface this deployment asked for counts. The
  // default stays loopback, so a stray wildcard binding is still rejected.
  const allowed = new Set(
    bindAddress === WORK_RUNTIME_DEFAULTS.previewBind
      ? ['127.0.0.1', '[::1]']
      : [bindAddress, formatPreviewHost(bindAddress)]
  );

  for (const line of output.trim().split(/\r?\n/)) {
    const match = line.match(/^(.*):(\d+)$/);
    if (!match || !allowed.has(match[1])) continue;
    const port = Number(match[2]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  return undefined;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

async function runProcess(
  command: string,
  args: string[],
  options: ProcessOptions
): Promise<ProcessResult> {
  const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
  const maxOutputChars = options.maxOutputChars ?? config.maxOutputChars;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    activeDockerProcesses.add(child);
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    let stdinError: Error | undefined;
    let timer: NodeJS.Timeout | undefined;
    const claimSettlement = (): boolean => {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      return true;
    };
    const append = (current: string, chunk: Buffer): string => {
      const next = current + chunk.toString('utf8');
      if (next.length <= maxOutputChars) return next;
      truncated = true;
      const half = Math.floor(maxOutputChars / 2);
      return `${next.slice(0, half)}\n... output truncated ...\n${next.slice(-half)}`;
    };
    child.stdout.on('data', chunk => {
      stdout = append(stdout, chunk as Buffer);
    });
    child.stderr.on('data', chunk => {
      stderr = append(stderr, chunk as Buffer);
    });
    child.stdin.on('error', error => {
      // A helper may reject the request and close stdin before a large input
      // has finished writing. EPIPE is then expected; the process exit carries
      // the useful error. Other stdin failures are reported when it closes.
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        stdinError = error;
      }
    });
    child.on('error', error => {
      activeDockerProcesses.delete(child);
      if (!claimSettlement()) return;
      reject(
        new WorkRuntimeError(
          `Could not start ${command}: ${error.message}`,
          503,
          'WORK_DOCKER_UNAVAILABLE'
        )
      );
    });
    child.on('close', (code, signal) => {
      activeDockerProcesses.delete(child);
      const result: ProcessResult = {
        exitCode: code ?? -1,
        stdout,
        stderr,
        truncated,
        signal: signal || undefined,
      };
      if (stdinError && !options.acceptFailure) {
        if (!claimSettlement()) return;
        reject(
          new WorkRuntimeError(
            `Could not write command input: ${stdinError.message}`,
            503,
            'WORK_DOCKER_STDIN_FAILED'
          )
        );
        return;
      }
      if (result.exitCode !== 0 && !options.acceptFailure) {
        if (!claimSettlement()) return;
        reject(
          new WorkRuntimeError(
            stderr.trim() ||
              stdout.trim() ||
              `${command} exited with code ${result.exitCode}.`,
            503,
            'WORK_DOCKER_COMMAND_FAILED'
          )
        );
        return;
      }
      if (claimSettlement()) resolve(result);
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      if (!claimSettlement()) return;
      reject(
        new WorkRuntimeError(
          `Command timed out after ${timeoutMs}ms.`,
          504,
          'WORK_COMMAND_TIMEOUT'
        )
      );
    }, timeoutMs);
    timer.unref();
    if (options.input !== undefined) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
  });
}
