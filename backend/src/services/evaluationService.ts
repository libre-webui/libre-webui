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

/**
 * Evaluation platform (ADMIN-02).
 *
 * Three complementary signals share this service:
 *
 * - **Feedback**: thumbs with topic tags, an optional comment, and an
 *   encrypted snapshot of the rated exchange, so evaluation datasets
 *   survive chat edits and deletions. One row per user and message.
 * - **Arena votes**: blind multi-model comparisons vote a winner per
 *   compare group; the leaderboard replays every vote in insertion order
 *   through a deterministic Elo (K=32, base 1000), so recomputation is
 *   reproducible.
 * - **Eval sets and runs**: reusable prompt sets execute against a chosen
 *   model as durable jobs; each run records the exact model, per-item
 *   outputs, latency, and errors, encrypted at rest and exportable.
 */

import { randomUUID } from 'crypto';
import { getPersistence } from '../persistence/index.js';
import type {
  StoredEvalRunRecord,
  StoredEvalSetRecord,
  StoredMessageFeedbackRecord,
} from '../persistence/resourceTypes.js';
import { encryptionService } from './encryptionService.js';
import chatService from './chatService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:evaluation');

const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 40;
const MAX_COMMENT_LENGTH = 2000;
const MAX_SNAPSHOT_CHARS = 8000;
const MAX_EVAL_SETS_PER_USER = 50;
const MAX_EVAL_ITEMS = 50;
const MAX_ITEM_PROMPT_CHARS = 4000;
const MAX_OUTPUT_CHARS = 8000;
const MAX_LIST = 500;
const ELO_K = 32;
const ELO_BASE = 1000;

export interface FeedbackInput {
  sessionId: string;
  messageId: string;
  rating: 1 | -1;
  tags?: string[];
  comment?: string;
}

export interface FeedbackView {
  id: string;
  userId: string;
  sessionId: string;
  messageId: string;
  rating: number;
  tags: string[];
  comment: string | null;
  model: string | null;
  pluginId: string | null;
  snapshot: { user: string; assistant: string } | null;
  createdAt: number;
  updatedAt: number;
}

export interface EvalItem {
  id: string;
  prompt: string;
}

export interface EvalSetView {
  id: string;
  name: string;
  description: string | null;
  items: EvalItem[];
  createdAt: number;
  updatedAt: number;
}

export interface EvalRunItemResult {
  itemId: string;
  prompt: string;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface EvalRunView {
  id: string;
  setId: string;
  label: string | null;
  pluginId: string | null;
  model: string;
  status: StoredEvalRunRecord['status'];
  results: EvalRunItemResult[] | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface ArenaLeaderboardRow {
  model: string;
  rating: number;
  wins: number;
  losses: number;
  ties: number;
  votes: number;
}

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

const aad = (kind: string, id: string, userId: string): Buffer =>
  Buffer.from(`evaluation:${kind}:${id}:${userId}`, 'utf8');

const normalizeTags = (tags: unknown): string[] => {
  if (!Array.isArray(tags)) return [];
  const cleaned: string[] = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') continue;
    const value = tag.trim().slice(0, MAX_TAG_LENGTH);
    if (value && !cleaned.includes(value)) cleaned.push(value);
    if (cleaned.length >= MAX_TAGS) break;
  }
  return cleaned;
};

class EvaluationService {
  // --------------------------------------------------------------- feedback

