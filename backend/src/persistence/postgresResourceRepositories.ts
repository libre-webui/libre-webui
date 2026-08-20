/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PoolClient, QueryResultRow } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  ApplicationResourceRepositories,
  AutomationRepository,
  AutomationRunRepository,
  CalendarEventRepository,
  ChatSessionRepository,
  DataArchiveApplyPlan,
  DataArchiveRepository,
  KnowledgeCollectionRepository,
  NoteRepository,
  PersistenceCommitFence,
  PreferenceRepository,
  PromptRepository,
  SessionFolderRepository,
  SkillFileRepository,
  SkillRepository,
  StoredAutomationRecord,
  StoredAutomationRunRecord,
  StoredCalendarEventRecord,
  StoredChatMessageRecord,
  StoredChatSessionAggregate,
  StoredChatSessionRecord,
  StoredNamedResourceRecord,
  StoredNotePatch,
  StoredNoteRecord,
  StoredPreferenceRecord,
  StoredPromptRecord,
  StoredPromptVersionRecord,
  StoredSkillFileRecord,
  StoredSkillRecord,
  StoredSkillVersionRecord,
  StoredToolApprovalRecord,
  StoredToolServerCredentialRecord,
  StoredToolServerRecord,
  StoredToolServerToolRecord,
  SystemSettingRepository,
  ToolApprovalRepository,
  ToolServerCredentialRepository,
  ToolServerRepository,
  ToolServerToolRepository,
} from './resourceTypes.js';
import {
  PersistenceResourceConflictError,
  PersistenceResourceDeletionReservedError,
  PersistenceResourceLimitError,
} from './resourceTypes.js';
import type {
  PostgresDatabase,
  PostgresQueryExecutor,
} from './postgresDatabase.js';
import type {
  ChatGenerationEnqueueInput,
  ChatGenerationEnqueuer,
} from './chatGenerationTypes.js';

type NumericRow = QueryResultRow & Record<string, unknown>;

const number = (value: unknown, field: string): number => {
  const converted = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(converted)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return converted;
};

const chatSession = (row: NumericRow): StoredChatSessionRecord => ({
  ...(row as unknown as StoredChatSessionRecord),
  created_at: number(row.created_at, 'session created_at'),
  updated_at: number(row.updated_at, 'session updated_at'),
  archived: number(row.archived, 'session archived'),
  pinned: number(row.pinned, 'session pinned'),
});

const chatMessage = (row: NumericRow): StoredChatMessageRecord => ({
  ...(row as unknown as StoredChatMessageRecord),
  timestamp: number(row.timestamp, 'message timestamp'),
  message_index: number(row.message_index, 'message index'),
  branch_index: number(row.branch_index, 'message branch index'),
  is_active: number(row.is_active, 'message active state'),
  rating: row.rating === null ? null : number(row.rating, 'message rating'),
});

const namedResource = (row: NumericRow): StoredNamedResourceRecord => ({
  ...(row as unknown as StoredNamedResourceRecord),
  created_at: number(row.created_at, 'resource created_at'),
  updated_at: number(row.updated_at, 'resource updated_at'),
});

const note = (row: NumericRow): StoredNoteRecord => ({
  ...(row as unknown as StoredNoteRecord),
  created_at: number(row.created_at, 'note created_at'),
  updated_at: number(row.updated_at, 'note updated_at'),
});

const calendarEvent = (row: NumericRow): StoredCalendarEventRecord => ({
  ...(row as unknown as StoredCalendarEventRecord),
  start_at: number(row.start_at, 'calendar event start_at'),
  end_at:
    row.end_at === null ? null : number(row.end_at, 'calendar event end_at'),
  all_day: number(row.all_day, 'calendar event all_day'),
  created_at: number(row.created_at, 'calendar event created_at'),
  updated_at: number(row.updated_at, 'calendar event updated_at'),
});

const automation = (row: NumericRow): StoredAutomationRecord => ({
  ...(row as unknown as StoredAutomationRecord),
  next_run_at:
    row.next_run_at === null
      ? null
      : number(row.next_run_at, 'automation next_run_at'),
  last_run_at:
    row.last_run_at === null
      ? null
      : number(row.last_run_at, 'automation last_run_at'),
  created_at: number(row.created_at, 'automation created_at'),
  updated_at: number(row.updated_at, 'automation updated_at'),
});

const automationRun = (row: NumericRow): StoredAutomationRunRecord => ({
  ...(row as unknown as StoredAutomationRunRecord),
  scheduled_for: number(row.scheduled_for, 'automation run scheduled_for'),
  started_at:
    row.started_at === null
      ? null
      : number(row.started_at, 'automation run started_at'),
  finished_at:
    row.finished_at === null
      ? null
      : number(row.finished_at, 'automation run finished_at'),
  seen_at:
    row.seen_at === null ? null : number(row.seen_at, 'automation run seen_at'),
  created_at: number(row.created_at, 'automation run created_at'),
});

const toolServer = (row: NumericRow): StoredToolServerRecord => ({
  ...(row as unknown as StoredToolServerRecord),
  spec_revision: number(row.spec_revision, 'tool server spec_revision'),
  enabled: number(row.enabled, 'tool server enabled'),
  timeout_ms: number(row.timeout_ms, 'tool server timeout_ms'),
  max_response_bytes: number(
    row.max_response_bytes,
    'tool server max_response_bytes'
  ),
  created_at: number(row.created_at, 'tool server created_at'),
  updated_at: number(row.updated_at, 'tool server updated_at'),
});

const toolServerTool = (row: NumericRow): StoredToolServerToolRecord => ({
  ...(row as unknown as StoredToolServerToolRecord),
  side_effect: number(row.side_effect, 'tool side_effect'),
  enabled: number(row.enabled, 'tool enabled'),
  created_at: number(row.created_at, 'tool created_at'),
  updated_at: number(row.updated_at, 'tool updated_at'),
});

const toolServerCredential = (
  row: NumericRow
): StoredToolServerCredentialRecord => ({
  ...(row as unknown as StoredToolServerCredentialRecord),
  created_at: number(row.created_at, 'tool credential created_at'),
  updated_at: number(row.updated_at, 'tool credential updated_at'),
});

const toolApproval = (row: NumericRow): StoredToolApprovalRecord => ({
  ...(row as unknown as StoredToolApprovalRecord),
  created_at: number(row.created_at, 'tool approval created_at'),
  resolved_at:
    row.resolved_at === null
      ? null
      : number(row.resolved_at, 'tool approval resolved_at'),
  expires_at:
    row.expires_at === null
      ? null
      : number(row.expires_at, 'tool approval expires_at'),
});

const prompt = (row: NumericRow): StoredPromptRecord => ({
  ...(row as unknown as StoredPromptRecord),
  version: number(row.version, 'prompt version'),
  created_at: number(row.created_at, 'prompt created_at'),
  updated_at: number(row.updated_at, 'prompt updated_at'),
});

const promptVersion = (row: NumericRow): StoredPromptVersionRecord => ({
  ...(row as unknown as StoredPromptVersionRecord),
  version: number(row.version, 'prompt revision version'),
  created_at: number(row.created_at, 'prompt revision created_at'),
});

