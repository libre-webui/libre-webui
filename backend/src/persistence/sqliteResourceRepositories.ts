/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type Database from 'better-sqlite3';
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
  ChatGenerationEnqueueInput,
  ChatGenerationEnqueuer,
} from './chatGenerationTypes.js';
import { createSQLiteSyncExecutor } from './sqliteSyncExecutor.js';

const ensureSameOwner = (
  database: Database.Database,
  table: string,
  id: string,
  owner: string
): boolean => {
  const row = database
    .prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
    .get(id) as { user_id: string } | undefined;
  if (row && row.user_id !== owner) {
    throw new PersistenceResourceConflictError();
  }
  return Boolean(row);
};

class SQLiteChatSessionRepository implements ChatSessionRepository {
  constructor(private readonly database: Database.Database) {}

  private replaceAggregate(aggregate: StoredChatSessionAggregate): void {
    ensureSameOwner(
      this.database,
      'sessions',
      aggregate.session.id,
      aggregate.session.user_id
    );
    this.database
      .prepare(
        `INSERT INTO sessions
           (id, user_id, title, model, persona_id, provider_type, provider_id,
            created_at, updated_at, archived, settings, folder_id, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           model = excluded.model,
           persona_id = excluded.persona_id,
           provider_type = excluded.provider_type,
           provider_id = excluded.provider_id,
           updated_at = excluded.updated_at,
           archived = excluded.archived,
           settings = excluded.settings,
           folder_id = excluded.folder_id,
           pinned = excluded.pinned
         WHERE sessions.user_id = excluded.user_id`
      )
      .run(
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
        aggregate.session.pinned
      );
    this.database
      .prepare('DELETE FROM session_messages WHERE session_id = ?')
      .run(aggregate.session.id);
    const insert = this.database.prepare(
      `INSERT INTO session_messages
         (id, session_id, role, content, thinking, timestamp, message_index,
          model, provider_metadata, images, statistics, artifacts, parent_id,
          branch_index, is_active, rating)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const message of aggregate.messages) {
      if (message.session_id !== aggregate.session.id) {
        throw new Error('A chat message does not belong to its aggregate');
      }
      insert.run(
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
        message.rating
      );
    }
  }

  async listByOwner(userId: string): Promise<StoredChatSessionAggregate[]> {
    const sessions = this.database
      .prepare(
        'SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC'
      )
      .all(userId) as StoredChatSessionRecord[];
    const messages = this.database.prepare(
      `SELECT * FROM session_messages
       WHERE session_id = ?
       ORDER BY message_index ASC, branch_index ASC`
    );
    return sessions.map(session => ({
      session,
      messages: messages.all(session.id) as StoredChatMessageRecord[],
    }));
  }

  async findByOwner(
    sessionId: string,
    userId: string
  ): Promise<StoredChatSessionAggregate | null> {
    const session = this.database
      .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
      .get(sessionId, userId) as StoredChatSessionRecord | undefined;
    if (!session) return null;
    const messages = this.database
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ?
         ORDER BY message_index ASC, branch_index ASC`
      )
      .all(sessionId) as StoredChatMessageRecord[];
    return { session, messages };
  }

  async replace(aggregate: StoredChatSessionAggregate): Promise<void> {
    const replace = this.database.transaction(() => {
      this.replaceAggregate(aggregate);
    });
    replace.immediate();
  }

  async replaceAndEnqueue(
    aggregate: StoredChatSessionAggregate,
    enqueuer: ChatGenerationEnqueuer,
    input: ChatGenerationEnqueueInput
  ): Promise<void> {
    if (
      input.sessionId !== aggregate.session.id ||
      input.actorUserId !== aggregate.session.user_id
    ) {
      throw new Error('Chat generation enqueue does not match its aggregate');
    }
    const replace = this.database.transaction(() => {
      const enqueue = enqueuer.enqueueSQLite(
        createSQLiteSyncExecutor(this.database),
        input
      );
      if (enqueue.created) this.replaceAggregate(aggregate);
    });
    replace.immediate();
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
    const remove = this.database.transaction(() => {
      const owner = this.database
        .prepare('SELECT user_id FROM sessions WHERE id = ?')
        .get(sessionId) as { user_id: string } | undefined;
      if (!owner || owner.user_id !== userId) return false;
      const target = this.database
        .prepare(
          `SELECT timestamp, parent_id, is_active
             FROM session_messages WHERE id = ? AND session_id = ?`
        )
        .get(messageId, sessionId) as
        | { timestamp: number; parent_id: string | null; is_active: number }
        | undefined;
      if (!target || target.timestamp !== expectedTimestamp) return false;
      const deleted = this.database
        .prepare(
          `DELETE FROM session_messages
            WHERE id = ? AND session_id = ? AND timestamp = ?`
        )
        .run(messageId, sessionId, expectedTimestamp).changes;
      if (deleted > 0) {
        this.database
          .prepare(
            `UPDATE sessions SET updated_at = ?
              WHERE id = ? AND user_id = ? AND updated_at = ?`
          )
          .run(
            previousSessionUpdatedAt,
            sessionId,
            userId,
            expectedSessionUpdatedAt
          );
      }
      if (
        deleted > 0 &&
        target.is_active === 1 &&
        target.parent_id &&
        previousActiveMessageId
      ) {
        const active = this.database
          .prepare(
            `SELECT 1 FROM session_messages
              WHERE session_id = ? AND (id = ? OR parent_id = ?)
                AND is_active = 1 LIMIT 1`
          )
          .get(sessionId, target.parent_id, target.parent_id);
        if (!active) {
          this.database
            .prepare(
              `UPDATE session_messages SET is_active = 1
                WHERE id = ? AND session_id = ?
                  AND (id = ? OR parent_id = ?)`
            )
            .run(
              previousActiveMessageId,
              sessionId,
              target.parent_id,
              target.parent_id
            );
        }
      }
      return deleted > 0;
    });
    return remove.immediate();
  }

