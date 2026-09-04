/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import { getPlatformStorageRuntime } from '../platform/storage/index.js';
import { assertPersonaMemoryStillReferenced } from '../platform/storage/personaMemoryIndexing.js';
import type { PersonaMemoryRecord } from '../platform/storage/platformDomainRepositories.js';
import type {
  EmbeddingModel,
  MemorySearchResult,
  PersonaMemoryEntry,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import embeddingService from './embeddingService.js';
import {
  applyMemoryDecay,
  calculateEnhancedImportance,
  classifyMemoryType,
  createConsolidatedContent,
  type MemoryType,
} from './memoryUtils.js';
import { randomUUID } from 'node:crypto';

const logger = createLogger('memory');
const MEMORY_VECTOR_NAMESPACE = 'persona-memory';
const MEMORY_VECTOR_VERSION = 'v1';
export type { MemoryType } from './memoryUtils.js';

export interface EnhancedMemoryEntry extends PersonaMemoryEntry {
  memory_type?: MemoryType;
  access_count?: number;
  last_accessed?: number;
  decay_factor?: number;
  consolidated_from?: string[];
}

const entryFromRecord = (record: PersonaMemoryRecord): EnhancedMemoryEntry => ({
  id: record.id,
  user_id: record.userId,
  persona_id: record.personaId,
  content: record.content,
  timestamp: record.timestamp,
  ...(record.context ? { context: record.context } : {}),
  importance_score: record.importanceScore,
  memory_type: record.memoryType,
  access_count: record.accessCount,
  ...(record.lastAccessed ? { last_accessed: record.lastAccessed } : {}),
  decay_factor: record.decayFactor,
  ...(record.consolidatedFrom
    ? { consolidated_from: record.consolidatedFrom }
    : {}),
});

const sourceRevision = (content: string): string =>
  crypto.createHash('sha256').update(content, 'utf8').digest('hex');

const deterministicMemoryId = (input: {
  userId: string;
  personaId: string;
  content: string;
  context?: string;
  importanceScore: number;
  memoryType: MemoryType;
}): string => {
  const digest = crypto
    .createHash('sha256')
    .update(
      JSON.stringify([
        'libre-persona-memory-v1',
        input.userId,
        input.personaId,
        input.content,
        input.context ?? null,
        input.importanceScore,
        input.memoryType,
      ]),
      'utf8'
    )
    .digest()
    .subarray(0, 16);
  // RFC 9562 UUIDv8 reserves this version for application-defined hashes.
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const sameMemoryIntent = (
  persisted: PersonaMemoryRecord,
  requested: PersonaMemoryRecord
): boolean =>
  persisted.id === requested.id &&
  persisted.userId === requested.userId &&
  persisted.personaId === requested.personaId &&
  persisted.content === requested.content &&
  persisted.context === requested.context &&
  persisted.memoryType === requested.memoryType;

const retainedOutcomeError = (message: string, cause: unknown): Error => {
  const error = new Error(message);
  Object.defineProperty(error, 'cause', {
    value: cause,
    enumerable: false,
  });
  return error;
};

const combinedOutcomeCause = (
  message: string,
  cause: unknown,
  relatedError: unknown
): Error => {
  const error = retainedOutcomeError(message, cause);
  Object.defineProperty(error, 'relatedError', {
    value: relatedError,
    enumerable: false,
  });
  return error;
};

const validateImportance = (value: number): number => {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('Memory importance must be between 0 and 1');
  }
  return value;
};

export class MemoryService {
  private readonly embeddingModels: EmbeddingModel[] = [
    {
      id: 'nomic-embed-text',
      name: 'Nomic Embed Text',
      description: 'High-quality text embeddings from Nomic AI',
      provider: 'ollama',
      dimensions: 768,
    },
    {
      id: 'bge-m3',
      name: 'BGE-M3',
      description: 'Multi-lingual and multi-granularity embedding model',
      provider: 'ollama',
      dimensions: 1024,
    },
    {
      id: 'text-embedding-3-large',
      name: 'OpenAI Text Embedding 3 Large',
      description: "OpenAI's largest text embedding model",
      provider: 'openai',
      dimensions: 3072,
    },
    {
      id: 'text-embedding-3-small',
      name: 'OpenAI Text Embedding 3 Small',
      description: "OpenAI's smaller, faster embedding model",
      provider: 'openai',
      dimensions: 1536,
    },
    {
      id: 'e5-large-v2',
      name: 'E5 Large v2',
      description: 'Microsoft E5 large text embedding model',
      provider: 'sentence-transformers',
      dimensions: 1024,
    },
  ];

  classifyMemoryType(content: string): MemoryType {
    return classifyMemoryType(content);
  }

  calculateEnhancedImportance(
    content: string,
    memoryType: MemoryType,
    _context?: string
  ): number {
    return calculateEnhancedImportance(content, memoryType);
  }

  applyDecay(
    originalImportance: number,
    timestamp: number,
    accessCount = 0,
    lastAccessed?: number
  ): number {
    return applyMemoryDecay(
      originalImportance,
      timestamp,
      accessCount,
      lastAccessed
    );
  }

  getEmbeddingModels(): EmbeddingModel[] {
    return [...this.embeddingModels];
  }

  private async generateEmbedding(
    text: string,
    model: string,
    userId?: string
  ): Promise<number[] | null> {
    try {
      const response = await embeddingService.generateEmbeddings(
        { model, input: text },
        userId
      );
      return response.embeddings[0] || null;
    } catch (error) {
      logger.error('Failed to generate embedding:', error);
      return null;
    }
  }

  private async indexRecord(
    record: PersonaMemoryRecord,
    embeddingModel: string,
    embedding: readonly number[] | undefined
  ): Promise<void> {
    if (!embedding?.length) return;
    const platform = getPlatformStorageRuntime();
    await platform.vectorStore.upsert({
      actor: { userId: record.userId },
      records: [
        {
          namespace: MEMORY_VECTOR_NAMESPACE,
          id: record.id,
          ownerUserId: record.userId,
          resourceId: record.personaId,
          model: embeddingModel,
          dimensions: embedding.length,
          version: MEMORY_VECTOR_VERSION,
          sourceRevision: sourceRevision(record.content),
          embedding,
          attributes: { memoryType: record.memoryType },
        },
      ],
    });

    // Relational persona deletion and vector persistence cannot share one
    // transaction. Recheck the authoritative memory row after the upsert so a
    // delete that wins either side of that boundary cannot leave (or recreate)
    // an orphan vector after resource.delete.v1 has already cleaned the
    // persona namespace.
    await assertPersonaMemoryStillReferenced(
      platform,
      record,
      MEMORY_VECTOR_NAMESPACE
    );
  }

  private async hasAuthoritativeVector(
    record: PersonaMemoryRecord,
    embeddingModel: string,
    embedding: readonly number[]
  ): Promise<boolean> {
    const hits = await getPlatformStorageRuntime().vectorStore.query({
      actor: { userId: record.userId },
      namespace: MEMORY_VECTOR_NAMESPACE,
      model: embeddingModel,
      dimensions: embedding.length,
      version: MEMORY_VECTOR_VERSION,
      embedding,
      limit: 100,
      minScore: 1 - 1e-6,
      resourceIds: [record.personaId],
      attributes: { memoryType: record.memoryType },
    });
    const expectedRevision = sourceRevision(record.content);
    return hits.some(
      hit =>
        hit.id === record.id &&
        hit.ownerUserId === record.userId &&
        hit.resourceId === record.personaId &&
        hit.model === embeddingModel &&
        hit.dimensions === embedding.length &&
        hit.version === MEMORY_VECTOR_VERSION &&
        hit.sourceRevision === expectedRevision &&
        hit.attributes.memoryType === record.memoryType
    );
  }

  private async backfillLegacy(
    records: readonly PersonaMemoryRecord[],
    embeddingModel: string
  ): Promise<void> {
    for (const record of records) {
      if (!record.legacyEmbedding?.length) continue;
      await this.indexRecord(record, embeddingModel, record.legacyEmbedding);
    }
  }

  async storeMemory(
    userId: string,
    personaId: string,
    content: string,
    embeddingModel: string,
    context?: string,
    importanceScore?: number,
    memoryType?: MemoryType
  ): Promise<EnhancedMemoryEntry> {
    const classifiedType = memoryType || this.classifyMemoryType(content);
    const calculatedImportance = validateImportance(
      importanceScore ??
        this.calculateEnhancedImportance(content, classifiedType, context)
    );
    const normalizedContext = context || undefined;
    const embedding = await this.generateEmbedding(
      content,
      embeddingModel,
      userId
    );
    if (embedding) {
      const existing = await this.findSimilarMemories(
        userId,
        personaId,
        embedding,
        embeddingModel,
        0.85
      );
      if (existing[0]) {
        await this.reinforceMemory(existing[0].entry.id, userId, personaId);
        return existing[0].entry as EnhancedMemoryEntry;
      }
    }

    const requestedRecord: PersonaMemoryRecord = {
      id: deterministicMemoryId({
        userId,
        personaId,
        content,
        ...(normalizedContext ? { context: normalizedContext } : {}),
        importanceScore: calculatedImportance,
        memoryType: classifiedType,
      }),
      userId,
      personaId,
      content,
      timestamp: Date.now(),
      ...(normalizedContext ? { context: normalizedContext } : {}),
      importanceScore: calculatedImportance,
      memoryType: classifiedType,
      accessCount: 0,
      decayFactor: 1,
    };
    const repository = getPlatformStorageRuntime().domains.memories;
    let record = requestedRecord;
    try {
      await repository.insert(requestedRecord);
    } catch (insertError) {
      let persisted: PersonaMemoryRecord | undefined;
      try {
        persisted = await repository.findByOwner(
          requestedRecord.id,
          userId,
          personaId
        );
      } catch (resolutionError) {
        throw retainedOutcomeError(
          'Could not resolve the persona memory insert outcome; retry with the same payload',
          combinedOutcomeCause(
            'Persona memory insert and outcome resolution both failed',
            insertError,
            resolutionError
          )
        );
      }
      if (!persisted) throw insertError;
      if (!sameMemoryIntent(persisted, requestedRecord)) {
        throw retainedOutcomeError(
          'The deterministic persona memory identifier belongs to another payload',
          insertError
        );
      }
      record = persisted;
    }

    if (embedding?.length) {
      try {
        await this.indexRecord(record, embeddingModel, embedding);
      } catch (indexError) {
        let persisted: PersonaMemoryRecord | undefined;
        try {
          persisted = await repository.findByOwner(
            record.id,
            userId,
            personaId
          );
        } catch (resolutionError) {
          throw retainedOutcomeError(
            'Could not resolve the persona memory vector outcome; the relational memory was retained for idempotent retry',
            combinedOutcomeCause(
              'Persona memory vector publication and outcome resolution both failed',
              indexError,
              resolutionError
            )
          );
        }

        if (!persisted) {
          try {
            await getPlatformStorageRuntime().vectorStore.delete({
              actor: { userId },
              namespace: MEMORY_VECTOR_NAMESPACE,
              ids: [record.id],
            });
          } catch (cleanupError) {
            throw retainedOutcomeError(
              'Persona memory disappeared during indexing and vector cleanup failed',
              combinedOutcomeCause(
                'Persona memory vector publication and cleanup both failed',
                indexError,
                cleanupError
              )
            );
          }
          throw indexError;
        }
        if (!sameMemoryIntent(persisted, requestedRecord)) {
          throw retainedOutcomeError(
            'The persona memory changed while its vector outcome was being resolved',
            indexError
          );
        }

        let committed = false;
        try {
          committed = await this.hasAuthoritativeVector(
            persisted,
            embeddingModel,
            embedding
          );
        } catch (resolutionError) {
          throw retainedOutcomeError(
            'Could not resolve the persona memory vector outcome; the relational memory was retained for idempotent retry',
            combinedOutcomeCause(
              'Persona memory vector publication and outcome resolution both failed',
              indexError,
              resolutionError
            )
          );
        }
        if (!committed) {
          throw retainedOutcomeError(
            'Persona memory vector publication was not confirmed; the relational memory was retained for idempotent retry',
            indexError
          );
        }
        // The vector may have committed after its acknowledgement was lost.
        // Recheck the SQL row once more so a concurrent persona deletion still
        // wins and compensates the vector before this call reports success.
        await assertPersonaMemoryStillReferenced(
          getPlatformStorageRuntime(),
          persisted,
          MEMORY_VECTOR_NAMESPACE
        );
        record = persisted;
      }
    }
    return entryFromRecord(record);
  }

  private async findSimilarMemories(
    userId: string,
    personaId: string,
    embedding: readonly number[],
    embeddingModel: string,
    minSimilarity: number
  ): Promise<MemorySearchResult[]> {
    const repository = getPlatformStorageRuntime().domains.memories;
    const records = await repository.listByOwner(userId, personaId, {
      limit: 100,
    });
    await this.backfillLegacy(records, embeddingModel);
    const byId = new Map(records.map(record => [record.id, record]));
    const hits = await getPlatformStorageRuntime().vectorStore.query({
      actor: { userId },
      namespace: MEMORY_VECTOR_NAMESPACE,
      model: embeddingModel,
      dimensions: embedding.length,
      version: MEMORY_VECTOR_VERSION,
      embedding,
      limit: 50,
      minScore: minSimilarity,
      resourceIds: [personaId],
    });
    return hits.flatMap((hit, index) => {
      const record = byId.get(hit.id);
      return record
        ? [
            {
              entry: entryFromRecord(record),
              similarity_score: hit.score,
              relevance_rank: index + 1,
            },
          ]
        : [];
    });
  }

  async reinforceMemory(
    memoryId: string,
    userId: string,
    personaId: string
  ): Promise<boolean> {
    return getPlatformStorageRuntime().domains.memories.reinforce(
      memoryId,
      userId,
      personaId,
      Date.now()
    );
  }

  async searchMemories(
    userId: string,
    personaId: string,
    query: string,
    embeddingModel: string,
    topK = 5,
    minSimilarity = 0.3,
    memoryTypes?: MemoryType[]
  ): Promise<MemorySearchResult[]> {
    const requestedTopK = Number.isFinite(topK) ? Math.trunc(topK) : 5;
    const normalizedTopK = Math.min(Math.max(requestedTopK, 1), 100);
    const embedding = await this.generateEmbedding(
      query,
      embeddingModel,
      userId
    );
    if (!embedding) return [];
    const records =
      await getPlatformStorageRuntime().domains.memories.listByOwner(
        userId,
        personaId,
        {
          limit: 10_000,
          ...(memoryTypes?.length ? { types: memoryTypes } : {}),
        }
      );
    await this.backfillLegacy(records, embeddingModel);
    const byId = new Map(records.map(record => [record.id, record]));
    const hits = await getPlatformStorageRuntime().vectorStore.query({
      actor: { userId },
      namespace: MEMORY_VECTOR_NAMESPACE,
      model: embeddingModel,
      dimensions: embedding.length,
      version: MEMORY_VECTOR_VERSION,
      embedding,
      limit: Math.min(normalizedTopK * 10, 100),
      minScore: minSimilarity,
      resourceIds: [personaId],
    });
    const now = Date.now();
    const results = hits.flatMap(hit => {
      const record = byId.get(hit.id);
      if (!record) return [];
      const decayed = this.applyDecay(
        record.importanceScore,
        record.timestamp,
        record.accessCount,
        record.lastAccessed
      );
      const ageHours = (now - record.timestamp) / (1000 * 60 * 60);
      const recency = ageHours < 24 ? 0.1 : ageHours < 168 ? 0.05 : 0;
      return [
        {
          entry: { ...entryFromRecord(record), importance_score: decayed },
          similarity_score: hit.score,
          relevance_rank: 0,
          composite: hit.score * 0.5 + decayed * 0.25 + recency,
        },
      ];
    });
    results.sort((left, right) => right.composite - left.composite);
    const top = results.slice(0, normalizedTopK);
    await getPlatformStorageRuntime().domains.memories.markAccessed(
      top.map(item => item.entry.id),
      userId,
      personaId,
      now
    );
    return top.map(({ composite: _composite, ...result }, index) => ({
      ...result,
      relevance_rank: index + 1,
    }));
  }

  async getMemories(
    userId: string,
    personaId: string,
    limit = 100,
    offset = 0
  ): Promise<PersonaMemoryEntry[]> {
    const records =
      await getPlatformStorageRuntime().domains.memories.listByOwner(
        userId,
        personaId,
        { limit, offset }
      );
    return records.map(entryFromRecord);
  }

  async getMemoryCount(userId: string, personaId: string): Promise<number> {
    return getPlatformStorageRuntime().domains.memories.countByOwner(
      userId,
      personaId
    );
  }

  async getMemoryStatus(
    userId: string,
    personaId: string
  ): Promise<{ memory_count: number; last_backup?: number; size_mb: number }> {
    const count = await this.getMemoryCount(userId, personaId);
    return {
      memory_count: count,
      last_backup: undefined,
      size_mb: Math.round(((count * 1024) / (1024 * 1024)) * 100) / 100,
    };
  }

  async wipeMemories(userId: string, personaId: string): Promise<number> {
    await getPlatformStorageRuntime().vectorStore.delete({
      actor: { userId },
      namespace: MEMORY_VECTOR_NAMESPACE,
      resourceId: personaId,
    });
    return getPlatformStorageRuntime().domains.memories.deleteAllByOwner(
      userId,
      personaId
    );
  }

  async exportMemories(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryEntry[]> {
    return this.getMemories(userId, personaId, 10_000, 0);
  }

  async importMemories(
    memories: PersonaMemoryEntry[],
    targetUserId: string
  ): Promise<number> {
    let imported = 0;
    const repository = getPlatformStorageRuntime().domains.memories;
    for (const memory of memories) {
      const record: PersonaMemoryRecord = {
        id: memory.id,
        userId: targetUserId,
        personaId: memory.persona_id,
        content: memory.content,
        timestamp: memory.timestamp,
        ...(memory.context ? { context: memory.context } : {}),
        importanceScore: validateImportance(memory.importance_score ?? 0.5),
        memoryType: classifyMemoryType(memory.content),
        accessCount: 0,
        decayFactor: 1,
      };
      try {
        await repository.insert(record);
        if (memory.embedding?.length) {
          await this.indexRecord(record, 'legacy-import', memory.embedding);
        }
        imported += 1;
      } catch (error) {
        logger.error('Failed to import memory:', error);
      }
    }
    return imported;
  }

  async updateMemoryImportance(
    memoryId: string,
    userId: string,
    personaId: string,
    importanceScore: number
  ): Promise<boolean> {
    return getPlatformStorageRuntime().domains.memories.updateImportance(
      memoryId,
      userId,
      personaId,
      validateImportance(importanceScore)
    );
  }

  async cleanupOldMemories(
    userId: string,
    personaId: string,
    retentionDays: number
  ): Promise<number> {
    const repository = getPlatformStorageRuntime().domains.memories;
    const ids = await repository.findOldLowImportanceIds(
      userId,
      personaId,
      Date.now() - retentionDays * 24 * 60 * 60 * 1000,
      0.7
    );
    if (ids.length) {
      await getPlatformStorageRuntime().vectorStore.delete({
        actor: { userId },
        namespace: MEMORY_VECTOR_NAMESPACE,
        ids,
      });
      await repository.deleteIds(ids, userId, personaId);
    }
    return ids.length;
  }

  async consolidateMemories(
    userId: string,
    personaId: string,
    embeddingModel: string,
    similarityThreshold = 0.8
  ): Promise<{ consolidated: number; deleted: number }> {
    const repository = getPlatformStorageRuntime().domains.memories;
    const records = await repository.listByOwner(userId, personaId, {
      limit: 10_000,
    });
    const remaining = new Map(records.map(record => [record.id, record]));
    let consolidated = 0;
    let deleted = 0;
    for (const record of records) {
      if (!remaining.has(record.id)) continue;
      const embedding = await this.generateEmbedding(
        record.content,
        embeddingModel,
        userId
      );
      if (!embedding) continue;
      await this.indexRecord(record, embeddingModel, embedding);
      const similar = await this.findSimilarMemories(
        userId,
        personaId,
        embedding,
        embeddingModel,
        similarityThreshold
      );
      const matches = similar
        .map(item => remaining.get(item.entry.id))
        .filter((item): item is PersonaMemoryRecord =>
          Boolean(item && item.id !== record.id)
        );
      if (matches.length === 0) continue;
      const group = [record, ...matches];
      const content = createConsolidatedContent(
        group.map(item => item.content)
      );
      const importance = Math.min(
        1,
        (group.reduce((sum, item) => sum + item.importanceScore, 0) /
          group.length) *
          1.1
      );
      const combinedEmbedding = await this.generateEmbedding(
        content,
        embeddingModel,
        userId
      );
      const combinedRecord: PersonaMemoryRecord = {
        id: randomUUID(),
        userId,
        personaId,
        content,
        timestamp: Date.now(),
        context: `Consolidated from ${group.length} memories`,
        importanceScore: importance,
        memoryType: record.memoryType,
        accessCount: 0,
        decayFactor: 1,
        consolidatedFrom: group.map(item => item.id),
      };
      await repository.insert(combinedRecord);
      try {
        await this.indexRecord(
          combinedRecord,
          embeddingModel,
          combinedEmbedding || undefined
        );
      } catch (error) {
        await repository.deleteIds([combinedRecord.id], userId, personaId);
        throw error;
      }
      const ids = group.map(item => item.id);
      await getPlatformStorageRuntime().vectorStore.delete({
        actor: { userId },
        namespace: MEMORY_VECTOR_NAMESPACE,
        ids,
      });
      await repository.deleteIds(ids, userId, personaId);
      for (const id of ids) remaining.delete(id);
      remaining.set(combinedRecord.id, combinedRecord);
      consolidated += 1;
      deleted += ids.length;
    }
    return { consolidated, deleted };
  }

  async getMemoryStats(
    userId: string,
    personaId: string
  ): Promise<{
    total_count: number;
    by_type: Record<string, number>;
    avg_importance: number;
    oldest_memory: number | null;
    newest_memory: number | null;
    total_accesses: number;
  }> {
    const stats = await getPlatformStorageRuntime().domains.memories.statistics(
      userId,
      personaId
    );
    return {
      total_count: stats.totalCount,
      by_type: stats.byType,
      avg_importance: stats.averageImportance,
      oldest_memory: stats.oldestMemory,
      newest_memory: stats.newestMemory,
      total_accesses: stats.totalAccesses,
    };
  }

  async applyGlobalDecay(userId: string, personaId: string): Promise<number> {
    const repository = getPlatformStorageRuntime().domains.memories;
    const records = await repository.listByOwner(userId, personaId, {
      limit: 10_000,
    });
    let updated = 0;
    for (const record of records) {
      const importance = this.applyDecay(
        record.importanceScore,
        record.timestamp,
        record.accessCount,
        record.lastAccessed
      );
      if (Math.abs(importance - record.importanceScore) <= 0.01) continue;
      await repository.updateImportance(
        record.id,
        userId,
        personaId,
        importance,
        record.importanceScore === 0 ? 1 : importance / record.importanceScore
      );
      updated += 1;
    }
    return updated;
  }

  async getCoreMemories(
    userId: string,
    personaId: string,
    limit = 5
  ): Promise<PersonaMemoryEntry[]> {
    const records =
      await getPlatformStorageRuntime().domains.memories.listByOwner(
        userId,
        personaId,
        {
          limit: Math.min(Math.max(limit, 1), 100),
          types: ['fact', 'preference', 'instruction'],
          minimumImportance: 0.7,
        }
      );
    return records
      .sort(
        (left, right) =>
          right.importanceScore - left.importanceScore ||
          right.accessCount - left.accessCount
      )
      .slice(0, limit)
      .map(entryFromRecord);
  }
}

export const memoryService = new MemoryService();
