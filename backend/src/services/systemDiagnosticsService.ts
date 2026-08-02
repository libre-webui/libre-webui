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

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readFile, stat, statfs } from 'node:fs/promises';

import { loadAppPackage } from '../utils/packagePaths.js';

const DOCKER_RESPONSE_LIMIT_BYTES = 5 * 1024 * 1024;
const DOCKER_TIMEOUT_MS = 4_000;
const MAX_DOCKER_CONTAINERS = 100;
const appVersion = String(loadAppPackage(import.meta.url).version ?? '0.0.0');

export interface SystemDiagnostics {
  generatedAt: number;
  host: {
    hostname: string;
    platform: string;
    release: string;
    architecture: string;
    uptimeSeconds: number;
    bootedAt: number;
    logicalCpus: number;
    cpuModel: string;
    loadAverage: [number, number, number];
    containerized: boolean;
  };
  runtime: {
    appVersion: string;
    nodeVersion: string;
    processId: number;
    processUptimeSeconds: number;
    workingDirectory: string;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPercent: number;
    processRssBytes: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
    externalBytes: number;
  };
  filesystems: SystemFilesystemDiagnostics[];
  network: {
    interfaces: SystemNetworkInterface[];
  };
  docker: DockerDiagnostics;
}

export interface SystemFilesystemDiagnostics {
  label: string;
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  usedPercent: number;
}

export interface SystemNetworkInterface {
  name: string;
  addresses: Array<{
    address: string;
    family: 'IPv4' | 'IPv6';
    cidr: string | null;
    internal: boolean;
  }>;
  receivedBytes?: number;
  transmittedBytes?: number;
}

export interface DockerContainerSummary {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  createdAt: number;
}

export interface DockerDiagnostics {
  available: boolean;
  socketMounted: boolean;
  reason?: string;
  serverVersion?: string;
  operatingSystem?: string;
  architecture?: string;
  kernelVersion?: string;
  logicalCpus?: number;
  memoryBytes?: number;
  totalContainers: number;
  runningContainers: number;
  stoppedContainers: number;
  pausedContainers: number;
  containers: DockerContainerSummary[];
}

type DockerGet = (socketPath: string, requestPath: string) => Promise<unknown>;

interface DockerVersionPayload {
  Version?: unknown;
}

interface DockerInfoPayload {
  OperatingSystem?: unknown;
  OSType?: unknown;
  Architecture?: unknown;
  KernelVersion?: unknown;
  NCPU?: unknown;
  MemTotal?: unknown;
  Containers?: unknown;
  ContainersRunning?: unknown;
  ContainersStopped?: unknown;
  ContainersPaused?: unknown;
}

interface DockerContainerPayload {
  Id?: unknown;
  Names?: unknown;
  Image?: unknown;
  State?: unknown;
  Status?: unknown;
  Created?: unknown;
}

const finiteNonNegative = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const safeText = (value: unknown, fallback = '', maxLength = 160): string => {
  if (typeof value !== 'string') return fallback;
  return Array.from(value)
    .filter(character => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint >= 32 && codePoint !== 127;
    })
    .join('')
    .trim()
    .slice(0, maxLength);
};

const percent = (used: number, total: number): number =>
  total > 0 ? Math.round((used / total) * 1_000) / 10 : 0;

export function resolveSystemDockerSocketPath(
  workDockerSocket: string | undefined,
  dockerHost: string | undefined
): string | null {
  if (workDockerSocket?.trim()) return workDockerSocket.trim();
  if (dockerHost) {
    return dockerHost.startsWith('unix://')
      ? dockerHost.slice('unix://'.length) || null
      : null;
  }
  return '/var/run/docker.sock';
}

export function parseNetworkCounters(
  contents: string
): Map<string, { receivedBytes: number; transmittedBytes: number }> {
  const counters = new Map<
    string,
    { receivedBytes: number; transmittedBytes: number }
  >();
  for (const line of contents.split('\n').slice(2)) {
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const name = line.slice(0, separator).trim();
    const values = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/);
    const receivedBytes = Number(values[0]);
    const transmittedBytes = Number(values[8]);
    if (
      name &&
      Number.isFinite(receivedBytes) &&
      receivedBytes >= 0 &&
      Number.isFinite(transmittedBytes) &&
      transmittedBytes >= 0
    ) {
      counters.set(name, { receivedBytes, transmittedBytes });
    }
  }
  return counters;
}

