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

/**
 * Driver-neutral, already-protected records used at the persistence boundary.
 * Encryption and JSON encoding belong to the application storage mapper; the
 * repositories never inspect or log protected values.
 */
import type {
  ChatGenerationEnqueueInput,
  ChatGenerationEnqueuer,
} from './chatGenerationTypes.js';
export interface StoredChatSessionRecord {
  id: string;
  user_id: string;
  title: string;
  model: string;
  persona_id: string | null;
  provider_type: string | null;
  provider_id: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
  settings: string | null;
  folder_id: string | null;
  pinned: number;
}

export interface StoredChatMessageRecord {
  id: string;
  session_id: string;
  role: string;
  content: string;
  thinking: string | null;
  timestamp: number;
  message_index: number;
  model: string | null;
  provider_metadata: string | null;
  images: string | null;
  statistics: string | null;
  artifacts: string | null;
  parent_id: string | null;
  branch_index: number;
  is_active: number;
  rating: number | null;
}

export interface StoredChatSessionAggregate {
  session: StoredChatSessionRecord;
  messages: StoredChatMessageRecord[];
}

export type PersistenceCommitFence = () => void | Promise<void>;

export interface ChatSessionRepository {
  listByOwner(userId: string): Promise<StoredChatSessionAggregate[]>;
  findByOwner(
    sessionId: string,
    userId: string
  ): Promise<StoredChatSessionAggregate | null>;
  replace(
    aggregate: StoredChatSessionAggregate,
    beforeCommit?: PersistenceCommitFence
  ): Promise<void>;
  replaceAndEnqueue(
    aggregate: StoredChatSessionAggregate,
    enqueuer: ChatGenerationEnqueuer,
    input: ChatGenerationEnqueueInput,
    beforeCommit?: PersistenceCommitFence
  ): Promise<void>;
  removeMessageIfCurrent(
    sessionId: string,
    userId: string,
    messageId: string,
    expectedTimestamp: number,
    expectedSessionUpdatedAt: number,
    previousSessionUpdatedAt: number,
    previousActiveMessageId?: string
  ): Promise<boolean>;
  deleteByOwner(
    sessionId: string,
    userId: string,
    beforeCommit?: PersistenceCommitFence
  ): Promise<boolean>;
  deleteAllByOwner(userId: string): Promise<number>;
}

export interface StoredNamedResourceRecord {
  id: string;
  user_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface KnowledgeCollectionRepository {
  listByOwner(userId: string): Promise<StoredNamedResourceRecord[]>;
  replace(collection: StoredNamedResourceRecord): Promise<void>;
  deleteAndDetach(collectionId: string, userId: string): Promise<boolean>;
}

export interface StoredNoteRecord {
  id: string;
  user_id: string;
  title: string;
  content: string;
  created_at: number;
  updated_at: number;
}

export interface StoredNotePatch {
  title?: string;
  content?: string;
  updated_at: number;
}

export interface NoteRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredNoteRecord[]>;
  findByOwner(noteId: string, userId: string): Promise<StoredNoteRecord | null>;
  replaceWithLimit(note: StoredNoteRecord, maximum: number): Promise<void>;
  patchByOwner(
    noteId: string,
    userId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null>;
  deleteByOwner(noteId: string, userId: string): Promise<boolean>;
}

export interface StoredCalendarEventRecord {
  id: string;
  user_id: string;
  title: string;
  notes: string | null;
  start_at: number;
  end_at: number | null;
  all_day: number;
  recurrence: string | null;
  created_at: number;
  updated_at: number;
}

export interface CalendarEventRepository {
  listByOwnerBetween(
    userId: string,
    from: number,
    to: number,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]>;
  listRecurringByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]>;
  findByOwner(
    eventId: string,
    userId: string
  ): Promise<StoredCalendarEventRecord | null>;
  replaceWithLimit(
    event: StoredCalendarEventRecord,
    maximum: number
  ): Promise<void>;
  deleteByOwner(eventId: string, userId: string): Promise<boolean>;
}

