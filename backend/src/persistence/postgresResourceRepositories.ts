/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PoolClient, QueryResultRow } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import type {
  ApplicationResourceRepositories,
  ArenaVoteRepository,
  AutomationRepository,
  AutomationRunRepository,
  CalendarEventRepository,
  CalendarRepository,
  ChannelMessageRepository,
  EvalRunRepository,
  EvalSetRepository,
  MessageFeedbackRepository,
  ModelTariffRepository,
  UsageBudgetRepository,
  ChannelRepository,
  ChannelTimelineCursor,
  ChatSessionRepository,
  DataArchiveApplyPlan,
  DataArchiveRepository,
  KnowledgeCollectionRepository,
  NoteRepository,
  NotificationRepository,
  PersistenceCommitFence,
  PreferenceRepository,
  PromptRepository,
  SessionFolderRepository,
  SkillFileRepository,
  SkillRepository,
  StoredArenaVoteRecord,
  StoredAutomationRecord,
  StoredAutomationRunRecord,
  StoredCalendarEventRecord,
  StoredCalendarRecord,
  StoredChannelAttachmentRecord,
  StoredEvalRunRecord,
  StoredEvalSetRecord,
  StoredMessageFeedbackRecord,
  StoredModelTariffRecord,
  StoredUsageBudgetRecord,
  StoredChannelMemberRecord,
  StoredChannelMembershipView,
  StoredChannelMessageRecord,
  StoredChannelReactionRecord,
  StoredChannelRecord,
  StoredChannelUnreadRow,
  StoredChatMessageRecord,
  StoredChatSessionAggregate,
  StoredChatSessionRecord,
  StoredNamedResourceRecord,
  StoredNoteAttachmentRecord,
  StoredNotePatch,
  StoredNoteRecord,
  StoredNoteRevisionRecord,
  StoredNotificationRecord,
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
  StoredWebhookTargetRecord,
  SystemSettingRepository,
  ToolApprovalRepository,
  ToolServerCredentialRepository,
  ToolServerRepository,
  ToolServerToolRepository,
  WebhookTargetRepository,
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
  pinned: number(row.pinned ?? 0, 'note pinned'),
  created_at: number(row.created_at, 'note created_at'),
  updated_at: number(row.updated_at, 'note updated_at'),
});

const noteRevision = (row: NumericRow): StoredNoteRevisionRecord => ({
  ...(row as unknown as StoredNoteRevisionRecord),
  created_at: number(row.created_at, 'note revision created_at'),
});

const noteAttachment = (row: NumericRow): StoredNoteAttachmentRecord => ({
  ...(row as unknown as StoredNoteAttachmentRecord),
  size: number(row.size, 'note attachment size'),
  created_at: number(row.created_at, 'note attachment created_at'),
});

const calendarEvent = (row: NumericRow): StoredCalendarEventRecord => ({
  ...(row as unknown as StoredCalendarEventRecord),
  start_at: number(row.start_at, 'calendar event start_at'),
  end_at:
    row.end_at === null ? null : number(row.end_at, 'calendar event end_at'),
  all_day: number(row.all_day, 'calendar event all_day'),
  reminder_minutes:
    row.reminder_minutes === null
      ? null
      : number(row.reminder_minutes, 'calendar event reminder_minutes'),
  last_reminded_occurrence:
    row.last_reminded_occurrence === null
      ? null
      : number(
          row.last_reminded_occurrence,
          'calendar event last_reminded_occurrence'
        ),
  created_at: number(row.created_at, 'calendar event created_at'),
  updated_at: number(row.updated_at, 'calendar event updated_at'),
});

const calendar = (row: NumericRow): StoredCalendarRecord => ({
  ...(row as unknown as StoredCalendarRecord),
  created_at: number(row.created_at, 'calendar created_at'),
  updated_at: number(row.updated_at, 'calendar updated_at'),
});

const channel = (row: NumericRow): StoredChannelRecord => ({
  ...(row as unknown as StoredChannelRecord),
  created_at: number(row.created_at, 'channel created_at'),
  updated_at: number(row.updated_at, 'channel updated_at'),
  archived_at:
    row.archived_at === null
      ? null
      : number(row.archived_at, 'channel archived_at'),
});

const channelMember = (row: NumericRow): StoredChannelMemberRecord => ({
  ...(row as unknown as StoredChannelMemberRecord),
  joined_at: number(row.joined_at, 'channel member joined_at'),
  last_read_at: number(row.last_read_at, 'channel member last_read_at'),
});

const channelMessage = (row: NumericRow): StoredChannelMessageRecord => ({
  ...(row as unknown as StoredChannelMessageRecord),
  created_at: number(row.created_at, 'channel message created_at'),
  updated_at: number(row.updated_at, 'channel message updated_at'),
  edited_at:
    row.edited_at === null
      ? null
      : number(row.edited_at, 'channel message edited_at'),
  deleted_at:
    row.deleted_at === null
      ? null
      : number(row.deleted_at, 'channel message deleted_at'),
  pinned_at:
    row.pinned_at === null
      ? null
      : number(row.pinned_at, 'channel message pinned_at'),
});

const channelReaction = (row: NumericRow): StoredChannelReactionRecord => ({
  ...(row as unknown as StoredChannelReactionRecord),
  created_at: number(row.created_at, 'channel reaction created_at'),
});

