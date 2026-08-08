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

import { Duplex, PassThrough, Readable, Writable } from 'node:stream';

import type { WorkTaskRecord } from '../types/work.js';
import { createLogger } from '../utils/logger.js';
import type {
  DiscoveredWorkContainer,
  WorkExecOptions,
  WorkRuntimeDriver,
  WorkRuntimeState,
  WorkTerminalTransport,
} from './workRuntimeDriver.js';
import workPolicyService from './workPolicyService.js';
import {
  ProcessResult,
  ResolvedWorkRuntimePolicy,
  WorkRuntimeError,
  computePolicyFingerprint,
  defaultRuntimePolicy,
  positiveInteger,
  workRuntimeConfig as config,
} from './workRuntimeShared.js';

const logger = createLogger('services:work-runtime');

// Kubernetes-only knobs. Everything the Docker backend also honors (image,
// limits, timeouts, DNS) comes from the shared Work runtime config so one
// deployment story covers both backends.
export const WORK_KUBERNETES_DEFAULTS = {
  namespace: 'libre-webui-work',
  workspaceSize: '5Gi',
  podReadyTimeoutMs: 900_000,
  podGoneTimeoutMs: 60_000,
} as const;

const k8sConfig = {
  namespace:
    process.env.WORK_K8S_NAMESPACE || WORK_KUBERNETES_DEFAULTS.namespace,
  storageClass: process.env.WORK_K8S_STORAGE_CLASS || undefined,
  workspaceSize:
    process.env.WORK_K8S_WORKSPACE_SIZE ||
    WORK_KUBERNETES_DEFAULTS.workspaceSize,
  podReadyTimeoutMs: positiveInteger(
    process.env.WORK_K8S_POD_READY_TIMEOUT_MS,
    WORK_KUBERNETES_DEFAULTS.podReadyTimeoutMs
  ),
  podGoneTimeoutMs: positiveInteger(
    process.env.WORK_K8S_POD_GONE_TIMEOUT_MS,
    WORK_KUBERNETES_DEFAULTS.podGoneTimeoutMs
  ),
};

const POD_POLL_INTERVAL_MS = 500;
const WORK_CONTAINER_NAME = 'work';
const MANAGED_LABEL = 'ai.libre-webui.managed';
const TASK_LABEL = 'ai.libre-webui.task';
const NETWORK_LABEL = 'ai.libre-webui.network';
const POLICY_ANNOTATION = 'ai.libre-webui.policy';

// Container states that mean the sandbox will never come up without operator
// action; waiting for the ready timeout would hide the actual problem.
const FATAL_WAITING_REASONS = new Set([
  'ErrImagePull',
  'ImagePullBackOff',
  'InvalidImageName',
  'CreateContainerConfigError',
  'CreateContainerError',
]);

type KubernetesLib = typeof import('@kubernetes/client-node');

interface KubernetesClient {
  lib: KubernetesLib;
  kubeConfig: import('@kubernetes/client-node').KubeConfig;
  core: import('@kubernetes/client-node').CoreV1Api;
}

/**
 * Work runtime driver backed by a Kubernetes namespace: one PVC per task
 * workspace, one on-demand Pod per running sandbox, exec for everything that
 * happens inside. No Docker daemon or socket is involved anywhere, and the
 * backing ServiceAccount only needs pods/pods-exec/PVC rights in the sandbox
 * namespace. Interactive terminals ride the exec subresource as a TTY
 * WebSocket, and preview is served from the sandbox Pod IP through the
 * signed proxy (the backend must run in-cluster to reach it).
 */
export class KubernetesWorkRuntimeDriver implements WorkRuntimeDriver {
  readonly image = config.image;
  readonly namespace = k8sConfig.namespace;
  private clientState?: Promise<KubernetesClient>;

  private client(): Promise<KubernetesClient> {
    if (!this.clientState) {
      this.clientState = (async () => {
        // Loaded lazily so Docker-backed deployments never pay for the
        // Kubernetes client at startup.
        const lib = await import('@kubernetes/client-node');
        const kubeConfig = new lib.KubeConfig();
        kubeConfig.loadFromDefault();
        return {
          lib,
          kubeConfig,
          core: kubeConfig.makeApiClient(lib.CoreV1Api),
        };
      })().catch(error => {
        this.clientState = undefined;
        throw new WorkRuntimeError(
          describeKubernetesUnavailable(error, this.namespace),
          503,
          'WORK_KUBERNETES_UNAVAILABLE'
        );
      });
    }
    return this.clientState;
  }