  async deleteByOwner(sessionId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
        .run(sessionId, userId).changes > 0
    );
  }

  async deleteAllByOwner(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM sessions WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLiteKnowledgeCollectionRepository implements KnowledgeCollectionRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(userId: string): Promise<StoredNamedResourceRecord[]> {
    return this.database
      .prepare(
        'SELECT * FROM knowledge_collections WHERE user_id = ? ORDER BY name COLLATE NOCASE ASC'
      )
      .all(userId) as StoredNamedResourceRecord[];
  }

  async replace(collection: StoredNamedResourceRecord): Promise<void> {
    ensureSameOwner(
      this.database,
      'knowledge_collections',
      collection.id,
      collection.user_id
    );
    this.database
      .prepare(
        `INSERT INTO knowledge_collections
           (id, user_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at
         WHERE knowledge_collections.user_id = excluded.user_id`
      )
      .run(
        collection.id,
        collection.user_id,
        collection.name,
        collection.created_at,
        collection.updated_at
      );
  }

  async deleteAndDetach(
    collectionId: string,
    userId: string
  ): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database
        .prepare(
          'UPDATE documents SET collection_id = NULL WHERE collection_id = ? AND user_id = ?'
        )
        .run(collectionId, userId);
      return this.database
        .prepare(
          'DELETE FROM knowledge_collections WHERE id = ? AND user_id = ?'
        )
        .run(collectionId, userId).changes;
    });
    return remove() > 0;
  }
}

