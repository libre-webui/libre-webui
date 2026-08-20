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

import { v4 as uuidv4 } from 'uuid';
import {
  AutomationTrigger,
  CalendarEvent,
  ChatSession,
  ChatMessage,
  DocumentChunk,
  KnowledgeCollection,
  Note,
  SessionFolder,
  UserPreferences,
} from './types/index.js';
import { encryptionService } from './services/encryptionService.js';
import { getPersistence } from './persistence/index.js';
import { PersistenceResourceLimitError } from './persistence/resourceTypes.js';
import { createLogger } from './utils/logger.js';
import {
  MAX_CALENDAR_EVENT_NOTES_LENGTH,
  MAX_CALENDAR_EVENT_TITLE_LENGTH,
  MAX_CALENDAR_EVENTS_PER_USER,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTES_PER_USER,
  MAX_NOTE_TITLE_LENGTH,
  MAX_SESSION_FOLDER_NAME_LENGTH,
  MAX_SESSION_FOLDERS_PER_USER,
  ResourcePolicyError,
} from './utils/resourceLimits.js';
import {
  mapSessionRow,
  type Document,
  type MessageRow,
  type SessionRow,
} from './storageMappers.js';
import { getPlatformStorageRuntime } from './platform/storage/index.js';
import type {
  ChatGenerationEnqueuer,
  ChatGenerationEnqueueInput,
} from './persistence/chatGenerationTypes.js';
import type {
  StoredCalendarEventRecord,
  StoredChatSessionAggregate,
  StoredChatMessageRecord,
  StoredPreferenceRecord,
} from './persistence/resourceTypes.js';
import type {
  DurableJobEventAppendInput,
  DurableJobLeaseIdentity,
} from './platform/jobs/durableJobTypes.js';
import { getDurableJobRuntime } from './platform/jobs/durableJobRuntime.js';

const logger = createLogger('storage');
export type { Document } from './storageMappers.js';

class StorageService {
  // =================================
  // SESSION MANAGEMENT
  // =================================

  async getAllSessions(userId = 'default'): Promise<ChatSession[]> {
    const aggregates =
      await getPersistence(
        encryptionService
      ).repositories.resources.chatSessions.listByOwner(userId);
    return aggregates.map(({ session, messages }) =>
      mapSessionRow(
        session as SessionRow,
        messages as MessageRow[],
        this.siblingCounts(messages as MessageRow[])
      )
    );
  }

  async getSession(
    sessionId: string,
    userId = 'default'
  ): Promise<ChatSession | undefined> {
    const aggregate = await getPersistence(
      encryptionService
    ).repositories.resources.chatSessions.findByOwner(sessionId, userId);
    if (!aggregate) return undefined;
    return mapSessionRow(
      aggregate.session as SessionRow,
      aggregate.messages as MessageRow[],
      this.siblingCounts(aggregate.messages as MessageRow[])
    );
  }

  private protectMessage(
    sessionId: string,
    message: ChatMessage,
    messageIndex: number
  ): StoredChatMessageRecord {
    return {
      id: message.id || uuidv4(),
      session_id: sessionId,
      role: message.role,
      content: encryptionService.encrypt(message.content),
      thinking: message.thinking
        ? encryptionService.encrypt(message.thinking)
        : null,
      timestamp: message.timestamp,
      message_index: messageIndex,
      model: message.model || null,
      provider_metadata: message.providerMetadata
        ? encryptionService.encrypt(JSON.stringify(message.providerMetadata))
        : null,
      images: message.images
        ? encryptionService.encrypt(JSON.stringify(message.images))
        : null,
      statistics: message.statistics
        ? encryptionService.encrypt(JSON.stringify(message.statistics))
        : null,
      artifacts: message.artifacts
        ? encryptionService.encrypt(JSON.stringify(message.artifacts))
        : null,
      parent_id: message.parentId || null,
      branch_index: message.branchIndex ?? 0,
      is_active: message.isActive !== false ? 1 : 0,
      rating: message.rating ?? null,
    };
  }