  async probe(): Promise<void> {
    const { core } = await this.client();
    try {
      await core.listNamespacedPod({ namespace: this.namespace, limit: 1 });
    } catch (error) {
      throw new WorkRuntimeError(
        describeKubernetesUnavailable(error, this.namespace),
        503,
        'WORK_KUBERNETES_UNAVAILABLE'
      );
    }
  }

  shutdown(): void {
    // Exec WebSockets die with the process; nothing to kill explicitly.
  }

  async ensureImage(): Promise<void> {
    // The kubelet pulls images when a Pod is scheduled; pull problems are
    // surfaced by ensureRuntime through the container waiting state.
  }

  async ensureWorkspace(task: WorkTaskRecord): Promise<void> {
    assertNoHostWorkspace(task);
    const { core } = await this.client();
    const existing = await ignoreNotFound(
      core.readNamespacedPersistentVolumeClaim({
        name: task.volumeName,
        namespace: this.namespace,
      })
    );
    if (existing) {
      assertOwnedWorkspace(existing.metadata?.labels, task);
      return;
    }
    // fsGroup on the Pod makes the kubelet hand the volume to the sandbox
    // user on mount; no chown init step is needed.
    await core.createNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      body: buildWorkspaceClaimManifest(
        task,
        workPolicyService.resolve(task.policyId).workspaceSize
      ),
    });
  }

  async ensureRuntime(task: WorkTaskRecord): Promise<void> {
    assertNoHostWorkspace(task);
    const policy = workPolicyService.resolve(task.policyId);
    const { core } = await this.client();
    const existing = await this.readPod(task.containerName);
    if (existing) {
      assertOwnedRuntime(existing.metadata?.labels, task);
      const phase = existing.status?.phase ?? '';
      const fingerprint = existing.metadata?.annotations?.[POLICY_ANNOTATION];
      const image = existing.spec?.containers?.[0]?.image;
      const stale =
        fingerprint !== computePolicyFingerprint(policy) ||
        image !== policy.image;
      const finished = phase === 'Succeeded' || phase === 'Failed';
      if (stale || finished) {
        if (stale) {
          logger.warn(
            `Recreating Work sandbox Pod ${task.containerName} because its isolation policy is stale.`
          );
        }
        await this.deletePodAndWait(task.containerName);
      } else {
        await this.waitForPodRunning(task.containerName);
        return;
      }
    }
    await core.createNamespacedPod({
      namespace: this.namespace,
      body: buildWorkPodManifest(task, policy),
    });
    await this.waitForPodRunning(task.containerName);
  }

  async runtimeState(task: WorkTaskRecord): Promise<WorkRuntimeState> {
    const pod = await this.readPod(task.containerName);
    if (!pod) return 'absent';
    assertOwnedRuntime(pod.metadata?.labels, task);
    return mapPodPhase(pod.status?.phase);
  }

  async stopRuntime(task: WorkTaskRecord): Promise<void> {
    const pod = await this.readPod(task.containerName);
    if (!pod) return;
    assertOwnedRuntime(pod.metadata?.labels, task);
    // A sandbox at rest is simply no Pod: the durable state is the PVC, so
    // stop and remove are the same operation on this backend.
    await this.deletePodAndWait(task.containerName);
  }

  async removeRuntime(task: WorkTaskRecord): Promise<void> {
    await this.stopRuntime(task);
  }

  async removeTaskResources(task: WorkTaskRecord): Promise<void> {
    const { core } = await this.client();
    const [pod, claim] = await Promise.all([
      this.readPod(task.containerName),
      ignoreNotFound(
        core.readNamespacedPersistentVolumeClaim({
          name: task.volumeName,
          namespace: this.namespace,
        })
      ),
    ]);
    // Validate every destructive target before removing either one, so a
    // conflicting unmanaged resource cannot cause partial cleanup.
    if (pod) {
      assertOwnedRuntime(pod.metadata?.labels, task);
    }
    if (claim) {
      assertOwnedWorkspace(claim.metadata?.labels, task);
    }
    if (pod) {
      await this.deletePodAndWait(task.containerName);
    }
    if (claim) {
      await ignoreNotFound(
        core.deleteNamespacedPersistentVolumeClaim({
          name: task.volumeName,
          namespace: this.namespace,
        })
      );
    }
  }

  async exec(
    task: WorkTaskRecord,
    command: string[],
    options: WorkExecOptions = {}
  ): Promise<ProcessResult> {
    return this.execInPod(
      task.containerName,
      wrapCommandWithWorkdir(command, options.workdir),
      options
    );
  }

  async previewEndpoint(
    task: WorkTaskRecord
  ): Promise<{ host?: string; port: number } | undefined> {
    // The sandbox publishes nothing: the backend (running in-cluster)
    // reaches the preview server directly on the Pod IP. The IP is valid
    // exactly as long as the Pod, which is exactly as long as the preview.
    const pod = await this.readPod(task.containerName);
    if (!pod) return undefined;
    assertOwnedRuntime(pod.metadata?.labels, task);
    const podIp = pod.status?.podIP;
    if (!podIp) return undefined;
    return { host: podIp, port: config.previewPort };
  }

  async listManaged(): Promise<DiscoveredWorkContainer[]> {
    const { core } = await this.client();
    const pods = await core.listNamespacedPod({
      namespace: this.namespace,
      labelSelector: `${MANAGED_LABEL}=true`,
    });
    return (pods.items ?? []).map(pod => ({
      name: pod.metadata?.name ?? '',
      taskId: pod.metadata?.labels?.[TASK_LABEL] ?? '',
      running: mapPodPhase(pod.status?.phase) === 'running',
    }));
  }

  async removeOrphan(name: string): Promise<void> {
    await this.deletePodAndWait(name);
  }

  async listWorkspaces(): Promise<{ name: string; taskId: string }[]> {
    const { core } = await this.client();
    const claims = await core.listNamespacedPersistentVolumeClaim({
      namespace: this.namespace,
      labelSelector: `${MANAGED_LABEL}=true`,
    });
    return (claims.items ?? []).map(claim => ({
      name: claim.metadata?.name ?? '',
      taskId: claim.metadata?.labels?.[TASK_LABEL] ?? '',
    }));
  }

  terminalUnavailableReason(): null {
    return null;
  }

  /**
   * Interactive TTY over the Kubernetes exec subresource. The exec API has
   * no env parameter, so TERM rides in via env(1); with tty=true the server
   * merges stderr into stdout, and resize frames travel on the dedicated
   * resize channel, driven by the client library watching our stdout-side
   * stream for TTY-style resize events.
   */
  async openTerminal(containerName: string): Promise<WorkTerminalTransport> {
    const { lib, kubeConfig } = await this.client();
    const stdinStream = new PassThrough();
    const outputStream = new ResizableOutputStream();
    const exec = new lib.Exec(kubeConfig);
    let socket: import('isomorphic-ws').WebSocket;
    try {
      socket = await exec.exec(
        this.namespace,
        containerName,
        WORK_CONTAINER_NAME,
        ['env', 'TERM=xterm-256color', '/bin/bash', '-l'],
        outputStream,
        null,
        stdinStream,
        true
      );
    } catch (error) {
      throw new WorkRuntimeError(
        `Could not open the terminal stream: ${error instanceof Error ? error.message : String(error)}`,
        503,
        'WORK_TERMINAL_UNAVAILABLE'
      );
    }
    const stream = new TerminalStreamBridge(stdinStream, outputStream);
    socket.on('close', () => {
      stream.destroy();
    });
    socket.on('error', () => {
      stream.destroy();
    });
    stream.on('close', () => {
      try {
        socket.close();
      } catch {
        // The socket may already be closed; nothing to clean up.
      }
    });
    return {
      stream,
      resize: async (cols: number, rows: number) => {
        outputStream.setSize(cols, rows);
      },
    };
  }

  private async readPod(name: string) {
    const { core } = await this.client();
    return ignoreNotFound(
      core.readNamespacedPod({ name, namespace: this.namespace })
    );
  }

  private async deletePodAndWait(name: string): Promise<void> {
    const { core } = await this.client();
    await ignoreNotFound(
      core.deleteNamespacedPod({
        name,
        namespace: this.namespace,
        gracePeriodSeconds: 1,
      })
    );
    const deadline = Date.now() + k8sConfig.podGoneTimeoutMs;
    while (await this.readPod(name)) {
      if (Date.now() >= deadline) {
        throw new WorkRuntimeError(
          `Work sandbox Pod "${name}" was not removed within ${k8sConfig.podGoneTimeoutMs}ms.`,
          503,
          'WORK_KUBERNETES_POD_STUCK'
        );
      }
      await sleep(POD_POLL_INTERVAL_MS);
    }
  }

  private async waitForPodRunning(name: string): Promise<void> {
    const deadline = Date.now() + k8sConfig.podReadyTimeoutMs;
    while (true) {
      const pod = await this.readPod(name);
      if (!pod) {
        throw new WorkRuntimeError(
          `Work sandbox Pod "${name}" disappeared while starting.`,
          503,
          'WORK_KUBERNETES_POD_STUCK'
        );
      }
      const phase = pod.status?.phase ?? 'Pending';
      if (phase === 'Running') return;
      const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
      if (phase === 'Failed' || phase === 'Succeeded') {
        throw new WorkRuntimeError(
          `Work sandbox Pod "${name}" exited while starting (phase ${phase}).`,
          503,
          'WORK_KUBERNETES_POD_STUCK'
        );
      }
      if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
        throw new WorkRuntimeError(
          `Work sandbox Pod "${name}" cannot start: ${waiting.reason}${waiting.message ? ` — ${waiting.message}` : ''}`,
          503,
          'WORK_KUBERNETES_POD_STUCK'
        );
      }
      if (Date.now() >= deadline) {
        throw new WorkRuntimeError(
          `Work sandbox Pod "${name}" did not reach Running within ${k8sConfig.podReadyTimeoutMs}ms${waiting?.reason ? ` (${waiting.reason})` : ''}.`,
          503,
          'WORK_KUBERNETES_POD_STUCK'
        );
      }
      await sleep(POD_POLL_INTERVAL_MS);
    }
  }

  private async execInPod(
    podName: string,
    command: string[],
    options: WorkExecOptions
  ): Promise<ProcessResult> {
    const { lib, kubeConfig } = await this.client();
    const timeoutMs = options.timeoutMs ?? config.commandTimeoutMs;
    const maxOutputChars = options.maxOutputChars ?? config.maxOutputChars;

    let stdout = '';
    let stderr = '';
    let truncated = false;
    const append = (current: string, chunk: Buffer | string): string => {
      const next = current + chunk.toString();
      if (next.length <= maxOutputChars) return next;
      truncated = true;
      const half = Math.floor(maxOutputChars / 2);
      return `${next.slice(0, half)}\n... output truncated ...\n${next.slice(-half)}`;
    };
    const collector = (write: (chunk: Buffer | string) => void) =>
      new Writable({
        write(chunk, _encoding, callback) {
          write(chunk as Buffer);
          callback();
        },
      });

    return new Promise<ProcessResult>((resolve, reject) => {
      let settled = false;
      let socket: import('isomorphic-ws').WebSocket | undefined;
      let status: import('@kubernetes/client-node').V1Status | undefined;
      const claimSettlement = (): boolean => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        return true;
      };
      // Armed before the connection attempt: a hung API-server connection
      // must hit the same deadline as a hung command.
      const timer = setTimeout(() => {
        if (!claimSettlement()) return;
        try {
          socket?.close();
        } catch {
          // The socket may already be closed; nothing to clean up.
        }
        reject(
          new WorkRuntimeError(
            `Command timed out after ${timeoutMs}ms.`,
            504,
            'WORK_COMMAND_TIMEOUT'
          )
        );
      }, timeoutMs);
      timer.unref();

      const exec = new lib.Exec(kubeConfig);
      exec
        .exec(
          this.namespace,
          podName,
          WORK_CONTAINER_NAME,
          command,
          collector(chunk => {
            stdout = append(stdout, chunk);
          }),
          collector(chunk => {
            stderr = append(stderr, chunk);
          }),
          options.input !== undefined ? Readable.from([options.input]) : null,
          false,
          result => {
            status = result;
          }
        )
        .then(connected => {
          socket = connected;
          if (settled) {
            try {
              connected.close();
            } catch {
              // The socket may already be closed; nothing to clean up.
            }
            return;
          }
          connected.on('error', error => {
            if (!claimSettlement()) return;
            reject(
              new WorkRuntimeError(
                `The Work exec stream failed: ${error instanceof Error ? error.message : String(error)}`,
                503,
                'WORK_KUBERNETES_UNAVAILABLE'
              )
            );
          });
          connected.on('close', () => {
            if (!claimSettlement()) return;
            const exitCode = statusToExitCode(status);
            const result: ProcessResult = {
              exitCode,
              stdout,
              stderr,
              truncated,
            };
            if (exitCode !== 0 && !options.acceptFailure) {
              reject(
                new WorkRuntimeError(
                  stderr.trim() ||
                    stdout.trim() ||
                    status?.message ||
                    `Command exited with code ${exitCode}.`,
                  503,
                  'WORK_COMMAND_FAILED'
                )
              );
              return;
            }
            resolve(result);
          });
        })
        .catch(error => {
          if (!claimSettlement()) return;
          reject(
            new WorkRuntimeError(
              `Could not exec in Work sandbox Pod "${podName}": ${error instanceof Error ? error.message : String(error)}`,
              503,
              'WORK_KUBERNETES_UNAVAILABLE'
            )
          );
        });
    });
  }
}

