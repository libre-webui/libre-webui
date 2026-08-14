/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PlatformStorageRuntime } from './platformStorageRuntime.js';
import type { PersonaMemoryRecord } from './platformDomainRepositories.js';

/**
 * Close the non-transactional SQL/vector deletion race after a memory upsert.
 *
 * If persona deletion committed while the vector write was in flight, its
 * cleanup job may have observed no vector to remove. The authoritative memory
 * row is therefore checked after the upsert; an absent row makes this writer
 * remove the vector it just recreated.
 */
export const assertPersonaMemoryStillReferenced = async (
  platform: Pick<PlatformStorageRuntime, 'domains' | 'vectorStore'>,
  record: PersonaMemoryRecord,
  namespace: string
): Promise<void> => {
  const persisted = await platform.domains.memories.findByOwner(
    record.id,
    record.userId,
    record.personaId
  );
  if (persisted) return;
  await platform.vectorStore.delete({
    actor: { userId: record.userId },
    namespace,
    ids: [record.id],
  });
  throw new Error('Persona memory disappeared while it was being indexed');
};
