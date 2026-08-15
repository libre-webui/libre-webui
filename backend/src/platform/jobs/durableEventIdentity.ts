/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';

/**
 * Produce a stable UUID-shaped event identity from a caller-owned occurrence.
 * Length-prefixing prevents ambiguous component tuples (for example `a|bc`
 * versus `ab|c`). The UUID variant/version bits keep PostgreSQL's uuid type
 * authoritative without relying on a process-local random ID.
 */
export const durableEventId = (...components: readonly string[]): string => {
  if (
    components.length === 0 ||
    components.some(
      component =>
        typeof component !== 'string' ||
        component.length === 0 ||
        Buffer.byteLength(component, 'utf8') > 2048
    )
  ) {
    throw new Error('Durable event identity components are invalid.');
  }
  const hash = createHash('sha256');
  for (const component of components) {
    const bytes = Buffer.from(component, 'utf8');
    hash.update(String(bytes.length));
    hash.update(':');
    hash.update(bytes);
  }
  const bytes = hash.digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
