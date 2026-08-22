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
 * Configuration, error type, and result shapes shared by the Work runtime
 * service (policy: admission, leases, locks, ownership rules) and the
 * runtime driver (mechanics: how a sandbox actually runs). Split out so the
 * driver never has to import the service.
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:work-runtime');

export const WORK_RUNTIME_DEFAULTS = {
  image:
    'node:22.22-bookworm@sha256:2d178f2785b96dfbf62a416ca2e40f50e30150b4ff3320d706f0d96e90600eb3',
  dockerCommand: 'docker',
  commandTimeoutMs: 120_000,
  maxOutputChars: 50_000,
  maxAgentRounds: 48,
  memoryLimit: '2g',
  cpuLimit: '2',
  pidsLimit: 256,
  previewPort: 4173,
  previewBind: '127.0.0.1',
  // Container-internal WebSocket port of the Work Computer screen bridge
  // (websockify in the GUI image). Published on previewBind when a task's
  // policy enables the GUI.
  screenPort: 6080,
  // Container-internal WebSocket port of the Work Computer audio bridge
  // (websockify → PulseAudio monitor capture). Published alongside the
  // screen port for GUI policies.
  audioPort: 6081,
  networkName: 'libre-webui-work',
  // 0 disables the idle sweep: previews stay up until stopped explicitly.
  idleTimeoutMs: 0,
} as const;

// Two runtimes per administrator so a second task does not have to wait for
// the first, three per instance to bound the worst case at three containers'
// resource caps. Both remain tunable through WORK_MAX_ACTIVE_RUNTIMES_*.
export const WORK_RUNTIME_ADMISSION_DEFAULTS = {
  maxActiveRuntimesGlobal: 3,
  maxActiveRuntimesPerUser: 2,
} as const;

export const workRuntimeConfig = {
  image: process.env.WORK_RUNTIME_IMAGE || WORK_RUNTIME_DEFAULTS.image,
  dockerCommand:
    process.env.WORK_DOCKER_COMMAND || WORK_RUNTIME_DEFAULTS.dockerCommand,
  commandTimeoutMs: positiveInteger(
    process.env.WORK_COMMAND_TIMEOUT_MS,
    WORK_RUNTIME_DEFAULTS.commandTimeoutMs
  ),
  maxOutputChars: positiveInteger(
    process.env.WORK_MAX_OUTPUT_CHARS,
    WORK_RUNTIME_DEFAULTS.maxOutputChars
  ),
  maxAgentRounds: positiveInteger(
    process.env.WORK_MAX_AGENT_ROUNDS,
    WORK_RUNTIME_DEFAULTS.maxAgentRounds
  ),
  memoryLimit:
    process.env.WORK_MEMORY_LIMIT || WORK_RUNTIME_DEFAULTS.memoryLimit,
  cpuLimit: process.env.WORK_CPU_LIMIT || WORK_RUNTIME_DEFAULTS.cpuLimit,
  pidsLimit: positiveInteger(
    process.env.WORK_PIDS_LIMIT,
    WORK_RUNTIME_DEFAULTS.pidsLimit
  ),
  previewPort: positiveInteger(
    process.env.WORK_PREVIEW_PORT,
    WORK_RUNTIME_DEFAULTS.previewPort
  ),
  // Interface the daemon publishes a task preview on. Loopback keeps a preview
  // private to the Docker host, which is correct when the browser runs there.
  previewBind:
    process.env.WORK_PREVIEW_BIND || WORK_RUNTIME_DEFAULTS.previewBind,
  screenPort: positiveInteger(
    process.env.WORK_COMPUTER_SCREEN_PORT,
    WORK_RUNTIME_DEFAULTS.screenPort
  ),
  audioPort: positiveInteger(
    process.env.WORK_COMPUTER_AUDIO_PORT,
    WORK_RUNTIME_DEFAULTS.audioPort
  ),
  // Stop a running sandbox after this much inactivity: no command finished,
  // no terminal attached, no preview request through the signed proxy.
  // Commands already stop their container on completion, so this mainly
  // bounds how long an unwatched preview keeps a sandbox (and its admission
  // slot) alive. 0 keeps today's behavior: previews run until stopped.
  idleTimeoutMs: positiveInteger(
    process.env.WORK_RUNTIME_IDLE_TIMEOUT_MS,
    WORK_RUNTIME_DEFAULTS.idleTimeoutMs
  ),
  maxActiveRuntimesGlobal: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_GLOBAL,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesGlobal
  ),
  maxActiveRuntimesPerUser: positiveInteger(
    process.env.WORK_MAX_ACTIVE_RUNTIMES_PER_USER,
    WORK_RUNTIME_ADMISSION_DEFAULTS.maxActiveRuntimesPerUser
  ),
  // Dedicated bridge network for networked Work tasks. It is created with
  // inter-container communication disabled, so a sandbox cannot reach other
  // Work sandboxes or the deployment's own containers on the default bridge.
  networkName:
    process.env.WORK_NETWORK_NAME || WORK_RUNTIME_DEFAULTS.networkName,
  // Optional resolvers forced onto every networked sandbox. Pointing this at
  // a filtering resolver is the supported egress-policy hook.
  dnsServers: parseDnsServers(process.env.WORK_RUNTIME_DNS),
};