  async upsertFeedback(
    userId: string,
    input: FeedbackInput
  ): Promise<FeedbackView> {
    if (input.rating !== 1 && input.rating !== -1) {
      throw new Error('rating must be 1 or -1');
    }
    const session = await chatService.getSession(input.sessionId, userId);
    if (!session) throw new Error('Session not found');
    const index = session.messages.findIndex(
      message => message.id === input.messageId
    );
    const message = index >= 0 ? session.messages[index] : undefined;
    if (!message || message.role !== 'assistant') {
      throw new Error('Assistant message not found');
    }
    let precedingUser = '';
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (session.messages[cursor].role === 'user') {
        precedingUser = session.messages[cursor].content;
        break;
      }
    }
    const comment =
      typeof input.comment === 'string' && input.comment.trim()
        ? input.comment.trim().slice(0, MAX_COMMENT_LENGTH)
        : null;
    const snapshot = JSON.stringify({
      user: precedingUser.slice(0, MAX_SNAPSHOT_CHARS),
      assistant: message.content.slice(0, MAX_SNAPSHOT_CHARS),
    });
    const id = randomUUID();
    const now = Date.now();
    const pluginId =
      typeof message.providerMetadata?.pluginId === 'string'
        ? message.providerMetadata.pluginId
        : null;
    const record: StoredMessageFeedbackRecord = {
      id,
      user_id: userId,
      session_id: input.sessionId,
      message_id: input.messageId,
      rating: input.rating,
      tags: JSON.stringify(normalizeTags(input.tags)),
      comment: comment
        ? encryptionService
            .encryptBuffer(
              Buffer.from(comment, 'utf8'),
              aad('comment', input.messageId, userId)
            )
            .toString('base64')
        : null,
      model: message.model ?? session.model ?? null,
      plugin_id: pluginId,
      snapshot: encryptionService
        .encryptBuffer(
          Buffer.from(snapshot, 'utf8'),
          aad('snapshot', input.messageId, userId)
        )
        .toString('base64'),
      created_at: now,
      updated_at: now,
    };
    await repositories().messageFeedback.upsertByMessage(record);
    const stored = (
      await repositories().messageFeedback.listByOwner(userId, MAX_LIST)
    ).find(row => row.message_id === input.messageId);
    return this.mapFeedback(stored ?? record, true);
  }

  async deleteFeedback(userId: string, messageId: string): Promise<boolean> {
    return repositories().messageFeedback.deleteByMessage(userId, messageId);
  }

  async listFeedback(
    options: { userId?: string } = {}
  ): Promise<FeedbackView[]> {
    const rows = options.userId
      ? await repositories().messageFeedback.listByOwner(
          options.userId,
          MAX_LIST
        )
      : await repositories().messageFeedback.listAll(MAX_LIST);
    return rows.map(row => this.mapFeedback(row, true));
  }