class SQLiteNoteRepository implements NoteRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredNoteRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM notes
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredNoteRecord[];
  }

  async findByOwner(
    noteId: string,
    userId: string
  ): Promise<StoredNoteRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?')
        .get(noteId, userId) as StoredNoteRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    note: StoredNoteRecord,
    maximum: number
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'notes',
        note.id,
        note.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare('SELECT COUNT(*) AS count FROM notes WHERE user_id = ?')
          .get(note.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('note', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO notes
             (id, user_id, title, content, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             content = excluded.content,
             updated_at = excluded.updated_at
           WHERE notes.user_id = excluded.user_id`
        )
        .run(
          note.id,
          note.user_id,
          note.title,
          note.content,
          note.created_at,
          note.updated_at
        );
    });
    replace();
  }

  async patchByOwner(
    noteId: string,
    userId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null> {
    const update = this.database.transaction(() => {
      const assignments: string[] = [];
      const values: Array<string | number> = [];
      if (patch.title !== undefined) {
        assignments.push('title = ?');
        values.push(patch.title);
      }
      if (patch.content !== undefined) {
        assignments.push('content = ?');
        values.push(patch.content);
      }
      assignments.push('updated_at = ?');
      values.push(patch.updated_at);

      const result = this.database
        .prepare(
          `UPDATE notes SET ${assignments.join(', ')}
            WHERE id = ? AND user_id = ?`
        )
        .run(...values, noteId, userId);
      if (result.changes !== 1) return null;
      return this.database
        .prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?')
        .get(noteId, userId) as StoredNoteRecord;
    });
    return update.immediate();
  }

  async deleteByOwner(noteId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM notes WHERE id = ? AND user_id = ?')
        .run(noteId, userId).changes > 0
    );
  }
}

class SQLiteCalendarEventRepository implements CalendarEventRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwnerBetween(
    userId: string,
    from: number,
    to: number,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM calendar_events
         WHERE user_id = ? AND start_at >= ? AND start_at < ?
         ORDER BY start_at ASC
         LIMIT ?`
      )
      .all(userId, from, to, maximum) as StoredCalendarEventRecord[];
  }

  async listRecurringByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM calendar_events
         WHERE user_id = ? AND recurrence IS NOT NULL
         ORDER BY start_at ASC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredCalendarEventRecord[];
  }

  async findByOwner(
    eventId: string,
    userId: string
  ): Promise<StoredCalendarEventRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM calendar_events WHERE id = ? AND user_id = ?')
        .get(eventId, userId) as StoredCalendarEventRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    event: StoredCalendarEventRecord,
    maximum: number
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'calendar_events',
        event.id,
        event.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare(
            'SELECT COUNT(*) AS count FROM calendar_events WHERE user_id = ?'
          )
          .get(event.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('calendar-event', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO calendar_events
             (id, user_id, title, notes, start_at, end_at, all_day,
              recurrence, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             notes = excluded.notes,
             start_at = excluded.start_at,
             end_at = excluded.end_at,
             all_day = excluded.all_day,
             recurrence = excluded.recurrence,
             updated_at = excluded.updated_at
           WHERE calendar_events.user_id = excluded.user_id`
        )
        .run(
          event.id,
          event.user_id,
          event.title,
          event.notes,
          event.start_at,
          event.end_at,
          event.all_day,
          event.recurrence,
          event.created_at,
          event.updated_at
        );
    });
    replace();
  }

  async deleteByOwner(eventId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM calendar_events WHERE id = ? AND user_id = ?')
        .run(eventId, userId).changes > 0
    );
  }
}

class SQLiteAutomationRepository implements AutomationRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredAutomationRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM automations
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredAutomationRecord[];
  }

  async findByOwner(
    automationId: string,
    userId: string
  ): Promise<StoredAutomationRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM automations WHERE id = ? AND user_id = ?')
        .get(automationId, userId) as StoredAutomationRecord | undefined) ??
      null
    );
  }

  async findById(automationId: string): Promise<StoredAutomationRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM automations WHERE id = ?')
        .get(automationId) as StoredAutomationRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    automation: StoredAutomationRecord,
    maximum: number
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'automations',
        automation.id,
        automation.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare(
            'SELECT COUNT(*) AS count FROM automations WHERE user_id = ?'
          )
          .get(automation.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('automation', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO automations
             (id, user_id, name, instructions, triggers, provider, model,
              notify, status, next_run_at, last_run_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             instructions = excluded.instructions,
             triggers = excluded.triggers,
             provider = excluded.provider,
             model = excluded.model,
             notify = excluded.notify,
             status = excluded.status,
             next_run_at = excluded.next_run_at,
             last_run_at = excluded.last_run_at,
             updated_at = excluded.updated_at
           WHERE automations.user_id = excluded.user_id`
        )
        .run(
          automation.id,
          automation.user_id,
          automation.name,
          automation.instructions,
          automation.triggers,
          automation.provider,
          automation.model,
          automation.notify,
          automation.status,
          automation.next_run_at,
          automation.last_run_at,
          automation.created_at,
          automation.updated_at
        );
    });
    replace();
  }

  async listDue(
    now: number,
    maximum: number
  ): Promise<StoredAutomationRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM automations
         WHERE status = 'active'
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`
      )
      .all(now, maximum) as StoredAutomationRecord[];
  }

  async advanceNextRun(
    automationId: string,
    observedNextRunAt: number,
    nextRunAt: number | null,
    lastRunAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE automations
           SET next_run_at = ?, last_run_at = ?
           WHERE id = ? AND next_run_at = ?`
        )
        .run(nextRunAt, lastRunAt, automationId, observedNextRunAt).changes > 0
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
      this.database
        .prepare(
          `UPDATE automations
           SET status = ?, next_run_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(status, nextRunAt, updatedAt, automationId, userId).changes > 0
    );
  }

  async deleteByOwner(automationId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM automations WHERE id = ? AND user_id = ?')
        .run(automationId, userId).changes > 0
    );
  }
}

class SQLiteAutomationRunRepository implements AutomationRunRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(run: StoredAutomationRunRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO automation_runs
           (id, automation_id, user_id, scheduled_for, started_at,
            finished_at, status, session_id, assistant_message_id, error,
            seen_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
        run.created_at
      );
  }

  async findByOwner(
    runId: string,
    userId: string
  ): Promise<StoredAutomationRunRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM automation_runs WHERE id = ? AND user_id = ?')
        .get(runId, userId) as StoredAutomationRunRecord | undefined) ?? null
    );
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
    const clauses = ['user_id = ?'];
    const values: Array<string | number> = [userId];
    if (options.automationId !== undefined) {
      clauses.push('automation_id = ?');
      values.push(options.automationId);
    }
    if (options.from !== undefined) {
      clauses.push('scheduled_for >= ?');
      values.push(options.from);
    }
    if (options.to !== undefined) {
      clauses.push('scheduled_for < ?');
      values.push(options.to);
    }
    values.push(options.maximum);
    return this.database
      .prepare(
        `SELECT * FROM automation_runs
         WHERE ${clauses.join(' AND ')}
         ORDER BY scheduled_for DESC
         LIMIT ?`
      )
      .all(...values) as StoredAutomationRunRecord[];
  }

  async listUnfinished(maximum: number): Promise<StoredAutomationRunRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM automation_runs
         WHERE status IN ('queued', 'running')
         ORDER BY scheduled_for ASC
         LIMIT ?`
      )
      .all(maximum) as StoredAutomationRunRecord[];
  }

  async markStarted(
    runId: string,
    sessionId: string,
    assistantMessageId: string,
    startedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE automation_runs
           SET session_id = ?, assistant_message_id = ?, started_at = ?,
               status = 'running'
           WHERE id = ? AND status = 'queued'`
        )
        .run(sessionId, assistantMessageId, startedAt, runId).changes > 0
    );
  }

  async finalize(
    runId: string,
    status: string,
    finishedAt: number,
    error: string | null
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE automation_runs
           SET status = ?, finished_at = ?, error = ?
           WHERE id = ? AND status IN ('queued', 'running')`
        )
        .run(status, finishedAt, error, runId).changes > 0
    );
  }

  async countUnseenFinished(userId: string): Promise<number> {
    const row = this.database
      .prepare(
        `SELECT COUNT(*) AS count FROM automation_runs
         WHERE user_id = ?
           AND status IN ('succeeded', 'failed')
           AND seen_at IS NULL`
      )
      .get(userId) as { count: number };
    return row.count;
  }

  async markSeenBefore(userId: string, seenAt: number): Promise<number> {
    return this.database
      .prepare(
        `UPDATE automation_runs
         SET seen_at = ?
         WHERE user_id = ?
           AND status IN ('succeeded', 'failed')
           AND seen_at IS NULL
           AND finished_at IS NOT NULL
           AND finished_at <= ?`
      )
      .run(seenAt, userId, seenAt).changes;
  }
}

class SQLiteToolServerRepository implements ToolServerRepository {
  constructor(private readonly database: Database.Database) {}

