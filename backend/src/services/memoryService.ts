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

// Memory types for categorization
export type MemoryType =
  | 'fact' // Factual information about the user
  | 'preference' // User preferences and likes/dislikes
  | 'experience' // Shared experiences or stories
  | 'emotional' // Emotional moments or sentiments
  | 'context' // Conversation context
  | 'instruction' // User instructions or requests
  | 'general'; // General conversation

// Extended memory entry with additional fields
export interface EnhancedMemoryEntry extends PersonaMemoryEntry {
  memory_type?: MemoryType;
  access_count?: number;
  last_accessed?: number;
  decay_factor?: number;
  consolidated_from?: string[]; // IDs of memories this was consolidated from
}

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

    // Persona memories table - create with basic schema first
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

    // Create basic indexes first (on columns that always exist)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_persona_memories_user_persona ON persona_memories(user_id, persona_id);
      CREATE INDEX IF NOT EXISTS idx_persona_memories_timestamp ON persona_memories(timestamp);
      CREATE INDEX IF NOT EXISTS idx_persona_memories_importance ON persona_memories(importance_score);
    `);

    // Add new columns if they don't exist (migration for existing databases)
    // This MUST happen before creating indexes on new columns
    this.migrateDatabase();

    // Now create indexes on the new columns (after migration ensures they exist)
    try {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_persona_memories_type ON persona_memories(memory_type);
        CREATE INDEX IF NOT EXISTS idx_persona_memories_last_accessed ON persona_memories(last_accessed);
      `);
    } catch (error) {
      // Indexes may already exist, ignore
      console.warn('[MemoryService] Index creation:', error);
    }
  }

  /**
   * Migrate database to add new columns for existing tables
   */
  private migrateDatabase(): void {
    if (!this.db) return;

    try {
      // Check if new columns exist and add them if not
      const columns = [
        'memory_type',
        'access_count',
        'last_accessed',
        'decay_factor',
        'consolidated_from',
      ];
      const defaults: Record<string, string> = {
        memory_type: "'general'",
        access_count: '0',
        last_accessed: 'NULL',
        decay_factor: '1.0',
        consolidated_from: 'NULL',
      };

      for (const column of columns) {
        try {
          this.db.exec(
            `ALTER TABLE persona_memories ADD COLUMN ${column} ${this.getColumnType(column)} DEFAULT ${defaults[column]}`
          );
          console.log(
            `[MemoryService] Added column ${column} to persona_memories`
          );
        } catch {
          // Column likely already exists, ignore
        }
      }
    } catch (error) {
      console.warn('[MemoryService] Migration check:', error);
    }
  }

  /**
   * Get SQLite column type for a given column name
   */
  private getColumnType(column: string): string {
    const types: Record<string, string> = {
      memory_type: 'TEXT',
      access_count: 'INTEGER',
      last_accessed: 'INTEGER',
      decay_factor: 'REAL',
      consolidated_from: 'TEXT',
    };
    return types[column] || 'TEXT';
  }

  /**
   * Classify memory content into a type
   */
  classifyMemoryType(content: string): MemoryType {
    const lowerContent = content.toLowerCase();

    // Check for preference indicators
    const preferencePatterns = [
      /i (like|love|prefer|enjoy|hate|dislike|don't like)/i,
      /my favorite/i,
      /i('m| am) (a fan of|into|interested in)/i,
    ];
    if (preferencePatterns.some(p => p.test(lowerContent))) {
      return 'preference';
    }

    // Check for factual information about the user
    const factPatterns = [
      /i (am|'m) (a |an )?(\w+ )?(developer|engineer|designer|student|teacher|doctor|lawyer)/i,
      /i (work|live|study) (at|in|for)/i,
      /my (name|job|profession|age|location|birthday)/i,
      /i have (a |an )?(\d+ )?(kids?|children|dogs?|cats?|pets?)/i,
    ];
    if (factPatterns.some(p => p.test(lowerContent))) {
      return 'fact';
    }

    // Check for emotional content
    const emotionalPatterns = [
      /i('m| am) (feeling|so|really|very) (happy|sad|excited|anxious|worried|stressed|grateful)/i,
      /thank you|thanks|appreciate/i,
      /i('m| am) (sorry|apologize)/i,
      /(love|hate) (this|that|it)/i,
    ];
    if (emotionalPatterns.some(p => p.test(lowerContent))) {
      return 'emotional';
    }

    // Check for instructions
    const instructionPatterns = [
      /please (always|never|remember|don't|do not)/i,
      /i want you to/i,
      /can you (please )?make sure/i,
      /when (i ask|responding|you)/i,
    ];
    if (instructionPatterns.some(p => p.test(lowerContent))) {
      return 'instruction';
    }

    // Check for experiences/stories
    const experiencePatterns = [
      /i (went|did|saw|visited|attended|met|had)/i,
      /yesterday|last (week|month|year)|recently/i,
      /one time|once upon a time|i remember when/i,
    ];
    if (experiencePatterns.some(p => p.test(lowerContent))) {
      return 'experience';
    }

    return 'general';
  }

  /**
   * Calculate enhanced importance score based on multiple factors
   */
  calculateEnhancedImportance(
    content: string,
    memoryType: MemoryType,
    _context?: string
  ): number {
    let score = 0.5; // Base score

    // Adjust based on memory type
    const typeWeights: Record<MemoryType, number> = {
      instruction: 0.9, // Instructions are very important
      fact: 0.8, // Facts about user are important
      preference: 0.75, // Preferences matter
      emotional: 0.7, // Emotional moments are memorable
      experience: 0.6, // Experiences are contextual
      context: 0.4, // Context is temporary
      general: 0.5, // Default
    };
    score = typeWeights[memoryType];

    // Adjust based on content length (longer = potentially more detailed/important)
    const wordCount = content.split(/\s+/).length;
    if (wordCount > 50) score = Math.min(1.0, score + 0.1);
    else if (wordCount < 10) score = Math.max(0.1, score - 0.1);

    // Adjust based on specificity (names, numbers, dates)
    const specificityIndicators = [
      /\b\d{4}\b/, // Years
      /\b\d{1,2}\/\d{1,2}\b/, // Dates
      /\b[A-Z][a-z]+\b/, // Proper nouns
      /\b\d+\s*(years?|months?|days?|hours?)\b/i, // Time durations
    ];
    const specificityCount = specificityIndicators.filter(p =>
      p.test(content)
    ).length;
    score = Math.min(1.0, score + specificityCount * 0.05);

    // Adjust based on question presence (questions often indicate important topics)
    if (content.includes('?')) {
      score = Math.min(1.0, score + 0.05);
    }

    // Clamp between 0.1 and 1.0
    return Math.max(0.1, Math.min(1.0, score));
  }

  /**
   * Apply time-based decay to importance score
   */
  applyDecay(
    originalImportance: number,
    timestamp: number,
    accessCount: number = 0,
    lastAccessed?: number
  ): number {
    const now = Date.now();
    const ageInDays = (now - timestamp) / (1000 * 60 * 60 * 24);
    const timeSinceAccess = lastAccessed
      ? (now - lastAccessed) / (1000 * 60 * 60 * 24)
      : ageInDays;

    // Base decay: memories lose ~10% importance per month if not accessed
    const decayRate = 0.003; // ~10% per month
    let decayedImportance =
      originalImportance * Math.exp(-decayRate * timeSinceAccess);

    // Boost for frequently accessed memories (reinforcement)
    const accessBoost = Math.min(0.3, accessCount * 0.02);
    decayedImportance = Math.min(1.0, decayedImportance + accessBoost);

    // Never let importance drop below 0.1 for recent memories (< 7 days)
    if (ageInDays < 7) {
      decayedImportance = Math.max(0.3, decayedImportance);
    }

    return Math.max(0.1, Math.min(1.0, decayedImportance));
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
   * Store a memory entry with embedding and automatic classification
   */
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

    // Auto-classify memory type if not provided
    const classifiedType = memoryType || this.classifyMemoryType(content);

    // Calculate enhanced importance if not provided
    const calculatedImportance =
      importanceScore !== undefined
        ? importanceScore
        : this.calculateEnhancedImportance(content, classifiedType, context);

    // Check for similar existing memories before storing
    const existingSimilar = await this.findSimilarMemories(
      userId,
      personaId,
      content,
      embeddingModel,
      0.85 // High similarity threshold for deduplication
    );

    // If very similar memory exists, reinforce it instead of creating new
    if (existingSimilar.length > 0) {
      const mostSimilar = existingSimilar[0];
      console.log(
        `[MEMORY] Found similar memory (${(mostSimilar.similarity_score * 100).toFixed(1)}% similar), reinforcing instead of creating new`
      );
      await this.reinforceMemory(mostSimilar.entry.id);
      return mostSimilar.entry as EnhancedMemoryEntry;
    }

    // Generate embedding
    const embedding = await this.generateEmbedding(content, embeddingModel);

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO persona_memories (
        id, user_id, persona_id, content, embedding, timestamp, context, importance_score,
        memory_type, access_count, last_accessed, decay_factor
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      userId,
      personaId,
      content,
      embedding ? Buffer.from(new Float32Array(embedding).buffer) : null,
      timestamp,
      context || null,
      calculatedImportance,
      classifiedType,
      0, // access_count
      null, // last_accessed
      1.0 // decay_factor
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

  /**
   * Find similar memories (for deduplication)
   */
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
    const stmt = db.prepare(`
      SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score,
             memory_type, access_count, last_accessed, decay_factor
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 50
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
      memory_type: string | null;
      access_count: number | null;
      last_accessed: number | null;
      decay_factor: number | null;
    }>;

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

  /**
   * Reinforce a memory (increases importance and access count)
   */
  async reinforceMemory(memoryId: string): Promise<boolean> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      UPDATE persona_memories
      SET access_count = COALESCE(access_count, 0) + 1,
          last_accessed = ?,
          importance_score = MIN(1.0, COALESCE(importance_score, 0.5) + 0.05)
      WHERE id = ?
    `);

    const result = stmt.run(Date.now(), memoryId);
    return result.changes > 0;
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
   * Search memories using semantic similarity with enhanced relevance scoring
   */
  async searchMemories(
    userId: string,
    personaId: string,
    query: string,
    embeddingModel: string,
    topK = 5,
    minSimilarity = 0.3,
    memoryTypes?: MemoryType[] // Optional filter by memory types
  ): Promise<MemorySearchResult[]> {
    // Generate embedding for query
    const queryEmbedding = await this.generateEmbedding(query, embeddingModel);
    if (!queryEmbedding) {
      return [];
    }

    // Get all memories for this user/persona with embeddings
    const db = this.ensureDatabase();
    let sql = `
      SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score,
             memory_type, access_count, last_accessed, decay_factor
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
    `;

    // Add memory type filter if specified
    if (memoryTypes && memoryTypes.length > 0) {
      sql += ` AND memory_type IN (${memoryTypes.map(() => '?').join(',')})`;
    }

    sql += ` ORDER BY timestamp DESC`;

    const stmt = db.prepare(sql);
    const params = memoryTypes
      ? [userId, personaId, ...memoryTypes]
      : [userId, personaId];

    const memories = stmt.all(...params) as Array<{
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
    }>;

    // Calculate enhanced relevance scores
    const results: MemorySearchResult[] = [];

    for (const memory of memories) {
      // Convert buffer back to float array
      const embeddingArray = Array.from(
        new Float32Array(memory.embedding.buffer)
      );

      const similarity = this.cosineSimilarity(queryEmbedding, embeddingArray);

      if (similarity >= minSimilarity) {
        // Calculate decayed importance
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
          relevance_rank: 0, // Will be set after sorting
        });
      }
    }

    // Sort by composite relevance score
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

    // Update access count for returned memories
    const topResults = results.slice(0, topK);
    for (const result of topResults) {
      await this.updateMemoryAccess(result.entry.id);
    }

    // Set relevance ranks and return top-k
    return topResults.map((result, index) => ({
      ...result,
      relevance_rank: index + 1,
    }));
  }

  /**
   * Update memory access tracking
   */
  private async updateMemoryAccess(memoryId: string): Promise<void> {
    try {
      const db = this.ensureDatabase();
      const stmt = db.prepare(`
        UPDATE persona_memories
        SET access_count = COALESCE(access_count, 0) + 1,
            last_accessed = ?
        WHERE id = ?
      `);
      stmt.run(Date.now(), memoryId);
    } catch (error) {
      console.warn('[MemoryService] Failed to update memory access:', error);
    }
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
    userId: string,
    personaId: string
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

  /**
   * Consolidate similar memories to reduce redundancy and save space
   * This merges memories with high similarity into a single, more comprehensive memory
   */
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
      // Get all memories with embeddings
      const stmt = db.prepare(`
        SELECT id, content, embedding, timestamp, importance_score, memory_type, access_count
        FROM persona_memories
        WHERE user_id = ? AND persona_id = ? AND embedding IS NOT NULL
        ORDER BY importance_score DESC, timestamp DESC
      `);

      const memories = stmt.all(userId, personaId) as Array<{
        id: string;
        content: string;
        embedding: Buffer;
        timestamp: number;
        importance_score: number;
        memory_type: string | null;
        access_count: number | null;
      }>;

      const processedIds = new Set<string>();
      const toDelete: string[] = [];

      for (let i = 0; i < memories.length; i++) {
        const memory = memories[i];
        if (processedIds.has(memory.id)) continue;

        const embeddingA = Array.from(
          new Float32Array(memory.embedding.buffer)
        );
        const similarMemories: typeof memories = [];

        // Find similar memories
        for (let j = i + 1; j < memories.length; j++) {
          const other = memories[j];
          if (processedIds.has(other.id)) continue;

          const embeddingB = Array.from(
            new Float32Array(other.embedding.buffer)
          );
          const similarity = this.cosineSimilarity(embeddingA, embeddingB);

          if (similarity >= similarityThreshold) {
            similarMemories.push(other);
            processedIds.add(other.id);
          }
        }

        // If we found similar memories, consolidate them
        if (similarMemories.length > 0) {
          processedIds.add(memory.id);

          // Create consolidated content
          const allContent = [
            memory.content,
            ...similarMemories.map(m => m.content),
          ];
          const consolidatedContent =
            this.createConsolidatedContent(allContent);

          // Calculate combined importance (weighted average with boost)
          const allImportances = [
            memory.importance_score,
            ...similarMemories.map(m => m.importance_score),
          ];
          const avgImportance =
            allImportances.reduce((a, b) => a + b, 0) / allImportances.length;
          const consolidatedImportance = Math.min(1.0, avgImportance * 1.1); // 10% boost for consolidation

          // Use the most common memory type
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

          // Generate new embedding for consolidated content
          const newEmbedding = await this.generateEmbedding(
            consolidatedContent,
            embeddingModel
          );

          // Store consolidated memory
          const consolidatedFromIds = [
            memory.id,
            ...similarMemories.map(m => m.id),
          ];

          const insertStmt = db.prepare(`
            INSERT INTO persona_memories (
              id, user_id, persona_id, content, embedding, timestamp, context, importance_score,
              memory_type, access_count, last_accessed, decay_factor, consolidated_from
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);

          insertStmt.run(
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

          // Mark original memories for deletion
          toDelete.push(...consolidatedFromIds);
          consolidated++;
        }
      }

      // Delete original memories that were consolidated
      if (toDelete.length > 0) {
        const deleteStmt = db.prepare(`
          DELETE FROM persona_memories WHERE id IN (${toDelete.map(() => '?').join(',')})
        `);
        deleteStmt.run(...toDelete);
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

  /**
   * Create consolidated content from multiple similar memories
   */
  private createConsolidatedContent(contents: string[]): string {
    if (contents.length === 1) return contents[0];

    // For now, use the longest content as base and note the count
    const sorted = [...contents].sort((a, b) => b.length - a.length);
    const base = sorted[0];

    // Add a note about consolidation
    if (contents.length === 2) {
      return base;
    }

    return `${base} (consolidated from ${contents.length} related interactions)`;
  }

  /**
   * Get memory statistics for a persona
   */
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

    // Get counts by type
    const typeStmt = db.prepare(`
      SELECT memory_type, COUNT(*) as count
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
      GROUP BY memory_type
    `);
    const typeCounts = typeStmt.all(userId, personaId) as Array<{
      memory_type: string | null;
      count: number;
    }>;

    // Get aggregate stats
    const statsStmt = db.prepare(`
      SELECT
        COUNT(*) as total_count,
        AVG(importance_score) as avg_importance,
        MIN(timestamp) as oldest_memory,
        MAX(timestamp) as newest_memory,
        SUM(COALESCE(access_count, 0)) as total_accesses
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
    `);
    const stats = statsStmt.get(userId, personaId) as {
      total_count: number;
      avg_importance: number | null;
      oldest_memory: number | null;
      newest_memory: number | null;
      total_accesses: number | null;
    };

    const byType: Record<string, number> = {};
    typeCounts.forEach(({ memory_type, count }) => {
      byType[memory_type || 'general'] = count;
    });

    return {
      total_count: stats.total_count,
      by_type: byType,
      avg_importance: stats.avg_importance || 0.5,
      oldest_memory: stats.oldest_memory,
      newest_memory: stats.newest_memory,
      total_accesses: stats.total_accesses || 0,
    };
  }

  /**
   * Apply decay to all memories (should be called periodically)
   */
  async applyGlobalDecay(userId: string, personaId: string): Promise<number> {
    const db = this.ensureDatabase();

    // Get all memories
    const selectStmt = db.prepare(`
      SELECT id, importance_score, timestamp, access_count, last_accessed
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
    `);

    const memories = selectStmt.all(userId, personaId) as Array<{
      id: string;
      importance_score: number;
      timestamp: number;
      access_count: number | null;
      last_accessed: number | null;
    }>;

    let updated = 0;
    const updateStmt = db.prepare(`
      UPDATE persona_memories
      SET importance_score = ?, decay_factor = ?
      WHERE id = ?
    `);

    for (const memory of memories) {
      const newImportance = this.applyDecay(
        memory.importance_score,
        memory.timestamp,
        memory.access_count || 0,
        memory.last_accessed || undefined
      );

      // Only update if importance changed significantly
      if (Math.abs(newImportance - memory.importance_score) > 0.01) {
        const decayFactor = newImportance / memory.importance_score;
        updateStmt.run(newImportance, decayFactor, memory.id);
        updated++;
      }
    }

    console.log(`[MEMORY] Applied decay to ${updated} memories`);
    return updated;
  }

  /**
   * Get important memories (facts, preferences, instructions) that should always be included
   */
  async getCoreMemories(
    userId: string,
    personaId: string,
    limit = 5
  ): Promise<PersonaMemoryEntry[]> {
    const db = this.ensureDatabase();

    const stmt = db.prepare(`
      SELECT id, user_id, persona_id, content, embedding, timestamp, context, importance_score,
             memory_type, access_count, last_accessed
      FROM persona_memories
      WHERE user_id = ? AND persona_id = ?
        AND memory_type IN ('fact', 'preference', 'instruction')
        AND importance_score >= 0.7
      ORDER BY importance_score DESC, access_count DESC
      LIMIT ?
    `);

    const memories = stmt.all(userId, personaId, limit) as Array<{
      id: string;
      user_id: string;
      persona_id: string;
      content: string;
      embedding: Buffer | null;
      timestamp: number;
      context: string | null;
      importance_score: number;
      memory_type: string | null;
      access_count: number | null;
      last_accessed: number | null;
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
}

export const memoryService = new MemoryService();
