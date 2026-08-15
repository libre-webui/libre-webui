/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Request } from 'express';

const CHAT_CANCELLATION_PATH =
  /^\/api\/chat\/sessions\/[^/]+\/generations\/[^/]+\/cancel\/?$/;

/**
 * Stop is an authenticated, idempotent SQL safety decision. It must not queue
 * behind the ordinary chat admission buckets that it exists to terminate.
 */
export const isChatCancellationSafetyRequest = (request: Request): boolean => {
  if (request.method !== 'POST') return false;
  const mountedPath = `${request.baseUrl}${request.path}`;
  return CHAT_CANCELLATION_PATH.test(mountedPath);
};