const channelAttachment = (row: NumericRow): StoredChannelAttachmentRecord => ({
  ...(row as unknown as StoredChannelAttachmentRecord),
  size: number(row.size, 'channel attachment size'),
  created_at: number(row.created_at, 'channel attachment created_at'),
});

const notification = (row: NumericRow): StoredNotificationRecord => ({
  ...(row as unknown as StoredNotificationRecord),
  created_at: number(row.created_at, 'notification created_at'),
  read_at:
    row.read_at === null ? null : number(row.read_at, 'notification read_at'),
});

const webhookTarget = (row: NumericRow): StoredWebhookTargetRecord => ({
  ...(row as unknown as StoredWebhookTargetRecord),
  enabled: number(row.enabled, 'webhook target enabled'),
  created_at: number(row.created_at, 'webhook target created_at'),
  updated_at: number(row.updated_at, 'webhook target updated_at'),
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

  async findById(
    collectionId: string
  ): Promise<StoredNamedResourceRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM knowledge_collections WHERE id = $1',
      [collectionId]
    );
    return result.rows[0] ? namedResource(result.rows[0]) : null;
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
        ORDER BY pinned DESC, updated_at DESC
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
        `INSERT INTO notes (id, user_id, title, content, pinned, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           content = EXCLUDED.content,
           pinned = EXCLUDED.pinned,
           updated_at = EXCLUDED.updated_at
         WHERE notes.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.title,
          value.content,
          value.pinned,
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
      column: 'title' | 'content' | 'pinned' | 'updated_at',
      value: string | number
    ): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.content !== undefined) assign('content', patch.content);
    if (patch.pinned !== undefined) assign('pinned', patch.pinned);
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

  async findById(noteId: string): Promise<StoredNoteRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM notes WHERE id = $1',
      [noteId]
    );
    return result.rows[0] ? note(result.rows[0]) : null;
  }

  async patchById(
    noteId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null> {
    const assignments: string[] = [];
    const values: Array<string | number> = [];
    const assign = (
      column: 'title' | 'content' | 'pinned' | 'updated_at',
      value: string | number
    ): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };
    if (patch.title !== undefined) assign('title', patch.title);
    if (patch.content !== undefined) assign('content', patch.content);
    if (patch.pinned !== undefined) assign('pinned', patch.pinned);
    assign('updated_at', patch.updated_at);
    values.push(noteId);

    const result = await this.database.query<NumericRow>(
      `UPDATE notes SET ${assignments.join(', ')}
        WHERE id = $${values.length}
        RETURNING *`,
      values
    );
    return result.rows[0] ? note(result.rows[0]) : null;
  }

  async listRevisions(
    noteId: string,
    maximum: number
  ): Promise<StoredNoteRevisionRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM note_revisions
        WHERE note_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [noteId, maximum]
    );
    return result.rows.map(noteRevision);
  }

  async findRevision(
    revisionId: string
  ): Promise<StoredNoteRevisionRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM note_revisions WHERE id = $1',
      [revisionId]
    );
    return result.rows[0] ? noteRevision(result.rows[0]) : null;
  }

  async insertRevision(
    revision: StoredNoteRevisionRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      // Strictly increasing per note so same-millisecond snapshots keep a
      // deterministic order for listing, restore, and pruning.
      await client.query(
        `INSERT INTO note_revisions (id, note_id, title, content, created_at)
         SELECT $1, $2, $3, $4,
                GREATEST($5::bigint, COALESCE(MAX(created_at), 0) + 1)
           FROM note_revisions WHERE note_id = $2`,
        [
          revision.id,
          revision.note_id,
          revision.title,
          revision.content,
          revision.created_at,
        ]
      );
      await client.query(
        `DELETE FROM note_revisions
          WHERE note_id = $1
            AND id NOT IN (
              SELECT id FROM note_revisions
               WHERE note_id = $1
               ORDER BY created_at DESC, id DESC
               LIMIT $2
            )`,
        [revision.note_id, maximum]
      );
    });
  }

  async listAttachments(noteId: string): Promise<StoredNoteAttachmentRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM note_attachments
        WHERE note_id = $1
        ORDER BY created_at ASC, id ASC`,
      [noteId]
    );
    return result.rows.map(noteAttachment);
  }

  async findAttachment(
    attachmentId: string
  ): Promise<StoredNoteAttachmentRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM note_attachments WHERE id = $1',
      [attachmentId]
    );
    return result.rows[0] ? noteAttachment(result.rows[0]) : null;
  }

  async insertAttachmentWithLimit(
    attachment: StoredNoteAttachmentRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await client.query('SELECT id FROM notes WHERE id = $1 FOR UPDATE', [
        attachment.note_id,
      ]);
      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM note_attachments WHERE note_id = $1',
        [attachment.note_id]
      );
      if (Number(count.rows[0]?.count || 0) >= maximum) {
        throw new PersistenceResourceLimitError('note-attachment', maximum);
      }
      await client.query(
        `INSERT INTO note_attachments
           (id, note_id, blob_id, filename, content_type, size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          attachment.id,
          attachment.note_id,
          attachment.blob_id,
          attachment.filename,
          attachment.content_type,
          attachment.size,
          attachment.created_at,
        ]
      );
    });
  }

  async deleteAttachment(attachmentId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM note_attachments WHERE id = $1',
            [attachmentId]
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

  async listByCalendarsBetween(
    calendarIds: readonly string[],
    from: number,
    to: number,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    if (calendarIds.length === 0) return [];
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendar_events
        WHERE calendar_id = ANY($1::text[])
          AND start_at >= $2 AND start_at < $3
        ORDER BY start_at ASC
        LIMIT $4`,
      [[...calendarIds], from, to, maximum]
    );
    return result.rows.map(calendarEvent);
  }

  async listRecurringByCalendars(
    calendarIds: readonly string[],
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    if (calendarIds.length === 0) return [];
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendar_events
        WHERE calendar_id = ANY($1::text[])
          AND recurrence IS NOT NULL
        ORDER BY start_at ASC
        LIMIT $2`,
      [[...calendarIds], maximum]
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

  async findById(eventId: string): Promise<StoredCalendarEventRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM calendar_events WHERE id = $1',
      [eventId]
    );
    return result.rows[0] ? calendarEvent(result.rows[0]) : null;
  }

  async listWithReminders(
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendar_events
        WHERE reminder_minutes IS NOT NULL
        ORDER BY start_at ASC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(calendarEvent);
  }

  async markReminded(
    eventId: string,
    occurrenceStart: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE calendar_events
              SET last_reminded_occurrence = $1
              WHERE id = $2
                AND (last_reminded_occurrence IS NULL
                  OR last_reminded_occurrence < $1)`,
            [occurrenceStart, eventId]
          )
        ).rowCount
      ) > 0
    );
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
            recurrence, calendar_id, reminder_minutes,
            last_reminded_occurrence, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           notes = EXCLUDED.notes,
           start_at = EXCLUDED.start_at,
           end_at = EXCLUDED.end_at,
           all_day = EXCLUDED.all_day,
           recurrence = EXCLUDED.recurrence,
           calendar_id = EXCLUDED.calendar_id,
           reminder_minutes = EXCLUDED.reminder_minutes,
           last_reminded_occurrence = EXCLUDED.last_reminded_occurrence,
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
          value.calendar_id,
          value.reminder_minutes,
          value.last_reminded_occurrence,
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

