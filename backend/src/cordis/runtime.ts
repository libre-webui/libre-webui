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
 * Process-wide owner of the Cordis host.
 *
 * The host is started lazily rather than during boot: an operator who has not
 * enabled the bridge must not pay for an engine they do not run, and a failure
 * inside the engine must not be able to stop Libre WebUI from serving the rest
 * of its features. Startup therefore happens on first use and reports its own
 * failure through the route layer, where an operator can see it.
 *
 * @module cordis/runtime
 */

import type { CordisHost, CordisHostConfig, DshEngine } from './index.js';
import {
  resolveCordisHostConfig,
  startCordisHost,
  DSH_ENGINE_SERVICE,
} from './index.js';
import type { CordisAccessState } from '../services/cordisAccessService.js';
import {
  getCordisAccess,
  getCordisEnabled,
} from '../services/cordisAccessService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('cordis-runtime');

/** Why the bridge cannot serve a request. */
export type CordisUnavailableReason =
  /** The operator has not enabled the bridge. */
  | 'disabled'
  /** Startup is still in flight. */
  | 'starting'
  /** Startup failed; `detail` carries the reason. */
  | 'failed';

/** Result of asking the runtime for the engine. */
export type CordisEngineResult =
  | { readonly ok: true; readonly engine: DshEngine }
  | {
      readonly ok: false;
      readonly reason: CordisUnavailableReason;
      readonly detail?: string;
    };

let host: CordisHost | undefined;
let startPromise: Promise<void> | undefined;
let stopPromise: Promise<void> | undefined;
let generation = 0;
let failure: string | undefined;
let overrides: Partial<CordisHostConfig> | undefined;

/**
 * Override resolution inputs, for tests and for callers that own their own
 * paths. Values are merged over the resolved configuration.
 * @param next - partial configuration overriding resolved values.
 */
export function configureCordisRuntime(
  next: Partial<CordisHostConfig> | undefined
): void {
  overrides = next;
}

/**
 * Resolve the configuration this runtime would start with.
 *
 * Overridden paths are handed to the resolver rather than only spread over its
 * result: a caller that owns its own composition and settings paths expects the
 * *parsed* values to come from those files. Spreading alone would leave
 * file-derived fields — such as whether the file declared `features.enabled` —
 * describing whatever document the environment happened to point at.
 * @returns the fully resolved configuration for this runtime.
 */
export function cordisRuntimeConfig(): CordisHostConfig {
  const resolved = resolveCordisHostConfig({
    ...(overrides?.configPath ? { configPath: overrides.configPath } : {}),
    ...(overrides?.settingsPath
      ? { settingsPath: overrides.settingsPath }
      : {}),
    ...(overrides?.workspacePath
      ? { workspacePath: overrides.workspacePath }
      : {}),
    ...(overrides?.sessionStorePath
      ? { sessionStorePath: overrides.sessionStorePath }
      : {}),
  });
  const effective = overrides
    ? {
        ...resolved,
        ...overrides,
        // These overrides were resolved above. Keep their canonical values so
        // blank or relative inputs cannot restore a cwd-dependent directory.
        configPath: resolved.configPath,
        settingsPath: resolved.settingsPath,
        workspacePath: resolved.workspacePath,
        sessionStorePath: resolved.sessionStorePath,
      }
    : resolved;
  // Attach the runtime capability the host hands to the adapter row. It is not
  // configuration and never reaches the composed document, so it is added here
  // rather than resolved from a file.
  return providerCapability
    ? { ...effective, providerHandler: providerCapability }
    : effective;
}

/**
 * The provider capability the host passes to the adapter row.
 *
 * Installed by the application at startup. It is held here rather than in the
 * adapter module because that module is loaded twice — once by path for the
 * application and once by URL for the plugin row — and a registration on one
 * copy is invisible to the other.
 */
let providerCapability: unknown;

/**
 * Install the provider capability for the engine's adapter row.
 * @param handler - the handler implementing Libre WebUI's provider layer.
 */
