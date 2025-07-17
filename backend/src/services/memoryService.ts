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
import ollamaService from './ollamaService.js';
import {
  PersonaMemoryEntry,
  MemorySearchResult,
  EmbeddingModel,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export class MemoryService {
  private db = getDatabaseSafe();
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

  constructor() {
    this.initializeTables();
  }

  /**
   * Ensure database is available
   */
  private ensureDatabase() {
    if (!this.db) {
      throw new Error('Database not available');
    }
    return this.db;
  }

  private initializeTables(): void {
    if (!this.db) {
      console.warn(
        'MemoryService: Database not available, skipping table initialization'
      );
      return;
    }

    // Persona memories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_memories (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        persona_id TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding BLOB, -- Stored as binary for efficiency
        timestamp INTEGER NOT NULL,
        context TEXT,
        importance_score REAL DEFAULT 0.5,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
      )
    `);

    // Create indexes for efficient querying
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_persona_memories_user_persona ON persona_memories(user_id, persona_id);
      CREATE INDEX IF NOT EXISTS idx_persona_memories_timestamp ON persona_memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_persona_memories_importance ON persona_memories(importance_score);
    `);
  }

  /**
   * Get available embedding models
   */
  getEmbeddingModels(): EmbeddingModel[] {
    return this.embeddingModels;
  }

  /**
   * Generate embedding for text using specified model
   */
  private async generateEmbedding(
    text: string,
    model: string
  ): Promise<number[] | null> {
    try {
      // For now, use Ollama for embedding generation
      // TODO: Add support for other providers (OpenAI, Sentence Transformers, etc.)
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

  /**
   * Store a memory entry with embedding
   */
  async storeMemory(
    userId: string,
    personaId: string,
    content: string,
    embeddingModel: string,
    context?: string,
    importanceScore = 0.5
  ): Promise<PersonaMemoryEntry> {
    const id = uuidv4();
    const timestamp = Date.now();

    // Generate embedding
    const embedding = await this.generateEmbedding(content, embeddingModel);

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO persona_memories (
        id, user_id, persona_id, content, embedding, timestamp, context, importance_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userId,
      personaId,
      content,
      embedding ? Buffer.from(new Float32Array(embedding).buffer) : null,
      timestamp,
      context || null,
      importanceScore
    );

    console.log(
      `[MEMORY-DEBUG] Memory stored successfully - id: ${id}, userId: ${userId}, personaId: ${personaId}, content: "${content.substring(0, 100)}..."`
    );

    return {
      id,
      user_id: userId,
      persona_id: personaId,
      content,
      embedding: embedding || undefined,
      timestamp,
      context,
      importance_score: importanceScore,
    };
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Search memories using semantic similarity
   */
  async searchMemories(
    userId: string,
    personaId: string,
    query: string,
    embeddingModel: string,
    topK = 5,
    minSimilarity = 0.3
  ): Promise<MemorySearchResult[]> {
    // Generate embedding for query
    const queryEmbedding = await this.generateEmbedding(query, embeddingModel);
    if (!queryEmbedding) {
      return [];
    }

    // Get all memories for this user/persona with embeddings
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
      ORDER BY timestamp DESC
    `);

    const memories = stmt.all(userId, personaId) as Array<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer;
      timestamp: number;
      context: string | null;
      importance_score: number;
    }>;

    // Calculate similarities
    const results: MemorySearchResult[] = [];

    for (const memory of memories) {
      // Convert buffer back to float array
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
          relevance_rank: 0, // Will be set after sorting
        });
      }
    }

    // Sort by similarity and importance
    results.sort((a, b) => {
      const scoreA =
        a.similarity_score * 0.7 + (a.entry.importance_score || 0.5) * 0.3;
      const scoreB =
        b.similarity_score * 0.7 + (b.entry.importance_score || 0.5) * 0.3;
      return scoreB - scoreA;
    });

    // Set relevance ranks and return top-k
    return results.slice(0, topK).map((result, index) => ({
      ...result,
      relevance_rank: index + 1,
    }));
  }

  /**
   * Get all memories for a persona
   */
  async getMemories(
    userId: string,
    personaId: string,
    limit = 100,
    offset = 0
  ): Promise<PersonaMemoryEntry[]> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);

    const memories = stmt.all(userId, personaId, limit, offset) as Array<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer | null;
      timestamp: number;
      context: string | null;
      importance_score: number;
    }>;

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

  /**
   * Get memory count for a persona
   */
  async getMemoryCount(userId: string, personaId: string): Promise<number> {
    console.log(
      `[MEMORY-DEBUG] getMemoryCount called - userId: ${userId}, personaId: ${personaId}`
    );

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT COUNT(*) as count
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
    `);

    const result = stmt.get(userId, personaId) as { count: number };
    console.log(`[MEMORY-DEBUG] Query result:`, result);
    console.log(`[MEMORY-DEBUG] Memory count: ${result.count}`);

    return result.count;
  }

  /**
   * Get memory status for a persona
   */
  async getMemoryStatus(
    personaId: string,
    userId: string
  ): Promise<{
    memory_count: number;
    last_backup?: number;
    size_mb: number;
  }> {
    try {
      const memoryCount = await this.getMemoryCount(userId, personaId);

      // Calculate approximate memory size (rough estimate)
      const avgMemorySize = 1024; // Average bytes per memory entry
      const sizeMb = (memoryCount * avgMemorySize) / (1024 * 1024);

      return {
        memory_count: memoryCount,
        last_backup: undefined, // Could be implemented later
        size_mb: Math.round(sizeMb * 100) / 100, // Round to 2 decimal places
      };
    } catch (error) {
      console.error('Error getting memory status:', error);
      throw new Error('Failed to get memory status');
    }
  }

  /**
   * Delete all memories for a persona (wipe)
   */
  async wipeMemories(userId: string, personaId: string): Promise<number> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      DELETE FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
    `);

    const result = stmt.run(userId, personaId);
    return result.changes;
  }

  /**
   * Export memories for backup
   */
  async exportMemories(
    userId: string,
    personaId: string
  ): Promise<PersonaMemoryEntry[]> {
    return this.getMemories(userId, personaId, 10000); // Export all
  }

  /**
   * Import memories from backup
   */
  async importMemories(
    memories: PersonaMemoryEntry[],
    targetUserId: string
  ): Promise<number> {
    let imported = 0;

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO persona_memories (
        id, user_id, persona_id, content, embedding, timestamp, context, importance_score
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const memory of memories) {
      try {
        stmt.run(
          memory.id,
          targetUserId, // Use target user ID
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
        // Continue with next memory
      }
    }

    return imported;
  }

  /**
   * Update memory importance score
   */
  async updateMemoryImportance(
    memoryId: string,
    importanceScore: number
  ): Promise<boolean> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      UPDATE persona_memories
      SET importance_score = ?
      WHERE id = ?
    `);

    const result = stmt.run(importanceScore, memoryId);
    return result.changes > 0;
  }

  /**
   * Delete old memories based on retention policy
   */
  async cleanupOldMemories(
    userId: string,
    personaId: string,
    retentionDays: number
  ): Promise<number> {
    const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      DELETE FROM persona_memories
      WHERE user_id = ? AND persona_id = ? AND timestamp < ?
      AND importance_score < 0.7
    `);

    const result = stmt.run(userId, personaId, cutoffTimestamp);
    return result.changes;
  }
}

export const memoryService = new MemoryService();