class PostgresCalendarRepository implements CalendarRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredCalendarRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM calendars
        WHERE user_id = $1
        ORDER BY created_at ASC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(calendar);
  }

  async findByOwner(
    calendarId: string,
    userId: string
  ): Promise<StoredCalendarRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM calendars WHERE id = $1 AND user_id = $2',
      [calendarId, userId]
    );
    return result.rows[0] ? calendar(result.rows[0]) : null;
  }

  async findById(calendarId: string): Promise<StoredCalendarRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM calendars WHERE id = $1',
      [calendarId]
    );
    return result.rows[0] ? calendar(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredCalendarRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM calendars WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM calendars WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('calendar', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO calendars
           (id, user_id, name, color, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           color = EXCLUDED.color,
           updated_at = EXCLUDED.updated_at
         WHERE calendars.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.name,
          value.color,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async deleteAndDetach(calendarId: string, userId: string): Promise<boolean> {
    return this.database.transaction(async client => {
      const deleted =
        changes(
          (
            await client.query(
              'DELETE FROM calendars WHERE id = $1 AND user_id = $2',
              [calendarId, userId]
            )
          ).rowCount
        ) > 0;
      if (deleted) {
        await client.query(
          `UPDATE calendar_events
            SET calendar_id = NULL
            WHERE calendar_id = $1 AND user_id = $2`,
          [calendarId, userId]
        );
      }
      return deleted;
    });
  }
}

class PostgresChannelRepository implements ChannelRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insertWithOwner(
    value: StoredChannelRecord,
    owner: StoredChannelMemberRecord,
    maximumPerUser: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, owner.user_id);
      const count = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM channels WHERE created_by = $1',
        [owner.user_id]
      );
      if (Number(count.rows[0]?.count || 0) >= maximumPerUser) {
        throw new PersistenceResourceLimitError('channel', maximumPerUser);
      }
      await client.query(
        `INSERT INTO channels
           (id, type, name, description, dm_key, created_by,
            created_at, updated_at, archived_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          value.id,
          value.type,
          value.name,
          value.description,
          value.dm_key,
          value.created_by,
          value.created_at,
          value.updated_at,
          value.archived_at,
        ]
      );
      await client.query(
        `INSERT INTO channel_members
           (channel_id, user_id, role, joined_at, last_read_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          owner.channel_id,
          owner.user_id,
          owner.role,
          owner.joined_at,
          owner.last_read_at,
        ]
      );
    });
  }

  async findById(channelId: string): Promise<StoredChannelRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM channels WHERE id = $1',
      [channelId]
    );
    return result.rows[0] ? channel(result.rows[0]) : null;
  }

  async findByDmKey(dmKey: string): Promise<StoredChannelRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM channels WHERE dm_key = $1',
      [dmKey]
    );
    return result.rows[0] ? channel(result.rows[0]) : null;
  }

  async listForUser(
    userId: string,
    maximum: number
  ): Promise<StoredChannelMembershipView[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT
         c.id, c.type, c.name, c.description, c.dm_key, c.created_by,
         c.created_at, c.updated_at, c.archived_at,
         m.channel_id AS member_channel_id, m.user_id AS member_user_id,
         m.role AS member_role, m.joined_at AS member_joined_at,
         m.last_read_at AS member_last_read_at
       FROM channel_members m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.user_id = $1
       ORDER BY c.updated_at DESC
       LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(row => ({
      channel: channel(row),
      member: channelMember({
        channel_id: row.member_channel_id,
        user_id: row.member_user_id,
        role: row.member_role,
        joined_at: row.member_joined_at,
        last_read_at: row.member_last_read_at,
      } as NumericRow),
    }));
  }

  async listPublic(maximum: number): Promise<StoredChannelRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channels
        WHERE type = 'public' AND archived_at IS NULL
        ORDER BY updated_at DESC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(channel);
  }

  async update(value: StoredChannelRecord): Promise<void> {
    await this.database.query(
      `UPDATE channels SET
         name = $1,
         description = $2,
         updated_at = $3,
         archived_at = $4
       WHERE id = $5`,
      [
        value.name,
        value.description,
        value.updated_at,
        value.archived_at,
        value.id,
      ]
    );
  }

  async delete(channelId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query('DELETE FROM channels WHERE id = $1', [
            channelId,
          ])
        ).rowCount
      ) > 0
    );
  }

  async upsertMember(
    member: StoredChannelMemberRecord,
    maximumMembers: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      const existing = await client.query(
        `SELECT 1 FROM channel_members
          WHERE channel_id = $1 AND user_id = $2
          FOR UPDATE`,
        [member.channel_id, member.user_id]
      );
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM channel_members
            WHERE channel_id = $1`,
          [member.channel_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximumMembers) {
          throw new PersistenceResourceLimitError(
            'channel-member',
            maximumMembers
          );
        }
      }
      await client.query(
        `INSERT INTO channel_members
           (channel_id, user_id, role, joined_at, last_read_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET
           role = EXCLUDED.role`,
        [
          member.channel_id,
          member.user_id,
          member.role,
          member.joined_at,
          member.last_read_at,
        ]
      );
    });
  }

  async findMember(
    channelId: string,
    userId: string
  ): Promise<StoredChannelMemberRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM channel_members WHERE channel_id = $1 AND user_id = $2',
      [channelId, userId]
    );
    return result.rows[0] ? channelMember(result.rows[0]) : null;
  }

  async listMembers(
    channelId: string,
    maximum: number
  ): Promise<StoredChannelMemberRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_members
        WHERE channel_id = $1
        ORDER BY joined_at ASC
        LIMIT $2`,
      [channelId, maximum]
    );
    return result.rows.map(channelMember);
  }

  async removeMember(channelId: string, userId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2',
            [channelId, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async advanceLastRead(
    channelId: string,
    userId: string,
    lastReadAt: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE channel_members
              SET last_read_at = $1
              WHERE channel_id = $2 AND user_id = $3 AND last_read_at < $1`,
            [lastReadAt, channelId, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async unreadSummaryForUser(
    userId: string
  ): Promise<StoredChannelUnreadRow[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT
         m.channel_id,
         COUNT(msg.id)::text AS unread_count,
         MAX(msg.created_at) AS latest_message_at
       FROM channel_members m
       LEFT JOIN channel_messages msg
         ON msg.channel_id = m.channel_id
        AND msg.created_at > m.last_read_at
        AND msg.deleted_at IS NULL
        AND (msg.user_id IS NULL OR msg.user_id != m.user_id
             OR msg.author_kind != 'user')
       WHERE m.user_id = $1
       GROUP BY m.channel_id`,
      [userId]
    );
    return result.rows.map(row => ({
      channel_id: row.channel_id as string,
      unread_count: number(row.unread_count, 'channel unread_count'),
      latest_message_at:
        row.latest_message_at === null
          ? null
          : number(row.latest_message_at, 'channel latest_message_at'),
    }));
  }
}

