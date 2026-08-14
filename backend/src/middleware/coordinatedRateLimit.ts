/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getCoordinator } from '../platform/coordination/service.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('coordinated-rate-limit');

export interface CoordinatedRateLimitOptions {
  keyPrefix: string;
  limit: number;
  windowMs: number;
  message: string;
}

/**
 * Security-sensitive rate limiting backed by the selected coordinator. Redis
 * failures deliberately reject the request instead of creating a per-process
 * bucket that attackers can bypass by changing replicas.
 */
export const coordinatedRateLimit = (
  options: CoordinatedRateLimitOptions
): RequestHandler => {
  if (!/^[a-z][a-z0-9.-]{0,63}$/.test(options.keyPrefix)) {
    throw new Error('Invalid coordinated rate-limit key prefix');
  }
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error('Invalid coordinated rate-limit capacity');
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error('Invalid coordinated rate-limit window');
  }

  return async (
    request: Request,
    response: Response,
    next: NextFunction
  ): Promise<void> => {
    const peer = request.ip || request.socket.remoteAddress || 'unknown';
    const peerDigest = createHash('sha256').update(peer).digest('base64url');
    try {
      const result = await getCoordinator().consumeRateLimit(
        `${options.keyPrefix}:${peerDigest}`,
        options.limit,
        options.windowMs
      );
      const resetSeconds = Math.max(
        0,
        Math.ceil((result.resetAt - Date.now()) / 1000)
      );
      response.setHeader('RateLimit-Limit', String(options.limit));
      response.setHeader('RateLimit-Remaining', String(result.remaining));
      response.setHeader('RateLimit-Reset', String(resetSeconds));
      if (!result.allowed) {
        response.setHeader('Retry-After', String(resetSeconds));
        response.status(429).json({ success: false, message: options.message });
        return;
      }
      next();
    } catch {
      logger.warn('Shared security rate limiting is unavailable');
      response.status(503).json({
        success: false,
        message: 'Authentication protection is temporarily unavailable',
      });
    }
  };
};
