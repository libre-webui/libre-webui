/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { getDatabaseSafe } from '../db.js';
import type { DatabaseAdapter } from '../database/types.js';
import ollamaService from './ollamaService.js';
import {
  PersonaMemoryEntry,
  MemorySearchResult,
  EmbeddingModel,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export type MemoryType =
  | 'fact'
  | 'preference'
  | 'experience'
  | 'emotional'
  | 'context'
  | 'instruction'
  | 'general';

export interface EnhancedMemoryEntry extends PersonaMemoryEntry {
  memory_type?: MemoryType;
  access_count?: number;
  last_accessed?: number;
  decay_factor?: number;
  consolidated_from?: string[];
}

export class MemoryService {
  private embeddingModels: EmbeddingModel[] = [
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
      description: "OpenAI's smaller, faster text embedding model",
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

  private getDb(): DatabaseAdapter | null {
    return getDatabaseSafe();
  }

  private ensureDatabase(): DatabaseAdapter {
    const db = this.getDb();
    if (!db) throw new Error('Database not available');
    return db;
  }

  classifyMemoryType(content: string): MemoryType {
    const lowerContent = content.toLowerCase();
    if (
      [
        /i (like|love|prefer|enjoy|hate|dislike|don't like)/i,
        /my favorite/i,
        /i('m| am) (a fan of|into|interested in)/i,
      ].some(p => p.test(lowerContent))
    )
      return 'preference';
    if (
      [
        /i (am|'m) (a |an )?(\w+ )?(developer|engineer|designer|student|teacher|doctor|lawyer)/i,
        /i (work|live|study) (at|in|for)/i,
        /my (name|job|profession|age|location|birthday)/i,
        /i have (a |an )?(\d+ )?(kids?|children|dogs?|cats?|pets?)/i,
      ].some(p => p.test(lowerContent))
    )
      return 'fact';
    if (
      [
        /i('m| am) (feeling|so|really|very) (happy|sad|excited|anxious|worried|stressed|grateful)/i,
        /thank you|thanks|appreciate/i,
        /i('m| am) (sorry|apologize)/i,
        /(love|hate) (this|that|it)/i,
      ].some(p => p.test(lowerContent))
    )
      return 'emotional';
    if (
      [
        /please (always|never|remember|don't|do not)/i,
        /i want you to/i,
        /can you (please )?make sure/i,
        /when (i ask|responding|you)/i,
      ].some(p => p.test(lowerContent))
    )
      return 'instruction';
    if (
      [
        /i (went|did|saw|visited|attended|met|had)/i,
        /yesterday|last (week|month|year)|recently/i,
        /one time|once upon a time|i remember when/i,
      ].some(p => p.test(lowerContent))
    )
      return 'experience';
    return 'general';
  }

  calculateEnhancedImportance(
    content: string,
    memoryType: MemoryType,
    _context?: string
  ): number {
    const typeWeights: Record<MemoryType, number> = {
      instruction: 0.9,
      fact: 0.8,
      preference: 0.75,
      emotional: 0.7,
      experience: 0.6,
      context: 0.4,
      general: 0.5,
    };
    let score = typeWeights[memoryType];
    const wordCount = content.split(/\s+/).length;
    if (wordCount > 50) score = Math.min(1.0, score + 0.1);
    else if (wordCount < 10) score = Math.max(0.1, score - 0.1);
    const specificityCount = [
      /\b\d{4}\b/,
      /\b\d{1,2}\/\d{1,2}\b/,
      /\b[A-Z][a-z]+\b/,
      /\b\d+\s*(years?|months?|days?|hours?)\b/i,
    ].filter(p => p.test(content)).length;
    score = Math.min(1.0, score + specificityCount * 0.05);
    if (content.includes('?')) score = Math.min(1.0, score + 0.05);
    return Math.max(0.1, Math.min(1.0, score));
  }

  applyDecay(
    originalImportance: number,
    timestamp: number,
    accessCount = 0,
    lastAccessed?: number
  ): number {
    const now = Date.now();
    const ageInDays = (now - timestamp) / (1000 * 60 * 60 * 24);
    const timeSinceAccess = lastAccessed
      ? (now - lastAccessed) / (1000 * 60 * 60 * 24)
      : ageInDays;
    let decayedImportance =
      originalImportance * Math.exp(-0.003 * timeSinceAccess);
    decayedImportance = Math.min(
      1.0,
      decayedImportance + Math.min(0.3, accessCount * 0.02)
    );
    if (ageInDays < 7) decayedImportance = Math.max(0.3, decayedImportance);
    return Math.max(0.1, Math.min(1.0, decayedImportance));
  }

  getEmbeddingModels(): EmbeddingModel[] {
    return this.embeddingModels;
  }

  private async generateEmbedding(
    text: string,
    model: string
  ): Promise<number[] | null> {
    try {
      const response = await ollamaService.generateEmbeddings({
        model,
        input: text,
      });
      return response.embeddings[0] || null;
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      return null;
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
    const id = uuidv4();
    const timestamp = Date.now();
    const classifiedType = memoryType || this.classifyMemoryType(content);
    const calculatedImportance =
      importanceScore ??
      this.calculateEnhancedImportance(content, classifiedType, context);

    const existingSimilar = await this.findSimilarMemories(
      userId,
      personaId,
      content,
      embeddingModel,
      0.85
    );
    if (existingSimilar.length > 0) {
      const mostSimilar = existingSimilar[0];
      console.log(
        `[MEMORY] Found similar memory (${(mostSimilar.similarity_score * 100).toFixed(1)}% similar), reinforcing instead of creating new`
      );
      await this.reinforceMemory(mostSimilar.entry.id);
      return mostSimilar.entry as EnhancedMemoryEntry;
    }

    const embedding = await this.generateEmbedding(content, embeddingModel);
    const db = this.ensureDatabase();

    await db.run(
      `INSERT INTO persona_memories (id, user_id, persona_id, content, embedding, timestamp, context, importance_score, memory_type, access_count, last_accessed, decay_factor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      userId,
      personaId,
      content,
      embedding ? Buffer.from(new Float32Array(embedding).buffer) : null,
      timestamp,
      context || null,
      calculatedImportance,
      classifiedType,
      0,
      null,
      1.0
    );

    console.log(
      `[MEMORY] Stored: type=${classifiedType}, importance=${calculatedImportance.toFixed(2)}, id=${id}, content="${content.substring(0, 50)}..."`
    );

    return {
      id,
      user_id: userId,
      persona_id: personaId,
      content,
      embedding: embedding || undefined,
      timestamp,
      context,
      importance_score: calculatedImportance,
      memory_type: classifiedType,
      access_count: 0,
      decay_factor: 1.0,
    };
  }

  private async findSimilarMemories(
    userId: string,
    personaId: string,
    content: string,
    embeddingModel: string,
    minSimilarity: number
  ): Promise<MemorySearchResult[]> {
    const queryEmbedding = await this.generateEmbedding(
      content,
      embeddingModel
    );
    if (!queryEmbedding) return [];

    const db = this.ensureDatabase();
    const memories = await db.all<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer;
      timestamp: number;
      context: string | null;
      importance_score: number;
    }>(
      `SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score
       FROM persona_memories WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
       ORDER BY timestamp DESC LIMIT 50`,
      userId,
      personaId
    );

    const results: MemorySearchResult[] = [];
    for (const memory of memories) {
      const embeddingArray = Array.from(
        new Float32Array(memory.embedding.buffer)
      );
      const similarity = this.cosineSimilarity(queryEmbedding, embeddingArray);
      if (similarity >= minSimilarity) {
        results.push({
          entry: {
            id: memory.id,
            user_id: memory.user_id,
            persona_id: memory.persona_id,
            content: memory.content,
            embedding: embeddingArray,
            timestamp: memory.timestamp,
            context: memory.context || undefined,
            importance_score: memory.importance_score,
          },
          similarity_score: similarity,
          relevance_rank: 0,
        });
      }
    }
    return results.sort((a, b) => b.similarity_score - a.similarity_score);
  }

  async reinforceMemory(memoryId: string): Promise<boolean> {
    const db = this.ensureDatabase();
    const result = await db.run(
      `UPDATE persona_memories SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ?, importance_score = MIN(1.0, COALESCE(importance_score, 0.5) + 0.05) WHERE id = ?`,
      Date.now(),
      memoryId
    );
    return result.changes > 0;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dotProduct = 0,
      normA = 0,
      normB = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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
    const queryEmbedding = await this.generateEmbedding(query, embeddingModel);
    if (!queryEmbedding) return [];

    const db = this.ensureDatabase();
    let sql = `SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score, memory_type, access_count, last_accessed, decay_factor
       FROM persona_memories WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL`;

    const params: unknown[] = [userId, personaId];
    if (memoryTypes && memoryTypes.length > 0) {
      sql += ` AND memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
      params.push(...memoryTypes);
    }
    sql += ' ORDER BY timestamp DESC';

    const memories = await db.all<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer;
      timestamp: number;
      context: string | null;
      importance_score: number;
      memory_type: string | null;
      access_count: number | null;
      last_accessed: number | null;
      decay_factor: number | null;
    }>(sql, ...params);

    const results: MemorySearchResult[] = [];
    for (const memory of memories) {
      const embeddingArray = Array.from(
        new Float32Array(memory.embedding.buffer)
      );
      const similarity = this.cosineSimilarity(queryEmbedding, embeddingArray);
      if (similarity >= minSimilarity) {
        const decayedImportance = this.applyDecay(
          memory.importance_score,
          memory.timestamp,
          memory.access_count || 0,
          memory.last_accessed || undefined
        );
        results.push({
          entry: {
            id: memory.id,
            user_id: memory.user_id,
            persona_id: memory.persona_id,
            content: memory.content,
            embedding: embeddingArray,
            timestamp: memory.timestamp,
            context: memory.context || undefined,
            importance_score: decayedImportance,
          },
          similarity_score: similarity,
          relevance_rank: 0,
        });
      }
    }

    results.sort((a, b) => {
      const now = Date.now();
      const ageA = (now - a.entry.timestamp) / (1000 * 60 * 60);
      const ageB = (now - b.entry.timestamp) / (1000 * 60 * 60);
      const recencyA = ageA < 24 ? 0.1 : ageA < 168 ? 0.05 : 0;
      const recencyB = ageB < 24 ? 0.1 : ageB < 168 ? 0.05 : 0;
      const scoreA =
        a.similarity_score * 0.5 +
        (a.entry.importance_score || 0.5) * 0.25 +
        recencyA;
      const scoreB =
        b.similarity_score * 0.5 +
        (b.entry.importance_score || 0.5) * 0.25 +
        recencyB;
      return scoreB - scoreA;
    });

    const topResults = results.slice(0, topK);
    for (const result of topResults)
      await this.updateMemoryAccess(result.entry.id);
    return topResults.map((result, index) => ({
      ...result,
      relevance_rank: index + 1,
    }));
  }

  private async updateMemoryAccess(memoryId: string): Promise<void> {
    try {
      const db = this.ensureDatabase();
      await db.run(
        'UPDATE persona_memories SET access_count = COALESCE(access_count, 0) + 1, last_accessed = ? WHERE id = ?',
        Date.now(),
        memoryId
      );
    } catch (error) {
      console.warn('[MemoryService] Failed to update memory access:', error);
    }
  }

  async getMemories(
    userId: string,
    personaId: string,
    limit = 100,
    offset = 0
  ): Promise<PersonaMemoryEntry[]> {
    const db = this.ensureDatabase();
    const memories = await db.all<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer | null;
      timestamp: number;
      context: string | null;
      importance_score: number;
    }>(
      `SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score
       FROM persona_memories WHERE user_id = ? AND persona_id = ? ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
      userId,
      personaId,
      limit,
      offset
    );
    return memories.map(memory => ({
      id: memory.id,
      user_id: memory.user_id,
      persona_id: memory.persona_id,
      content: memory.content,
      embedding: memory.embedding
        ? Array.from(new Float32Array(memory.embedding.buffer))
        : undefined,
      timestamp: memory.timestamp,
      context: memory.context || undefined,
      importance_score: memory.importance_score,
    }));
  }

  async getMemoryCount(userId: string, personaId: string): Promise<number> {
    const db = this.ensureDatabase();
    const result = await db.get<{ count: number }>(
      'SELECT COUNT(*) as count FROM persona_memories WHERE user_id = ? AND persona_id = ?',
      userId,
      personaId
    );
    return result?.count ?? 0;
  }

  async getMemoryStatus(
    userId: string,
    personaId: string
  ): Promise<{ memory_count: number; last_backup?: number; size_mb: number }> {
    const memoryCount = await this.getMemoryCount(userId, personaId);
    const sizeMb = (memoryCount * 1024) / (1024 * 1024);
    return {
      memory_count: memoryCount,
      last_backup: undefined,
      size_mb: Math.round(sizeMb * 100) / 100,
    };
  }

  async wipeMemories(userId: string, personaId: string): Promise<number> {
    const db = this.ensureDatabase();
    const result = await db.run(
      'DELETE FROM persona_memories WHERE user_id = ? AND persona_id = ?',
      userId,
      personaId
    );
    return result.changes;
  }

  async exportMemories(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryEntry[]> {
    return this.getMemories(userId, personaId, 10000);
  }

  async importMemories(
    memories: PersonaMemoryEntry[],
    targetUserId: string
  ): Promise<number> {
    let imported = 0;
    const db = this.ensureDatabase();
    for (const memory of memories) {
      try {
        await db.run(
          `INSERT INTO persona_memories (id, user_id, persona_id, content, embedding, timestamp, context, importance_score)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          memory.id,
          targetUserId,
          memory.persona_id,
          memory.content,
          memory.embedding
            ? Buffer.from(new Float32Array(memory.embedding).buffer)
            : null,
          memory.timestamp,
          memory.context || null,
          memory.importance_score || 0.5
        );
        imported++;
      } catch (error) {
        console.error('Failed to import memory:', error);
      }
    }
    return imported;
  }

  async updateMemoryImportance(
    memoryId: string,
    importanceScore: number
  ): Promise<boolean> {
    const db = this.ensureDatabase();
    const result = await db.run(
      'UPDATE persona_memories SET importance_score = ? WHERE id = ?',
      importanceScore,
      memoryId
    );
    return result.changes > 0;
  }

  async cleanupOldMemories(
    userId: string,
    personaId: string,
    retentionDays: number
  ): Promise<number> {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const db = this.ensureDatabase();
    const result = await db.run(
      'DELETE FROM persona_memories WHERE user_id = ? AND persona_id = ? AND timestamp < ? AND importance_score < 0.7',
      userId,
      personaId,
      cutoff
    );
    return result.changes;
  }

  async consolidateMemories(
    userId: string,
    personaId: string,
    embeddingModel: string,
    similarityThreshold = 0.8
  ): Promise<{ consolidated: number; deleted: number }> {
    const db = this.ensureDatabase();
    let consolidated = 0;
    let deleted = 0;

    try {
      const memories = await db.all<{
        id: string;
        content: string;
        embedding: Buffer;
        timestamp: number;
        importance_score: number;
        memory_type: string | null;
        access_count: number | null;
      }>(
        `SELECT id, content, embedding, timestamp, importance_score, memory_type, access_count
         FROM persona_memories WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
         ORDER BY importance_score DESC, timestamp DESC`,
        userId,
        personaId
      );

      const processedIds = new Set<string>();
      const toDelete: string[] = [];

      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i];
        if (processedIds.has(memory.id)) continue;
        const embeddingA = Array.from(
          new Float32Array(memory.embedding.buffer)
        );
        const similarMemories: typeof memories = [];

        for (let j = i + 1; j < memories.length; j++) {
          const other = memories[j];
          if (processedIds.has(other.id)) continue;
          const embeddingB = Array.from(
            new Float32Array(other.embedding.buffer)
          );
          if (
            this.cosineSimilarity(embeddingA, embeddingB) >= similarityThreshold
          ) {
            similarMemories.push(other);
            processedIds.add(other.id);
          }
        }

        if (similarMemories.length > 0) {
          processedIds.add(memory.id);
          const allContent = [
            memory.content,
            ...similarMemories.map(m => m.content),
          ];
          const consolidatedContent =
            allContent.length === 1
              ? allContent[0]
              : allContent.length === 2
                ? allContent.sort((a, b) => b.length - a.length)[0]
                : `${allContent.sort((a, b) => b.length - a.length)[0]} (consolidated from ${allContent.length} related interactions)`;

          const allImportances = [
            memory.importance_score,
            ...similarMemories.map(m => m.importance_score),
          ];
          const consolidatedImportance = Math.min(
            1.0,
            (allImportances.reduce((a, b) => a + b, 0) /
              allImportances.length) *
              1.1
          );

          const types = [
            memory.memory_type,
            ...similarMemories.map(m => m.memory_type),
          ].filter(Boolean);
          const typeCount: Record<string, number> = {};
          types.forEach(t => {
            if (t) typeCount[t] = (typeCount[t] || 0) + 1;
          });
          const consolidatedType =
            Object.entries(typeCount).sort((a, b) => b[1] - a[1])[0]?.[0] ||
            'general';

          const newEmbedding = await this.generateEmbedding(
            consolidatedContent,
            embeddingModel
          );
          const consolidatedFromIds = [
            memory.id,
            ...similarMemories.map(m => m.id),
          ];

          await db.run(
            `INSERT INTO persona_memories (id, user_id, persona_id, content, embedding, timestamp, context, importance_score, memory_type, access_count, last_accessed, decay_factor, consolidated_from)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uuidv4(),
            userId,
            personaId,
            consolidatedContent,
            newEmbedding
              ? Buffer.from(new Float32Array(newEmbedding).buffer)
              : null,
            Date.now(),
            `Consolidated from ${consolidatedFromIds.length} memories`,
            consolidatedImportance,
            consolidatedType,
            similarMemories.reduce(
              (sum, m) => sum + (m.access_count || 0),
              memory.access_count || 0
            ),
            Date.now(),
            1.0,
            JSON.stringify(consolidatedFromIds)
          );

          toDelete.push(...consolidatedFromIds);
          consolidated++;
        }
      }

      if (toDelete.length > 0) {
        for (const id of toDelete) {
          await db.run('DELETE FROM persona_memories WHERE id = ?', id);
        }
        deleted = toDelete.length;
      }

      console.log(
        `[MEMORY] Consolidation complete: ${consolidated} groups merged, ${deleted} memories deleted`
      );
    } catch (error) {
      console.error('[MEMORY] Consolidation error:', error);
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
    const db = this.ensureDatabase();
    const typeCounts = await db.all<{
      memory_type: string | null;
      count: number;
    }>(
      'SELECT memory_type, COUNT(*) as count FROM persona_memories WHERE user_id = ? AND persona_id = ? GROUP BY memory_type',
      userId,
      personaId
    );
    const stats = await db.get<{
      total_count: number;
      avg_importance: number | null;
      oldest_memory: number | null;
      newest_memory: number | null;
      total_accesses: number | null;
    }>(
      `SELECT COUNT(*) as total_count, AVG(importance_score) as avg_importance,
              MIN(timestamp) as oldest_memory, MAX(timestamp) as newest_memory,
              SUM(COALESCE(access_count, 0)) as total_accesses
       FROM persona_memories WHERE user_id = ? AND persona_id = ?`,
      userId,
      personaId
    );
    const byType: Record<string, number> = {};
    typeCounts.forEach(({ memory_type, count }) => {
      byType[memory_type || 'general'] = count;
    });
    return {
      total_count: stats?.total_count ?? 0,
      by_type: byType,
      avg_importance: stats?.avg_importance ?? 0.5,
      oldest_memory: stats?.oldest_memory ?? null,
      newest_memory: stats?.newest_memory ?? null,
      total_accesses: stats?.total_accesses ?? 0,
    };
  }

  async applyGlobalDecay(userId: string, personaId: string): Promise<number> {
    const db = this.ensureDatabase();
    const memories = await db.all<{
      id: string;
      importance_score: number;
      timestamp: number;
      access_count: number | null;
      last_accessed: number | null;
    }>(
      'SELECT id, importance_score, timestamp, access_count, last_accessed FROM persona_memories WHERE user_id = ? AND persona_id = ?',
      userId,
      personaId
    );

    let updated = 0;
    for (const memory of memories) {
      const newImportance = this.applyDecay(
        memory.importance_score,
        memory.timestamp,
        memory.access_count || 0,
        memory.last_accessed || undefined
      );
      if (Math.abs(newImportance - memory.importance_score) > 0.01) {
        await db.run(
          'UPDATE persona_memories SET importance_score = ?, decay_factor = ? WHERE id = ?',
          newImportance,
          newImportance / memory.importance_score,
          memory.id
        );
        updated++;
      }
    }
    console.log(`[MEMORY] Applied decay to ${updated} memories`);
    return updated;
  }

  async getCoreMemories(
    userId: string,
    personaId: string,
    limit = 5
  ): Promise<PersonaMemoryEntry[]> {
    const db = this.ensureDatabase();
    const memories = await db.all<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer | null;
      timestamp: number;
      context: string | null;
      importance_score: number;
    }>(
      `SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score
       FROM persona_memories WHERE user_id = ? AND persona_id = ?
       AND memory_type IN ('fact', 'preference', 'instruction') AND importance_score >= 0.7
       ORDER BY importance_score DESC, access_count DESC LIMIT ?`,
      userId,
      personaId,
      limit
    );
    return memories.map(memory => ({
      id: memory.id,
      user_id: memory.user_id,
      persona_id: memory.persona_id,
      content: memory.content,
      embedding: memory.embedding
        ? Array.from(new Float32Array(memory.embedding.buffer))
        : undefined,
      timestamp: memory.timestamp,
      context: memory.context || undefined,
      importance_score: memory.importance_score,
    }));
  }
}

export const memoryService = new MemoryService();