class PostgresChannelMessageRepository implements ChannelMessageRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insertIfAbsent(
    message: StoredChannelMessageRecord,
    attachments: readonly StoredChannelAttachmentRecord[],
    maximumPerChannel: number
  ): Promise<{ stored: StoredChannelMessageRecord; inserted: boolean }> {
    return this.database.transaction(async client => {
      const existing = await client.query<NumericRow>(
        'SELECT * FROM channel_messages WHERE id = $1',
        [message.id]
      );
      if (existing.rows[0]) {
        return { stored: channelMessage(existing.rows[0]), inserted: false };
      }
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM channel_messages
          WHERE channel_id = $1`,
        [message.channel_id]
      );
      if (Number(count.rows[0]?.count || 0) >= maximumPerChannel) {
        throw new PersistenceResourceLimitError(
          'channel-message',
          maximumPerChannel
        );
      }
      await client.query(
        `INSERT INTO channel_messages
           (id, channel_id, user_id, parent_id, author_kind, model, content,
            metadata, created_at, updated_at, edited_at, deleted_at,
            pinned_at, pinned_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          message.id,
          message.channel_id,
          message.user_id,
          message.parent_id,
          message.author_kind,
          message.model,
          message.content,
          message.metadata,
          message.created_at,
          message.updated_at,
          message.edited_at,
          message.deleted_at,
          message.pinned_at,
          message.pinned_by,
        ]
      );
      for (const attachment of attachments) {
        if (attachment.message_id !== message.id) {
          throw new Error(
            'A channel attachment does not belong to its message'
          );
        }
        await client.query(
          `INSERT INTO channel_attachments
             (id, message_id, channel_id, blob_id, filename, content_type,
              size, created_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            attachment.id,
            attachment.message_id,
            attachment.channel_id,
            attachment.blob_id,
            attachment.filename,
            attachment.content_type,
            attachment.size,
            attachment.created_by,
            attachment.created_at,
          ]
        );
      }
      await client.query('UPDATE channels SET updated_at = $1 WHERE id = $2', [
        message.created_at,
        message.channel_id,
      ]);
      return { stored: message, inserted: true };
    });
  }

  async findById(
    messageId: string
  ): Promise<StoredChannelMessageRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM channel_messages WHERE id = $1',
      [messageId]
    );
    return result.rows[0] ? channelMessage(result.rows[0]) : null;
  }

  async listPage(
    channelId: string,
    options: {
      before?: ChannelTimelineCursor;
      after?: ChannelTimelineCursor;
      parentId?: string | null;
      limit: number;
    }
  ): Promise<StoredChannelMessageRecord[]> {
    const clauses = ['channel_id = $1'];
    const parameters: unknown[] = [channelId];
    if (options.parentId === null) {
      clauses.push('parent_id IS NULL');
    } else if (options.parentId !== undefined) {
      parameters.push(options.parentId);
      clauses.push(`parent_id = $${parameters.length}`);
    }
    if (options.before) {
      parameters.push(options.before.created_at);
      const createdIndex = parameters.length;
      parameters.push(options.before.id);
      clauses.push(
        `(created_at < $${createdIndex} OR ` +
          `(created_at = $${createdIndex} AND id < $${parameters.length}))`
      );
    }
    if (options.after) {
      parameters.push(options.after.created_at);
      const createdIndex = parameters.length;
      parameters.push(options.after.id);
      clauses.push(
        `(created_at > $${createdIndex} OR ` +
          `(created_at = $${createdIndex} AND id > $${parameters.length}))`
      );
    }
    const direction = options.after ? 'ASC' : 'DESC';
    parameters.push(options.limit);
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_messages
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ${direction}, id ${direction}
        LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(channelMessage);
  }

  async listThread(
    parentId: string,
    maximum: number
  ): Promise<StoredChannelMessageRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_messages
        WHERE parent_id = $1
        ORDER BY created_at ASC, id ASC
        LIMIT $2`,
      [parentId, maximum]
    );
    return result.rows.map(channelMessage);
  }

  async countThreadReplies(
    parentIds: readonly string[]
  ): Promise<Record<string, number>> {
    if (parentIds.length === 0) return {};
    const result = await this.database.query<NumericRow>(
      `SELECT parent_id, COUNT(*)::text AS count
        FROM channel_messages
        WHERE parent_id = ANY($1::text[]) AND deleted_at IS NULL
        GROUP BY parent_id`,
      [[...parentIds]]
    );
    const counts: Record<string, number> = {};
    for (const row of result.rows) {
      counts[row.parent_id as string] = number(
        row.count,
        'channel thread reply count'
      );
    }
    return counts;
  }

  async update(message: StoredChannelMessageRecord): Promise<void> {
    await this.database.query(
      `UPDATE channel_messages SET
         content = $1,
         metadata = $2,
         updated_at = $3,
         edited_at = $4,
         deleted_at = $5,
         pinned_at = $6,
         pinned_by = $7
       WHERE id = $8`,
      [
        message.content,
        message.metadata,
        message.updated_at,
        message.edited_at,
        message.deleted_at,
        message.pinned_at,
        message.pinned_by,
        message.id,
      ]
    );
  }

  async listPinned(
    channelId: string,
    maximum: number
  ): Promise<StoredChannelMessageRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_messages
        WHERE channel_id = $1 AND pinned_at IS NOT NULL
          AND deleted_at IS NULL
        ORDER BY pinned_at DESC
        LIMIT $2`,
      [channelId, maximum]
    );
    return result.rows.map(channelMessage);
  }

  async listRecentForChannels(
    channelIds: readonly string[],
    maximum: number
  ): Promise<StoredChannelMessageRecord[]> {
    if (channelIds.length === 0) return [];
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_messages
        WHERE channel_id = ANY($1::text[]) AND deleted_at IS NULL
        ORDER BY created_at DESC
        LIMIT $2`,
      [[...channelIds], maximum]
    );
    return result.rows.map(channelMessage);
  }

  async addReaction(
    reaction: StoredChannelReactionRecord,
    maximumPerMessage: number
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      const existing = await client.query(
        `SELECT 1 FROM channel_reactions
          WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
        [reaction.message_id, reaction.user_id, reaction.emoji]
      );
      if (existing.rows[0]) return false;
      const count = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM channel_reactions
          WHERE message_id = $1`,
        [reaction.message_id]
      );
      if (Number(count.rows[0]?.count || 0) >= maximumPerMessage) {
        throw new PersistenceResourceLimitError(
          'channel-reaction',
          maximumPerMessage
        );
      }
      const result = await client.query(
        `INSERT INTO channel_reactions
           (id, message_id, user_id, emoji, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (message_id, user_id, emoji) DO NOTHING`,
        [
          reaction.id,
          reaction.message_id,
          reaction.user_id,
          reaction.emoji,
          reaction.created_at,
        ]
      );
      return changes(result.rowCount) > 0;
    });
  }

  async removeReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `DELETE FROM channel_reactions
              WHERE message_id = $1 AND user_id = $2 AND emoji = $3`,
            [messageId, userId, emoji]
          )
        ).rowCount
      ) > 0
    );
  }

  async listReactionsForMessages(
    messageIds: readonly string[]
  ): Promise<StoredChannelReactionRecord[]> {
    if (messageIds.length === 0) return [];
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_reactions
        WHERE message_id = ANY($1::text[])
        ORDER BY created_at ASC`,
      [[...messageIds]]
    );
    return result.rows.map(channelReaction);
  }

  async findAttachment(
    attachmentId: string
  ): Promise<StoredChannelAttachmentRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM channel_attachments WHERE id = $1',
      [attachmentId]
    );
    return result.rows[0] ? channelAttachment(result.rows[0]) : null;
  }

  async listAttachmentsForMessages(
    messageIds: readonly string[]
  ): Promise<StoredChannelAttachmentRecord[]> {
    if (messageIds.length === 0) return [];
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM channel_attachments
        WHERE message_id = ANY($1::text[])
        ORDER BY created_at ASC`,
      [[...messageIds]]
    );
    return result.rows.map(channelAttachment);
  }

  async listAttachmentBlobIds(
    channelId: string
  ): Promise<Array<{ blob_id: string; created_by: string | null }>> {
    const result = await this.database.query<{
      blob_id: string;
      created_by: string | null;
    }>(
      'SELECT blob_id, created_by FROM channel_attachments WHERE channel_id = $1',
      [channelId]
    );
    return result.rows;
  }
}