export function summarizeDockerPayloads(
  versionPayload: DockerVersionPayload,
  infoPayload: DockerInfoPayload,
  containerPayload: DockerContainerPayload[]
): DockerDiagnostics {
  const containers = containerPayload
    .slice(0, MAX_DOCKER_CONTAINERS)
    .map(container => {
      const names = Array.isArray(container.Names) ? container.Names : [];
      const firstName = names.find(name => typeof name === 'string');
      const id = safeText(container.Id, 'unknown', 64);
      return {
        id: id.slice(0, 12),
        name: safeText(firstName, id.slice(0, 12) || 'unnamed', 120).replace(
          /^\/+/,
          ''
        ),
        image: safeText(container.Image, 'unknown', 200),
        state: safeText(container.State, 'unknown', 40),
        status: safeText(container.Status, 'Unknown', 160),
        createdAt: Math.round(
          (finiteNonNegative(container.Created) ?? 0) * 1000
        ),
      };
    });
  const running = finiteNonNegative(infoPayload.ContainersRunning);
  const stopped = finiteNonNegative(infoPayload.ContainersStopped);
  const paused = finiteNonNegative(infoPayload.ContainersPaused);
  const total = finiteNonNegative(infoPayload.Containers);

  return {
    available: true,
    socketMounted: true,
    serverVersion: safeText(versionPayload.Version) || undefined,
    operatingSystem:
      safeText(infoPayload.OperatingSystem) ||
      safeText(infoPayload.OSType) ||
      undefined,
    architecture: safeText(infoPayload.Architecture) || undefined,
    kernelVersion: safeText(infoPayload.KernelVersion) || undefined,
    logicalCpus: finiteNonNegative(infoPayload.NCPU),
    memoryBytes: finiteNonNegative(infoPayload.MemTotal),
    totalContainers: Math.round(total ?? containerPayload.length),
    runningContainers: Math.round(
      running ??
        containerPayload.filter(item => item.State === 'running').length
    ),
    stoppedContainers: Math.round(
      stopped ?? containerPayload.filter(item => item.State === 'exited').length
    ),
    pausedContainers: Math.round(
      paused ?? containerPayload.filter(item => item.State === 'paused').length
    ),
    containers,
  };
}

export async function collectDockerDiagnostics(
  socketPath: string | null,
  dockerGet: DockerGet = dockerApiGet
): Promise<DockerDiagnostics> {
  const unavailable = (
    reason: string,
    socketMounted: boolean
  ): DockerDiagnostics => ({
    available: false,
    socketMounted,
    reason,
    totalContainers: 0,
    runningContainers: 0,
    stoppedContainers: 0,
    pausedContainers: 0,
    containers: [],
  });
  if (!socketPath) {
    return unavailable(
      'Docker diagnostics require a local Unix socket; remote Docker endpoints are not queried.',
      false
    );
  }

  let socketMounted = false;
  try {
    const socketStats = await stat(socketPath);
    socketMounted = socketStats.isSocket();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EACCES') {
      return unavailable(
        'The Docker socket is mounted but the Libre WebUI process cannot read it.',
        true
      );
    }
    return unavailable(
      'Docker is unavailable because its local socket is not mounted.',
      false
    );
  }
  if (!socketMounted) {
    return unavailable(
      'The configured Docker path is not a Unix socket.',
      false
    );
  }

  try {
    const [version, info, containers] = await Promise.all([
      dockerGet(socketPath, '/version'),
      dockerGet(socketPath, '/info'),
      dockerGet(socketPath, '/containers/json?all=1'),
    ]);
    return summarizeDockerPayloads(
      (version ?? {}) as DockerVersionPayload,
      (info ?? {}) as DockerInfoPayload,
      Array.isArray(containers) ? (containers as DockerContainerPayload[]) : []
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const reason =
      code === 'EACCES'
        ? 'The Docker socket is mounted but the Libre WebUI process cannot read it.'
        : code === 'ETIMEDOUT'
          ? 'The Docker daemon did not answer the diagnostics request in time.'
          : 'The Docker socket is mounted, but the daemon could not be reached.';
    return unavailable(reason, true);
  }
}

async function dockerApiGet(
  socketPath: string,
  requestPath: string
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath,
        method: 'GET',
        path: requestPath,
        headers: { Host: 'docker', Accept: 'application/json' },
      },
      response => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on('data', chunk => {
          const buffer = Buffer.from(chunk);
          received += buffer.length;
          if (received > DOCKER_RESPONSE_LIMIT_BYTES) {
            request.destroy(
              new Error('Docker diagnostics response exceeded the size limit.')
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on('end', () => {
          if (
            (response.statusCode ?? 0) < 200 ||
            (response.statusCode ?? 0) >= 300
          ) {
            const error = new Error('Docker diagnostics request was rejected.');
            (error as NodeJS.ErrnoException).code = 'EDOCKER';
            reject(error);
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            const error = new Error(
              'Docker returned invalid diagnostics data.'
            );
            (error as NodeJS.ErrnoException).code = 'EDOCKER';
            reject(error);
          }
        });
      }
    );
    request.setTimeout(DOCKER_TIMEOUT_MS, () => {
      const error = new Error('Docker diagnostics request timed out.');
      (error as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      request.destroy(error);
    });
    request.on('error', reject);
    request.end();
  });
}