/**
 * The runtime configuration one task's sandbox is actually built with: the
 * global config, with a named policy's overrides applied. `workspaceSize`
 * stays optional because its fallback belongs to the Kubernetes driver.
 */
export interface ResolvedWorkRuntimePolicy {
  policyId: string | null;
  image: string;
  memoryLimit: string;
  cpuLimit: string;
  pidsLimit: number;
  idleTimeoutMs: number;
  workspaceSize?: string;
  /** GUI session (Work Computer) enabled for containers under this policy. */
  guiEnabled?: boolean;
}

/** The resolution of "no policy": exactly the global configuration. */
export const defaultRuntimePolicy: ResolvedWorkRuntimePolicy = {
  policyId: null,
  image: workRuntimeConfig.image,
  memoryLimit: workRuntimeConfig.memoryLimit,
  cpuLimit: workRuntimeConfig.cpuLimit,
  pidsLimit: workRuntimeConfig.pidsLimit,
  idleTimeoutMs: workRuntimeConfig.idleTimeoutMs,
};

/**
 * Fingerprint of the isolation-relevant configuration a sandbox was created
 * with; a mismatch at ensure time recreates the sandbox. Computed per task
 * from its resolved policy. The payload shape (and therefore the digest for
 * a task without a policy) is unchanged from the pre-policy global
 * fingerprint, so existing sandboxes are not recreated by the upgrade.
 */
export function computePolicyFingerprint(
  policy: Pick<
    ResolvedWorkRuntimePolicy,
    'memoryLimit' | 'cpuLimit' | 'pidsLimit' | 'guiEnabled'
  >
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        // v4: GUI containers additionally publish the audio bridge port.
        version: 4,
        memoryLimit: policy.memoryLimit,
        cpuLimit: policy.cpuLimit,
        pidsLimit: policy.pidsLimit,
        previewPort: workRuntimeConfig.previewPort,
        previewBind: workRuntimeConfig.previewBind,
        networkName: workRuntimeConfig.networkName,
        dnsServers: workRuntimeConfig.dnsServers,
        memorySwapPinned: true,
        guiEnabled: policy.guiEnabled === true,
        screenPort: workRuntimeConfig.screenPort,
        audioPort: workRuntimeConfig.audioPort,
      })
    )
    .digest('hex');
}

export const runtimePolicyFingerprint =
  computePolicyFingerprint(workRuntimeConfig);

export interface WorkCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface ProcessOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  input?: string;
  acceptFailure?: boolean;
  /** Cancels the underlying runtime command when distributed authority is lost. */
  abortSignal?: AbortSignal;
}

export interface ProcessResult extends WorkCommandResult {
  signal?: NodeJS.Signals;
}

export class WorkRuntimeError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(
    message: string,
    status = 503,
    code = 'WORK_RUNTIME_UNAVAILABLE'
  ) {
    super(message);
    this.name = 'WorkRuntimeError';
    this.status = status;
    this.code = code;
  }
}

export function positiveInteger(
  value: string | undefined,
  fallback: number
): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseDnsServers(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map(server => server.trim())
    .filter(server => {
      if (!server) return false;
      if (/^[0-9a-fA-F:.]+$/.test(server)) return true;
      logger.warn(
        `Ignoring WORK_RUNTIME_DNS entry "${server}": not an IPv4/IPv6 address.`
      );
      return false;
    });
}