class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insertWithLimit(
    value: StoredNotificationRecord,
    maximumPerUser: number
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const result = await client.query(
        `INSERT INTO notifications
           (id, user_id, type, title, body, href, source_key,
            created_at, read_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, source_key) DO NOTHING`,
        [
          value.id,
          value.user_id,
          value.type,
          value.title,
          value.body,
          value.href,
          value.source_key,
          value.created_at,
          value.read_at,
        ]
      );
      if (changes(result.rowCount) === 0) return false;
      await client.query(
        `DELETE FROM notifications
          WHERE user_id = $1
            AND id NOT IN (
              SELECT id FROM notifications
              WHERE user_id = $1
              ORDER BY created_at DESC, id DESC
              LIMIT $2
            )`,
        [value.user_id, maximumPerUser]
      );
      return true;
    });
  }

  async listByOwner(
    userId: string,
    options: { before?: number; limit: number; unreadOnly?: boolean }
  ): Promise<StoredNotificationRecord[]> {
    const clauses = ['user_id = $1'];
    const parameters: unknown[] = [userId];
    if (options.before !== undefined) {
      parameters.push(options.before);
      clauses.push(`created_at < $${parameters.length}`);
    }
    if (options.unreadOnly) {
      clauses.push('read_at IS NULL');
    }
    parameters.push(options.limit);
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM notifications
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${parameters.length}`,
      parameters
    );
    return result.rows.map(notification);
  }

  async countUnread(userId: string): Promise<number> {
    const result = await this.database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM notifications
        WHERE user_id = $1 AND read_at IS NULL`,
      [userId]
    );
    return Number(result.rows[0]?.count || 0);
  }

  async markRead(
    notificationId: string,
    userId: string,
    readAt: number
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            `UPDATE notifications SET read_at = $1
              WHERE id = $2 AND user_id = $3 AND read_at IS NULL`,
            [readAt, notificationId, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async markAllRead(userId: string, readAt: number): Promise<number> {
    return changes(
      (
        await this.database.query(
          `UPDATE notifications SET read_at = $1
            WHERE user_id = $2 AND read_at IS NULL`,
          [readAt, userId]
        )
      ).rowCount
    );
  }

  async deleteByOwner(
    notificationId: string,
    userId: string
  ): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM notifications WHERE id = $1 AND user_id = $2',
            [notificationId, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

class PostgresWebhookTargetRepository implements WebhookTargetRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(maximum: number): Promise<StoredWebhookTargetRecord[]> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM webhook_targets ORDER BY created_at ASC LIMIT $1',
      [maximum]
    );
    return result.rows.map(webhookTarget);
  }

  async findById(targetId: string): Promise<StoredWebhookTargetRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM webhook_targets WHERE id = $1',
      [targetId]
    );
    return result.rows[0] ? webhookTarget(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredWebhookTargetRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      const existing = await client.query(
        'SELECT 1 FROM webhook_targets WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM webhook_targets'
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('webhook-target', maximum);
        }
      }
      await client.query(
        `INSERT INTO webhook_targets
           (id, name, url, secret, events, enabled, created_by,
            created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           url = EXCLUDED.url,
           secret = EXCLUDED.secret,
           events = EXCLUDED.events,
           enabled = EXCLUDED.enabled,
           updated_at = EXCLUDED.updated_at`,
        [
          value.id,
          value.name,
          value.url,
          value.secret,
          value.events,
          value.enabled,
          value.created_by,
          value.created_at,
          value.updated_at,
        ]
      );
    });
  }

  async delete(targetId: string): Promise<boolean> {
    return (
      changes(
        (
          await this.database.query(
            'DELETE FROM webhook_targets WHERE id = $1',
            [targetId]
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
  calendar: 'calendars',
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

const modelTariff = (row: NumericRow): StoredModelTariffRecord => ({
  ...(row as unknown as StoredModelTariffRecord),
  input_per_million:
    row.input_per_million === null ? null : Number(row.input_per_million),
  output_per_million:
    row.output_per_million === null ? null : Number(row.output_per_million),
  unit_price: row.unit_price === null ? null : Number(row.unit_price),
  effective_from: number(row.effective_from, 'tariff effective_from'),
  created_at: number(row.created_at, 'tariff created_at'),
});

const usageBudget = (row: NumericRow): StoredUsageBudgetRecord => ({
  ...(row as unknown as StoredUsageBudgetRecord),
  amount_usd: Number(row.amount_usd),
  created_at: number(row.created_at, 'budget created_at'),
  updated_at: number(row.updated_at, 'budget updated_at'),
});

const messageFeedback = (row: NumericRow): StoredMessageFeedbackRecord => ({
  ...(row as unknown as StoredMessageFeedbackRecord),
  rating: number(row.rating, 'feedback rating'),
  created_at: number(row.created_at, 'feedback created_at'),
  updated_at: number(row.updated_at, 'feedback updated_at'),
});

const arenaVote = (row: NumericRow): StoredArenaVoteRecord => ({
  ...(row as unknown as StoredArenaVoteRecord),
  created_at: number(row.created_at, 'arena vote created_at'),
});

const evalSet = (row: NumericRow): StoredEvalSetRecord => ({
  ...(row as unknown as StoredEvalSetRecord),
  created_at: number(row.created_at, 'eval set created_at'),
  updated_at: number(row.updated_at, 'eval set updated_at'),
});

const evalRun = (row: NumericRow): StoredEvalRunRecord => ({
  ...(row as unknown as StoredEvalRunRecord),
  created_at: number(row.created_at, 'eval run created_at'),
  updated_at: number(row.updated_at, 'eval run updated_at'),
  completed_at:
    row.completed_at === null
      ? null
      : number(row.completed_at, 'eval run completed_at'),
});

class PostgresModelTariffRepository implements ModelTariffRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listAll(maximum: number): Promise<StoredModelTariffRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM model_tariffs
        ORDER BY plugin_id ASC, model ASC, effective_from DESC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(modelTariff);
  }

  async insert(tariff: StoredModelTariffRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO model_tariffs
         (id, plugin_id, model, input_per_million, output_per_million,
          unit_price, currency, effective_from, created_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        tariff.id,
        tariff.plugin_id,
        tariff.model,
        tariff.input_per_million,
        tariff.output_per_million,
        tariff.unit_price,
        tariff.currency,
        tariff.effective_from,
        tariff.created_by,
        tariff.created_at,
      ]
    );
  }

  async deleteById(tariffId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM model_tariffs WHERE id = $1',
      [tariffId]
    );
    return changes(result.rowCount) > 0;
  }
}

class PostgresUsageBudgetRepository implements UsageBudgetRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listAll(maximum: number): Promise<StoredUsageBudgetRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM usage_budgets
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(usageBudget);
  }

  async findById(budgetId: string): Promise<StoredUsageBudgetRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM usage_budgets WHERE id = $1',
      [budgetId]
    );
    return result.rows[0] ? usageBudget(result.rows[0]) : null;
  }

  async replace(budget: StoredUsageBudgetRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO usage_budgets
         (id, name, principal_type, principal_id, period, amount_usd,
          mode, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         principal_type = EXCLUDED.principal_type,
         principal_id = EXCLUDED.principal_id,
         period = EXCLUDED.period,
         amount_usd = EXCLUDED.amount_usd,
         mode = EXCLUDED.mode,
         updated_at = EXCLUDED.updated_at`,
      [
        budget.id,
        budget.name,
        budget.principal_type,
        budget.principal_id,
        budget.period,
        budget.amount_usd,
        budget.mode,
        budget.created_by,
        budget.created_at,
        budget.updated_at,
      ]
    );
  }

  async deleteById(budgetId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM usage_budgets WHERE id = $1',
      [budgetId]
    );
    return changes(result.rowCount) > 0;
  }
}

class PostgresMessageFeedbackRepository implements MessageFeedbackRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async upsertByMessage(feedback: StoredMessageFeedbackRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO message_feedback
         (id, user_id, session_id, message_id, rating, tags, comment,
          model, plugin_id, snapshot, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (user_id, message_id) DO UPDATE SET
         rating = EXCLUDED.rating,
         tags = EXCLUDED.tags,
         comment = EXCLUDED.comment,
         model = EXCLUDED.model,
         plugin_id = EXCLUDED.plugin_id,
         snapshot = EXCLUDED.snapshot,
         updated_at = EXCLUDED.updated_at`,
      [
        feedback.id,
        feedback.user_id,
        feedback.session_id,
        feedback.message_id,
        feedback.rating,
        feedback.tags,
        feedback.comment,
        feedback.model,
        feedback.plugin_id,
        feedback.snapshot,
        feedback.created_at,
        feedback.updated_at,
      ]
    );
  }

  async deleteByMessage(userId: string, messageId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM message_feedback WHERE user_id = $1 AND message_id = $2',
      [userId, messageId]
    );
    return changes(result.rowCount) > 0;
  }

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredMessageFeedbackRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM message_feedback
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(messageFeedback);
  }

  async listAll(maximum: number): Promise<StoredMessageFeedbackRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM message_feedback
        ORDER BY created_at DESC, id DESC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(messageFeedback);
  }
}

