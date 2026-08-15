/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type {
  Coordinator,
  CoordinationUnsubscribe,
} from '../platform/coordination/types.js';
import { getInitializedCoordinator } from '../platform/coordination/service.js';
import { getPersistence } from '../persistence/index.js';
import { createLogger } from '../utils/logger.js';
import { encryptionService } from './encryptionService.js';

const logger = createLogger('services:plugin-cache-invalidation');

export const PLUGIN_CACHE_INVALIDATION_TOPIC =
  'plugin.runtime-cache.changed.v1';

export type PluginCacheInvalidation =
  | {
      version: 1;
      scope: 'plugin-user';
      pluginId: string;
      userId: string;
    }
  | {
      version: 1;
      scope: 'plugin';
      pluginId: string;
    }
  | {
      version: 1;
      scope: 'user';
      userId: string;
    };

type PluginCacheInvalidationListener = (
  invalidation: PluginCacheInvalidation
) => void;

const listeners = new Set<PluginCacheInvalidationListener>();
let subscription:
  | { coordinator: Coordinator; unsubscribe: CoordinationUnsubscribe }
  | undefined;
let subscriptionInitialization:
  { coordinator: Coordinator; promise: Promise<void> } | undefined;
let publicationReady = true;
let pendingInvalidation: PluginCacheInvalidation | undefined;
let recoveryProbe: Promise<boolean> | undefined;
let lifecycleRevision = 0;

const RECOVERY_PROBE_TIMEOUT_MS = 1_500;

const printable = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some(
    character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  );

const validPluginId = (value: unknown): value is string =>
  printable(value, 128) && /^[A-Za-z0-9._-]+$/.test(value);

export const isPluginCacheInvalidation = (
  value: unknown
): value is PluginCacheInvalidation => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1) return false;
  if (candidate.scope === 'plugin-user') {
    return (
      validPluginId(candidate.pluginId) && printable(candidate.userId, 256)
    );
  }
  if (candidate.scope === 'plugin') return validPluginId(candidate.pluginId);
  if (candidate.scope === 'user') return printable(candidate.userId, 256);
  return false;
};

const dispatch = (invalidation: PluginCacheInvalidation): void => {
  for (const listener of [...listeners]) {
    try {
      listener(invalidation);
    } catch {
      // Invalidation is advisory because PostgreSQL remains authoritative.
      // One broken consumer must not prevent every other local cache clearing.
      logger.warn('A plugin cache invalidation listener failed');
    }
  }
};

const selectedCoordinator = (): Coordinator | null => {
  const coordinator = getInitializedCoordinator();
  if (coordinator) return coordinator;
  if (getPersistence(encryptionService).dialect === 'postgres') {
    throw new Error(
      'Plugin cache invalidation requires the initialized team coordinator'
    );
  }
  // SQLite is the supported single-process profile. Tests and maintenance
  // utilities may intentionally use it without starting a coordinator.
  return null;
};

export const ensurePluginCacheInvalidationSubscription =
  async (): Promise<void> => {
    const coordinator = selectedCoordinator();
    if (!coordinator) return;
    if (subscription?.coordinator === coordinator) return;
    if (subscriptionInitialization?.coordinator === coordinator) {
      return subscriptionInitialization.promise;
    }

    const promise = (async () => {
      const previous = subscription;
      subscription = undefined;
      if (previous) await previous.unsubscribe().catch(() => undefined);
      const unsubscribe = await coordinator.subscribe<unknown>(
        PLUGIN_CACHE_INVALIDATION_TOPIC,
        event => {
          if (!isPluginCacheInvalidation(event.payload)) {
            logger.warn(
              'Ignoring an invalid plugin cache invalidation message'
            );
            return;
          }
          dispatch(event.payload);
        }
      );
      subscription = { coordinator, unsubscribe };
    })();
    subscriptionInitialization = { coordinator, promise };
    try {
      await promise;
    } finally {
      if (subscriptionInitialization?.promise === promise) {
        subscriptionInitialization = undefined;
      }
    }
  };

export const registerPluginCacheInvalidationListener = (
  listener: PluginCacheInvalidationListener
): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Publish only after the corresponding SQL mutation has committed. */
export const publishPluginCacheInvalidation = async (
  invalidation: PluginCacheInvalidation
): Promise<boolean> => {
  if (!isPluginCacheInvalidation(invalidation)) {
    throw new Error('Invalid plugin cache invalidation');
  }
  // Clear the writer immediately, including when Redis publication fails.
  dispatch(invalidation);
  try {
    const coordinator = selectedCoordinator();
    if (!coordinator) return true;
    await ensurePluginCacheInvalidationSubscription();
    await coordinator.publish(PLUGIN_CACHE_INVALIDATION_TOPIC, invalidation);
    publicationReady = true;
    pendingInvalidation = undefined;
    return true;
  } catch {
    // SQL has already committed. PostgreSQL readers deliberately bypass the
    // process caches, so report committed truth to the caller while readiness
    // exposes the failed advisory fan-out to operators.
    publicationReady = false;
    pendingInvalidation = invalidation;
    logger.warn('Plugin cache invalidation publication failed');
    return false;
  }
};

export const getPluginCacheInvalidationHealth = (): {
  ready: boolean;
  message?: string;
} =>
  publicationReady
    ? { ready: true }
    : {
        ready: false,
        message: 'Plugin cache invalidation publication failed',
      };

/**
 * Bounded readiness recovery for a post-commit publication failure. Retrying
 * the last invalidation proves Redis command publication while coordinator
 * health proves both command and subscriber clients are ready. PostgreSQL
 * remains authoritative while this advisory path is unavailable.
 */
export const probePluginCacheInvalidationHealth = async (): Promise<{
  ready: boolean;
  message?: string;
}> => {
  if (publicationReady) return { ready: true };
  const invalidation = pendingInvalidation;
  const coordinator = getInitializedCoordinator();
  if (!invalidation || !coordinator) {
    return getPluginCacheInvalidationHealth();
  }

  if (!recoveryProbe) {
    const revision = lifecycleRevision;
    const attempt = (async (): Promise<boolean> => {
      try {
        await ensurePluginCacheInvalidationSubscription();
        const health = await coordinator.health();
        if (!health.ready) return false;
        await coordinator.publish(
          PLUGIN_CACHE_INVALIDATION_TOPIC,
          invalidation
        );
        if (
          revision !== lifecycleRevision ||
          pendingInvalidation !== invalidation
        ) {
          return false;
        }
        pendingInvalidation = undefined;
        publicationReady = true;
        return true;
      } catch {
        return false;
      }
    })();
    let tracked: Promise<boolean>;
    tracked = attempt.finally(() => {
      if (recoveryProbe === tracked) recoveryProbe = undefined;
    });
    recoveryProbe = tracked;
  }

  const recovered = await Promise.race([
    recoveryProbe,
    new Promise<false>(resolve => {
      const timer = setTimeout(() => resolve(false), RECOVERY_PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  return recovered ? { ready: true } : getPluginCacheInvalidationHealth();
};

export const closePluginCacheInvalidation = async (): Promise<void> => {
  lifecycleRevision += 1;
  const pending = subscriptionInitialization?.promise;
  if (pending) await pending.catch(() => undefined);
  const current = subscription;
  subscription = undefined;
  subscriptionInitialization = undefined;
  publicationReady = true;
  pendingInvalidation = undefined;
  recoveryProbe = undefined;
  if (current) await current.unsubscribe().catch(() => undefined);
};
