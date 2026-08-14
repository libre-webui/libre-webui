/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { getCoordinator } from '../platform/coordination/service.js';
import type { Coordinator } from '../platform/coordination/types.js';
import {
  SHARED_COORDINATION_OPERATION_TIMEOUT_MS,
  withCoordinationTimeout,
} from '../platform/coordination/sharedAdmission.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('shared-rate-limit');

export interface SharedRateLimitOptions {
  /** Stable route/policy identity; it is part of the shared Redis key. */
  keyPrefix: string;
  windowMs: number;
  max: number;
  message?: unknown;
  keyGenerator?: (
    request: Request,
    response: Response
  ) => string | Promise<string>;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  skipSuccessfulRequests?: boolean;
  /** Bypass this policy before any coordinator operation. */
  skip?: (request: Request, response: Response) => boolean | Promise<boolean>;
  /** Test seam; production uses the lifecycle-owned platform coordinator. */
  coordinator?: Coordinator;
  operationTimeoutMs?: number;
}

const clientDigest = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

const responseMessage = (options: SharedRateLimitOptions): unknown =>
  options.message ?? 'Too many requests, please try again later.';

/**
 * Fixed-window request limiting backed exclusively by the selected platform
 * coordinator. Team replicas share Redis state; a Redis failure returns 503
 * instead of silently opening an independent in-memory bucket.
 */
export const sharedRateLimit = (
  options: SharedRateLimitOptions
): RequestHandler => {
  const prefix = options.keyPrefix.trim().toLowerCase();
  if (!/^[a-z][a-z0-9.-]{0,95}$/.test(prefix)) {
    throw new Error('Invalid shared rate-limit key prefix.');
  }
  if (!Number.isSafeInteger(options.max) || options.max < 1) {
    throw new Error('Invalid shared rate-limit capacity.');
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('Invalid shared rate-limit window.');
  }

  return async (
    request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    let coordinationKey: string;
    let windowToken: string;
    let coordinator: Coordinator;
    try {
      if (options.skip && (await options.skip(request, response))) {
        next();
        return;
      }
      const rawClientKey = options.keyGenerator
        ? await options.keyGenerator(request, response)
        : ipKeyGenerator(
            request.ip || request.socket.remoteAddress || 'unknown'
          );
      coordinationKey = `http-rate:${prefix}:${clientDigest(rawClientKey)}`;
      coordinator = options.coordinator ?? getCoordinator();
      const result = await withCoordinationTimeout(
        coordinator.consumeRateLimit(
          coordinationKey,
          options.max,
          options.windowMs
        ),
        options.operationTimeoutMs ?? SHARED_COORDINATION_OPERATION_TIMEOUT_MS
      );
      windowToken = result.windowToken;
      const resetSeconds = Math.max(
        0,
        Math.ceil((result.resetAt - Date.now()) / 1000)
      );
      if (options.standardHeaders !== false) {
        response.setHeader('RateLimit-Limit', String(options.max));
        response.setHeader('RateLimit-Remaining', String(result.remaining));
        response.setHeader('RateLimit-Reset', String(resetSeconds));
      }
      if (options.legacyHeaders !== false) {
        response.setHeader('X-RateLimit-Limit', String(options.max));
        response.setHeader('X-RateLimit-Remaining', String(result.remaining));
        response.setHeader(
          'X-RateLimit-Reset',
          String(Math.ceil(result.resetAt / 1000))
        );
      }
      if (!result.allowed) {
        response.setHeader('Retry-After', String(resetSeconds));
        response.status(429).send(responseMessage(options));
        return;
      }
    } catch (error) {
      logger.warn('Shared request rate limiting is unavailable', {
        scope: prefix,
        error: error instanceof Error ? error.message : String(error),
      });
      response.status(503).json({
        success: false,
        message: 'Request admission is temporarily unavailable',
      });
      return;
    }

    if (options.skipSuccessfulRequests) {
      let refunded = false;
      response.once('finish', () => {
        if (refunded || response.statusCode >= 400) return;
        refunded = true;
        try {
          void withCoordinationTimeout(
            coordinator.refundRateLimit(coordinationKey, windowToken),
            options.operationTimeoutMs ??
              SHARED_COORDINATION_OPERATION_TIMEOUT_MS
          ).catch(error =>
            logger.warn('Shared request rate-limit refund failed', {
              scope: prefix,
              error: error instanceof Error ? error.message : String(error),
            })
          );
        } catch (error) {
          logger.warn('Shared request rate-limit refund failed', {
            scope: prefix,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    next();
  };
};

export default sharedRateLimit;