  private protectSession(
    session: ChatSession,
    userId: string
  ): StoredChatSessionAggregate {
    return {
      session: {
        id: session.id,
        user_id: userId,
        title: encryptionService.encrypt(session.title),
        model: session.model,
        persona_id: session.personaId || null,
        provider_type: session.providerType || null,
        provider_id: session.providerId || null,
        created_at: session.createdAt,
        updated_at: session.updatedAt,
        archived: session.archived ? 1 : 0,
        settings: session.settings
          ? encryptionService.encrypt(JSON.stringify(session.settings))
          : null,
        folder_id: session.folderId || null,
        pinned: session.pinned ? 1 : 0,
      },
      messages: (session.messages || []).map((message, index) =>
        this.protectMessage(session.id, message, index)
      ),
    };
  }

  async saveSession(
    session: ChatSession,
    userId = 'default',
    beforeCommit?: () => void | Promise<void>
  ): Promise<void> {
    const persistence = getPersistence(encryptionService);
    if (beforeCommit && persistence.dialect === 'sqlite') await beforeCommit();
    await persistence.repositories.resources.chatSessions.replace(
      this.protectSession(session, userId),
      persistence.dialect === 'postgres' ? beforeCommit : undefined
    );
  }

  async saveSessionAndEnqueueGeneration(
    session: ChatSession,
    userId: string,
    enqueuer: ChatGenerationEnqueuer,
    input: ChatGenerationEnqueueInput,
    beforeCommit?: () => void | Promise<void>
  ): Promise<void> {
    const persistence = getPersistence(encryptionService);
    if (beforeCommit && persistence.dialect === 'sqlite') await beforeCommit();
    await persistence.repositories.resources.chatSessions.replaceAndEnqueue(
      this.protectSession(session, userId),
      enqueuer,
      input,
      persistence.dialect === 'postgres' ? beforeCommit : undefined
    );
  }

  async publishDurableChatCompletion(input: {
    sessionId: string;
    userId: string;
    message: ChatMessage & { role: 'assistant' };
    lease: DurableJobLeaseIdentity;
    expectedJobType: string;
    event: DurableJobEventAppendInput;
    beforeCommit?: () => void | Promise<void>;
  }): Promise<number> {
    const message = this.protectMessage(input.sessionId, input.message, 0);
    const persistence = getPersistence(encryptionService);
    if (input.beforeCommit && persistence.dialect === 'sqlite') {
      await input.beforeCommit();
    }
    return getDurableJobRuntime().service.publishChatCompletion({
      lease: input.lease,
      actorUserId: input.userId,
      sessionId: input.sessionId,
      expectedJobType: input.expectedJobType,
      message: {
        id: message.id,
        sessionId: message.session_id,
        role: 'assistant',
        content: message.content,
        thinking: message.thinking,
        timestamp: message.timestamp,
        model: message.model,
        providerMetadata: message.provider_metadata,
        images: message.images,
        statistics: message.statistics,
        artifacts: message.artifacts,
        parentId: message.parent_id,
        isActive: message.is_active,
        rating: message.rating,
      },
      event: input.event,
      ...(persistence.dialect === 'postgres' && input.beforeCommit
        ? { beforeCommit: input.beforeCommit }
        : {}),
    });
  }

  async removeSessionMessageIfCurrent(input: {
    sessionId: string;
    userId: string;
    messageId: string;
    expectedTimestamp: number;
    expectedSessionUpdatedAt: number;
    previousSessionUpdatedAt: number;
    previousActiveMessageId?: string;
  }): Promise<boolean> {
    return getPersistence(
      encryptionService
    ).repositories.resources.chatSessions.removeMessageIfCurrent(
      input.sessionId,
      input.userId,
      input.messageId,
      input.expectedTimestamp,
      input.expectedSessionUpdatedAt,
      input.previousSessionUpdatedAt,
      input.previousActiveMessageId
    );
  }