const skill = (row: NumericRow): StoredSkillRecord => ({
  ...(row as unknown as StoredSkillRecord),
  enabled: number(row.enabled, 'skill enabled'),
  version: number(row.version, 'skill version'),
  created_at: number(row.created_at, 'skill created_at'),
  updated_at: number(row.updated_at, 'skill updated_at'),
});

const skillVersion = (row: NumericRow): StoredSkillVersionRecord => ({
  ...(row as unknown as StoredSkillVersionRecord),
  version: number(row.version, 'skill revision version'),
  created_at: number(row.created_at, 'skill revision created_at'),
});

const skillFile = (row: NumericRow): StoredSkillFileRecord => ({
  ...(row as unknown as StoredSkillFileRecord),
  size: number(row.size, 'skill file size'),
  created_at: number(row.created_at, 'skill file created_at'),
  updated_at: number(row.updated_at, 'skill file updated_at'),
});

const changes = (rowCount: number | null): number => rowCount ?? 0;

const lockOwner = async (
  client: PostgresQueryExecutor,
  userId: string
): Promise<void> => {
  const result = await client.query(
    'SELECT id FROM users WHERE id = $1 FOR UPDATE',
    [userId]
  );
  if (result.rowCount !== 1) throw new Error('Resource owner does not exist');
};

