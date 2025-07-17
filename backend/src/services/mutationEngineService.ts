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
import { memoryService } from './memoryService.js';
import {
  PersonaState,
  MutationEngineResult,
  MemorySearchResult,
  Persona,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

export class MutationEngineService {
  private db = getDatabaseSafe();

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
        'MutationEngineService: Database not available, skipping table initialization'
      );
      return;
    }
    // Persona states table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS persona_states (
        persona_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        runtime_state TEXT NOT NULL, -- JSON
        mutation_log TEXT NOT NULL, -- JSON array
        last_updated INTEGER NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_persona_states_user ON persona_states(user_id);
      CREATE INDEX IF NOT EXISTS idx_persona_states_updated ON persona_states(last_updated);
    `);
  }

  /**
   * Initialize persona state if not exists
   */
  async initializePersonaState(
    personaId: string,
    userId: string
  ): Promise<PersonaState> {
    const existing = await this.getPersonaState(personaId, userId);
    if (existing) {
      return existing;
    }

    const state: PersonaState = {
      persona_id: personaId,
      user_id: userId,
      runtime_state: {
        mood: 'neutral',
        energy_level: 0.5,
        conversation_context: {},
        learned_preferences: {},
        interaction_patterns: {},
      },
      mutation_log: [],
      last_updated: Date.now(),
      version: 1,
    };

    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT INTO persona_states (persona_id, user_id, runtime_state, mutation_log, last_updated, version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      personaId,
      userId,
      JSON.stringify(state.runtime_state),
      JSON.stringify(state.mutation_log),
      state.last_updated,
      state.version
    );

    return state;
  }

  /**
   * Get persona state
   */
  async getPersonaState(
    personaId: string,
    userId: string
  ): Promise<PersonaState | null> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      SELECT persona_id, user_id, runtime_state, mutation_log, last_updated, version
      FROM persona_states
      WHERE persona_id = ? AND user_id = ?
    `);

    const row = stmt.get(personaId, userId) as
      | {
          persona_id: string;
          user_id: string;
          runtime_state: string;
          mutation_log: string;
          last_updated: number;
          version: number;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      persona_id: row.persona_id,
      user_id: row.user_id,
      runtime_state: JSON.parse(row.runtime_state),
      mutation_log: JSON.parse(row.mutation_log),
      last_updated: row.last_updated,
      version: row.version,
    };
  }

  /**
   * Save persona state
   */
  async savePersonaState(state: PersonaState): Promise<void> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO persona_states (persona_id, user_id, runtime_state, mutation_log, last_updated, version)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      state.persona_id,
      state.user_id,
      JSON.stringify(state.runtime_state),
      JSON.stringify(state.mutation_log),
      state.last_updated,
      state.version
    );
  }

  /**
   * Main mutation engine - analyzes input and memories to generate state changes
   */
  async processMutation(
    userInput: string,
    persona: Persona,
    userId: string,
    relevantMemories: MemorySearchResult[]
  ): Promise<MutationEngineResult> {
    const result: MutationEngineResult = {
      state_deltas: {},
      new_memories: [],
      updated_memories: [],
      mutations: [],
    };

    // Get or initialize persona state
    let state = await this.getPersonaState(persona.id, userId);
    if (!state) {
      state = await this.initializePersonaState(persona.id, userId);
    }

    // Analyze user input for sentiment and intent
    const sentiment = this.analyzeSentiment(userInput);
    const intent = this.extractIntent(userInput);
    const topics = this.extractTopics(userInput);

    // Process different types of mutations based on sensitivity
    const sensitivity = persona.mutation_settings?.sensitivity || 'medium';

    // 1. Mood adjustment based on conversation
    if (this.shouldAdjustMood(userInput, sentiment, sensitivity)) {
      const moodDelta = this.calculateMoodAdjustment(
        sentiment,
        state.runtime_state.mood as string
      );
      result.state_deltas.mood = moodDelta;

      result.mutations.push({
        type: 'state_change',
        description: `Mood adjusted to ${moodDelta} based on user sentiment`,
        changes: { mood: moodDelta },
        triggered_by: userInput.substring(0, 50) + '...',
      });
    }

    // 2. Learn user preferences
    const preferences = this.extractPreferences(userInput, relevantMemories);
    if (preferences && Object.keys(preferences).length > 0) {
      result.state_deltas.learned_preferences = {
        ...((state.runtime_state.learned_preferences as Record<
          string,
          unknown
        >) || {}),
        ...preferences,
      };

      result.mutations.push({
        type: 'state_change',
        description: `Learned new user preferences: ${Object.keys(preferences).join(', ')}`,
        changes: { learned_preferences: preferences },
        triggered_by: userInput.substring(0, 50) + '...',
      });
    }

    // 3. Update interaction patterns
    const patterns = this.updateInteractionPatterns(
      userInput,
      (state.runtime_state.interaction_patterns as Record<string, unknown>) ||
        {}
    );
    if (patterns) {
      result.state_deltas.interaction_patterns = patterns;

      result.mutations.push({
        type: 'state_change',
        description: 'Updated interaction patterns based on conversation style',
        changes: { interaction_patterns: patterns },
        triggered_by: userInput.substring(0, 50) + '...',
      });
    }

    // 4. Create new memories from significant interactions
    if (this.shouldCreateMemory(userInput, relevantMemories, sensitivity)) {
      const importance = this.calculateImportance(userInput, intent, topics);

      result.new_memories.push({
        user_id: userId,
        persona_id: persona.id,
        content: userInput,
        context: `Intent: ${intent}, Topics: ${topics.join(', ')}, Sentiment: ${sentiment}`,
        importance_score: importance,
      });

      result.mutations.push({
        type: 'memory_add',
        description: `Created new memory with importance ${importance.toFixed(2)}`,
        changes: { memory_content: userInput, importance },
        triggered_by: userInput.substring(0, 50) + '...',
      });
    }

    // 5. Update existing memories if they become more relevant
    for (const memoryResult of relevantMemories.slice(0, 3)) {
      // Top 3 most relevant
      if (memoryResult.similarity_score > 0.8) {
        // High similarity
        const newImportance = Math.min(
          1.0,
          (memoryResult.entry.importance_score || 0.5) + 0.1
        );

        result.updated_memories.push({
          id: memoryResult.entry.id,
          updates: { importance_score: newImportance },
        });

        result.mutations.push({
          type: 'memory_update',
          description: `Increased importance of related memory`,
          changes: {
            memory_id: memoryResult.entry.id,
            new_importance: newImportance,
          },
          triggered_by: userInput.substring(0, 50) + '...',
        });
      }
    }

    return result;
  }

  /**
   * Apply mutation results to persona state
   */
  async applyMutations(
    personaId: string,
    userId: string,
    mutationResult: MutationEngineResult
  ): Promise<PersonaState> {
    // Get current state
    let state = await this.getPersonaState(personaId, userId);
    if (!state) {
      state = await this.initializePersonaState(personaId, userId);
    }

    // Apply state deltas
    for (const [key, value] of Object.entries(mutationResult.state_deltas)) {
      state.runtime_state[key] = value;
    }

    // Add mutations to log with timestamps and IDs
    const timestampedMutations = mutationResult.mutations.map(mutation => ({
      ...mutation,
      id: uuidv4(),
      timestamp: Date.now(),
    }));

    state.mutation_log.push(...timestampedMutations);

    // Keep only last 1000 mutations to prevent unbounded growth
    if (state.mutation_log.length > 1000) {
      state.mutation_log = state.mutation_log.slice(-1000);
    }

    // Update metadata
    state.last_updated = Date.now();
    state.version += 1;

    // Save updated state
    await this.savePersonaState(state);

    // Process new memories
    for (const newMemory of mutationResult.new_memories) {
      await memoryService.storeMemory(
        newMemory.user_id,
        newMemory.persona_id,
        newMemory.content,
        'nomic-embed-text', // Default embedding model
        newMemory.context,
        newMemory.importance_score
      );
    }

    // Update existing memories
    for (const update of mutationResult.updated_memories) {
      if (update.updates.importance_score !== undefined) {
        await memoryService.updateMemoryImportance(
          update.id,
          update.updates.importance_score
        );
      }
    }

    return state;
  }

  // Helper methods for analysis

  private analyzeSentiment(text: string): 'positive' | 'negative' | 'neutral' {
    const positiveWords = [
      'good',
      'great',
      'awesome',
      'excellent',
      'love',
      'like',
      'happy',
      'amazing',
      'wonderful',
    ];
    const negativeWords = [
      'bad',
      'terrible',
      'awful',
      'hate',
      'dislike',
      'sad',
      'angry',
      'frustrated',
      'annoying',
    ];

    const lowerText = text.toLowerCase();
    const positiveCount = positiveWords.filter(word =>
      lowerText.includes(word)
    ).length;
    const negativeCount = negativeWords.filter(word =>
      lowerText.includes(word)
    ).length;

    if (positiveCount > negativeCount) return 'positive';
    if (negativeCount > positiveCount) return 'negative';
    return 'neutral';
  }

  private extractIntent(text: string): string {
    const lowerText = text.toLowerCase();

    if (
      lowerText.includes('help') ||
      lowerText.includes('assist') ||
      lowerText.includes('support')
    ) {
      return 'help_request';
    }
    if (
      lowerText.includes('explain') ||
      lowerText.includes('what is') ||
      lowerText.includes('how does')
    ) {
      return 'explanation_request';
    }
    if (
      lowerText.includes('create') ||
      lowerText.includes('make') ||
      lowerText.includes('generate')
    ) {
      return 'creation_request';
    }
    if (lowerText.includes('?')) {
      return 'question';
    }

    return 'general_conversation';
  }

  private extractTopics(text: string): string[] {
    // Simple topic extraction based on common keywords
    const topics: string[] = [];
    const lowerText = text.toLowerCase();

    const topicKeywords = {
      technology: ['computer', 'software', 'ai', 'programming', 'code', 'tech'],
      science: ['research', 'study', 'experiment', 'theory', 'scientific'],
      business: ['market', 'company', 'business', 'finance', 'economy'],
      personal: ['feel', 'think', 'believe', 'my', 'me', 'personal'],
      creative: ['art', 'design', 'creative', 'music', 'write', 'draw'],
    };

    for (const [topic, keywords] of Object.entries(topicKeywords)) {
      if (keywords.some(keyword => lowerText.includes(keyword))) {
        topics.push(topic);
      }
    }

    return topics.length > 0 ? topics : ['general'];
  }

  private shouldAdjustMood(
    text: string,
    sentiment: string,
    sensitivity: string
  ): boolean {
    if (sensitivity === 'low') return sentiment !== 'neutral';
    if (sensitivity === 'medium') return true;
    if (sensitivity === 'high') return true;
    return false;
  }

  private calculateMoodAdjustment(
    sentiment: string,
    _currentMood: string
  ): string {
    const moodMap = {
      positive: ['happy', 'excited', 'optimistic', 'cheerful'],
      negative: ['sad', 'frustrated', 'disappointed', 'concerned'],
      neutral: ['calm', 'neutral', 'balanced', 'thoughtful'],
    };

    const moods = moodMap[sentiment as keyof typeof moodMap] || moodMap.neutral;
    return moods[Math.floor(Math.random() * moods.length)];
  }

  private extractPreferences(
    text: string,
    _memories: MemorySearchResult[]
  ): Record<string, unknown> | null {
    const preferences: Record<string, unknown> = {};
    const lowerText = text.toLowerCase();

    // Look for explicit preferences
    if (lowerText.includes('i prefer') || lowerText.includes('i like')) {
      const preferenceMatch = text.match(/i (prefer|like) ([^.!?]+)/i);
      if (preferenceMatch) {
        preferences.general = preferenceMatch[2].trim();
      }
    }

    // Look for style preferences
    if (lowerText.includes('style') || lowerText.includes('format')) {
      preferences.communication_style = 'detailed'; // Could be more sophisticated
    }

    return Object.keys(preferences).length > 0 ? preferences : null;
  }

  private updateInteractionPatterns(
    text: string,
    currentPatterns: Record<string, unknown>
  ): Record<string, unknown> | null {
    const patterns = { ...currentPatterns };

    // Track conversation length preference
    const wordCount = text.split(' ').length;
    patterns.preferred_response_length =
      wordCount > 50 ? 'detailed' : 'concise';

    // Track question frequency
    const questionCount = (text.match(/\?/g) || []).length;
    patterns.question_frequency =
      questionCount > 2 ? 'high' : questionCount > 0 ? 'medium' : 'low';

    return patterns;
  }

  private shouldCreateMemory(
    text: string,
    memories: MemorySearchResult[],
    sensitivity: string
  ): boolean {
    const minLength =
      sensitivity === 'high' ? 10 : sensitivity === 'medium' ? 20 : 50;

    if (text.length < minLength) return false;

    // Don't create memory if very similar one exists
    const highSimilarity = memories.some(m => m.similarity_score > 0.9);
    return !highSimilarity;
  }

  private calculateImportance(
    text: string,
    intent: string,
    topics: string[]
  ): number {
    let importance = 0.5; // Base importance

    // Adjust based on intent
    const intentScores = {
      help_request: 0.8,
      explanation_request: 0.7,
      creation_request: 0.9,
      question: 0.6,
      general_conversation: 0.4,
    };

    importance +=
      (intentScores[intent as keyof typeof intentScores] || 0.5) * 0.3;

    // Adjust based on length (longer = potentially more important)
    const lengthBonus = Math.min(0.2, text.length / 1000);
    importance += lengthBonus;

    // Adjust based on topic diversity
    importance += topics.length * 0.05;

    return Math.min(1.0, Math.max(0.1, importance));
  }

  /**
   * Clean up old mutation logs
   */
  async cleanupOldMutations(
    personaId: string,
    userId: string,
    retentionDays: number
  ): Promise<void> {
    const state = await this.getPersonaState(personaId, userId);
    if (!state) return;

    const cutoffTimestamp = Date.now() - retentionDays * 24 * 60 * 60 * 1000;

    state.mutation_log = state.mutation_log.filter(
      mutation => mutation.timestamp > cutoffTimestamp
    );

    await this.savePersonaState(state);
  }

  /**
   * Reset persona state
   */
  async resetPersonaState(personaId: string, userId: string): Promise<void> {
    const db = this.ensureDatabase();
    const stmt = db.prepare(`
      DELETE FROM persona_states
      WHERE persona_id = ? AND user_id = ?
    `);

    stmt.run(personaId, userId);
  }
}

export const mutationEngineService = new MutationEngineService();
