/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export const OLLAMA_RUNTIME_DEFAULTS = {
  timeoutMs: 300_000,
  longOperationTimeoutMs: 900_000,
  maxContext: 32_768,
} as const;

export const OLLAMA_RUNTIME_LIMITS = {
  timeoutMs: { minimum: 1_000, maximum: 3_600_000 },
  longOperationTimeoutMs: { minimum: 1_000, maximum: 3_600_000 },
  maxContext: { minimum: 128, maximum: 2_097_152 },
} as const;

export interface OllamaRuntimeConfig {
  timeoutMs: number;
  longOperationTimeoutMs: number;
  maxContext: number;
  blockers: string[];
}

export class OllamaConfigurationError extends Error {
  constructor(readonly blockers: string[]) {
    super(`Invalid Ollama configuration:\n- ${blockers.join('\n- ')}`);
    this.name = 'OllamaConfigurationError';
  }
}

const boundedDecimalInteger = (
  value: string | undefined,
  fallback: number,
  name: string,
  minimum: number,
  maximum: number,
  blockers: string[]
): number => {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim();
  if (!/^[0-9]+$/.test(normalized)) {
    blockers.push(
      `${name} must be a base-10 integer between ${minimum} and ${maximum}.`
    );
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    blockers.push(
      `${name} must be a base-10 integer between ${minimum} and ${maximum}.`
    );
    return fallback;
  }
  return parsed;
};

/** Parse provider limits without opening files, databases, or connections. */
export const resolveOllamaRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): OllamaRuntimeConfig => {
  const blockers: string[] = [];
  const timeoutMs = boundedDecimalInteger(
    env.OLLAMA_TIMEOUT,
    OLLAMA_RUNTIME_DEFAULTS.timeoutMs,
    'OLLAMA_TIMEOUT',
    OLLAMA_RUNTIME_LIMITS.timeoutMs.minimum,
    OLLAMA_RUNTIME_LIMITS.timeoutMs.maximum,
    blockers
  );
  const longOperationTimeoutMs = boundedDecimalInteger(
    env.OLLAMA_LONG_OPERATION_TIMEOUT,
    OLLAMA_RUNTIME_DEFAULTS.longOperationTimeoutMs,
    'OLLAMA_LONG_OPERATION_TIMEOUT',
    OLLAMA_RUNTIME_LIMITS.longOperationTimeoutMs.minimum,
    OLLAMA_RUNTIME_LIMITS.longOperationTimeoutMs.maximum,
    blockers
  );
  const maxContext = boundedDecimalInteger(
    env.OLLAMA_MAX_CONTEXT,
    OLLAMA_RUNTIME_DEFAULTS.maxContext,
    'OLLAMA_MAX_CONTEXT',
    OLLAMA_RUNTIME_LIMITS.maxContext.minimum,
    OLLAMA_RUNTIME_LIMITS.maxContext.maximum,
    blockers
  );
  if (longOperationTimeoutMs < timeoutMs) {
    blockers.push(
      'OLLAMA_LONG_OPERATION_TIMEOUT must be greater than or equal to OLLAMA_TIMEOUT.'
    );
  }
  return {
    timeoutMs,
    longOperationTimeoutMs,
    maxContext,
    blockers: [...new Set(blockers)],
  };
};

export const assertOllamaRuntimeConfig = (
  config: OllamaRuntimeConfig
): OllamaRuntimeConfig => {
  if (config.blockers.length > 0) {
    throw new OllamaConfigurationError(config.blockers);
  }
  return config;
};

/**
 * Return one normalized, validated view for every Ollama consumer. Entry
 * points call this before provisioning state; services use the same parser so
 * no permissive parseInt fallback can reinterpret an already accepted value.
 */
export const getOllamaRuntimeConfig = (
  env: NodeJS.ProcessEnv = process.env
): OllamaRuntimeConfig =>
  assertOllamaRuntimeConfig(resolveOllamaRuntimeConfig(env));

export const normalizeOllamaRuntimeEnvironment = (
  config: OllamaRuntimeConfig,
  env: NodeJS.ProcessEnv = process.env
): void => {
  env.OLLAMA_TIMEOUT = String(config.timeoutMs);
  env.OLLAMA_LONG_OPERATION_TIMEOUT = String(config.longOperationTimeoutMs);
  env.OLLAMA_MAX_CONTEXT = String(config.maxContext);
};
