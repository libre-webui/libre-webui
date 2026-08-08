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
 * A Docker Engine API endpoint the backend can open an HTTP connection to:
 * the local Unix socket, or a plain-HTTP tcp:// endpoint such as a
 * socket proxy that holds the real socket and forwards a filtered subset of
 * the API. Anything else (ssh://, npipe://, TLS-verified tcp) resolves to
 * null so callers report the feature unavailable instead of guessing.
 */
export type DockerEndpoint =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number };

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';
const DEFAULT_DOCKER_TCP_PORT = 2375;

/**
 * Resolve the endpoint from the same environment the docker CLI reads, so the
 * Engine-API clients (terminal, diagnostics) and the spawned CLI always talk
 * to the same daemon. Precedence: WORK_DOCKER_SOCKET pins a Unix socket,
 * then DOCKER_HOST (unix:// or tcp://), then the default socket path.
 *
 * A tcp:// DOCKER_HOST with DOCKER_TLS_VERIFY set resolves to null: this
 * client speaks plain HTTP, and silently skipping TLS against an endpoint
 * that demands it would either fail or, worse, downgrade the transport.
 */
export function resolveDockerEndpoint(
  workDockerSocket: string | undefined,
  dockerHost: string | undefined,
  dockerTlsVerify?: string
): DockerEndpoint | null {
  const pinnedSocket = workDockerSocket?.trim();
  if (pinnedSocket) return { kind: 'unix', socketPath: pinnedSocket };

  const host = dockerHost?.trim();
  if (!host) return { kind: 'unix', socketPath: DEFAULT_DOCKER_SOCKET };

  if (host.startsWith('unix://')) {
    const socketPath = host.slice('unix://'.length);
    return socketPath ? { kind: 'unix', socketPath } : null;
  }

  if (host.startsWith('tcp://')) {
    if (dockerTlsVerify?.trim()) return null;
    try {
      const parsed = new URL(host);
      if (!parsed.hostname) return null;
      const port = parsed.port ? Number(parsed.port) : DEFAULT_DOCKER_TCP_PORT;
      if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
      // URL keeps IPv6 hostnames bracketed; node's http client wants them bare.
      const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
      return { kind: 'tcp', host: hostname, port };
    } catch {
      return null;
    }
  }

  return null;
}

/** node:http request options that select the endpoint's transport. */
export function dockerEndpointRequestOptions(
  endpoint: DockerEndpoint
): { socketPath: string } | { host: string; port: number } {
  return endpoint.kind === 'unix'
    ? { socketPath: endpoint.socketPath }
    : { host: endpoint.host, port: endpoint.port };
}

/** Human-readable endpoint for log lines and error messages. */
export function describeDockerEndpoint(endpoint: DockerEndpoint): string {
  return endpoint.kind === 'unix'
    ? endpoint.socketPath
    : `tcp://${endpoint.host}:${endpoint.port}`;
}
