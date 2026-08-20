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

export interface StoredToolServerRecord {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  kind: string;
  base_url: string;
  spec: string | null;
  spec_digest: string | null;
  spec_revision: number;
  auth_mode: string;
  auth_header: string | null;
  access_mode: string;
  enabled: number;
  timeout_ms: number;
  max_response_bytes: number;
  created_at: number;
  updated_at: number;
}

export interface StoredToolServerToolRecord {
  id: string;
  server_id: string;
  name: string;
  description: string | null;
  params_schema: string | null;
  detail: string | null;
  side_effect: number;
  enabled: number;
  created_at: number;
  updated_at: number;
}

export interface StoredToolServerCredentialRecord {
  id: string;
  server_id: string;
  user_id: string;
  secret: string;
  created_at: number;
  updated_at: number;
}

export interface StoredToolApprovalRecord {
  id: string;
  user_id: string;
  session_id: string | null;
  server_id: string | null;
  tool_name: string;
  call_id: string | null;
  arguments_digest: string | null;
  scope: string;
  status: string;
  created_at: number;
  resolved_at: number | null;
  expires_at: number | null;
}

export interface ToolServerRepository {
  list(maximum: number): Promise<StoredToolServerRecord[]>;
  findById(serverId: string): Promise<StoredToolServerRecord | null>;
  replaceWithLimit(
    server: StoredToolServerRecord,
    maximum: number
  ): Promise<void>;
  delete(serverId: string): Promise<boolean>;
}

export interface ToolServerToolRepository {
  listByServer(serverId: string): Promise<StoredToolServerToolRecord[]>;
  /** Re-pin a server's tool inventory atomically, preserving admin overrides by tool name. */
  replaceAllForServer(
    serverId: string,
    tools: readonly StoredToolServerToolRecord[]
  ): Promise<void>;
  updateOverrides(
    serverId: string,
    toolName: string,
    overrides: { enabled?: number; side_effect?: number },
    updatedAt: number
  ): Promise<StoredToolServerToolRecord | null>;
}

export interface ToolServerCredentialRepository {
  find(
    serverId: string,
    userId: string
  ): Promise<StoredToolServerCredentialRecord | null>;
  upsert(credential: StoredToolServerCredentialRecord): Promise<void>;
  delete(serverId: string, userId: string): Promise<boolean>;
}

export interface ToolApprovalRepository {
  insert(approval: StoredToolApprovalRecord): Promise<void>;
  findByOwner(
    approvalId: string,
    userId: string
  ): Promise<StoredToolApprovalRecord | null>;
  /**
   * Find a standing decision covering this tool: an approved `always` grant,
   * or an approved `session` grant bound to the given session.
   */
  findStanding(
    userId: string,
    serverId: string | null,
    toolName: string,
    sessionId: string | null
  ): Promise<StoredToolApprovalRecord | null>;
  /** Resolve a pending approval exactly once; returns null when it is no longer pending. */
  resolvePending(
    approvalId: string,
    userId: string,
    status: string,
    scope: string,
    resolvedAt: number
  ): Promise<StoredToolApprovalRecord | null>;
  listPendingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]>;
  listStandingByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredToolApprovalRecord[]>;
  expirePending(now: number): Promise<number>;
  deleteByOwner(approvalId: string, userId: string): Promise<boolean>;
}

export interface StoredPromptRecord {
  id: string;
  user_id: string;
  slug: string;
  title: string;
  description: string | null;
  content: string;
  variables: string | null;
  tags: string | null;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface StoredPromptVersionRecord {
  id: string;
  prompt_id: string;
  version: number;
  content: string;
  variables: string | null;
  created_at: number;
}

export interface PromptRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredPromptRecord[]>;
  findByOwner(
    promptId: string,
    userId: string
  ): Promise<StoredPromptRecord | null>;
  findById(promptId: string): Promise<StoredPromptRecord | null>;
  findBySlug(userId: string, slug: string): Promise<StoredPromptRecord | null>;
  /** Upsert the prompt and archive the given prior revision in one transaction. */
  replaceWithLimit(
    prompt: StoredPromptRecord,
    maximum: number,
    archivedVersion: StoredPromptVersionRecord | null
  ): Promise<void>;
  listVersions(
    promptId: string,
    maximum: number
  ): Promise<StoredPromptVersionRecord[]>;
  findVersion(
    promptId: string,
    version: number
  ): Promise<StoredPromptVersionRecord | null>;
  deleteByOwner(promptId: string, userId: string): Promise<boolean>;
}

export interface StoredSkillRecord {
  id: string;
  user_id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: number;
  version: number;
  created_at: number;
  updated_at: number;
}

export interface StoredSkillVersionRecord {
  id: string;
  skill_id: string;
  version: number;
  instructions: string;
  created_at: number;
}

export interface StoredSkillFileRecord {
  id: string;
  skill_id: string;
  path: string;
  content: string;
  size: number;
  created_at: number;
  updated_at: number;
}

export interface SkillFileRepository {
  listBySkill(skillId: string): Promise<StoredSkillFileRecord[]>;
  find(skillId: string, path: string): Promise<StoredSkillFileRecord | null>;
  upsert(file: StoredSkillFileRecord, maximumPerSkill: number): Promise<void>;
  /** Replace a skill's whole bundle atomically (imports and full saves). */
  replaceAllForSkill(
    skillId: string,
    files: readonly StoredSkillFileRecord[]
  ): Promise<void>;
  delete(skillId: string, path: string): Promise<boolean>;
}

export interface SkillRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredSkillRecord[]>;
  findByOwner(
    skillId: string,
    userId: string
  ): Promise<StoredSkillRecord | null>;
  findById(skillId: string): Promise<StoredSkillRecord | null>;
  findBySlug(userId: string, slug: string): Promise<StoredSkillRecord | null>;
  /** Upsert the skill and archive the given prior revision in one transaction. */
  replaceWithLimit(
    skill: StoredSkillRecord,
    maximum: number,
    archivedVersion: StoredSkillVersionRecord | null
  ): Promise<void>;
  listVersions(
    skillId: string,
    maximum: number
  ): Promise<StoredSkillVersionRecord[]>;
  findVersion(
    skillId: string,
    version: number
  ): Promise<StoredSkillVersionRecord | null>;
  deleteByOwner(skillId: string, userId: string): Promise<boolean>;
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

/**
 * Resources that can carry access grants. Archive-owned resources are always
 * grantable; prompts, skills, and tool servers are grantable without being
 * part of the portable user archive (tool servers are instance-level, and
 * prompt/skill portability uses their dedicated import/export surfaces).
 */
export type GrantableResource =
  ArchiveOwnedResource | 'prompt' | 'skill' | 'tool-server';

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
  ownerOf(resource: GrantableResource, id: string): Promise<string | null>;
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
  toolServers: ToolServerRepository;
  toolServerTools: ToolServerToolRepository;
  toolServerCredentials: ToolServerCredentialRepository;
  toolApprovals: ToolApprovalRepository;
  prompts: PromptRepository;
  skills: SkillRepository;
  skillFiles: SkillFileRepository;
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
      | 'note'
      | 'session-folder'
      | 'calendar-event'
      | 'automation'
      | 'tool-server'
      | 'prompt'
      | 'skill'
      | 'skill-file',
    readonly maximum: number
  ) {
    super(`The ${resource} storage limit of ${maximum} has been reached`);
    this.name = 'PersistenceResourceLimitError';
  }
}