  async list(maximum: number): Promise<StoredToolServerRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM tool_servers
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(maximum) as StoredToolServerRecord[];
  }

  async findById(serverId: string): Promise<StoredToolServerRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM tool_servers WHERE id = ?')
        .get(serverId) as StoredToolServerRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    server: StoredToolServerRecord,
    maximum: number
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = this.database
        .prepare('SELECT id FROM tool_servers WHERE id = ?')
        .get(server.id);
      if (!exists) {
        const row = this.database
          .prepare('SELECT COUNT(*) AS count FROM tool_servers')
          .get() as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('tool-server', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO tool_servers
             (id, user_id, name, description, kind, base_url, spec,
              spec_digest, spec_revision, auth_mode, auth_header, access_mode,
              enabled, timeout_ms, max_response_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             description = excluded.description,
             base_url = excluded.base_url,
             spec = excluded.spec,
             spec_digest = excluded.spec_digest,
             spec_revision = excluded.spec_revision,
             auth_mode = excluded.auth_mode,
             auth_header = excluded.auth_header,
             access_mode = excluded.access_mode,
             enabled = excluded.enabled,
             timeout_ms = excluded.timeout_ms,
             max_response_bytes = excluded.max_response_bytes,
             updated_at = excluded.updated_at`
        )
        .run(
          server.id,
          server.user_id,
          server.name,
          server.description,
          server.kind,
          server.base_url,
          server.spec,
          server.spec_digest,
          server.spec_revision,
          server.auth_mode,
          server.auth_header,
          server.access_mode,
          server.enabled,
          server.timeout_ms,
          server.max_response_bytes,
          server.created_at,
          server.updated_at
        );
    });
    replace();
  }

  async delete(serverId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM tool_servers WHERE id = ?')
        .run(serverId).changes > 0
    );
  }
}

class SQLiteToolServerToolRepository implements ToolServerToolRepository {
  constructor(private readonly database: Database.Database) {}

  async listByServer(serverId: string): Promise<StoredToolServerToolRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM tool_server_tools
         WHERE server_id = ?
         ORDER BY name ASC`
      )
      .all(serverId) as StoredToolServerToolRecord[];
  }

  async replaceAllForServer(
    serverId: string,
    tools: readonly StoredToolServerToolRecord[]
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const previous = new Map(
        (
          this.database
            .prepare(
              'SELECT name, enabled, side_effect FROM tool_server_tools WHERE server_id = ?'
            )
            .all(serverId) as Array<{
            name: string;
            enabled: number;
            side_effect: number;
          }>
        ).map(row => [row.name, row])
      );
      this.database
        .prepare('DELETE FROM tool_server_tools WHERE server_id = ?')
        .run(serverId);
      const insert = this.database.prepare(
        `INSERT INTO tool_server_tools
           (id, server_id, name, description, params_schema, detail,
            side_effect, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const tool of tools) {
        if (tool.server_id !== serverId) {
          throw new Error('A tool row does not belong to its server');
        }
        const kept = previous.get(tool.name);
        insert.run(
          tool.id,
          tool.server_id,
          tool.name,
          tool.description,
          tool.params_schema,
          tool.detail,
          kept ? kept.side_effect : tool.side_effect,
          kept ? kept.enabled : tool.enabled,
          tool.created_at,
          tool.updated_at
        );
      }
    });
    replace();
  }

  async updateOverrides(
    serverId: string,
    toolName: string,
    overrides: { enabled?: number; side_effect?: number },
    updatedAt: number
  ): Promise<StoredToolServerToolRecord | null> {
    const assignments: string[] = ['updated_at = ?'];
    const values: Array<string | number> = [updatedAt];
    if (overrides.enabled !== undefined) {
      assignments.push('enabled = ?');
      values.push(overrides.enabled);
    }
    if (overrides.side_effect !== undefined) {
      assignments.push('side_effect = ?');
      values.push(overrides.side_effect);
    }
    const changed = this.database
      .prepare(
        `UPDATE tool_server_tools
         SET ${assignments.join(', ')}
         WHERE server_id = ? AND name = ?`
      )
      .run(...values, serverId, toolName).changes;
    if (changed === 0) return null;
    return (
      (this.database
        .prepare(
          'SELECT * FROM tool_server_tools WHERE server_id = ? AND name = ?'
        )
        .get(serverId, toolName) as StoredToolServerToolRecord | undefined) ??
      null
    );
  }
}

class SQLiteToolServerCredentialRepository implements ToolServerCredentialRepository {
  constructor(private readonly database: Database.Database) {}

  async find(
    serverId: string,
    userId: string
  ): Promise<StoredToolServerCredentialRecord | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM tool_server_credentials WHERE server_id = ? AND user_id = ?'
        )
        .get(serverId, userId) as
        StoredToolServerCredentialRecord | undefined) ?? null
    );
  }

  async upsert(credential: StoredToolServerCredentialRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO tool_server_credentials
           (id, server_id, user_id, secret, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(server_id, user_id) DO UPDATE SET
           secret = excluded.secret,
           updated_at = excluded.updated_at`
      )
      .run(
        credential.id,
        credential.server_id,
        credential.user_id,
        credential.secret,
        credential.created_at,
        credential.updated_at
      );
  }

  async delete(serverId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM tool_server_credentials WHERE server_id = ? AND user_id = ?'
        )
        .run(serverId, userId).changes > 0
    );
  }
}

class SQLiteToolApprovalRepository implements ToolApprovalRepository {
  constructor(private readonly database: Database.Database) {}

  async insert(approval: StoredToolApprovalRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO tool_approvals
           (id, user_id, session_id, server_id, tool_name, call_id,
            arguments_digest, scope, status, created_at, resolved_at,
            expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
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
        approval.expires_at
      );
  }

  async findByOwner(
    approvalId: string,
    userId: string
  ): Promise<StoredToolApprovalRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM tool_approvals WHERE id = ? AND user_id = ?')
        .get(approvalId, userId) as StoredToolApprovalRecord | undefined) ??
      null
    );
  }

  async findStanding(
    userId: string,
    serverId: string | null,
    toolName: string,
    sessionId: string | null
  ): Promise<StoredToolApprovalRecord | null> {
    return (
      (this.database
        .prepare(
          `SELECT * FROM tool_approvals
           WHERE user_id = ?
             AND status = 'approved'
             AND tool_name = ?
             AND ((server_id IS NULL AND ? IS NULL) OR server_id = ?)
             AND (scope = 'always'
                  OR (scope = 'session' AND session_id IS NOT NULL AND session_id = ?))
           ORDER BY resolved_at DESC
           LIMIT 1`
        )
        .get(userId, toolName, serverId, serverId, sessionId) as
        StoredToolApprovalRecord | undefined) ?? null
    );
  }

  async resolvePending(
    approvalId: string,
    userId: string,
    status: string,
    scope: string,
    resolvedAt: number
  ): Promise<StoredToolApprovalRecord | null> {
    const changed = this.database
      .prepare(
        `UPDATE tool_approvals
         SET status = ?, scope = ?, resolved_at = ?
         WHERE id = ? AND user_id = ? AND status = 'pending'
           AND (expires_at IS NULL OR expires_at > ?)`
      )
      .run(status, scope, resolvedAt, approvalId, userId, resolvedAt).changes;
    if (changed === 0) return null;
    return this.findByOwner(approvalId, userId);
  }

  async listPendingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM tool_approvals
         WHERE user_id = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredToolApprovalRecord[];
  }

  async listStandingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM tool_approvals
         WHERE user_id = ? AND status = 'approved'
           AND scope IN ('session', 'always')
         ORDER BY resolved_at DESC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredToolApprovalRecord[];
  }

  async expirePending(now: number): Promise<number> {
    return this.database
      .prepare(
        `UPDATE tool_approvals
         SET status = 'expired', resolved_at = ?
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?`
      )
      .run(now, now).changes;
  }

  async deleteByOwner(approvalId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM tool_approvals WHERE id = ? AND user_id = ?')
        .run(approvalId, userId).changes > 0
    );
  }
}