export interface StoredAutomationRecord {
  id: string;
  user_id: string;
  name: string;
  instructions: string;
  triggers: string;
  provider: string | null;
  model: string | null;
  notify: string;
  status: string;
  next_run_at: number | null;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredAutomationRunRecord {
  id: string;
  automation_id: string;
  user_id: string;
  scheduled_for: number;
  started_at: number | null;
  finished_at: number | null;
  status: string;
  session_id: string | null;
  assistant_message_id: string | null;
  error: string | null;
  seen_at: number | null;
  created_at: number;
}

export interface AutomationRepository {
  listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredAutomationRecord[]>;
  findByOwner(
    automationId: string,
    userId: string
  ): Promise<StoredAutomationRecord | null>;
  findById(automationId: string): Promise<StoredAutomationRecord | null>;
  replaceWithLimit(
    automation: StoredAutomationRecord,
    maximum: number
  ): Promise<void>;
  /** Claim due automations: read active rows whose next_run_at is at or before now. */
  listDue(now: number, maximum: number): Promise<StoredAutomationRecord[]>;
  /**
   * Advance scheduling state only when the row still carries the observed
   * next_run_at, so concurrent ticks fire each occurrence exactly once.
   */
  advanceNextRun(
    automationId: string,
    observedNextRunAt: number,
    nextRunAt: number | null,
    lastRunAt: number
  ): Promise<boolean>;
  setStatus(
    automationId: string,
    userId: string,
    status: string,
    nextRunAt: number | null,
    updatedAt: number
  ): Promise<boolean>;
  deleteByOwner(automationId: string, userId: string): Promise<boolean>;
}

export interface AutomationRunRepository {
  insert(run: StoredAutomationRunRecord): Promise<void>;
  findByOwner(
    runId: string,
    userId: string
  ): Promise<StoredAutomationRunRecord | null>;
  listByOwner(
    userId: string,
    options: {
      automationId?: string;
      from?: number;
      to?: number;
      maximum: number;
    }
  ): Promise<StoredAutomationRunRecord[]>;
  listUnfinished(maximum: number): Promise<StoredAutomationRunRecord[]>;
  markStarted(
    runId: string,
    sessionId: string,
    assistantMessageId: string,
    startedAt: number
  ): Promise<boolean>;
  finalize(
    runId: string,
    status: string,
    finishedAt: number,
    error: string | null
  ): Promise<boolean>;
  countUnseenFinished(userId: string): Promise<number>;
  markSeenBefore(userId: string, seenAt: number): Promise<number>;
}

export interface SessionFolderRepository {
  listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredNamedResourceRecord[]>;
  replaceWithLimit(
    folder: StoredNamedResourceRecord,
    maximum: number
  ): Promise<void>;
  deleteAndDetach(folderId: string, userId: string): Promise<boolean>;
}

export interface StoredPreferenceRecord {
  key: string;
  value: string;
}

export interface PreferenceRepository {
  resolveOwner(userId?: string): Promise<string | null>;
  listByOwner(userId: string): Promise<StoredPreferenceRecord[]>;
  /**
   * Serialize a read/modify/write of one owner's complete preference set.
   * Returning undefined leaves the freshly read rows unchanged. The callback
   * is deliberately synchronous so every dialect can keep it inside its
   * database transaction without holding a transaction across application
   * awaits.
   */
  mutateAll(
    userId: string | undefined,
    timestamp: number,
    mutation: (
      preferences: readonly StoredPreferenceRecord[]
    ) => readonly StoredPreferenceRecord[] | undefined
  ): Promise<{
    userId: string;
    preferences: StoredPreferenceRecord[];
  } | null>;
  replaceAll(
    userId: string,
    preferences: readonly StoredPreferenceRecord[],
    timestamp: number
  ): Promise<void>;
  deleteKeys(userId: string, keys: readonly string[]): Promise<number>;
}

export interface SystemSettingRepository {
  get(key: string): Promise<string | null>;
  getMany(keys: readonly string[]): Promise<Record<string, string>>;
  upsert(key: string, value: string, updatedAt: number): Promise<void>;
  upsertMany(
    values: Readonly<Record<string, string>>,
    updatedAt: number
  ): Promise<void>;
}

export type ArchiveOwnedResource =
  | 'session'
  | 'session-folder'
  | 'note'
  | 'knowledge-collection'
  | 'document'
  | 'persona';
export type ArchiveNestedResource = 'session-message' | 'document-chunk';

export interface ArchiveNestedOwner {
  userId: string;
  parentId: string;
}

export type DataArchiveMergeStrategy = 'skip' | 'overwrite';

/**
 * Fully protected relational payload for one portable archive import. The
 * application mapper encrypts every private field before crossing this
 * boundary; adapters only provide ownership checks and atomic persistence.
 */
export interface StoredArchiveDocumentRecord {
  id: string;
  user_id: string;
  filename: string;
  title: string | null;
  content: string | null;
  file_type: string | null;
  size: number | null;
  session_id: string | null;
  collection_id: string | null;
  metadata: string | null;
  uploaded_at: number;
  created_at: number;
  updated_at: number;
}

export interface StoredArchiveDocumentChunkRecord {
  id: string;
  document_id: string;
  chunk_index: number;
  content: string;
  start_char: number | null;
  end_char: number | null;
  embedding: null;
  created_at: number;
}

export interface StoredArchiveDocumentAggregate {
  document: StoredArchiveDocumentRecord;
  chunks: StoredArchiveDocumentChunkRecord[];
}

export interface DataArchiveApplyPlan {
  userId: string;
  strategy: DataArchiveMergeStrategy;
  timestamp: number;
  maximumNotes: number;
  maximumSessionFolders: number;
  /** Fail-closed synchronous fence evaluated immediately before commit. */
  assertCanCommit?: () => void;
  /**
   * Overwrite imports carry a fixed protected set. Merge imports derive the
   * protected set synchronously from rows read after the owner lock is held.
   */
  preferences:
    | StoredPreferenceRecord[]
    | ((
        current: readonly StoredPreferenceRecord[]
      ) => readonly StoredPreferenceRecord[]);
  sessionFolders: StoredNamedResourceRecord[];
  sessions: StoredChatSessionAggregate[];
  notes: StoredNoteRecord[];
  knowledgeCollections: StoredNamedResourceRecord[];
  documents: StoredArchiveDocumentAggregate[];
}

export interface DataArchiveRepository {
  ownerOf(resource: ArchiveOwnedResource, id: string): Promise<string | null>;
  nestedOwnerOf(
    resource: ArchiveNestedResource,
    id: string
  ): Promise<ArchiveNestedOwner | null>;
  countByOwner(
    resource: 'session-folder' | 'note',
    userId: string
  ): Promise<number>;
  resourceDeletionReserved(resource: 'document', id: string): Promise<boolean>;
  /** Apply every included archive section in one database transaction. */
  applyImport(plan: DataArchiveApplyPlan): Promise<void>;
}

export interface ApplicationResourceRepositories {
  chatSessions: ChatSessionRepository;
  knowledgeCollections: KnowledgeCollectionRepository;
  notes: NoteRepository;
  calendarEvents: CalendarEventRepository;
  automations: AutomationRepository;
  automationRuns: AutomationRunRepository;
  sessionFolders: SessionFolderRepository;
  preferences: PreferenceRepository;
  systemSettings: SystemSettingRepository;
  archive: DataArchiveRepository;
}

export class PersistenceResourceConflictError extends Error {
  constructor() {
    super('A resource with this identifier already belongs to another owner');
    this.name = 'PersistenceResourceConflictError';
  }
}

export class PersistenceResourceDeletionReservedError extends Error {
  constructor(readonly resourceId: string) {
    super(
      'A portable resource identifier is reserved by retained deletion state'
    );
    this.name = 'PersistenceResourceDeletionReservedError';
  }
}

export class PersistenceResourceLimitError extends Error {
  constructor(
    readonly resource:
      'note' | 'session-folder' | 'calendar-event' | 'automation',
    readonly maximum: number
  ) {
    super(`The ${resource} storage limit of ${maximum} has been reached`);
    this.name = 'PersistenceResourceLimitError';
  }
}