export function setCordisProviderCapability(handler: unknown): void {
  providerCapability = handler;
}

/**
 * Whether the engine is offered.
 *
 * The administrator's persisted opt-in is the live switch, and
 * `LIBRE_CORDIS_ENABLED` can pin it. The settings document's
 * `features.enabled` pins it only when the file states it and no override is in
 * force: an override is a caller stating the answer, so consulting the file's
 * lock alongside it would make the seam unusable.
 * @returns the effective boolean.
 */
export async function isCordisBridgeEnabled(): Promise<boolean> {
  if (overrides?.features) return overrides.features.enabled;
  return getCordisEnabled(cordisRuntimeConfig());
}

/**
 * Resolve the effective access state for this runtime.
 *
 * The runtime's own resolved configuration is the one that matters: a caller
 * that supplied overrides expects the decision to describe those paths, and the
 * settings document's lock is only visible through them.
 * @returns the decision and whether a deployment-level source pinned it.
 */
export async function cordisAccessState(): Promise<CordisAccessState> {
  return getCordisAccess(cordisRuntimeConfig());
}

/**
 * Start the host if it is enabled and not already running.
 *
 * Concurrent callers share one startup: the first request begins the mount and
 * every other waiter observes the same promise, so the engine is never mounted
 * twice.
 * @returns the running host, or undefined when the bridge is disabled.
 * @throws when startup fails.
 */
export async function ensureCordisHost(): Promise<CordisHost | undefined> {
  await stopPromise;
  if (!(await isCordisBridgeEnabled())) return undefined;
  if (host) return host;
  if (!startPromise) {
    const currentGeneration = generation;
    const config = cordisRuntimeConfig();
    const pending = (async () => {
      try {
        const candidate = await startCordisHost(config);
        if (
          currentGeneration !== generation ||
          !(await isCordisBridgeEnabled())
        ) {
          await candidate.stop();
          return;
        }
        host = candidate;
        failure = undefined;
      } catch (error) {
        if (currentGeneration === generation)
          failure = error instanceof Error ? error.message : String(error);
        logger.error('Cordis host failed to start', { error: String(error) });
        throw error;
      }
    })();
    startPromise = pending;
    void pending
      .finally(() => {
        if (startPromise === pending) startPromise = undefined;
      })
      .catch(() => undefined);
  }
  await startPromise;
  return host;
}

/**
 * Read the engine contract, starting the host on first use.
 * @returns the engine, or a typed reason the bridge cannot serve the request.
 */
export async function getCordisEngine(): Promise<CordisEngineResult> {
  if (!(await isCordisBridgeEnabled())) {
    return { ok: false, reason: 'disabled' };
  }
  if (!host && !startPromise && failure !== undefined) {
    return { ok: false, reason: 'failed', detail: failure };
  }
  try {
    const running = await ensureCordisHost();
    if (!running) return { ok: false, reason: 'disabled' };
    const engine = running.context.get(DSH_ENGINE_SERVICE) as
      DshEngine | undefined;
    if (!engine) {
      return {
        ok: false,
        reason: 'failed',
        detail:
          'the composition mounted no libreDshEngine service; check the bridge row',
      };
    }
    return { ok: true, engine };
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The running host, if any. Used by diagnostics and tests. */
export function cordisHost(): CordisHost | undefined {
  return host;
}

/**
 * Stop the host and release every engine effect.
 *
 * Safe to call when the bridge was never started or is already stopped.
 * @returns a promise resolving once teardown has completed.
 */
export async function stopCordisHost(): Promise<void> {
  if (stopPromise) return stopPromise;
  generation += 1;
  const pending = startPromise;
  const running = host;
  host = undefined;
  failure = undefined;
  const stopping = (async () => {
    await pending?.catch(() => undefined);
    if (running) await running.stop();
  })();
  stopPromise = stopping;
  try {
    await stopping;
  } finally {
    // Only this stop operation may clear the shared teardown promise.
    if (Object.is(stopPromise, stopping)) stopPromise = undefined;
  }
}
