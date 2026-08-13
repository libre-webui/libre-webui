/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { LocalCoordinator } from './localCoordinator.js';
import { RedisCoordinator } from './redisCoordinator.js';
import type { Coordinator } from './types.js';
import type { PlatformRuntimeConfig } from '../runtimeConfig.js';

export * from './types.js';
export { LocalCoordinator } from './localCoordinator.js';
export { RedisCoordinator } from './redisCoordinator.js';

export const createCoordinator = (
  config: PlatformRuntimeConfig
): Coordinator => {
  if (config.coordination.backend === 'redis') {
    if (!config.coordination.redisUrl) {
      throw new Error('REDIS_URL is required for Redis coordination.');
    }
    return new RedisCoordinator({
      url: config.coordination.redisUrl,
      keyPrefix: config.coordination.keyPrefix,
      connectTimeoutMs: config.coordination.connectTimeoutMs,
    });
  }
  return new LocalCoordinator();
};
