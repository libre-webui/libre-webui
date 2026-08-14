/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { DeletablePlatformResourceType } from './platformDomainRepositories.js';

const appendPart = (
  hash: ReturnType<typeof createHash>,
  value: string
): void => {
  hash.update(String(Buffer.byteLength(value, 'utf8')));
  hash.update(':');
  hash.update(value);
};

/**
 * A resource identifier is single-incarnation: once deleted, its tombstone is
 * retained and every creator must reject that identifier.  This stable token
 * therefore names the one deletion occurrence without relying on wall time or
 * process-local randomness, and survives a lost transaction acknowledgement.
 */
export const resourceDeletionToken = (input: {
  resourceType: DeletablePlatformResourceType;
  resourceId: string;
  ownerUserId: string;
  deletionIncarnation: number;
}): string => {
  const hash = createHash('sha256');
  for (const value of [
    'libre-resource-deletion-v1',
    input.resourceType,
    input.resourceId,
    input.ownerUserId,
    String(input.deletionIncarnation),
  ]) {
    appendPart(hash, value);
  }
  return hash.digest('hex');
};