  private mapFeedback(
    row: StoredMessageFeedbackRecord,
    includeSnapshot: boolean
  ): FeedbackView {
    let tags: string[] = [];
    try {
      tags = normalizeTags(JSON.parse(row.tags ?? '[]'));
    } catch {
      tags = [];
    }
    let comment: string | null = null;
    if (row.comment) {
      try {
        comment = encryptionService
          .decryptBuffer(
            Buffer.from(row.comment, 'base64'),
            aad('comment', row.message_id, row.user_id)
          )
          .toString('utf8');
      } catch (error) {
        logger.warn('Feedback comment decryption failed', { error });
      }
    }
    let snapshot: FeedbackView['snapshot'] = null;
    if (includeSnapshot && row.snapshot) {
      try {
        snapshot = JSON.parse(
          encryptionService
            .decryptBuffer(
              Buffer.from(row.snapshot, 'base64'),
              aad('snapshot', row.message_id, row.user_id)
            )
            .toString('utf8')
        ) as FeedbackView['snapshot'];
      } catch (error) {
        logger.warn('Feedback snapshot decryption failed', { error });
      }
    }
    return {
      id: row.id,
      userId: row.user_id,
      sessionId: row.session_id,
      messageId: row.message_id,
      rating: row.rating,
      tags,
      comment,
      model: row.model,
      pluginId: row.plugin_id,
      snapshot,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // ------------------------------------------------------------------ arena

  async recordArenaVote(
    userId: string,
    input: {
      compareGroup: string;
      modelA: string;
      modelB: string;
      winner: 'a' | 'b' | 'tie' | 'both-bad';
    }
  ): Promise<boolean> {
    if (
      !input.compareGroup?.trim() ||
      !input.modelA?.trim() ||
      !input.modelB?.trim()
    ) {
      throw new Error('compareGroup, modelA, and modelB are required');
    }
    if (!['a', 'b', 'tie', 'both-bad'].includes(input.winner)) {
      throw new Error('Unknown arena verdict');
    }
    return repositories().arenaVotes.insertOnce({
      id: randomUUID(),
      user_id: userId,
      compare_group: input.compareGroup.trim().slice(0, 120),
      model_a: input.modelA.trim().slice(0, 200),
      model_b: input.modelB.trim().slice(0, 200),
      winner: input.winner,
      created_at: Date.now(),
    });
  }

  /** Deterministic Elo replay over every vote in insertion order. */
  async arenaLeaderboard(): Promise<ArenaLeaderboardRow[]> {
    const votes = await repositories().arenaVotes.listAllOrdered(10_000);
    const table = new Map<string, ArenaLeaderboardRow>();
    const rowFor = (model: string): ArenaLeaderboardRow => {
      let row = table.get(model);
      if (!row) {
        row = {
          model,
          rating: ELO_BASE,
          wins: 0,
          losses: 0,
          ties: 0,
          votes: 0,
        };
        table.set(model, row);
      }
      return row;
    };
    for (const vote of votes) {
      const a = rowFor(vote.model_a);
      const b = rowFor(vote.model_b);
      a.votes += 1;
      b.votes += 1;
      if (vote.winner === 'both-bad') continue;
      const scoreA = vote.winner === 'a' ? 1 : vote.winner === 'b' ? 0 : 0.5;
      const expectedA = 1 / (1 + 10 ** ((b.rating - a.rating) / 400));
      const delta = ELO_K * (scoreA - expectedA);
      a.rating += delta;
      b.rating -= delta;
      if (vote.winner === 'a') {
        a.wins += 1;
        b.losses += 1;
      } else if (vote.winner === 'b') {
        b.wins += 1;
        a.losses += 1;
      } else {
        a.ties += 1;
        b.ties += 1;
      }
    }
    return [...table.values()]
      .map(row => ({ ...row, rating: Math.round(row.rating) }))
      .sort((left, right) => right.rating - left.rating);
  }

  // -------------------------------------------------------------- eval sets

  async listEvalSets(userId: string): Promise<EvalSetView[]> {
    const rows = await repositories().evalSets.listByOwner(userId, MAX_LIST);
    return rows.map(row => this.mapEvalSet(row));
  }

  async getEvalSet(setId: string, userId: string): Promise<EvalSetView | null> {
    const row = await repositories().evalSets.findByOwner(setId, userId);
    return row ? this.mapEvalSet(row) : null;
  }

  async saveEvalSet(
    userId: string,
    input: {
      id?: string;
      name: string;
      description?: string | null;
      items: Array<{ id?: string; prompt: string }>;
    }
  ): Promise<EvalSetView> {
    if (!input.name?.trim() || input.name.length > 120) {
      throw new Error(
        'An evaluation set name up to 120 characters is required'
      );
    }
    if (!Array.isArray(input.items) || input.items.length === 0) {
      throw new Error('At least one prompt item is required');
    }
    if (input.items.length > MAX_EVAL_ITEMS) {
      throw new Error(`At most ${MAX_EVAL_ITEMS} prompt items are allowed`);
    }
    const items: EvalItem[] = input.items.map(item => {
      const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : '';
      if (!prompt || prompt.length > MAX_ITEM_PROMPT_CHARS) {
        throw new Error(
          `Every item needs a prompt up to ${MAX_ITEM_PROMPT_CHARS} characters`
        );
      }
      return { id: item.id || randomUUID(), prompt };
    });
    const id = input.id ?? randomUUID();
    const existing = input.id
      ? await repositories().evalSets.findByOwner(id, userId)
      : null;
    if (input.id && !existing) throw new Error('Evaluation set not found');
    const now = Date.now();
    const record: StoredEvalSetRecord = {
      id,
      user_id: userId,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      items: encryptionService
        .encryptBuffer(
          Buffer.from(JSON.stringify(items), 'utf8'),
          aad('set-items', id, userId)
        )
        .toString('base64'),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await repositories().evalSets.replaceWithLimit(
      record,
      MAX_EVAL_SETS_PER_USER
    );
    return this.mapEvalSet(record);
  }

  async deleteEvalSet(setId: string, userId: string): Promise<boolean> {
    return repositories().evalSets.deleteByOwner(setId, userId);
  }

  private mapEvalSet(row: StoredEvalSetRecord): EvalSetView {
    let items: EvalItem[] = [];
    try {
      items = JSON.parse(
        encryptionService
          .decryptBuffer(
            Buffer.from(row.items, 'base64'),
            aad('set-items', row.id, row.user_id)
          )
          .toString('utf8')
      ) as EvalItem[];
    } catch (error) {
      logger.warn('Evaluation set items decryption failed', { error });
    }
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      items,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // -------------------------------------------------------------- eval runs

  async createRunRecord(
    userId: string,
    input: {
      setId: string;
      model: string;
      pluginId?: string | null;
      label?: string | null;
    }
  ): Promise<StoredEvalRunRecord> {
    if (!input.model?.trim()) throw new Error('A model is required');
    const set = await repositories().evalSets.findByOwner(input.setId, userId);
    if (!set) throw new Error('Evaluation set not found');
    const record: StoredEvalRunRecord = {
      id: randomUUID(),
      set_id: input.setId,
      user_id: userId,
      label: input.label?.trim().slice(0, 120) || null,
      plugin_id: input.pluginId?.trim() || null,
      model: input.model.trim(),
      status: 'queued',
      results: null,
      error: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      completed_at: null,
    };
    await repositories().evalRuns.insert(record);
    return record;
  }

  async listRuns(userId: string, setId?: string): Promise<EvalRunView[]> {
    const rows = setId
      ? await repositories().evalRuns.listBySet(setId, userId, MAX_LIST)
      : await repositories().evalRuns.listByOwner(userId, MAX_LIST);
    return rows.map(row => this.mapRun(row));
  }

  async getRun(runId: string, userId: string): Promise<EvalRunView | null> {
    const row = await repositories().evalRuns.findByOwner(runId, userId);
    return row ? this.mapRun(row) : null;
  }

  async updateRunStatus(
    runId: string,
    userId: string,
    status: StoredEvalRunRecord['status'],
    options: { results?: EvalRunItemResult[]; error?: string | null } = {}
  ): Promise<boolean> {
    const now = Date.now();
    return repositories().evalRuns.update(runId, userId, {
      status,
      updated_at: now,
      ...(options.results
        ? {
            results: encryptionService
              .encryptBuffer(
                Buffer.from(JSON.stringify(options.results), 'utf8'),
                aad('run-results', runId, userId)
              )
              .toString('base64'),
          }
        : {}),
      error: options.error ?? null,
      ...(status === 'completed' ||
      status === 'failed' ||
      status === 'cancelled'
        ? { completed_at: now }
        : {}),
    });
  }

  truncateOutput(output: string): string {
    return output.length > MAX_OUTPUT_CHARS
      ? `${output.slice(0, MAX_OUTPUT_CHARS)}…`
      : output;
  }

  private mapRun(row: StoredEvalRunRecord): EvalRunView {
    let results: EvalRunItemResult[] | null = null;
    if (row.results) {
      try {
        results = JSON.parse(
          encryptionService
            .decryptBuffer(
              Buffer.from(row.results, 'base64'),
              aad('run-results', row.id, row.user_id)
            )
            .toString('utf8')
        ) as EvalRunItemResult[];
      } catch (error) {
        logger.warn('Evaluation run results decryption failed', { error });
      }
    }
    return {
      id: row.id,
      setId: row.set_id,
      label: row.label,
      pluginId: row.plugin_id,
      model: row.model,
      status: row.status,
      results,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

export const evaluationService = new EvaluationService();
export default evaluationService;
