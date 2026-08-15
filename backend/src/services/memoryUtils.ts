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

import type { PersonaMemoryEntry } from '../types/index.js';

export type MemoryType =
  | 'fact'
  | 'preference'
  | 'experience'
  | 'emotional'
  | 'context'
  | 'instruction'
  | 'general';

export interface MemoryRow {
  id: string;
  user_id: string;
  persona_id: string;
  content: string;
  embedding: Buffer | null;
  timestamp: number;
  context: string | null;
  importance_score: number;
}

export interface EnhancedMemoryRow extends MemoryRow {
  memory_type: string | null;
  access_count: number | null;
  last_accessed: number | null;
  decay_factor: number | null;
}

export const memoryColumnTypes: Record<string, string> = {
  memory_type: 'TEXT',
  access_count: 'INTEGER',
  last_accessed: 'INTEGER',
  decay_factor: 'REAL',
  consolidated_from: 'TEXT',
};

export function getMemoryColumnType(column: string): string {
  return memoryColumnTypes[column] || 'TEXT';
}

export function classifyMemoryType(content: string): MemoryType {
  const lowerContent = content.toLowerCase();

  const preferencePatterns = [
    /i (like|love|prefer|enjoy|hate|dislike|don't like)/i,
    /my favorite/i,
    /i('m| am) (a fan of|into|interested in)/i,
  ];
  if (preferencePatterns.some(pattern => pattern.test(lowerContent))) {
    return 'preference';
  }

  const factPatterns = [
    /i (am|'m) (a |an )?(\w+ )?(developer|engineer|designer|student|teacher|doctor|lawyer)/i,
    /i (work|live|study) (at|in|for)/i,
    /my (name|job|profession|age|location|birthday)/i,
    /i have (a |an )?(\d+ )?(kids?|children|dogs?|cats?|pets?)/i,
  ];
  if (factPatterns.some(pattern => pattern.test(lowerContent))) {
    return 'fact';
  }

  const emotionalPatterns = [
    /i('m| am) (feeling|so|really|very) (happy|sad|excited|anxious|worried|stressed|grateful)/i,
    /thank you|thanks|appreciate/i,
    /i('m| am) (sorry|apologize)/i,
    /(love|hate) (this|that|it)/i,
  ];
  if (emotionalPatterns.some(pattern => pattern.test(lowerContent))) {
    return 'emotional';
  }

  const instructionPatterns = [
    /please (always|never|remember|don't|do not)/i,
    /i want you to/i,
    /can you (please )?make sure/i,
    /when (i ask|responding|you)/i,
  ];
  if (instructionPatterns.some(pattern => pattern.test(lowerContent))) {
    return 'instruction';
  }

  const experiencePatterns = [
    /i (went|did|saw|visited|attended|met|had)/i,
    /yesterday|last (week|month|year)|recently/i,
    /one time|once upon a time|i remember when/i,
  ];
  if (experiencePatterns.some(pattern => pattern.test(lowerContent))) {
    return 'experience';
  }

  return 'general';
}

export function calculateEnhancedImportance(
  content: string,
  memoryType: MemoryType
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
  if (wordCount > 50) {
    score = Math.min(1.0, score + 0.1);
  } else if (wordCount < 10) {
    score = Math.max(0.1, score - 0.1);
  }

  const specificityIndicators = [
    /\b\d{4}\b/,
    /\b\d{1,2}\/\d{1,2}\b/,
    /\b[A-Z][a-z]+\b/,
    /\b\d+\s*(years?|months?|days?|hours?)\b/i,
  ];
  const specificityCount = specificityIndicators.filter(pattern =>
    pattern.test(content)
  ).length;
  score = Math.min(1.0, score + specificityCount * 0.05);

  if (content.includes('?')) {
    score = Math.min(1.0, score + 0.05);
  }

  return Math.max(0.1, Math.min(1.0, score));
}

export function applyMemoryDecay(
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

  const decayRate = 0.003;
  let decayedImportance =
    originalImportance * Math.exp(-decayRate * timeSinceAccess);

  const accessBoost = Math.min(0.3, accessCount * 0.02);
  decayedImportance = Math.min(1.0, decayedImportance + accessBoost);

  if (ageInDays < 7) {
    decayedImportance = Math.max(0.3, decayedImportance);
  }

  return Math.max(0.1, Math.min(1.0, decayedImportance));
}

export function cosineSimilarity(a: number[], b: number[]): number {
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

export function embeddingBufferToArray(embedding: Buffer): number[] {
  if (embedding.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error('Stored memory embedding has an invalid byte length');
  }
  const values: number[] = [];
  for (let offset = 0; offset < embedding.byteLength; offset += 4) {
    values.push(embedding.readFloatLE(offset));
  }
  return values;
}

export function embeddingArrayToBuffer(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer);
}

export function toPersonaMemoryEntry(row: MemoryRow): PersonaMemoryEntry {
  return {
    id: row.id,
    user_id: row.user_id,
    persona_id: row.persona_id,
    content: row.content,
    embedding: row.embedding
      ? embeddingBufferToArray(row.embedding)
      : undefined,
    timestamp: row.timestamp,
    context: row.context || undefined,
    importance_score: row.importance_score,
  };
}

export function createConsolidatedContent(contents: string[]): string {
  if (contents.length === 1) return contents[0];

  const sorted = [...contents].sort((a, b) => b.length - a.length);
  const base = sorted[0];

  if (contents.length === 2) {
    return base;
  }

  return `${base} (consolidated from ${contents.length} related interactions)`;
}