export function buildWorkspaceClaimManifest(
  task: WorkTaskRecord,
  workspaceSize?: string
): import('@kubernetes/client-node').V1PersistentVolumeClaim {
  return {
    metadata: {
      name: task.volumeName,
      labels: {
        [MANAGED_LABEL]: 'true',
        [TASK_LABEL]: task.id,
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: {
        requests: { storage: workspaceSize ?? k8sConfig.workspaceSize },
      },
      ...(k8sConfig.storageClass
        ? { storageClassName: k8sConfig.storageClass }
        : {}),
    },
  };
}

export function buildWorkPodManifest(
  task: WorkTaskRecord,
  policy: ResolvedWorkRuntimePolicy = defaultRuntimePolicy
): import('@kubernetes/client-node').V1Pod {
  assertNoHostWorkspace(task);
  return {
    metadata: {
      name: task.containerName,
      labels: {
        [MANAGED_LABEL]: 'true',
        [TASK_LABEL]: task.id,
        // Network isolation is enforced by NetworkPolicy selecting on this
        // label (plan phase 4); the label ships now so existing sandboxes
        // are already selectable when those policies land.
        [NETWORK_LABEL]: String(task.networkEnabled),
      },
      // The fingerprint is a 64-char sha256 hex digest — too long for a
      // label value, so it rides as an annotation.
      annotations: { [POLICY_ANNOTATION]: computePolicyFingerprint(policy) },
    },
    spec: {
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: {
        runAsUser: 1000,
        runAsGroup: 1000,
        runAsNonRoot: true,
        fsGroup: 1000,
        fsGroupChangePolicy: 'OnRootMismatch',
        seccompProfile: { type: 'RuntimeDefault' },
      },
      containers: [
        {
          name: WORK_CONTAINER_NAME,
          image: policy.image,
          command: ['tail', '-f', '/dev/null'],
          workingDir: '/workspace',
          env: [
            { name: 'HOME', value: '/tmp' },
            { name: 'NPM_CONFIG_CACHE', value: '/tmp/npm-cache' },
          ],
          securityContext: {
            allowPrivilegeEscalation: false,
            readOnlyRootFilesystem: true,
            capabilities: { drop: ['ALL'] },
          },
          resources: {
            limits: {
              memory: dockerMemoryToKubernetes(policy.memoryLimit),
              cpu: dockerCpusToKubernetes(policy.cpuLimit),
            },
          },
          volumeMounts: [
            { name: 'workspace', mountPath: '/workspace' },
            { name: 'tmp', mountPath: '/tmp' },
          ],
        },
      ],
      volumes: [
        {
          name: 'workspace',
          persistentVolumeClaim: { claimName: task.volumeName },
        },
        { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
      ],
      ...(config.dnsServers.length > 0
        ? {
            dnsPolicy: 'None',
            dnsConfig: { nameservers: config.dnsServers },
          }
        : {}),
    },
  };
}

/**
 * Kubernetes exec always runs in the container's workingDir (/workspace for
 * Work sandboxes); a different working directory needs a shell hop.
 */
export function wrapCommandWithWorkdir(
  command: string[],
  workdir?: string
): string[] {
  if (!workdir || workdir === '/workspace') return command;
  return ['/bin/sh', '-c', 'cd -- "$0" && exec "$@"', workdir, ...command];
}

/**
 * Docker memory strings use binary multiples; so do Ki/Mi/Gi. Docker accepts
 * both one- and two-letter suffixes (2g, 2gb, 2gib) for the same quantity.
 */
export function dockerMemoryToKubernetes(value: string): string {
  const match = value.trim().match(/^(\d+(?:\.\d+)?)([bkmg])(?:i?b)?$/i);
  if (!match) return value;
  const suffix = { b: '', k: 'Ki', m: 'Mi', g: 'Gi' }[
    match[2].toLowerCase() as 'b' | 'k' | 'm' | 'g'
  ];
  return `${match[1]}${suffix}`;
}

export function dockerCpusToKubernetes(value: string): string {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return value;
  return Number.isInteger(parsed)
    ? String(parsed)
    : `${Math.round(parsed * 1000)}m`;
}

export function mapPodPhase(phase: string | undefined): WorkRuntimeState {
  // Pending Pods hold execution intent (scheduling, image pull, starting);
  // treating them as running keeps stop/reconcile semantics conservative.
  if (phase === 'Running' || phase === 'Pending' || phase === 'Unknown') {
    return 'running';
  }
  if (phase === 'Succeeded' || phase === 'Failed') return 'stopped';
  return 'absent';
}

export function statusToExitCode(
  status: import('@kubernetes/client-node').V1Status | undefined
): number {
  if (!status) return -1;
  if (status.status === 'Success') return 0;
  const cause = status.details?.causes?.find(
    item => item.reason === 'ExitCode'
  );
  const parsed = Number(cause?.message);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : -1;
}

export function describeKubernetesUnavailable(
  error: unknown,
  namespace: string
): string {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === 404) {
    return `The Work sandbox namespace "${namespace}" does not exist. Create it (kubectl create namespace ${namespace}) or point WORK_K8S_NAMESPACE at an existing one.`;
  }
  if (code === 401 || code === 403) {
    return `The Kubernetes credentials cannot manage Pods in namespace "${namespace}". Grant the backend ServiceAccount pods, pods/exec, and persistentvolumeclaims rights there.`;
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/.test(message)) {
    return `No Kubernetes API server is reachable: ${message}. Check KUBECONFIG or run Libre WebUI inside the cluster.`;
  }
  if (/no active cluster|cannot load|ENOENT/i.test(message)) {
    return `No Kubernetes configuration was found: ${message}. Provide a kubeconfig or run Libre WebUI inside the cluster.`;
  }
  return message;
}

function assertNoHostWorkspace(task: WorkTaskRecord): void {
  if (task.hostPath) {
    throw new WorkRuntimeError(
      'Host-folder workspaces are not supported on the Kubernetes Work backend.',
      501,
      'WORK_HOST_WORKSPACE_UNSUPPORTED'
    );
  }
}

function assertOwnedRuntime(
  labels: Record<string, string> | undefined,
  task: WorkTaskRecord
): void {
  if (labels?.[TASK_LABEL] !== task.id) {
    throw new WorkRuntimeError(
      `Refusing to operate unmanaged container "${task.containerName}".`,
      409,
      'WORK_CONTAINER_NAME_CONFLICT'
    );
  }
}

function assertOwnedWorkspace(
  labels: Record<string, string> | undefined,
  task: WorkTaskRecord
): void {
  if (labels?.[TASK_LABEL] !== task.id) {
    throw new WorkRuntimeError(
      `Refusing to operate unmanaged volume "${task.volumeName}".`,
      409,
      'WORK_VOLUME_NAME_CONFLICT'
    );
  }
}

async function ignoreNotFound<T>(promise: Promise<T>): Promise<T | undefined> {
  try {
    return await promise;
  } catch (error) {
    if ((error as { code?: unknown })?.code === 404) return undefined;
    throw error;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Terminal output stream that also looks like a TTY to the Kubernetes
 * client: exposing rows/columns and emitting 'resize' makes the client
 * library open the resize channel and forward size updates to the server.
 * That is undocumented @kubernetes/client-node behavior, so a client
 * upgrade can silently break resize — the kind e2e suite asserts it works
 * (`stty size` after a resize call); trust that check when bumping the
 * dependency.
 */
class ResizableOutputStream extends PassThrough {
  rows = 24;
  columns = 80;

  setSize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }
}

/**
 * One bidirectional stream over the exec channel pair: writes become the
 * shell's stdin, reads are the shell's merged TTY output — the same Duplex
 * contract the Docker driver gets from its hijacked Engine-API socket.
 */
class TerminalStreamBridge extends Duplex {
  constructor(
    private readonly sink: PassThrough,
    private readonly source: PassThrough
  ) {
    super();
    source.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) source.pause();
    });
    source.on('end', () => this.push(null));
    source.on('error', error => this.destroy(error));
  }

  _read(): void {
    this.source.resume();
  }

  _write(
    chunk: unknown,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.sink.write(chunk, encoding, callback);
  }

  _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.sink.destroy();
    this.source.destroy();
    callback(error);
  }
}