class SQLitePromptRepository implements PromptRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredPromptRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM prompts
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredPromptRecord[];
  }

  async findByOwner(
    promptId: string,
    userId: string
  ): Promise<StoredPromptRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM prompts WHERE id = ? AND user_id = ?')
        .get(promptId, userId) as StoredPromptRecord | undefined) ?? null
    );
  }

  async findById(promptId: string): Promise<StoredPromptRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM prompts WHERE id = ?')
        .get(promptId) as StoredPromptRecord | undefined) ?? null
    );
  }

  async findBySlug(
    userId: string,
    slug: string
  ): Promise<StoredPromptRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM prompts WHERE user_id = ? AND slug = ?')
        .get(userId, slug) as StoredPromptRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    prompt: StoredPromptRecord,
    maximum: number,
    archivedVersion: StoredPromptVersionRecord | null
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'prompts',
        prompt.id,
        prompt.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare('SELECT COUNT(*) AS count FROM prompts WHERE user_id = ?')
          .get(prompt.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('prompt', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO prompts
             (id, user_id, slug, title, description, content, variables,
              tags, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             title = excluded.title,
             description = excluded.description,
             content = excluded.content,
             variables = excluded.variables,
             tags = excluded.tags,
             version = excluded.version,
             updated_at = excluded.updated_at
           WHERE prompts.user_id = excluded.user_id`
        )
        .run(
          prompt.id,
          prompt.user_id,
          prompt.slug,
          prompt.title,
          prompt.description,
          prompt.content,
          prompt.variables,
          prompt.tags,
          prompt.version,
          prompt.created_at,
          prompt.updated_at
        );
      if (archivedVersion) {
        this.database
          .prepare(
            `INSERT INTO prompt_versions
               (id, prompt_id, version, content, variables, created_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(prompt_id, version) DO NOTHING`
          )
          .run(
            archivedVersion.id,
            archivedVersion.prompt_id,
            archivedVersion.version,
            archivedVersion.content,
            archivedVersion.variables,
            archivedVersion.created_at
          );
      }
    });
    replace();
  }

  async listVersions(
    promptId: string,
    maximum: number
  ): Promise<StoredPromptVersionRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM prompt_versions
         WHERE prompt_id = ?
         ORDER BY version DESC
         LIMIT ?`
      )
      .all(promptId, maximum) as StoredPromptVersionRecord[];
  }

  async findVersion(
    promptId: string,
    version: number
  ): Promise<StoredPromptVersionRecord | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM prompt_versions WHERE prompt_id = ? AND version = ?'
        )
        .get(promptId, version) as StoredPromptVersionRecord | undefined) ??
      null
    );
  }

  async deleteByOwner(promptId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM prompts WHERE id = ? AND user_id = ?')
        .run(promptId, userId).changes > 0
    );
  }
}

class SQLiteSkillRepository implements SkillRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredSkillRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM skills
         WHERE user_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredSkillRecord[];
  }

  async findByOwner(
    skillId: string,
    userId: string
  ): Promise<StoredSkillRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM skills WHERE id = ? AND user_id = ?')
        .get(skillId, userId) as StoredSkillRecord | undefined) ?? null
    );
  }

  async findById(skillId: string): Promise<StoredSkillRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM skills WHERE id = ?')
        .get(skillId) as StoredSkillRecord | undefined) ?? null
    );
  }

  async findBySlug(
    userId: string,
    slug: string
  ): Promise<StoredSkillRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM skills WHERE user_id = ? AND slug = ?')
        .get(userId, slug) as StoredSkillRecord | undefined) ?? null
    );
  }

  async replaceWithLimit(
    skill: StoredSkillRecord,
    maximum: number,
    archivedVersion: StoredSkillVersionRecord | null
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'skills',
        skill.id,
        skill.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare('SELECT COUNT(*) AS count FROM skills WHERE user_id = ?')
          .get(skill.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('skill', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO skills
             (id, user_id, slug, name, description, instructions, enabled,
              version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             slug = excluded.slug,
             name = excluded.name,
             description = excluded.description,
             instructions = excluded.instructions,
             enabled = excluded.enabled,
             version = excluded.version,
             updated_at = excluded.updated_at
           WHERE skills.user_id = excluded.user_id`
        )
        .run(
          skill.id,
          skill.user_id,
          skill.slug,
          skill.name,
          skill.description,
          skill.instructions,
          skill.enabled,
          skill.version,
          skill.created_at,
          skill.updated_at
        );
      if (archivedVersion) {
        this.database
          .prepare(
            `INSERT INTO skill_versions
               (id, skill_id, version, instructions, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(skill_id, version) DO NOTHING`
          )
          .run(
            archivedVersion.id,
            archivedVersion.skill_id,
            archivedVersion.version,
            archivedVersion.instructions,
            archivedVersion.created_at
          );
      }
    });
    replace();
  }

  async listVersions(
    skillId: string,
    maximum: number
  ): Promise<StoredSkillVersionRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM skill_versions
         WHERE skill_id = ?
         ORDER BY version DESC
         LIMIT ?`
      )
      .all(skillId, maximum) as StoredSkillVersionRecord[];
  }

  async findVersion(
    skillId: string,
    version: number
  ): Promise<StoredSkillVersionRecord | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM skill_versions WHERE skill_id = ? AND version = ?'
        )
        .get(skillId, version) as StoredSkillVersionRecord | undefined) ?? null
    );
  }

  async deleteByOwner(skillId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM skills WHERE id = ? AND user_id = ?')
        .run(skillId, userId).changes > 0
    );
  }
}