async function detectContainerized(): Promise<boolean> {
  try {
    await stat('/.dockerenv');
    return true;
  } catch {
    // Fall through to Linux control-group detection.
  }
  try {
    const cgroup = await readFile('/proc/1/cgroup', 'utf8');
    return /(?:docker|containerd|kubepods|podman)/i.test(cgroup);
  } catch {
    return false;
  }
}

async function collectFilesystem(
  label: string,
  location: string
): Promise<SystemFilesystemDiagnostics | null> {
  try {
    const details = await statfs(location);
    const totalBytes = Math.max(0, details.bsize * details.blocks);
    const freeBytes = Math.max(0, details.bsize * details.bavail);
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    return {
      label,
      path: location,
      totalBytes,
      freeBytes,
      usedBytes,
      usedPercent: percent(usedBytes, totalBytes),
    };
  } catch {
    return null;
  }
}

async function collectNetworkInterfaces(): Promise<SystemNetworkInterface[]> {
  let counters = new Map<
    string,
    { receivedBytes: number; transmittedBytes: number }
  >();
  try {
    counters = parseNetworkCounters(await readFile('/proc/net/dev', 'utf8'));
  } catch {
    // Traffic counters are Linux-specific and optional.
  }

  return Object.entries(os.networkInterfaces())
    .slice(0, 64)
    .map(([name, addresses]) => {
      const traffic = counters.get(name);
      return {
        name: safeText(name, 'interface', 80),
        addresses: (addresses ?? []).slice(0, 16).map(address => ({
          address: safeText(address.address, '', 120),
          family: address.family,
          cidr: address.cidr ? safeText(address.cidr, '', 140) : null,
          internal: address.internal,
        })),
        ...(traffic ?? {}),
      };
    })
    .filter(item => item.addresses.length > 0)
    .sort(
      (left, right) =>
        Number(left.addresses[0].internal) - Number(right.addresses[0].internal)
    );
}

export class SystemDiagnosticsService {
  async getDiagnostics(): Promise<SystemDiagnostics> {
    const generatedAt = Date.now();
    const cpus = os.cpus();
    const totalBytes = Math.max(0, os.totalmem());
    const freeBytes = Math.max(0, os.freemem());
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const processMemory = process.memoryUsage();
    const dataDirectory =
      process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
    const socketPath = resolveSystemDockerSocketPath(
      process.env.WORK_DOCKER_SOCKET,
      process.env.DOCKER_HOST
    );
    const [containerized, runtimeFilesystem, dataFilesystem, network, docker] =
      await Promise.all([
        detectContainerized(),
        collectFilesystem('Runtime filesystem', '/'),
        collectFilesystem('Data directory', dataDirectory),
        collectNetworkInterfaces(),
        collectDockerDiagnostics(socketPath),
      ]);
    const filesystems = [runtimeFilesystem, dataFilesystem].filter(
      (item): item is SystemFilesystemDiagnostics => item !== null
    );

    return {
      generatedAt,
      host: {
        hostname: safeText(os.hostname(), 'unknown', 255),
        platform: safeText(os.platform(), 'unknown', 40),
        release: safeText(os.release(), 'unknown', 120),
        architecture: safeText(os.arch(), 'unknown', 40),
        uptimeSeconds: Math.max(0, Math.round(os.uptime())),
        bootedAt: generatedAt - Math.max(0, Math.round(os.uptime() * 1000)),
        logicalCpus: cpus.length,
        cpuModel: safeText(cpus[0]?.model, 'Unknown CPU', 200),
        loadAverage: os
          .loadavg()
          .map(value => Math.round(value * 100) / 100) as [
          number,
          number,
          number,
        ],
        containerized,
      },
      runtime: {
        appVersion,
        nodeVersion: process.version,
        processId: process.pid,
        processUptimeSeconds: Math.max(0, Math.round(process.uptime())),
        workingDirectory: process.cwd(),
      },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        usedPercent: percent(usedBytes, totalBytes),
        processRssBytes: processMemory.rss,
        heapUsedBytes: processMemory.heapUsed,
        heapTotalBytes: processMemory.heapTotal,
        externalBytes: processMemory.external,
      },
      filesystems,
      network: { interfaces: network },
      docker,
    };
  }
}

const systemDiagnosticsService = new SystemDiagnosticsService();
export default systemDiagnosticsService;
