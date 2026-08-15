/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export const VIDEO_RESUME_JOB_TYPE = 'media.video.resume.v1';
export const VIDEO_RESUME_IDEMPOTENCY_SCOPE = 'media.video.resume.v1';
export const VIDEO_SUBMIT_JOB_TYPE = 'media.video.submit.v1';
export const VIDEO_SUBMIT_IDEMPOTENCY_SCOPE = 'media.video.submit.v1';
export const RESOURCE_DELETE_JOB_TYPE = 'resource.delete.v1';
export const RESOURCE_DELETE_IDEMPOTENCY_SCOPE = 'resource.delete.v1';
export const RESOURCE_DELETE_RECOVERY_IDEMPOTENCY_SCOPE =
  'resource.delete.v1:recovery';
export const DOCUMENT_INGEST_JOB_TYPE = 'document.extract-embed.v1';
export const DOCUMENT_INGEST_IDEMPOTENCY_SCOPE = 'document.extract-embed.v1';
export const CHAT_GENERATE_JOB_TYPE = 'chat.generate.v1';
export const CHAT_GENERATE_IDEMPOTENCY_SCOPE = 'chat.generate.v1';
export const chatGenerationIdempotencyScope = (sessionId: string): string =>
  `${CHAT_GENERATE_IDEMPOTENCY_SCOPE}:${sessionId}`;
export const chatEventStreamId = (sessionId: string): string =>
  `chat:${sessionId}`;
export const OWNER_DELETE_CONTENT_JOB_TYPE = 'owner.delete-content.v1';
export const OWNER_DELETE_CONTENT_IDEMPOTENCY_SCOPE = 'owner.delete-content.v1';
export const OWNER_DELETE_CONTENT_RECOVERY_IDEMPOTENCY_SCOPE =
  'owner.delete-content.v1:recovery';
export const DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX =
  'lifecycle-recovery:';
export const DELETION_LIFECYCLE_RECOVERY_NOT_REQUIRED_REFERENCE = `${DELETION_LIFECYCLE_RECOVERY_REFERENCE_PREFIX}not-required`;
export const WORK_EXECUTE_JOB_TYPE = 'work.execute.v1';
export const WORK_EXECUTE_IDEMPOTENCY_SCOPE = 'work.execute.v1';

/**
 * Only failures produced after a lifecycle payload was authenticated and its
 * cleanup handler reached a retryable boundary may receive a successor job.
 * Corrupt payloads, revoked actors, and unsupported handlers remain terminal.
 */
export const RESOURCE_DELETE_RECOVERABLE_ERROR_CODES = Object.freeze([
  'resource-busy',
  'coordination-unavailable',
  'resource-lease-lost',
  'resource-work-draining',
  'resource-cleanup-failed',
  'cache-invalidation-failed',
  'resource-tombstone-lost',
  'lease-expired',
  'worker-shutdown',
]);
export const OWNER_DELETE_CONTENT_RECOVERABLE_ERROR_CODES = Object.freeze([
  'resource-busy',
  'coordination-unavailable',
  'resource-lease-lost',
  'owner-jobs-draining',
  'owner-cleanup-failed',
  'lease-expired',
  'worker-shutdown',
]);

/** A successor never becomes claimable in the same outage hot loop. */
export const DELETION_LIFECYCLE_RECOVERY_DELAY_MS = 60_000;