class SQLiteSkillFileRepository implements SkillFileRepository {
  constructor(private readonly database: Database.Database) {}

  async listBySkill(skillId: string): Promise<StoredSkillFileRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM skill_files
         WHERE skill_id = ?
         ORDER BY path ASC`
      )
      .all(skillId) as StoredSkillFileRecord[];
  }

  async find(
    skillId: string,
    path: string
  ): Promise<StoredSkillFileRecord | null> {
    return (
      (this.database
        .prepare('SELECT * FROM skill_files WHERE skill_id = ? AND path = ?')
        .get(skillId, path) as StoredSkillFileRecord | undefined) ?? null
    );
  }

  async upsert(
    file: StoredSkillFileRecord,
    maximumPerSkill: number
  ): Promise<void> {
    const upsert = this.database.transaction(() => {
      const exists = this.database
        .prepare('SELECT id FROM skill_files WHERE skill_id = ? AND path = ?')
        .get(file.skill_id, file.path);
      if (!exists) {
        const row = this.database
          .prepare(
            'SELECT COUNT(*) AS count FROM skill_files WHERE skill_id = ?'
          )
          .get(file.skill_id) as { count: number };
        if (row.count >= maximumPerSkill) {
          throw new PersistenceResourceLimitError(
            'skill-file',
            maximumPerSkill
          );
        }
      }
      this.database
        .prepare(
          `INSERT INTO skill_files
             (id, skill_id, path, content, size, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(skill_id, path) DO UPDATE SET
             content = excluded.content,
             size = excluded.size,
             updated_at = excluded.updated_at`
        )
        .run(
          file.id,
          file.skill_id,
          file.path,
          file.content,
          file.size,
          file.created_at,
          file.updated_at
        );
    });
    upsert();
  }

  async replaceAllForSkill(
    skillId: string,
    files: readonly StoredSkillFileRecord[]
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM skill_files WHERE skill_id = ?')
        .run(skillId);
      const insert = this.database.prepare(
        `INSERT INTO skill_files
           (id, skill_id, path, content, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const file of files) {
        if (file.skill_id !== skillId) {
          throw new Error('A skill file does not belong to its skill');
        }
        insert.run(
          file.id,
          file.skill_id,
          file.path,
          file.content,
          file.size,
          file.created_at,
          file.updated_at
        );
      }
    });
    replace();
  }

  async delete(skillId: string, path: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM skill_files WHERE skill_id = ? AND path = ?')
        .run(skillId, path).changes > 0
    );
  }
}

class SQLiteSessionFolderRepository implements SessionFolderRepository {
  constructor(private readonly database: Database.Database) {}

  async listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredNamedResourceRecord[]> {
    return this.database
      .prepare(
        `SELECT * FROM session_folders
         WHERE user_id = ?
         ORDER BY name COLLATE NOCASE ASC
         LIMIT ?`
      )
      .all(userId, maximum) as StoredNamedResourceRecord[];
  }

  async replaceWithLimit(
    folder: StoredNamedResourceRecord,
    maximum: number
  ): Promise<void> {
    const replace = this.database.transaction(() => {
      const exists = ensureSameOwner(
        this.database,
        'session_folders',
        folder.id,
        folder.user_id
      );
      if (!exists) {
        const row = this.database
          .prepare(
            'SELECT COUNT(*) AS count FROM session_folders WHERE user_id = ?'
          )
          .get(folder.user_id) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError('session-folder', maximum);
        }
      }
      this.database
        .prepare(
          `INSERT INTO session_folders
             (id, user_id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             updated_at = excluded.updated_at
           WHERE session_folders.user_id = excluded.user_id`
        )
        .run(
          folder.id,
          folder.user_id,
          folder.name,
          folder.created_at,
          folder.updated_at
        );
    });
    replace();
  }

  async deleteAndDetach(folderId: string, userId: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database
        .prepare(
          'UPDATE sessions SET folder_id = NULL WHERE folder_id = ? AND user_id = ?'
        )
        .run(folderId, userId);
      return this.database
        .prepare('DELETE FROM session_folders WHERE id = ? AND user_id = ?')
        .run(folderId, userId).changes;
    });
    return remove() > 0;
  }
}

class SQLitePreferenceRepository implements PreferenceRepository {
  constructor(private readonly database: Database.Database) {}

  async resolveOwner(userId?: string): Promise<string | null> {
    if (userId) return userId;
    const row = this.database
      .prepare('SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1')
      .get() as { id: string } | undefined;
    return row?.id ?? null;
  }

