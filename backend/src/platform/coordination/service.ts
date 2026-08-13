/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createLogger } from '../../utils/logger.js';
import {
  assertPlatformRuntimeConfig,
  resolvePlatformRuntimeConfig,
  summarizePlatformRuntimeConfig,
  type PlatformRuntimeConfig,
} from '../runtimeConfig.js';
import { createCoordinator } from './index.js';
import type { Coordinator } from './types.js';

const logger = createLogger('platform');

let runtimeConfig: PlatformRuntimeConfig | undefined;
let coordinator: Coordinator | undefined;
let initialization: Promise<Coordinator> | undefined;

export const getPlatformRuntimeConfig = (): PlatformRuntimeConfig => {
  runtimeConfig ||= assertPlatformRuntimeConfig(resolvePlatformRuntimeConfig());
  return runtimeConfig;
};

export const initializeCoordinator = async (): Promise<Coordinator> => {
  if (initialization) return initialization;
  const config = getPlatformRuntimeConfig();
  const candidate = createCoordinator(config);
  initialization = candidate
    .connect()
    .then(() => {
      coordinator = candidate;
      logger.info(
        'Platform profile ready',
        summarizePlatformRuntimeConfig(config)
      );
      return candidate;
    })
    .catch(error => {
      initialization = undefined;
      throw error;
    });
  return initialization;
};

export const getCoordinator = (): Coordinator => {
  if (!coordinator) {
    throw new Error('Platform coordinator has not been initialized.');
  }
  return coordinator;
};

export const closeCoordinator = async (): Promise<void> => {
  const current = coordinator;
  coordinator = undefined;
  initialization = undefined;
  if (current) await current.close();
};

/** Test-only reset for environment-driven singleton state. */
export const resetPlatformServicesForTests = async (): Promise<void> => {
  await closeCoordinator();
  runtimeConfig = undefined;
};