  async deleteSession(
    sessionId: string,
    userId = 'default',
    beforeCommit?: () => void | Promise<void>
  ): Promise<boolean> {
    const persistence = getPersistence(encryptionService);
    if (beforeCommit && persistence.dialect === 'sqlite') await beforeCommit();
    return persistence.repositories.resources.chatSessions.deleteByOwner(
      sessionId,
      userId,
      persistence.dialect === 'postgres' ? beforeCommit : undefined
    );
  }

  private siblingCounts(messages: MessageRow[]): Array<{
    parent_id: string;
    count: number;
  }> {
    const counts = new Map<string, number>();
    for (const message of messages) {
      if (message.parent_id) {
        counts.set(message.parent_id, (counts.get(message.parent_id) || 0) + 1);
      }
    }
    return [...counts].map(([parent_id, count]) => ({ parent_id, count }));
  }

  // =================================
  // KNOWLEDGE COLLECTIONS
  // =================================

  async getKnowledgeCollections(
    userId = 'default'
  ): Promise<KnowledgeCollection[]> {
    const rows =
      await getPersistence(
        encryptionService
      ).repositories.resources.knowledgeCollections.listByOwner(userId);
    return rows.map(row => ({
      id: row.id,
      name: encryptionService.decrypt(row.name),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveKnowledgeCollection(
    collection: KnowledgeCollection,
    userId = 'default'
  ): Promise<void> {
    await getPersistence(
      encryptionService
    ).repositories.resources.knowledgeCollections.replace({
      id: collection.id,
      user_id: userId,
      name: encryptionService.encrypt(collection.name),
      created_at: collection.createdAt,
      updated_at: collection.updatedAt,
    });
  }

  async deleteKnowledgeCollection(
    collectionId: string,
    userId = 'default'
  ): Promise<boolean> {
    return getPersistence(
      encryptionService
    ).repositories.resources.knowledgeCollections.deleteAndDetach(
      collectionId,
      userId
    );
  }

  async setDocumentCollection(
    documentId: string,
    collectionId: string | null,
    userId = 'default'
  ): Promise<boolean> {
    return getPlatformStorageRuntime().domains.documents.setCollection(
      documentId,
      collectionId,
      userId
    );
  }

  // =================================
  // NOTES
  // =================================

  async getNotes(userId = 'default'): Promise<Note[]> {
    const rows = await getPersistence(
      encryptionService
    ).repositories.resources.notes.listByOwner(userId, MAX_NOTES_PER_USER);
    return rows.map(row => ({
      id: row.id,
      title: encryptionService.decrypt(row.title),
      content: encryptionService.decrypt(row.content),
      ...(row.pinned ? { pinned: true } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getNote(noteId: string, userId = 'default'): Promise<Note | undefined> {
    const row = await getPersistence(
      encryptionService
    ).repositories.resources.notes.findByOwner(noteId, userId);
    return row
      ? {
          id: row.id,
          title: encryptionService.decrypt(row.title),
          content: encryptionService.decrypt(row.content),
          ...(row.pinned ? { pinned: true } : {}),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async saveNote(note: Note, userId = 'default'): Promise<void> {
    if (
      note.title.length > MAX_NOTE_TITLE_LENGTH ||
      note.content.length > MAX_NOTE_CONTENT_LENGTH
    ) {
      throw new ResourcePolicyError('Note exceeds the maximum size', 400);
    }
    try {
      await getPersistence(
        encryptionService
      ).repositories.resources.notes.replaceWithLimit(
        {
          id: note.id,
          user_id: userId,
          title: encryptionService.encrypt(note.title),
          content: encryptionService.encrypt(note.content),
          pinned: note.pinned ? 1 : 0,
          created_at: note.createdAt,
          updated_at: note.updatedAt,
        },
        MAX_NOTES_PER_USER
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ResourcePolicyError(
          `A user may store at most ${MAX_NOTES_PER_USER} notes`,
          409
        );
      }
      throw error;
    }
  }

  async updateNote(
    noteId: string,
    updates: { title?: string; content?: string },
    userId = 'default'
  ): Promise<Note | undefined> {
    if (
      (updates.title !== undefined &&
        updates.title.length > MAX_NOTE_TITLE_LENGTH) ||
      (updates.content !== undefined &&
        updates.content.length > MAX_NOTE_CONTENT_LENGTH)
    ) {
      throw new ResourcePolicyError('Note exceeds the maximum size', 400);
    }
    const row = await getPersistence(
      encryptionService
    ).repositories.resources.notes.patchByOwner(noteId, userId, {
      ...(updates.title !== undefined
        ? { title: encryptionService.encrypt(updates.title) }
        : {}),
      ...(updates.content !== undefined
        ? { content: encryptionService.encrypt(updates.content) }
        : {}),
      updated_at: Date.now(),
    });
    return row
      ? {
          id: row.id,
          title: encryptionService.decrypt(row.title),
          content: encryptionService.decrypt(row.content),
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }
      : undefined;
  }

  async deleteNote(noteId: string, userId = 'default'): Promise<boolean> {
    return getPersistence(
      encryptionService
    ).repositories.resources.notes.deleteByOwner(noteId, userId);
  }

  // =================================
  // CALENDAR EVENTS
  // =================================

  private mapCalendarEventRow(row: StoredCalendarEventRecord): CalendarEvent {
    const recurrence = row.recurrence
      ? (JSON.parse(
          encryptionService.decrypt(row.recurrence)
        ) as AutomationTrigger)
      : undefined;
    return {
      id: row.id,
      title: encryptionService.decrypt(row.title),
      notes: row.notes ? encryptionService.decrypt(row.notes) : undefined,
      startAt: row.start_at,
      endAt: row.end_at ?? undefined,
      allDay: row.all_day === 1,
      ...(recurrence ? { recurrence } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async getCalendarEventsBetween(
    from: number,
    to: number,
    userId = 'default'
  ): Promise<CalendarEvent[]> {
    const repositories = getPersistence(encryptionService).repositories;
    const rows = await repositories.resources.calendarEvents.listByOwnerBetween(
      userId,
      from,
      to,
      MAX_CALENDAR_EVENTS_PER_USER
    );
    return rows.map(row => this.mapCalendarEventRow(row));
  }

  async getRecurringCalendarEvents(
    userId = 'default'
  ): Promise<CalendarEvent[]> {
    const repositories = getPersistence(encryptionService).repositories;
    const rows =
      await repositories.resources.calendarEvents.listRecurringByOwner(
        userId,
        MAX_CALENDAR_EVENTS_PER_USER
      );
    return rows.map(row => this.mapCalendarEventRow(row));
  }

  async getCalendarEvent(
    eventId: string,
    userId = 'default'
  ): Promise<CalendarEvent | undefined> {
    const row = await getPersistence(
      encryptionService
    ).repositories.resources.calendarEvents.findByOwner(eventId, userId);
    return row ? this.mapCalendarEventRow(row) : undefined;
  }

  async saveCalendarEvent(
    event: CalendarEvent,
    userId = 'default'
  ): Promise<void> {
    if (
      event.title.length > MAX_CALENDAR_EVENT_TITLE_LENGTH ||
      (event.notes?.length ?? 0) > MAX_CALENDAR_EVENT_NOTES_LENGTH
    ) {
      throw new ResourcePolicyError(
        'Calendar event exceeds the maximum size',
        400
      );
    }
    try {
      await getPersistence(
        encryptionService
      ).repositories.resources.calendarEvents.replaceWithLimit(
        {
          id: event.id,
          user_id: userId,
          title: encryptionService.encrypt(event.title),
          notes: event.notes ? encryptionService.encrypt(event.notes) : null,
          start_at: event.startAt,
          end_at: event.endAt ?? null,
          all_day: event.allDay ? 1 : 0,
          recurrence: event.recurrence
            ? encryptionService.encrypt(JSON.stringify(event.recurrence))
            : null,
          created_at: event.createdAt,
          updated_at: event.updatedAt,
        },
        MAX_CALENDAR_EVENTS_PER_USER
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ResourcePolicyError(
          `A user may store at most ${MAX_CALENDAR_EVENTS_PER_USER} calendar events`,
          409
        );
      }
      throw error;
    }
  }

  async deleteCalendarEvent(
    eventId: string,
    userId = 'default'
  ): Promise<boolean> {
    return getPersistence(
      encryptionService
    ).repositories.resources.calendarEvents.deleteByOwner(eventId, userId);
  }

  // =================================
  // SESSION FOLDERS
  // =================================

  async getSessionFolders(userId = 'default'): Promise<SessionFolder[]> {
    const rows = await getPersistence(
      encryptionService
    ).repositories.resources.sessionFolders.listByOwner(
      userId,
      MAX_SESSION_FOLDERS_PER_USER
    );
    return rows.map(row => ({
      id: row.id,
      name: encryptionService.decrypt(row.name),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async saveSessionFolder(
    folder: SessionFolder,
    userId = 'default'
  ): Promise<void> {
    if (
      !folder.name.trim() ||
      folder.name.length > MAX_SESSION_FOLDER_NAME_LENGTH
    ) {
      throw new ResourcePolicyError('Invalid session folder name', 400);
    }
    try {
      await getPersistence(
        encryptionService
      ).repositories.resources.sessionFolders.replaceWithLimit(
        {
          id: folder.id,
          user_id: userId,
          name: encryptionService.encrypt(folder.name),
          created_at: folder.createdAt,
          updated_at: folder.updatedAt,
        },
        MAX_SESSION_FOLDERS_PER_USER
      );
    } catch (error) {
      if (error instanceof PersistenceResourceLimitError) {
        throw new ResourcePolicyError(
          `A user may store at most ${MAX_SESSION_FOLDERS_PER_USER} session folders`,
          409
        );
      }
      throw error;
    }
  }

  async deleteSessionFolder(
    folderId: string,
    userId = 'default'
  ): Promise<boolean> {
    return getPersistence(
      encryptionService
    ).repositories.resources.sessionFolders.deleteAndDetach(folderId, userId);
  }

  async clearAllSessions(userId = 'default'): Promise<number> {
    return getPersistence(
      encryptionService
    ).repositories.resources.chatSessions.deleteAllByOwner(userId);
  }

  // =================================
  // PREFERENCES MANAGEMENT
  // =================================

  /**
   * Safely decrypt and parse a preference value with proper error handling
   * while distinguishing valid JSON null from corrupted data.
   */
  private safeDecryptPreference(
    value: string
  ): { valid: true; value: unknown } | { valid: false } {
    try {
      const decryptedValue = encryptionService.decrypt(value);
      try {
        return { valid: true, value: JSON.parse(decryptedValue) };
      } catch {
        return { valid: false };
      }
    } catch {
      // Try as unencrypted legacy data
      try {
        return { valid: true, value: JSON.parse(value) };
      } catch {
        return { valid: false };
      }
    }
  }

  private decodePreferences(rows: readonly StoredPreferenceRecord[]): {
    preferences: UserPreferences | null;
    validRows: StoredPreferenceRecord[];
    corruptedCount: number;
  } {
    const preferences: Record<string, unknown> = {};
    const validRows: StoredPreferenceRecord[] = [];
    let corruptedCount = 0;
    for (const row of rows) {
      const decoded = this.safeDecryptPreference(row.value);
      if (!decoded.valid) {
        corruptedCount += 1;
        continue;
      }
      preferences[row.key] = decoded.value;
      validRows.push(row);
    }
    return {
      preferences:
        Object.keys(preferences).length > 0
          ? (preferences as unknown as UserPreferences)
          : null,
      validRows,
      corruptedCount,
    };
  }

  private encodePreferences(
    preferences: UserPreferences
  ): StoredPreferenceRecord[] {
    return Object.entries(preferences).flatMap(([key, value]) =>
      value === undefined
        ? []
        : [
            {
              key,
              value: encryptionService.encrypt(JSON.stringify(value)),
            },
          ]
    );
  }

  /**
   * Map protected preference rows through a synchronous application mutation.
   * Archive repositories use this only from their owner-locked transaction so
   * merge imports derive from the latest committed preferences.
   */
  transformStoredPreferences(
    current: readonly StoredPreferenceRecord[],
    mutation: (preferences: UserPreferences | null) => UserPreferences
  ): StoredPreferenceRecord[] {
    return this.encodePreferences(
      mutation(this.decodePreferences(current).preferences)
    );
  }

  async getPreferences(userId?: string): Promise<UserPreferences | null> {
    const repository =
      getPersistence(encryptionService).repositories.resources.preferences;
    const owner = await repository.resolveOwner(userId);
    if (!owner) return null;
    const rows = await repository.listByOwner(owner);
    if (rows.length === 0) return null;
    const decoded = this.decodePreferences(rows);
    if (decoded.corruptedCount === 0) return decoded.preferences;

    // Re-read under the same serialization boundary used by writers. A stale
    // read must never delete a value that another replica repaired meanwhile.
    let cleaned = 0;
    const result = await repository.mutateAll(owner, Date.now(), current => {
      const fresh = this.decodePreferences(current);
      cleaned = fresh.corruptedCount;
      return fresh.corruptedCount > 0 ? fresh.validRows : undefined;
    });
    if (cleaned > 0) {
      logger.debug(`Cleaned up ${cleaned} corrupted preference value(s)`);
    }
    return result
      ? this.decodePreferences(result.preferences).preferences
      : null;
  }

  /**
   * Atomically derive a preference set from the latest committed value.
   * Returning undefined from the callback performs no logical update (while
   * still removing any corrupt rows encountered under the lock).
   */
  async mutatePreferences(
    mutation: (current: UserPreferences | null) => UserPreferences | undefined,
    userId?: string
  ): Promise<UserPreferences | null> {
    const repository =
      getPersistence(encryptionService).repositories.resources.preferences;
    const result = await repository.mutateAll(userId, Date.now(), current => {
      const decoded = this.decodePreferences(current);
      const requested = mutation(decoded.preferences);
      if (requested !== undefined) {
        return this.transformStoredPreferences(current, () => requested);
      }
      return decoded.corruptedCount > 0 ? decoded.validRows : undefined;
    });
    return result
      ? this.decodePreferences(result.preferences).preferences
      : null;
  }

  async savePreferences(
    preferences: UserPreferences,
    userId?: string
  ): Promise<void> {
    const saved = await this.mutatePreferences(() => preferences, userId);
    if (!saved) throw new Error('No users found in database');
  }

  // =================================
  // DOCUMENT MANAGEMENT
  // =================================

  async getAllDocuments(userId = 'default'): Promise<Document[]> {
    return getPlatformStorageRuntime().domains.documents.listByOwner(userId);
  }

  async getDocument(
    documentId: string,
    userId = 'default'
  ): Promise<Document | undefined> {
    return getPlatformStorageRuntime().domains.documents.findByOwner(
      documentId,
      userId
    );
  }

  async saveDocument(document: Document, userId = 'default'): Promise<void> {
    await getPlatformStorageRuntime().domains.documents.upsert(
      document,
      userId
    );
  }

  async deleteDocument(
    documentId: string,
    userId = 'default'
  ): Promise<boolean> {
    return getPlatformStorageRuntime().domains.documents.deleteByOwner(
      documentId,
      userId
    );
  }

  // =================================
  // DOCUMENT CHUNKS MANAGEMENT
  // =================================

  async getDocumentChunks(documentId: string): Promise<DocumentChunk[]> {
    return getPlatformStorageRuntime().domains.documents.listChunks(documentId);
  }

  async saveDocumentChunks(
    documentId: string,
    chunks: DocumentChunk[]
  ): Promise<void> {
    await getPlatformStorageRuntime().domains.documents.replaceChunks(
      documentId,
      chunks
    );
  }

  async deleteDocumentChunks(documentId: string): Promise<boolean> {
    return getPlatformStorageRuntime().domains.documents.deleteChunks(
      documentId
    );
  }
}

// Export singleton instance
const storageService = new StorageService();
export default storageService;
