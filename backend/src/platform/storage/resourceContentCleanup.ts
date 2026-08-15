/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { getPlatformStorageRuntime } from './platformStorageRuntime.js';

export type PlatformContentResourceType =
  'document' | 'generated-media' | 'persona';

export interface PlatformContentCleanupRequest {
  resourceType: PlatformContentResourceType;
  resourceId: string;
  ownerUserId: string;
}

export interface PlatformContentCleanupResult {
  deletedVectors: number;
  deletedBlob: boolean;
  detachedReference: boolean;
}

export interface PlatformOwnerContentCleanupResult {
  deletedVectors: number;
  deletedBlobs: number;
  detachedReferences: number;
}

const vectorNamespace = (
  resourceType: PlatformContentResourceType
): string | undefined => {
  if (resourceType === 'document') return 'document-chunk';
  if (resourceType === 'persona') return 'persona-memory';
  return undefined;
};

const blobPurpose = (
  resourceType: PlatformContentResourceType
): string | undefined => {
  if (resourceType === 'document') return 'document.source';
  if (resourceType === 'generated-media') return 'gallery.media';
  return undefined;
};

/**
 * Retriable physical-content cleanup used by resource.delete.v1.
 *
 * The reference is deliberately detached only after the idempotent physical
 * delete succeeds. A crash therefore retains enough information for the next
 * attempt; a crash after physical deletion repeats a harmless missing delete
 * and then removes the reference. Vector deletes are owner/resource scoped and
 * idempotent as well.
 */
export const cleanupPlatformResourceContent = async (
  request: PlatformContentCleanupRequest
): Promise<PlatformContentCleanupResult> => {
  const platform = getPlatformStorageRuntime();
  const namespace = vectorNamespace(request.resourceType);
  const deletedVectors = namespace
    ? await platform.vectorStore.delete({
        actor: { userId: request.ownerUserId },
        namespace,
        resourceId: request.resourceId,
      })
    : 0;
  const purpose = blobPurpose(request.resourceType);
  if (!purpose) {
    return { deletedVectors, deletedBlob: false, detachedReference: false };
  }
  const reference = await platform.blobReferences.find(
    request.resourceType,
    request.resourceId,
    purpose
  );
  if (!reference) {
    return { deletedVectors, deletedBlob: false, detachedReference: false };
  }
  if (reference.ownerUserId !== request.ownerUserId) {
    throw new Error('Platform content reference owner mismatch');
  }
  const deletedBlob = await platform.blobStore.delete({
    id: reference.blobId,
    ownerUserId: request.ownerUserId,
  });
  const detached = await platform.blobReferences.detach(
    request.resourceType,
    request.resourceId,
    purpose
  );
  return {
    deletedVectors,
    deletedBlob,
    detachedReference: Boolean(detached),
  };
};

/** Idempotent owner-wide cleanup used after an account row is durably retired. */
export const cleanupPlatformOwnerContent = async (
  ownerUserId: string
): Promise<PlatformOwnerContentCleanupResult> => {
  const platform = getPlatformStorageRuntime();
  const deletedVectors = await platform.vectorStore.deleteAllForOwner({
    userId: ownerUserId,
  });
  let deletedBlobs = 0;
  let detachedReferences = 0;
  for (;;) {
    const references = await platform.blobReferences.listByOwner(
      ownerUserId,
      500
    );
    if (references.length === 0) break;
    for (const reference of references) {
      const deleted = await platform.blobStore.delete({
        id: reference.blobId,
        ownerUserId,
      });
      if (deleted) deletedBlobs += 1;
      const detached = await platform.blobReferences.detach(
        reference.resourceType,
        reference.resourceId,
        reference.purpose
      );
      if (detached) detachedReferences += 1;
    }
  }
  // Quota inventory also contains committed objects that never acquired an
  // application reference because the caller crashed after BlobStore.put().
  for (;;) {
    const objectIds = await platform.blobQuota.listStoredObjectIdsByOwner(
      ownerUserId,
      500
    );
    if (objectIds.length === 0) break;
    for (const id of objectIds) {
      if (await platform.blobStore.delete({ id, ownerUserId })) {
        deletedBlobs += 1;
      }
    }
  }
  return { deletedVectors, deletedBlobs, detachedReferences };
};