  async listByOwner(userId: string): Promise<StoredPreferenceRecord[]> {
    return this.database
      .prepare(
        'SELECT key, value FROM user_preferences WHERE user_id = ? ORDER BY key ASC'
      )
      .all(userId) as StoredPreferenceRecord[];
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
    const mutate = this.database.transaction(() => {
      const owner = userId
        ? (this.database
            .prepare('SELECT id FROM users WHERE id = ?')
            .get(userId) as { id: string } | undefined)
        : (this.database
            .prepare(
              'SELECT id FROM users ORDER BY created_at ASC, id ASC LIMIT 1'
            )
            .get() as { id: string } | undefined);
      if (!owner) {
        if (userId) throw new Error('Resource owner does not exist');
        return null;
      }

      const current = this.database
        .prepare(
          'SELECT key, value FROM user_preferences WHERE user_id = ? ORDER BY key ASC'
        )
        .all(owner.id) as StoredPreferenceRecord[];
      const requested = mutation(current);
      if (requested === undefined) {
        return { userId: owner.id, preferences: current };
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
      this.database
        .prepare('DELETE FROM user_preferences WHERE user_id = ?')
        .run(owner.id);
      const insert = this.database.prepare(
        `INSERT INTO user_preferences
           (id, user_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const preference of preferences) {
        insert.run(
          uuidv4(),
          owner.id,
          preference.key,
          preference.value,
          timestamp,
          timestamp
        );
      }
      return { userId: owner.id, preferences };
    });
    return mutate.immediate();
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
    const remove = this.database.transaction(() => {
      const statement = this.database.prepare(
        'DELETE FROM user_preferences WHERE user_id = ? AND key = ?'
      );
      let removed = 0;
      for (const key of keys) removed += statement.run(userId, key).changes;
      return removed;
    });
    return remove();
  }
}

class SQLiteSystemSettingRepository implements SystemSettingRepository {
  constructor(private readonly database: Database.Database) {}

  async get(key: string): Promise<string | null> {
    const row = this.database
      .prepare('SELECT value FROM system_settings WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  async getMany(keys: readonly string[]): Promise<Record<string, string>> {
    if (keys.length === 0) return {};
    const statement = this.database.prepare(
      'SELECT value FROM system_settings WHERE key = ?'
    );
    const values: Record<string, string> = {};
    for (const key of keys) {
      const row = statement.get(key) as { value: string } | undefined;
      if (row) values[key] = row.value;
    }
    return values;
  }

  async upsert(key: string, value: string, updatedAt: number): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      )
      .run(key, value, updatedAt);
  }

  async upsertMany(
    values: Readonly<Record<string, string>>,
    updatedAt: number
  ): Promise<void> {
    const save = this.database.transaction(() => {
      const statement = this.database.prepare(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value = excluded.value,
           updated_at = excluded.updated_at`
      );
      for (const [key, value] of Object.entries(values)) {
        statement.run(key, value, updatedAt);
      }
    });
    save();
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

class SQLiteDataArchiveRepository implements DataArchiveRepository {
  constructor(private readonly database: Database.Database) {}

  async ownerOf(
    resource: keyof typeof ARCHIVE_TABLES,
    id: string
  ): Promise<string | null> {
    const row = this.database
      .prepare(`SELECT user_id FROM ${ARCHIVE_TABLES[resource]} WHERE id = ?`)
      .get(id) as { user_id: string } | undefined;
    return row?.user_id ?? null;
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
    const row = this.database
      .prepare(
        `SELECT owner.user_id, child.${definition.parent} AS parent_id
           FROM ${definition.child} child
           JOIN ${definition.owner} owner ON owner.id = child.${definition.parent}
          WHERE child.id = ?`
      )
      .get(id) as { user_id: string; parent_id: string } | undefined;
    return row ? { userId: row.user_id, parentId: row.parent_id } : null;
  }

  async countByOwner(
    resource: 'session-folder' | 'note',
    userId: string
  ): Promise<number> {
    const table = resource === 'session-folder' ? 'session_folders' : 'notes';
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
      .get(userId) as { count: number };
    return row.count;
  }

  async resourceDeletionReserved(
    resource: 'document',
    id: string
  ): Promise<boolean> {
    return Boolean(
      this.database
        .prepare(
          `SELECT 1 FROM platform_resource_deletion_tombstones
            WHERE resource_type = ? AND resource_id = ?`
        )
        .get(resource, id)
    );
  }

  async applyImport(plan: DataArchiveApplyPlan): Promise<void> {
    const apply = this.database.transaction(() => {
      const owner = this.database
        .prepare('SELECT id FROM users WHERE id = ?')
        .get(plan.userId);
      if (!owner) throw new Error('Archive import owner does not exist');

      const shouldWrite = (table: string, id: string): boolean => {
        const exists = ensureSameOwner(this.database, table, id, plan.userId);
        return !exists || plan.strategy === 'overwrite';
      };
      const enforceLimit = (
        table: 'notes' | 'session_folders',
        id: string,
        maximum: number
      ): void => {
        const existing = this.database
          .prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
          .get(id) as { user_id: string } | undefined;
        if (existing) return;
        const row = this.database
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id = ?`)
          .get(plan.userId) as { count: number };
        if (row.count >= maximum) {
          throw new PersistenceResourceLimitError(
            table === 'notes' ? 'note' : 'session-folder',
            maximum
          );
        }
      };

      const currentPreferences = this.database
        .prepare(
          'SELECT key, value FROM user_preferences WHERE user_id = ? ORDER BY key ASC'
        )
        .all(plan.userId) as StoredPreferenceRecord[];
      const preferences =
        typeof plan.preferences === 'function'
          ? [...plan.preferences(currentPreferences)]
          : plan.preferences;
      this.database
        .prepare('DELETE FROM user_preferences WHERE user_id = ?')
        .run(plan.userId);
      const insertPreference = this.database.prepare(
        `INSERT INTO user_preferences
           (id, user_id, key, value, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      for (const preference of preferences) {
        insertPreference.run(
          uuidv4(),
          plan.userId,
          preference.key,
          preference.value,
          plan.timestamp,
          plan.timestamp
        );
      }

      const upsertFolder = this.database.prepare(
        `INSERT INTO session_folders
           (id, user_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at
         WHERE session_folders.user_id = excluded.user_id`
      );
      for (const folder of plan.sessionFolders) {
        if (!shouldWrite('session_folders', folder.id)) continue;
        enforceLimit('session_folders', folder.id, plan.maximumSessionFolders);
        upsertFolder.run(
          folder.id,
          plan.userId,
          folder.name,
          folder.created_at,
          folder.updated_at
        );
      }

      const upsertNote = this.database.prepare(
        `INSERT INTO notes
           (id, user_id, title, content, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           updated_at = excluded.updated_at
         WHERE notes.user_id = excluded.user_id`
      );
      for (const note of plan.notes) {
        if (!shouldWrite('notes', note.id)) continue;
        enforceLimit('notes', note.id, plan.maximumNotes);
        upsertNote.run(
          note.id,
          plan.userId,
          note.title,
          note.content,
          note.created_at,
          note.updated_at
        );
      }

      const upsertCollection = this.database.prepare(
        `INSERT INTO knowledge_collections
           (id, user_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at
         WHERE knowledge_collections.user_id = excluded.user_id`
      );
      for (const collection of plan.knowledgeCollections) {
        if (!shouldWrite('knowledge_collections', collection.id)) continue;
        upsertCollection.run(
          collection.id,
          plan.userId,
          collection.name,
          collection.created_at,
          collection.updated_at
        );
      }

      const upsertSession = this.database.prepare(
        `INSERT INTO sessions
           (id, user_id, title, model, persona_id, provider_type, provider_id,
            created_at, updated_at, archived, settings, folder_id, pinned)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           model = excluded.model,
           persona_id = excluded.persona_id,
           provider_type = excluded.provider_type,
           provider_id = excluded.provider_id,
           updated_at = excluded.updated_at,
           archived = excluded.archived,
           settings = excluded.settings,
           folder_id = excluded.folder_id,
           pinned = excluded.pinned
         WHERE sessions.user_id = excluded.user_id`
      );
      const insertMessage = this.database.prepare(
        `INSERT INTO session_messages
           (id, session_id, role, content, thinking, timestamp, message_index,
            model, provider_metadata, images, statistics, artifacts, parent_id,
            branch_index, is_active, rating)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const updateMessageParent = this.database.prepare(
        'UPDATE session_messages SET parent_id = ? WHERE id = ? AND session_id = ?'
      );
      for (const aggregate of plan.sessions) {
        const { session } = aggregate;
        if (!shouldWrite('sessions', session.id)) continue;
        upsertSession.run(
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
          session.pinned
        );
        this.database
          .prepare('DELETE FROM session_messages WHERE session_id = ?')
          .run(session.id);
        for (const message of aggregate.messages) {
          if (message.session_id !== session.id) {
            throw new Error('A chat message does not belong to its aggregate');
          }
          insertMessage.run(
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
            null,
            message.branch_index,
            message.is_active,
            message.rating
          );
        }
        for (const message of aggregate.messages) {
          if (message.parent_id) {
            updateMessageParent.run(message.parent_id, message.id, session.id);
          }
        }
      }

      const upsertDocument = this.database.prepare(
        `INSERT INTO documents
           (id, user_id, filename, title, content, file_type, size, session_id,
            collection_id, metadata, uploaded_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           filename = excluded.filename,
           title = excluded.title,
           content = excluded.content,
           file_type = excluded.file_type,
           size = excluded.size,
           session_id = excluded.session_id,
           collection_id = excluded.collection_id,
           metadata = excluded.metadata,
           uploaded_at = excluded.uploaded_at,
           updated_at = excluded.updated_at
         WHERE documents.user_id = excluded.user_id`
      );
      const insertChunk = this.database.prepare(
        `INSERT INTO document_chunks
           (id, document_id, chunk_index, content, start_char, end_char,
            embedding, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const aggregate of plan.documents) {
        const { document } = aggregate;
        const reserved = this.database
          .prepare(
            `SELECT 1 FROM platform_resource_deletion_tombstones
              WHERE resource_type = 'document' AND resource_id = ?`
          )
          .get(document.id);
        if (reserved) {
          throw new PersistenceResourceDeletionReservedError(document.id);
        }
        if (!shouldWrite('documents', document.id)) continue;
        upsertDocument.run(
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
          document.updated_at
        );
        this.database
          .prepare('DELETE FROM document_chunks WHERE document_id = ?')
          .run(document.id);
        for (const chunk of aggregate.chunks) {
          if (chunk.document_id !== document.id) {
            throw new Error(
              'A document chunk does not belong to its aggregate'
            );
          }
          insertChunk.run(
            chunk.id,
            chunk.document_id,
            chunk.chunk_index,
            chunk.content,
            chunk.start_char,
            chunk.end_char,
            null,
            chunk.created_at
          );
        }
      }
      plan.assertCanCommit?.();
    });
    apply.immediate();
  }
}

export const createSQLiteResourceRepositories = (
  database: Database.Database
): ApplicationResourceRepositories => ({
  chatSessions: new SQLiteChatSessionRepository(database),
  knowledgeCollections: new SQLiteKnowledgeCollectionRepository(database),
  notes: new SQLiteNoteRepository(database),
  calendarEvents: new SQLiteCalendarEventRepository(database),
  automations: new SQLiteAutomationRepository(database),
  automationRuns: new SQLiteAutomationRunRepository(database),
  toolServers: new SQLiteToolServerRepository(database),
  toolServerTools: new SQLiteToolServerToolRepository(database),
  toolServerCredentials: new SQLiteToolServerCredentialRepository(database),
  toolApprovals: new SQLiteToolApprovalRepository(database),
  prompts: new SQLitePromptRepository(database),
  skills: new SQLiteSkillRepository(database),
  skillFiles: new SQLiteSkillFileRepository(database),
  sessionFolders: new SQLiteSessionFolderRepository(database),
  preferences: new SQLitePreferenceRepository(database),
  systemSettings: new SQLiteSystemSettingRepository(database),
  archive: new SQLiteDataArchiveRepository(database),
});