class PostgresChatSessionRepository implements ChatSessionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  private async replaceAggregate(
    client: PostgresQueryExecutor,
    aggregate: StoredChatSessionAggregate
  ): Promise<void> {
    await lockOwner(client, aggregate.session.user_id);
    const result = await client.query(
      `INSERT INTO sessions
         (id, user_id, title, model, persona_id, provider_type, provider_id,
          created_at, updated_at, archived, settings, folder_id, pinned)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         model = EXCLUDED.model,
         persona_id = EXCLUDED.persona_id,
         provider_type = EXCLUDED.provider_type,
         provider_id = EXCLUDED.provider_id,
         updated_at = EXCLUDED.updated_at,
         archived = EXCLUDED.archived,
         settings = EXCLUDED.settings,
         folder_id = EXCLUDED.folder_id,
         pinned = EXCLUDED.pinned
       WHERE sessions.user_id = EXCLUDED.user_id`,
      [
        aggregate.session.id,
        aggregate.session.user_id,
        aggregate.session.title,
        aggregate.session.model,
        aggregate.session.persona_id,
        aggregate.session.provider_type,
        aggregate.session.provider_id,
        aggregate.session.created_at,
        aggregate.session.updated_at,
        aggregate.session.archived,
        aggregate.session.settings,
        aggregate.session.folder_id,
        aggregate.session.pinned,
      ]
    );
    if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    await client.query('DELETE FROM session_messages WHERE session_id = $1', [
      aggregate.session.id,
    ]);
    for (const message of aggregate.messages) {
      if (message.session_id !== aggregate.session.id) {
        throw new Error('A chat message does not belong to its aggregate');
      }
      await client.query(
        `INSERT INTO session_messages
           (id, session_id, role, content, thinking, timestamp, message_index,
            model, provider_metadata, images, statistics, artifacts,
            parent_id, branch_index, is_active, rating)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16)`,
        [
          message.id,
          message.session_id,
          message.role,
          message.content,
          message.thinking,
          message.timestamp,
          message.message_index,
          message.model,
          message.provider_metadata,
          message.images,
          message.statistics,
          message.artifacts,
          message.parent_id,
          message.branch_index,
          message.is_active,
          message.rating,
        ]
      );
    }
  }

  async listByOwner(userId: string): Promise<StoredChatSessionAggregate[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT s.*,
              COALESCE(
                json_agg(to_jsonb(m) ORDER BY m.message_index, m.branch_index)
                  FILTER (WHERE m.id IS NOT NULL),
                '[]'::json
              ) AS messages
         FROM sessions s
         LEFT JOIN session_messages m ON m.session_id = s.id
        WHERE s.user_id = $1
        GROUP BY s.id
        ORDER BY s.updated_at DESC`,
      [userId]
    );
    return result.rows.map(row => {
      const rawMessages = Array.isArray(row.messages) ? row.messages : [];
      return {
        session: chatSession(row),
        messages: rawMessages.map(item => chatMessage(item as NumericRow)),
      };
    });
  }

  async findByOwner(
    sessionId: string,
    userId: string
  ): Promise<StoredChatSessionAggregate | null> {
    const sessionResult = await this.database.query<NumericRow>(
      'SELECT * FROM sessions WHERE id = $1 AND user_id = $2',
      [sessionId, userId]
    );
    const session = sessionResult.rows[0];
    if (!session) return null;
    const messageResult = await this.database.query<NumericRow>(
      `SELECT * FROM session_messages
        WHERE session_id = $1
        ORDER BY message_index ASC, branch_index ASC`,
      [sessionId]
    );
    return {
      session: chatSession(session),
      messages: messageResult.rows.map(chatMessage),
    };
  }

  async replace(
    aggregate: StoredChatSessionAggregate,
    beforeCommit?: PersistenceCommitFence
  ): Promise<void> {
    await this.database.transaction(
      async client => {
        await this.replaceAggregate(client, aggregate);
      },
      { isolationLevel: 'serializable', beforeCommit }
    );
  }

  async replaceAndEnqueue(
    aggregate: StoredChatSessionAggregate,
    enqueuer: ChatGenerationEnqueuer,
    input: ChatGenerationEnqueueInput,
    beforeCommit?: PersistenceCommitFence
  ): Promise<void> {
    if (
      input.sessionId !== aggregate.session.id ||
      input.actorUserId !== aggregate.session.user_id
    ) {
      throw new Error('Chat generation enqueue does not match its aggregate');
    }
    await this.database.transaction(
      async client => {
        const enqueue = await enqueuer.enqueuePostgres(client, input);
        if (enqueue.created) await this.replaceAggregate(client, aggregate);
      },
      { isolationLevel: 'serializable', beforeCommit }
    );
  }

  async removeMessageIfCurrent(
    sessionId: string,
    userId: string,
    messageId: string,
    expectedTimestamp: number,
    expectedSessionUpdatedAt: number,
    previousSessionUpdatedAt: number,
    previousActiveMessageId?: string
  ): Promise<boolean> {
    return this.database.transaction(
      async client => {
        const owner = await client.query<{ user_id: string }>(
          'SELECT user_id FROM sessions WHERE id = $1 FOR UPDATE',
          [sessionId]
        );
        if (owner.rows[0]?.user_id !== userId) return false;
        const target = await client.query<{
          timestamp: string | number;
          parent_id: string | null;
          is_active: string | number;
        }>(
          `SELECT timestamp, parent_id, is_active
             FROM session_messages
            WHERE id = $1 AND session_id = $2 FOR UPDATE`,
          [messageId, sessionId]
        );
        const row = target.rows[0];
        if (
          !row ||
          number(row.timestamp, 'message timestamp') !== expectedTimestamp
        )
          return false;
        const deleted = await client.query(
          `DELETE FROM session_messages
            WHERE id = $1 AND session_id = $2 AND timestamp = $3`,
          [messageId, sessionId, expectedTimestamp]
        );
        if (changes(deleted.rowCount) > 0) {
          await client.query(
            `UPDATE sessions SET updated_at = $1
              WHERE id = $2 AND user_id = $3 AND updated_at = $4`,
            [
              previousSessionUpdatedAt,
              sessionId,
              userId,
              expectedSessionUpdatedAt,
            ]
          );
        }
        if (
          changes(deleted.rowCount) > 0 &&
          number(row.is_active, 'message active state') === 1 &&
          row.parent_id &&
          previousActiveMessageId
        ) {
          const active = await client.query(
            `SELECT 1 FROM session_messages
              WHERE session_id = $1 AND (id = $2 OR parent_id = $2)
                AND is_active = 1 LIMIT 1`,
            [sessionId, row.parent_id]
          );
          if (!active.rows[0]) {
            await client.query(
              `UPDATE session_messages SET is_active = 1
                WHERE id = $1 AND session_id = $2
                  AND (id = $3 OR parent_id = $3)`,
              [previousActiveMessageId, sessionId, row.parent_id]
            );
          }
        }
        return changes(deleted.rowCount) > 0;
      },
      { isolationLevel: 'serializable' }
    );
  }

  async deleteByOwner(
    sessionId: string,
    userId: string,
    beforeCommit?: PersistenceCommitFence
  ): Promise<boolean> {
    return this.database.transaction(
      async client =>
        changes(
          (
            await client.query(
              'DELETE FROM sessions WHERE id = $1 AND user_id = $2',
              [sessionId, userId]
            )
          ).rowCount
        ) > 0,
      { isolationLevel: 'serializable', beforeCommit }
    );
  }

  async deleteAllByOwner(userId: string): Promise<number> {
    return changes(
      (
        await this.database.query('DELETE FROM sessions WHERE user_id = $1', [
          userId,
        ])
      ).rowCount
    );
  }
}

class PostgresKnowledgeCollectionRepository implements KnowledgeCollectionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(userId: string): Promise<StoredNamedResourceRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM knowledge_collections
        WHERE user_id = $1
        ORDER BY lower(name), name`,
      [userId]
    );
    return result.rows.map(namedResource);
  }

  async replace(collection: StoredNamedResourceRecord): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, collection.user_id);
      const result = await client.query(
        `INSERT INTO knowledge_collections
           (id, user_id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at
         WHERE knowledge_collections.user_id = EXCLUDED.user_id`,
        [
          collection.id,
          collection.user_id,
          collection.name,
          collection.created_at,
          collection.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async deleteAndDetach(
    collectionId: string,
    userId: string
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM knowledge_collections WHERE id = $1 AND user_id = $2',
            [collectionId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresNoteRepository implements NoteRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredNoteRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM notes
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(note);
  }

  async findByOwner(
    noteId: string,
    userId: string
  ): Promise<StoredNoteRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM notes WHERE id = $1 AND user_id = $2',
      [noteId, userId]
    );
    return result.rows[0] ? note(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredNoteRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM notes WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM notes WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('note', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO notes (id, user_id, title, content, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           updated_at = EXCLUDED.updated_at
         WHERE notes.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.title,
          value.content,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async patchByOwner(
    noteId: string,
    userId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null> {
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    const assign = (
      column: 'title' | 'content' | 'updated_at',
      value: string | number
    ): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.content !== undefined) assign('content', patch.content);
    assign('updated_at', patch.updated_at);
    values.push(noteId, userId);

    const result = await this.database.query<NumericRow>(
      `UPDATE notes SET ${assignments.join(', ')}
        WHERE id = $${values.length - 1} AND user_id = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? note(result.rows[0]) : null;
  }

  async deleteByOwner(noteId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM notes WHERE id = $1 AND user_id = $2',
            [noteId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresCalendarEventRepository implements CalendarEventRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwnerBetween(
    userId: string,
    from: number,
    to: number,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendar_events
        WHERE user_id = $1 AND start_at >= $2 AND start_at < $3
        ORDER BY start_at ASC
        LIMIT $4`,
      [userId, from, to, maximum]
    );
    return result.rows.map(calendarEvent);
  }

  async listRecurringByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendar_events
        WHERE user_id = $1 AND recurrence IS NOT NULL
        ORDER BY start_at ASC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(calendarEvent);
  }

  async findByOwner(
    eventId: string,
    userId: string
  ): Promise<StoredCalendarEventRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM calendar_events WHERE id = $1 AND user_id = $2',
      [eventId, userId]
    );
    return result.rows[0] ? calendarEvent(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredCalendarEventRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM calendar_events WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM calendar_events WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('calendar-event', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO calendar_events
           (id, user_id, title, notes, start_at, end_at, all_day,
            recurrence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           notes = EXCLUDED.notes,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           all_day = EXCLUDED.all_day,
           recurrence = EXCLUDED.recurrence,
           updated_at = EXCLUDED.updated_at
         WHERE calendar_events.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.title,
          value.notes,
          value.start_at,
          value.end_at,
          value.all_day,
          value.recurrence,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async deleteByOwner(eventId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM calendar_events WHERE id = $1 AND user_id = $2',
            [eventId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresAutomationRepository implements AutomationRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredAutomationRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM automations
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(automation);
  }

  async findByOwner(
    automationId: string,
    userId: string
  ): Promise<StoredAutomationRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM automations WHERE id = $1 AND user_id = $2',
      [automationId, userId]
    );
    return result.rows[0] ? automation(result.rows[0]) : null;
  }

  async findById(automationId: string): Promise<StoredAutomationRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM automations WHERE id = $1',
      [automationId]
    );
    return result.rows[0] ? automation(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredAutomationRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM automations WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM automations WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('automation', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO automations
           (id, user_id, name, instructions, triggers, provider, model,
            notify, status, next_run_at, last_run_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           instructions = EXCLUDED.instructions,
           triggers = EXCLUDED.triggers,
           provider = EXCLUDED.provider,
           model = EXCLUDED.model,
           notify = EXCLUDED.notify,
           status = EXCLUDED.status,
           next_run_at = EXCLUDED.next_run_at,
           last_run_at = EXCLUDED.last_run_at,
           updated_at = EXCLUDED.updated_at
         WHERE automations.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.name,
          value.instructions,
          value.triggers,
          value.provider,
          value.model,
          value.notify,
          value.status,
          value.next_run_at,
          value.last_run_at,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async listDue(
    now: number,
    maximum: number
  ): Promise<StoredAutomationRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM automations
        WHERE status = 'active'
          AND next_run_at IS NOT NULL
          AND next_run_at <= $1
        ORDER BY next_run_at ASC
        LIMIT $2`,
      [now, maximum]
    );
    return result.rows.map(automation);
  }

  async advanceNextRun(
    automationId: string,
    observedNextRunAt: number,
    nextRunAt: number | null,
    lastRunAt: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE automations
              SET next_run_at = $1, last_run_at = $2
              WHERE id = $3 AND next_run_at = $4`,
            [nextRunAt, lastRunAt, automationId, observedNextRunAt]
          )
        ).rowCount
      ) > 0
    );
  }

  async setStatus(
    automationId: string,
    userId: string,
    status: string,
    nextRunAt: number | null,
    updatedAt: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE automations
              SET status = $1, next_run_at = $2, updated_at = $3
              WHERE id = $4 AND user_id = $5`,
            [status, nextRunAt, updatedAt, automationId, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async deleteByOwner(automationId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM automations WHERE id = $1 AND user_id = $2',
            [automationId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresAutomationRunRepository implements AutomationRunRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insert(run: StoredAutomationRunRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO automation_runs
         (id, automation_id, user_id, scheduled_for, started_at, finished_at,
          status, session_id, assistant_message_id, error, seen_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        run.id,
        run.automation_id,
        run.user_id,
        run.scheduled_for,
        run.started_at,
        run.finished_at,
        run.status,
        run.session_id,
        run.assistant_message_id,
        run.error,
        run.seen_at,
        run.created_at,
      ]
    );
  }

  async findByOwner(
    runId: string,
    userId: string
  ): Promise<StoredAutomationRunRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM automation_runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    return result.rows[0] ? automationRun(result.rows[0]) : null;
  }

  async listByOwner(
    userId: string,
    options: {
      automationId?: string;
      from?: number;
      to?: number;
      maximum: number;
    }
  ): Promise<StoredAutomationRunRecord[]> {
    const clauses = ['user_id = $1'];
    const values: Array<string | number> = [userId];
    if (options.automationId !== undefined) {
      values.push(options.automationId);
      clauses.push(`automation_id = $${values.length}`);
    }
    if (options.from !== undefined) {
      values.push(options.from);
      clauses.push(`scheduled_for >= $${values.length}`);
    }
    if (options.to !== undefined) {
      values.push(options.to);
      clauses.push(`scheduled_for < $${values.length}`);
    }
    values.push(options.maximum);
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM automation_runs
        WHERE ${clauses.join(' AND ')}
        ORDER BY scheduled_for DESC
        LIMIT $${values.length}`,
      values
    );
    return result.rows.map(automationRun);
  }

  async listUnfinished(maximum: number): Promise<StoredAutomationRunRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM automation_runs
        WHERE status IN ('queued', 'running')
        ORDER BY scheduled_for ASC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(automationRun);
  }

  async markStarted(
    runId: string,
    sessionId: string,
    assistantMessageId: string,
    startedAt: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE automation_runs
              SET session_id = $1, assistant_message_id = $2, started_at = $3,
                  status = 'running'
              WHERE id = $4 AND status = 'queued'`,
            [sessionId, assistantMessageId, startedAt, runId]
          )
        ).rowCount
      ) > 0
    );
  }

  async finalize(
    runId: string,
    status: string,
    finishedAt: number,
    error: string | null
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE automation_runs
              SET status = $1, finished_at = $2, error = $3
              WHERE id = $4 AND status IN ('queued', 'running')`,
            [status, finishedAt, error, runId]
          )
        ).rowCount
      ) > 0
    );
  }

  async countUnseenFinished(userId: string): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM automation_runs
        WHERE user_id = $1
          AND status IN ('succeeded', 'failed')
          AND seen_at IS NULL`,
      [userId]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async markSeenBefore(userId: string, seenAt: number): Promise<number> {
    return changes(
      (
        await this.database.query(
          `UPDATE automation_runs
            SET seen_at = $1
            WHERE user_id = $2
              AND status IN ('succeeded', 'failed')
              AND seen_at IS NULL
              AND finished_at IS NOT NULL
              AND finished_at <= $3`,
          [seenAt, userId, seenAt]
        )
      ).rowCount
    );
  }
}

class PostgresToolServerRepository implements ToolServerRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(maximum: number): Promise<StoredToolServerRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_servers
        ORDER BY updated_at DESC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(toolServer);
  }

  async findById(serverId: string): Promise<StoredToolServerRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM tool_servers WHERE id = $1',
      [serverId]
    );
    return result.rows[0] ? toolServer(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredToolServerRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query(
        'SELECT id FROM tool_servers WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM tool_servers'
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('tool-server', maximum);
        }
      }
      await client.query(
        `INSERT INTO tool_servers
           (id, user_id, name, description, kind, base_url, spec, spec_digest,
            spec_revision, auth_mode, auth_header, access_mode, enabled,
            timeout_ms, max_response_bytes, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
                 $15, $16, $17)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           base_url = EXCLUDED.base_url,
           spec = EXCLUDED.spec,
           spec_digest = EXCLUDED.spec_digest,
           spec_revision = EXCLUDED.spec_revision,
           auth_mode = EXCLUDED.auth_mode,
           auth_header = EXCLUDED.auth_header,
           access_mode = EXCLUDED.access_mode,
           enabled = EXCLUDED.enabled,
           timeout_ms = EXCLUDED.timeout_ms,
           max_response_bytes = EXCLUDED.max_response_bytes,
           updated_at = EXCLUDED.updated_at`,
        [
          value.id,
          value.user_id,
          value.name,
          value.description,
          value.kind,
          value.base_url,
          value.spec,
          value.spec_digest,
          value.spec_revision,
          value.auth_mode,
          value.auth_header,
          value.access_mode,
          value.enabled,
          value.timeout_ms,
          value.max_response_bytes,
          value.created_at,
          value.updated_at,
        ]
      );
    });
  }

  async delete(serverId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query('DELETE FROM tool_servers WHERE id = $1', [
            serverId,
          ])
        ).rowCount
      ) > 0
    );
  }
}

class PostgresToolServerToolRepository implements ToolServerToolRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByServer(serverId: string): Promise<StoredToolServerToolRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_server_tools
        WHERE server_id = $1
        ORDER BY name ASC`,
      [serverId]
    );
    return result.rows.map(toolServerTool);
  }

  async replaceAllForServer(
    serverId: string,
    tools: readonly StoredToolServerToolRecord[]
  ): Promise<void> {
    await this.database.transaction(async client => {
      const previousResult = await client.query<{
        name: string;
        enabled: unknown;
        side_effect: unknown;
      }>(
        `SELECT name, enabled, side_effect FROM tool_server_tools
          WHERE server_id = $1 FOR UPDATE`,
        [serverId]
      );
      const previous = new Map(
        previousResult.rows.map(row => [
          row.name,
          {
            enabled: number(row.enabled, 'tool enabled'),
            side_effect: number(row.side_effect, 'tool side_effect'),
          },
        ])
      );
      await client.query('DELETE FROM tool_server_tools WHERE server_id = $1', [
        serverId,
      ]);
      for (const tool of tools) {
        if (tool.server_id !== serverId) {
          throw new Error('A tool row does not belong to its server');
        }
        const kept = previous.get(tool.name);
        await client.query(
          `INSERT INTO tool_server_tools
             (id, server_id, name, description, params_schema, detail,
              side_effect, enabled, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            tool.id,
            tool.server_id,
            tool.name,
            tool.description,
            tool.params_schema,
            tool.detail,
            kept ? kept.side_effect : tool.side_effect,
            kept ? kept.enabled : tool.enabled,
            tool.created_at,
            tool.updated_at,
          ]
        );
      }
    });
  }

  async updateOverrides(
    serverId: string,
    toolName: string,
    overrides: { enabled?: number; side_effect?: number },
    updatedAt: number
  ): Promise<StoredToolServerToolRecord | null> {
    const assignments: string[] = ['updated_at = $1'];
    const values: Array<string | number> = [updatedAt];
    if (overrides.enabled !== undefined) {
      values.push(overrides.enabled);
      assignments.push(`enabled = $${values.length}`);
    }
    if (overrides.side_effect !== undefined) {
      values.push(overrides.side_effect);
      assignments.push(`side_effect = $${values.length}`);
    }
    values.push(serverId, toolName);
    const result = await this.database.query<NumericRow>(
      `UPDATE tool_server_tools
        SET ${assignments.join(', ')}
        WHERE server_id = $${values.length - 1} AND name = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? toolServerTool(result.rows[0]) : null;
  }
}

class PostgresToolServerCredentialRepository implements ToolServerCredentialRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async find(
    serverId: string,
    userId: string
  ): Promise<StoredToolServerCredentialRecord | null> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_server_credentials
        WHERE server_id = $1 AND user_id = $2`,
      [serverId, userId]
    );
    return result.rows[0] ? toolServerCredential(result.rows[0]) : null;
  }

  async upsert(credential: StoredToolServerCredentialRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO tool_server_credentials
         (id, server_id, user_id, secret, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (server_id, user_id) DO UPDATE SET
         secret = EXCLUDED.secret,
         updated_at = EXCLUDED.updated_at`,
      [
        credential.id,
        credential.server_id,
        credential.user_id,
        credential.secret,
        credential.created_at,
        credential.updated_at,
      ]
    );
  }

  async delete(serverId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `DELETE FROM tool_server_credentials
              WHERE server_id = $1 AND user_id = $2`,
            [serverId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresToolApprovalRepository implements ToolApprovalRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insert(approval: StoredToolApprovalRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO tool_approvals
         (id, user_id, session_id, server_id, tool_name, call_id,
          arguments_digest, scope, status, created_at, resolved_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        approval.id,
        approval.user_id,
        approval.session_id,
        approval.server_id,
        approval.tool_name,
        approval.call_id,
        approval.arguments_digest,
        approval.scope,
        approval.status,
        approval.created_at,
        approval.resolved_at,
        approval.expires_at,
      ]
    );
  }

  async findByOwner(
    approvalId: string,
    userId: string
  ): Promise<StoredToolApprovalRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM tool_approvals WHERE id = $1 AND user_id = $2',
      [approvalId, userId]
    );
    return result.rows[0] ? toolApproval(result.rows[0]) : null;
  }

  async findStanding(
    userId: string,
    serverId: string | null,
    toolName: string,
    sessionId: string | null
  ): Promise<StoredToolApprovalRecord | null> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_approvals
        WHERE user_id = $1
          AND status = 'approved'
          AND tool_name = $2
          AND ((server_id IS NULL AND $3::text IS NULL) OR server_id = $3)
          AND (scope = 'always'
               OR (scope = 'session' AND session_id IS NOT NULL AND session_id = $4))
        ORDER BY resolved_at DESC
        LIMIT 1`,
      [userId, toolName, serverId, sessionId]
    );
    return result.rows[0] ? toolApproval(result.rows[0]) : null;
  }

  async resolvePending(
    approvalId: string,
    userId: string,
    status: string,
    scope: string,
    resolvedAt: number
  ): Promise<StoredToolApprovalRecord | null> {
    const result = await this.database.query<NumericRow>(
      `UPDATE tool_approvals
        SET status = $1, scope = $2, resolved_at = $3
        WHERE id = $4 AND user_id = $5 AND status = 'pending'
          AND (expires_at IS NULL OR expires_at > $3)
        RETURNING *`,
      [status, scope, resolvedAt, approvalId, userId]
    );
    return result.rows[0] ? toolApproval(result.rows[0]) : null;
  }

  async listPendingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_approvals
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at ASC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(toolApproval);
  }

  async listStandingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM tool_approvals
        WHERE user_id = $1 AND status = 'approved'
          AND scope IN ('session', 'always')
        ORDER BY resolved_at DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(toolApproval);
  }

  async expirePending(now: number): Promise<number> {
    return changes(
      (
        await this.database.query(
          `UPDATE tool_approvals
            SET status = 'expired', resolved_at = $1
            WHERE status = 'pending' AND expires_at IS NOT NULL
              AND expires_at <= $1`,
          [now]
        )
      ).rowCount
    );
  }

  async deleteByOwner(approvalId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM tool_approvals WHERE id = $1 AND user_id = $2',
            [approvalId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresPromptRepository implements PromptRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredPromptRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM prompts
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(prompt);
  }

  async findByOwner(
    promptId: string,
    userId: string
  ): Promise<StoredPromptRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM prompts WHERE id = $1 AND user_id = $2',
      [promptId, userId]
    );
    return result.rows[0] ? prompt(result.rows[0]) : null;
  }

  async findById(promptId: string): Promise<StoredPromptRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM prompts WHERE id = $1',
      [promptId]
    );
    return result.rows[0] ? prompt(result.rows[0]) : null;
  }

  async findBySlug(
    userId: string,
    slug: string
  ): Promise<StoredPromptRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM prompts WHERE user_id = $1 AND slug = $2',
      [userId, slug]
    );
    return result.rows[0] ? prompt(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredPromptRecord,
    maximum: number,
    archivedVersion: StoredPromptVersionRecord | null
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM prompts WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM prompts WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('prompt', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO prompts
           (id, user_id, slug, title, description, content, variables, tags,
            version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (id) DO UPDATE SET
           slug = EXCLUDED.slug,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           content = EXCLUDED.content,
           variables = EXCLUDED.variables,
           tags = EXCLUDED.tags,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at
         WHERE prompts.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.slug,
          value.title,
          value.description,
          value.content,
          value.variables,
          value.tags,
          value.version,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
      if (archivedVersion) {
        await client.query(
          `INSERT INTO prompt_versions
             (id, prompt_id, version, content, variables, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (prompt_id, version) DO NOTHING`,
          [
            archivedVersion.id,
            archivedVersion.prompt_id,
            archivedVersion.version,
            archivedVersion.content,
            archivedVersion.variables,
            archivedVersion.created_at,
          ]
        );
      }
    });
  }

  async listVersions(
    promptId: string,
    maximum: number
  ): Promise<StoredPromptVersionRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM prompt_versions
        WHERE prompt_id = $1
        ORDER BY version DESC
        LIMIT $2`,
      [promptId, maximum]
    );
    return result.rows.map(promptVersion);
  }

  async findVersion(
    promptId: string,
    version: number
  ): Promise<StoredPromptVersionRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM prompt_versions WHERE prompt_id = $1 AND version = $2',
      [promptId, version]
    );
    return result.rows[0] ? promptVersion(result.rows[0]) : null;
  }

  async deleteByOwner(promptId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM prompts WHERE id = $1 AND user_id = $2',
            [promptId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresSkillRepository implements SkillRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredSkillRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM skills
        WHERE user_id = $1
        ORDER BY updated_at DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(skill);
  }

  async findByOwner(
    skillId: string,
    userId: string
  ): Promise<StoredSkillRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM skills WHERE id = $1 AND user_id = $2',
      [skillId, userId]
    );
    return result.rows[0] ? skill(result.rows[0]) : null;
  }

  async findById(skillId: string): Promise<StoredSkillRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM skills WHERE id = $1',
      [skillId]
    );
    return result.rows[0] ? skill(result.rows[0]) : null;
  }

  async findBySlug(
    userId: string,
    slug: string
  ): Promise<StoredSkillRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM skills WHERE user_id = $1 AND slug = $2',
      [userId, slug]
    );
    return result.rows[0] ? skill(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredSkillRecord,
    maximum: number,
    archivedVersion: StoredSkillVersionRecord | null
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM skills WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM skills WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('skill', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO skills
           (id, user_id, slug, name, description, instructions, enabled,
            version, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET
           slug = EXCLUDED.slug,
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           instructions = EXCLUDED.instructions,
           enabled = EXCLUDED.enabled,
           version = EXCLUDED.version,
           updated_at = EXCLUDED.updated_at
         WHERE skills.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.slug,
          value.name,
          value.description,
          value.instructions,
          value.enabled,
          value.version,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
      if (archivedVersion) {
        await client.query(
          `INSERT INTO skill_versions
             (id, skill_id, version, instructions, created_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (skill_id, version) DO NOTHING`,
          [
            archivedVersion.id,
            archivedVersion.skill_id,
            archivedVersion.version,
            archivedVersion.instructions,
            archivedVersion.created_at,
          ]
        );
      }
    });
  }

  async listVersions(
    skillId: string,
    maximum: number
  ): Promise<StoredSkillVersionRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM skill_versions
        WHERE skill_id = $1
        ORDER BY version DESC
        LIMIT $2`,
      [skillId, maximum]
    );
    return result.rows.map(skillVersion);
  }

  async findVersion(
    skillId: string,
    version: number
  ): Promise<StoredSkillVersionRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM skill_versions WHERE skill_id = $1 AND version = $2',
      [skillId, version]
    );
    return result.rows[0] ? skillVersion(result.rows[0]) : null;
  }

  async deleteByOwner(skillId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM skills WHERE id = $1 AND user_id = $2',
            [skillId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresSkillFileRepository implements SkillFileRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listBySkill(skillId: string): Promise<StoredSkillFileRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM skill_files
        WHERE skill_id = $1
        ORDER BY path ASC`,
      [skillId]
    );
    return result.rows.map(skillFile);
  }

  async find(
    skillId: string,
    path: string
  ): Promise<StoredSkillFileRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM skill_files WHERE skill_id = $1 AND path = $2',
      [skillId, path]
    );
    return result.rows[0] ? skillFile(result.rows[0]) : null;
  }

  async upsert(
    file: StoredSkillFileRecord,
    maximumPerSkill: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      const existing = await client.query(
        'SELECT id FROM skill_files WHERE skill_id = $1 AND path = $2 FOR UPDATE',
        [file.skill_id, file.path]
      );
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM skill_files WHERE skill_id = $1',
          [file.skill_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximumPerSkill) {
          throw new PersistenceResourceLimitError(
            'skill-file',
            maximumPerSkill
          );
        }
      }
      await client.query(
        `INSERT INTO skill_files
           (id, skill_id, path, content, size, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (skill_id, path) DO UPDATE SET
           content = EXCLUDED.content,
           size = EXCLUDED.size,
           updated_at = EXCLUDED.updated_at`,
        [
          file.id,
          file.skill_id,
          file.path,
          file.content,
          file.size,
          file.created_at,
          file.updated_at,
        ]
      );
    });
  }

  async replaceAllForSkill(
    skillId: string,
    files: readonly StoredSkillFileRecord[]
  ): Promise<void> {
    await this.database.transaction(async client => {
      await client.query('DELETE FROM skill_files WHERE skill_id = $1', [
        skillId,
      ]);
      for (const file of files) {
        if (file.skill_id !== skillId) {
          throw new Error('A skill file does not belong to its skill');
        }
        await client.query(
          `INSERT INTO skill_files
             (id, skill_id, path, content, size, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            file.id,
            file.skill_id,
            file.path,
            file.content,
            file.size,
            file.created_at,
            file.updated_at,
          ]
        );
      }
    });
  }

  async delete(skillId: string, path: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM skill_files WHERE skill_id = $1 AND path = $2',
            [skillId, path]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresSessionFolderRepository implements SessionFolderRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredNamedResourceRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM session_folders
        WHERE user_id = $1
        ORDER BY lower(name), name
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(namedResource);
  }

  async replaceWithLimit(
    folder: StoredNamedResourceRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, folder.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM session_folders WHERE id = $1 FOR UPDATE',
        [folder.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== folder.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM session_folders WHERE user_id = $1',
          [folder.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('session-folder', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO session_folders (id, user_id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           updated_at = EXCLUDED.updated_at
         WHERE session_folders.user_id = EXCLUDED.user_id`,
        [
          folder.id,
          folder.user_id,
          folder.name,
          folder.created_at,
          folder.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async deleteAndDetach(folderId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM session_folders WHERE id = $1 AND user_id = $2',
            [folderId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresPreferenceRepository implements PreferenceRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async resolveOwner(userId?: string): Promise<string | null> {
    if (userId) return userId;
    const result = await this.database.query<{ id: string }>(
      'SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1'
    );
    return result.rows[0]?.id ?? null;
  }

  async listByOwner(userId: string): Promise<StoredPreferenceRecord[]> {
    const result = await this.database.query<
      StoredPreferenceRecord & QueryResultRow
    >(
      'SELECT key, value FROM user_preferences WHERE user_id = $1 ORDER BY key ASC',
      [userId]
    );
    return result.rows;
  }

  async mutateAll(
    userId: string | undefined,
    timestamp: number,
    mutation: (
      preferences: readonly StoredPreferenceRecord[]
    ) => readonly StoredPreferenceRecord[] | undefined
  ): Promise<{
    userId: string;
    preferences: StoredPreferenceRecord[];
  } | null> {
    return this.database.transaction(
      async client => {
        const owner = userId
          ? await client.query<{ id: string }>(
              'SELECT id FROM users WHERE id = $1 FOR UPDATE',
              [userId]
            )
          : await client.query<{ id: string }>(
              `SELECT id FROM users
              ORDER BY created_at ASC, id ASC
              LIMIT 1
              FOR UPDATE`
            );
        const ownerId = owner.rows[0]?.id;
        if (!ownerId) {
          if (userId) throw new Error('Resource owner does not exist');
          return null;
        }

        // READ COMMITTED gives a writer that waited for the owner lock a fresh
        // snapshot here, including the preceding writer's committed rows.
        const current = await client.query<
          StoredPreferenceRecord & QueryResultRow
        >(
          `SELECT key, value FROM user_preferences
          WHERE user_id = $1
          ORDER BY key ASC`,
          [ownerId]
        );
        const requested = mutation(current.rows);
        if (requested === undefined) {
          return { userId: ownerId, preferences: current.rows };
        }

        const preferences = [...requested].sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0
        );
        if (
          new Set(preferences.map(preference => preference.key)).size !==
          preferences.length
        ) {
          throw new Error('Preference mutation returned duplicate keys');
        }
        await client.query('DELETE FROM user_preferences WHERE user_id = $1', [
          ownerId,
        ]);
        for (const preference of preferences) {
          await client.query(
            `INSERT INTO user_preferences
             (id, user_id, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              uuidv4(),
              ownerId,
              preference.key,
              preference.value,
              timestamp,
              timestamp,
            ]
          );
        }
        return { userId: ownerId, preferences };
      },
      { isolationLevel: 'read committed' }
    );
  }

  async replaceAll(
    userId: string,
    preferences: readonly StoredPreferenceRecord[],
    timestamp: number
  ): Promise<void> {
    await this.mutateAll(userId, timestamp, () => preferences);
  }

  async deleteKeys(userId: string, keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return changes(
      (
        await this.database.query(
          'DELETE FROM user_preferences WHERE user_id = $1 AND key = ANY($2::text[])',
          [userId, [...keys]]
        )
      ).rowCount
    );
  }
}

class PostgresSystemSettingRepository implements SystemSettingRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async get(key: string): Promise<string | null> {
    const result = await this.database.query<{ value: string }>(
      'SELECT value FROM system_settings WHERE key = $1',
      [key]
    );
    return result.rows[0]?.value ?? null;
  }

  async getMany(keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const result = await this.database.query<{ key: string; value: string }>(
      'SELECT key, value FROM system_settings WHERE key = ANY($1::text[])',
      [[...keys]]
    );
    return Object.fromEntries(result.rows.map(row => [row.key, row.value]));
  }

  async upsert(key: string, value: string, updatedAt: number): Promise<void> {
    await this.database.query(
      `INSERT INTO system_settings (key, value, updated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET
         value = EXCLUDED.value,
         updated_at = EXCLUDED.updated_at`,
      [key, value, updatedAt]
    );
  }

  async upsertMany(
    values: Readonly<Record<string, string>>,
    updatedAt: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      for (const [key, value] of Object.entries(values)) {
        await client.query(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES ($1, $2, $3)
           ON CONFLICT (key) DO UPDATE SET
             value = EXCLUDED.value,
             updated_at = EXCLUDED.updated_at`,
          [key, value, updatedAt]
        );
      }
    });
  }
}

const ARCHIVE_TABLES = {
  session: 'sessions',
  'session-folder': 'session_folders',
  note: 'notes',
  'knowledge-collection': 'knowledge_collections',
  document: 'documents',
  persona: 'personas',
  prompt: 'prompts',
  skill: 'skills',
  'tool-server': 'tool_servers',
} as const;

class PostgresDataArchiveRepository implements DataArchiveRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async ownerOf(
    resource: keyof typeof ARCHIVE_TABLES,
    id: string
  ): Promise<string | null> {
    // The table name is selected only from this closed server-owned map.
    const result = await this.database.query<{ user_id: string }>(
      `SELECT user_id FROM ${ARCHIVE_TABLES[resource]} WHERE id = $1`,
      [id]
    );
    return result.rows[0]?.user_id ?? null;
  }

  async nestedOwnerOf(
    resource: 'session-message' | 'document-chunk',
    id: string
  ): Promise<{ userId: string; parentId: string } | null> {
    const definition =
      resource === 'session-message'
        ? {
            child: 'session_messages',
            owner: 'sessions',
            parent: 'session_id',
          }
        : {
            child: 'document_chunks',
            owner: 'documents',
            parent: 'document_id',
          };
    const result = await this.database.query<{
      user_id: string;
      parent_id: string;
    }>(
      `SELECT owner.user_id, child.${definition.parent} AS parent_id
         FROM ${definition.child} child
         JOIN ${definition.owner} owner ON owner.id = child.${definition.parent}
        WHERE child.id = $1`,
      [id]
    );
    const row = result.rows[0];
    return row ? { userId: row.user_id, parentId: row.parent_id } : null;
  }

  async countByOwner(
    resource: 'session-folder' | 'note',
    userId: string
  ): Promise<number> {
    const table = resource === 'session-folder' ? 'session_folders' : 'notes';
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM ${table} WHERE user_id = $1`,
      [userId]
    );
    return number(result.rows[0]?.count || '0', 'archive resource count');
  }

  async resourceDeletionReserved(
    resource: 'document',
    id: string
  ): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1 FROM platform_resource_deletion_tombstones
        WHERE resource_type = $1 AND resource_id = $2`,
      [resource, id]
    );
    return result.rowCount === 1;
  }

  async applyImport(plan: DataArchiveApplyPlan): Promise<void> {
    await this.database.transaction(
      async client => {
        await lockOwner(client, plan.userId);
        const shouldWrite = async (
          table: string,
          id: string
        ): Promise<boolean> => {
          const result = await client.query<{ user_id: string }>(
            `SELECT user_id FROM ${table} WHERE id = $1 FOR UPDATE`,
            [id]
          );
          const existing = result.rows[0];
          if (existing && existing.user_id !== plan.userId) {
            throw new PersistenceResourceConflictError();
          }
          return !existing || plan.strategy === 'overwrite';
        };
        const enforceLimit = async (
          table: 'notes' | 'session_folders',
          maximum: number
        ): Promise<void> => {
          const result = await client.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM ${table} WHERE user_id = $1`,
            [plan.userId]
          );
          if (Number(result.rows[0]?.count || 0) >= maximum) {
            throw new PersistenceResourceLimitError(
              table === 'notes' ? 'note' : 'session-folder',
              maximum
            );
          }
        };

        const currentPreferences = await client.query<
          StoredPreferenceRecord & QueryResultRow
        >(
          `SELECT key, value FROM user_preferences
            WHERE user_id = $1
            ORDER BY key ASC`,
          [plan.userId]
        );
        const preferences =
          typeof plan.preferences === 'function'
            ? [...plan.preferences(currentPreferences.rows)]
            : plan.preferences;
        await client.query('DELETE FROM user_preferences WHERE user_id = $1', [
          plan.userId,
        ]);
        for (const preference of preferences) {
          await client.query(
            `INSERT INTO user_preferences
             (id, user_id, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              uuidv4(),
              plan.userId,
              preference.key,
              preference.value,
              plan.timestamp,
              plan.timestamp,
            ]
          );
        }

        for (const folder of plan.sessionFolders) {
          const write = await shouldWrite('session_folders', folder.id);
          if (!write) continue;
          const existing = await client.query(
            'SELECT 1 FROM session_folders WHERE id = $1',
            [folder.id]
          );
          if (existing.rowCount === 0) {
            await enforceLimit('session_folders', plan.maximumSessionFolders);
          }
          const result = await client.query(
            `INSERT INTO session_folders
             (id, user_id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at
           WHERE session_folders.user_id = EXCLUDED.user_id`,
            [
              folder.id,
              plan.userId,
              folder.name,
              folder.created_at,
              folder.updated_at,
            ]
          );
          if (result.rowCount !== 1)
            throw new PersistenceResourceConflictError();
        }

        for (const note of plan.notes) {
          const write = await shouldWrite('notes', note.id);
          if (!write) continue;
          const existing = await client.query(
            'SELECT 1 FROM notes WHERE id = $1',
            [note.id]
          );
          if (existing.rowCount === 0) {
            await enforceLimit('notes', plan.maximumNotes);
          }
          const result = await client.query(
            `INSERT INTO notes
             (id, user_id, title, content, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             updated_at = EXCLUDED.updated_at
           WHERE notes.user_id = EXCLUDED.user_id`,
            [
              note.id,
              plan.userId,
              note.title,
              note.content,
              note.created_at,
              note.updated_at,
            ]
          );
          if (result.rowCount !== 1)
            throw new PersistenceResourceConflictError();
        }

        for (const collection of plan.knowledgeCollections) {
          if (!(await shouldWrite('knowledge_collections', collection.id))) {
            continue;
          }
          const result = await client.query(
            `INSERT INTO knowledge_collections
             (id, user_id, name, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name,
             updated_at = EXCLUDED.updated_at
           WHERE knowledge_collections.user_id = EXCLUDED.user_id`,
            [
              collection.id,
              plan.userId,
              collection.name,
              collection.created_at,
              collection.updated_at,
            ]
          );
          if (result.rowCount !== 1)
            throw new PersistenceResourceConflictError();
        }

        for (const aggregate of plan.sessions) {
          const { session } = aggregate;
          if (!(await shouldWrite('sessions', session.id))) continue;
          const result = await client.query(
            `INSERT INTO sessions
             (id, user_id, title, model, persona_id, provider_type, provider_id,
              created_at, updated_at, archived, settings, folder_id, pinned)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             title = EXCLUDED.title,
             model = EXCLUDED.model,
             persona_id = EXCLUDED.persona_id,
             provider_type = EXCLUDED.provider_type,
             provider_id = EXCLUDED.provider_id,
             updated_at = EXCLUDED.updated_at,
             archived = EXCLUDED.archived,
             settings = EXCLUDED.settings,
             folder_id = EXCLUDED.folder_id,
             pinned = EXCLUDED.pinned
           WHERE sessions.user_id = EXCLUDED.user_id`,
            [
              session.id,
              plan.userId,
              session.title,
              session.model,
              session.persona_id,
              session.provider_type,
              session.provider_id,
              session.created_at,
              session.updated_at,
              session.archived,
              session.settings,
              session.folder_id,
              session.pinned,
            ]
          );
          if (result.rowCount !== 1)
            throw new PersistenceResourceConflictError();
          await client.query(
            'DELETE FROM session_messages WHERE session_id = $1',
            [session.id]
          );
          for (const message of aggregate.messages) {
            if (message.session_id !== session.id) {
              throw new Error(
                'A chat message does not belong to its aggregate'
              );
            }
            await client.query(
              `INSERT INTO session_messages
               (id, session_id, role, content, thinking, timestamp,
                message_index, model, provider_metadata, images, statistics,
                artifacts, parent_id, branch_index, is_active, rating)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                     NULL, $13, $14, $15)`,
              [
                message.id,
                message.session_id,
                message.role,
                message.content,
                message.thinking,
                message.timestamp,
                message.message_index,
                message.model,
                message.provider_metadata,
                message.images,
                message.statistics,
                message.artifacts,
                message.branch_index,
                message.is_active,
                message.rating,
              ]
            );
          }
          for (const message of aggregate.messages) {
            if (message.parent_id) {
              await client.query(
                `UPDATE session_messages
                  SET parent_id = $1
                WHERE id = $2 AND session_id = $3`,
                [message.parent_id, message.id, session.id]
              );
            }
          }
        }

        for (const aggregate of plan.documents) {
          const { document } = aggregate;
          await client.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
            [JSON.stringify(['libre-resource-v1', 'document', document.id])]
          );
          const reserved = await client.query(
            `SELECT 1 FROM platform_resource_deletion_tombstones
              WHERE resource_type = 'document' AND resource_id = $1`,
            [document.id]
          );
          if (reserved.rowCount) {
            throw new PersistenceResourceDeletionReservedError(document.id);
          }
          if (!(await shouldWrite('documents', document.id))) continue;
          const result = await client.query(
            `INSERT INTO documents
             (id, user_id, filename, title, content, file_type, size,
              session_id, collection_id, metadata, uploaded_at, created_at,
              updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (id) DO UPDATE SET
             filename = EXCLUDED.filename,
             title = EXCLUDED.title,
             content = EXCLUDED.content,
             file_type = EXCLUDED.file_type,
             size = EXCLUDED.size,
             session_id = EXCLUDED.session_id,
             collection_id = EXCLUDED.collection_id,
             metadata = EXCLUDED.metadata,
             uploaded_at = EXCLUDED.uploaded_at,
             updated_at = EXCLUDED.updated_at
           WHERE documents.user_id = EXCLUDED.user_id`,
            [
              document.id,
              plan.userId,
              document.filename,
              document.title,
              document.content,
              document.file_type,
              document.size,
              document.session_id,
              document.collection_id,
              document.metadata,
              document.uploaded_at,
              document.created_at,
              document.updated_at,
            ]
          );
          if (result.rowCount !== 1)
            throw new PersistenceResourceConflictError();
          await client.query(
            'DELETE FROM document_chunks WHERE document_id = $1',
            [document.id]
          );
          for (const chunk of aggregate.chunks) {
            if (chunk.document_id !== document.id) {
              throw new Error(
                'A document chunk does not belong to its aggregate'
              );
            }
            await client.query(
              `INSERT INTO document_chunks
               (id, document_id, chunk_index, content, start_char, end_char,
                embedding, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NULL, $7)`,
              [
                chunk.id,
                chunk.document_id,
                chunk.chunk_index,
                chunk.content,
                chunk.start_char,
                chunk.end_char,
                chunk.created_at,
              ]
            );
          }
        }
      },
      // Every owner-scoped archive and preference mutation takes the users row
      // lock first. READ COMMITTED lets a transaction that waited for that
      // lock reread the preceding writer's committed preferences before merge.
      {
        isolationLevel: 'read committed',
        beforeCommit: plan.assertCanCommit,
      }
    );
  }
}

export const createPostgresResourceRepositories = (
  database: PostgresDatabase
): ApplicationResourceRepositories => ({
  chatSessions: new PostgresChatSessionRepository(database),
  knowledgeCollections: new PostgresKnowledgeCollectionRepository(database),
  notes: new PostgresNoteRepository(database),
  calendarEvents: new PostgresCalendarEventRepository(database),
  automations: new PostgresAutomationRepository(database),
  automationRuns: new PostgresAutomationRunRepository(database),
  toolServers: new PostgresToolServerRepository(database),
  toolServerTools: new PostgresToolServerToolRepository(database),
  toolServerCredentials: new PostgresToolServerCredentialRepository(database),
  toolApprovals: new PostgresToolApprovalRepository(database),
  prompts: new PostgresPromptRepository(database),
  skills: new PostgresSkillRepository(database),
  skillFiles: new PostgresSkillFileRepository(database),
  sessionFolders: new PostgresSessionFolderRepository(database),
  preferences: new PostgresPreferenceRepository(database),
  systemSettings: new PostgresSystemSettingRepository(database),
  archive: new PostgresDataArchiveRepository(database),
});

/** Create transaction-scoped repositories over one pinned pooled client. */
export const createPostgresTransactionalResourceRepositories = (
  database: PostgresDatabase,
  client: PoolClient
): ApplicationResourceRepositories => {
  const transactionDatabase = {
    query: client.query.bind(client),
    transaction: async <T>(operation: (nested: PoolClient) => Promise<T>) =>
      operation(client),
  } as unknown as PostgresDatabase;
  return createPostgresResourceRepositories(transactionDatabase);
};
