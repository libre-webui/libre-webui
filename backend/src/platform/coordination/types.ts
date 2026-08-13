/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 */

export interface CoordinationHealth {
  ready: boolean;
  backend: 'local' | 'redis';
  latencyMs: number;
  message?: string;
}

export interface CoordinationEvent<T = unknown> {
  id: string;
  topic: string;
  emittedAt: string;
  payload: T;
}

export interface CoordinationLease {
  key: string;
  ownerToken: string;
  fencingToken: number;
  expiresAt: number;
  extend(ttlMs: number): Promise<boolean>;
  release(): Promise<boolean>;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export type CoordinationEventHandler<T = unknown> = (
  event: CoordinationEvent<T>
) => void | Promise<void>;

export type CoordinationUnsubscribe = () => Promise<void>;

export interface Coordinator {
  readonly backend: 'local' | 'redis';
  connect(): Promise<void>;
  close(): Promise<void>;
  health(): Promise<CoordinationHealth>;
  publish<T>(topic: string, payload: T): Promise<CoordinationEvent<T>>;
  subscribe<T>(
    topic: string,
    handler: CoordinationEventHandler<T>
  ): Promise<CoordinationUnsubscribe>;
  getCache<T>(key: string): Promise<T | null>;
  setCache<T>(key: string, value: T, ttlMs: number): Promise<void>;
  deleteCache(key: string): Promise<void>;
  acquireLease(key: string, ttlMs: number): Promise<CoordinationLease | null>;
  consumeRateLimit(
    key: string,
    limit: number,
    windowMs: number
  ): Promise<RateLimitResult>;
}

export class CoordinationUnavailableError extends Error {
  readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'CoordinationUnavailableError';
    this.cause = cause;
  }
}

export const assertCoordinationName = (
  value: string,
  label: string
): string => {
  const normalized = value.trim();
  const hasControlCharacter = [...normalized].some(
    character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
  );
  if (!normalized || normalized.length > 256 || hasControlCharacter) {
    throw new Error(`${label} must contain 1-256 printable characters.`);
  }
  return normalized;
};

export const assertTtl = (ttlMs: number): number => {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > 86_400_000) {
    throw new Error(
      'TTL must be an integer between 1 and 86400000 milliseconds.'
    );
  }
  return ttlMs;
};