class PostgresArenaVoteRepository implements ArenaVoteRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async insertOnce(vote: StoredArenaVoteRecord): Promise<boolean> {
    const result = await this.database.query(
      `INSERT INTO arena_votes
         (id, user_id, compare_group, model_a, model_b, winner, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, compare_group) DO NOTHING`,
      [
        vote.id,
        vote.user_id,
        vote.compare_group,
        vote.model_a,
        vote.model_b,
        vote.winner,
        vote.created_at,
      ]
    );
    return changes(result.rowCount) > 0;
  }

  async listAllOrdered(maximum: number): Promise<StoredArenaVoteRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM arena_votes
        ORDER BY created_at ASC, id ASC
        LIMIT $1`,
      [maximum]
    );
    return result.rows.map(arenaVote);
  }
}

class PostgresEvalSetRepository implements EvalSetRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredEvalSetRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM eval_sets
        WHERE user_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(evalSet);
  }

  async findByOwner(
    setId: string,
    userId: string
  ): Promise<StoredEvalSetRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM eval_sets WHERE id = $1 AND user_id = $2',
      [setId, userId]
    );
    return result.rows[0] ? evalSet(result.rows[0]) : null;
  }

  async replaceWithLimit(
    value: StoredEvalSetRecord,
    maximum: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await lockOwner(client, value.user_id);
      const existing = await client.query<{ user_id: string }>(
        'SELECT user_id FROM eval_sets WHERE id = $1 FOR UPDATE',
        [value.id]
      );
      if (existing.rows[0] && existing.rows[0].user_id !== value.user_id) {
        throw new PersistenceResourceConflictError();
      }
      if (!existing.rows[0]) {
        const count = await client.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM eval_sets WHERE user_id = $1',
          [value.user_id]
        );
        if (Number(count.rows[0]?.count || 0) >= maximum) {
          throw new PersistenceResourceLimitError('eval-set', maximum);
        }
      }
      const result = await client.query(
        `INSERT INTO eval_sets
           (id, user_id, name, description, items, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           description = EXCLUDED.description,
           items = EXCLUDED.items,
           updated_at = EXCLUDED.updated_at
         WHERE eval_sets.user_id = EXCLUDED.user_id`,
        [
          value.id,
          value.user_id,
          value.name,
          value.description,
          value.items,
          value.created_at,
          value.updated_at,
        ]
      );
      if (result.rowCount !== 1) throw new PersistenceResourceConflictError();
    });
  }

  async deleteByOwner(setId: string, userId: string): Promise<boolean> {
    const result = await this.database.query(
      'DELETE FROM eval_sets WHERE id = $1 AND user_id = $2',
      [setId, userId]
    );
    return changes(result.rowCount) > 0;
  }
}

class PostgresEvalRunRepository implements EvalRunRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredEvalRunRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM eval_runs
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [userId, maximum]
    );
    return result.rows.map(evalRun);
  }

  async listBySet(
    setId: string,
    userId: string,
    maximum: number
  ): Promise<StoredEvalRunRecord[]> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM eval_runs
        WHERE set_id = $1 AND user_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [setId, userId, maximum]
    );
    return result.rows.map(evalRun);
  }

  async findByOwner(
    runId: string,
    userId: string
  ): Promise<StoredEvalRunRecord | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM eval_runs WHERE id = $1 AND user_id = $2',
      [runId, userId]
    );
    return result.rows[0] ? evalRun(result.rows[0]) : null;
  }

  async insert(run: StoredEvalRunRecord): Promise<void> {
    await this.database.query(
      `INSERT INTO eval_runs
         (id, set_id, user_id, label, plugin_id, model, status, results,
          error, created_at, updated_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        run.id,
        run.set_id,
        run.user_id,
        run.label,
        run.plugin_id,
        run.model,
        run.status,
        run.results,
        run.error,
        run.created_at,
        run.updated_at,
        run.completed_at,
      ]
    );
  }

  async update(
    runId: string,
    userId: string,
    updates: {
      status: StoredEvalRunRecord['status'];
      results?: string | null;
      error?: string | null;
      updated_at: number;
      completed_at?: number | null;
    }
  ): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE eval_runs SET
         status = $1,
         results = COALESCE($2, results),
         error = $3,
         updated_at = $4,
         completed_at = COALESCE($5, completed_at)
       WHERE id = $6 AND user_id = $7`,
      [
        updates.status,
        updates.results ?? null,
        updates.error ?? null,
        updates.updated_at,
        updates.completed_at ?? null,
        runId,
        userId,
      ]
    );
    return changes(result.rowCount) > 0;
  }
}

export const createPostgresResourceRepositories = (
  database: PostgresDatabase
): ApplicationResourceRepositories => ({
  chatSessions: new PostgresChatSessionRepository(database),
  knowledgeCollections: new PostgresKnowledgeCollectionRepository(database),
  notes: new PostgresNoteRepository(database),
  calendars: new PostgresCalendarRepository(database),
  calendarEvents: new PostgresCalendarEventRepository(database),
  channels: new PostgresChannelRepository(database),
  channelMessages: new PostgresChannelMessageRepository(database),
  notifications: new PostgresNotificationRepository(database),
  webhookTargets: new PostgresWebhookTargetRepository(database),
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
  modelTariffs: new PostgresModelTariffRepository(database),
  usageBudgets: new PostgresUsageBudgetRepository(database),
  messageFeedback: new PostgresMessageFeedbackRepository(database),
  arenaVotes: new PostgresArenaVoteRepository(database),
  evalSets: new PostgresEvalSetRepository(database),
  evalRuns: new PostgresEvalRunRepository(database),
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
