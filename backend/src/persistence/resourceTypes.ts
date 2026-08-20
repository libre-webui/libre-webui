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
  /** Cross-owner read; callers must authorize before returning content. */
  findById(collectionId: string): Promise<StoredNamedResourceRecord | null>;
  replace(collection: StoredNamedResourceRecord): Promise<void>;
  deleteAndDetach(collectionId: string, userId: string): Promise<boolean>;
}

export interface StoredNoteRecord {
  id: string;
  user_id: string;
  title: string;
  content: string;
  pinned: number;
  created_at: number;
  updated_at: number;
}

export interface StoredNotePatch {
  title?: string;
  content?: string;
  pinned?: number;
  updated_at: number;
}

export interface StoredNoteRevisionRecord {
  id: string;
  note_id: string;
  title: string;
  content: string;
  created_at: number;
}

export interface StoredNoteAttachmentRecord {
  id: string;
  note_id: string;
  blob_id: string;
  filename: string;
  content_type: string;
  size: number;
  created_at: number;
}

export interface NoteRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredNoteRecord[]>;
  findByOwner(noteId: string, userId: string): Promise<StoredNoteRecord | null>;
  /** Cross-owner read; callers must authorize before returning content. */
  findById(noteId: string): Promise<StoredNoteRecord | null>;
  replaceWithLimit(note: StoredNoteRecord, maximum: number): Promise<void>;
  patchByOwner(
    noteId: string,
    userId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null>;
  /** Cross-owner patch; callers must authorize write before invoking. */
  patchById(
    noteId: string,
    patch: StoredNotePatch
  ): Promise<StoredNoteRecord | null>;
  deleteByOwner(noteId: string, userId: string): Promise<boolean>;
  listRevisions(
    noteId: string,
    maximum: number
  ): Promise<StoredNoteRevisionRecord[]>;
  findRevision(revisionId: string): Promise<StoredNoteRevisionRecord | null>;
  /** Inserts a revision and prunes the oldest beyond the per-note cap. */
  insertRevision(
    revision: StoredNoteRevisionRecord,
    maximum: number
  ): Promise<void>;
  listAttachments(noteId: string): Promise<StoredNoteAttachmentRecord[]>;
  findAttachment(
    attachmentId: string
  ): Promise<StoredNoteAttachmentRecord | null>;
  insertAttachmentWithLimit(
    attachment: StoredNoteAttachmentRecord,
    maximum: number
  ): Promise<void>;
  deleteAttachment(attachmentId: string): Promise<boolean>;
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
  calendar_id: string | null;
  reminder_minutes: number | null;
  last_reminded_occurrence: number | null;
  created_at: number;
  updated_at: number;
}

export interface StoredCalendarRecord {
  id: string;
  user_id: string;
  name: string;
  color: string | null;
  created_at: number;
  updated_at: number;
}

export interface CalendarRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredCalendarRecord[]>;
  findByOwner(
    calendarId: string,
    userId: string
  ): Promise<StoredCalendarRecord | null>;
  /** Cross-owner read; callers must authorize before returning content. */
  findById(calendarId: string): Promise<StoredCalendarRecord | null>;
  replaceWithLimit(
    calendar: StoredCalendarRecord,
    maximum: number
  ): Promise<void>;
  /** Deletes the calendar and detaches its events back to the default scope. */
  deleteAndDetach(calendarId: string, userId: string): Promise<boolean>;
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
  /** Cross-owner reads for shared calendars; callers authorize per calendar. */
  listByCalendarsBetween(
    calendarIds: readonly string[],
    from: number,
    to: number,
    maximum: number
  ): Promise<StoredCalendarEventRecord[]>;
  listRecurringByCalendars(
    calendarIds: readonly string[],
    maximum: number
  ): Promise<StoredCalendarEventRecord[]>;
  findByOwner(
    eventId: string,
    userId: string
  ): Promise<StoredCalendarEventRecord | null>;
  /** Cross-owner read; callers must authorize before returning content. */
  findById(eventId: string): Promise<StoredCalendarEventRecord | null>;
  /** Events carrying a reminder offset, for the scheduler sweep. */
  listWithReminders(maximum: number): Promise<StoredCalendarEventRecord[]>;
  /**
   * Record that a reminder fired for the given occurrence start. Only
   * advances forward, so concurrent sweeps notify each occurrence once.
   */
  markReminded(eventId: string, occurrenceStart: number): Promise<boolean>;
  replaceWithLimit(
    event: StoredCalendarEventRecord,
    maximum: number
  ): Promise<void>;
  deleteByOwner(eventId: string, userId: string): Promise<boolean>;
}

export interface StoredChannelRecord {
  id: string;
  type: string;
  name: string;
  description: string | null;
  dm_key: string | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

export interface StoredChannelMemberRecord {
  channel_id: string;
  user_id: string;
  role: string;
  joined_at: number;
  last_read_at: number;
}

export interface StoredChannelMembershipView {
  channel: StoredChannelRecord;
  member: StoredChannelMemberRecord;
}

export interface StoredChannelUnreadRow {
  channel_id: string;
  unread_count: number;
  latest_message_at: number | null;
}

export interface StoredChannelMessageRecord {
  id: string;
  channel_id: string;
  user_id: string | null;
  parent_id: string | null;
  author_kind: string;
  model: string | null;
  content: string;
  metadata: string | null;
  created_at: number;
  updated_at: number;
  edited_at: number | null;
  deleted_at: number | null;
  pinned_at: number | null;
  pinned_by: string | null;
}

export interface StoredChannelReactionRecord {
  id: string;
  message_id: string;
  user_id: string;
  emoji: string;
  created_at: number;
}

export interface StoredChannelAttachmentRecord {
  id: string;
  message_id: string;
  channel_id: string;
  blob_id: string;
  filename: string;
  content_type: string;
  size: number;
  created_by: string | null;
  created_at: number;
}

export interface ChannelTimelineCursor {
  created_at: number;
  id: string;
}

export interface ChannelRepository {
  /** Creates the channel and its owner membership atomically. */
  insertWithOwner(
    channel: StoredChannelRecord,
    owner: StoredChannelMemberRecord,
    maximumPerUser: number
  ): Promise<void>;
  findById(channelId: string): Promise<StoredChannelRecord | null>;
  findByDmKey(dmKey: string): Promise<StoredChannelRecord | null>;
  listForUser(
    userId: string,
    maximum: number
  ): Promise<StoredChannelMembershipView[]>;
  listPublic(maximum: number): Promise<StoredChannelRecord[]>;
  update(channel: StoredChannelRecord): Promise<void>;
  delete(channelId: string): Promise<boolean>;
  upsertMember(
    member: StoredChannelMemberRecord,
    maximumMembers: number
  ): Promise<void>;
  findMember(
    channelId: string,
    userId: string
  ): Promise<StoredChannelMemberRecord | null>;
  listMembers(
    channelId: string,
    maximum: number
  ): Promise<StoredChannelMemberRecord[]>;
  removeMember(channelId: string, userId: string): Promise<boolean>;
  /** Advances the read cursor monotonically; never moves it backwards. */
  advanceLastRead(
    channelId: string,
    userId: string,
    lastReadAt: number
  ): Promise<boolean>;
  /** Per-channel unread counts for every channel the user belongs to. */
  unreadSummaryForUser(userId: string): Promise<StoredChannelUnreadRow[]>;
}

export interface ChannelMessageRepository {
  /**
   * Idempotent append: when the id already exists the stored row is
   * returned unchanged and `inserted` is false, so client retries and
   * duplicate deliveries never duplicate timeline entries.
   */
  insertIfAbsent(
    message: StoredChannelMessageRecord,
    attachments: readonly StoredChannelAttachmentRecord[],
    maximumPerChannel: number
  ): Promise<{ stored: StoredChannelMessageRecord; inserted: boolean }>;
  findById(messageId: string): Promise<StoredChannelMessageRecord | null>;
  listPage(
    channelId: string,
    options: {
      before?: ChannelTimelineCursor;
      after?: ChannelTimelineCursor;
      parentId?: string | null;
      limit: number;
    }
  ): Promise<StoredChannelMessageRecord[]>;
  listThread(
    parentId: string,
    maximum: number
  ): Promise<StoredChannelMessageRecord[]>;
  countThreadReplies(
    parentIds: readonly string[]
  ): Promise<Record<string, number>>;
  /** Cross-owner patch; callers must authorize before invoking. */
  update(message: StoredChannelMessageRecord): Promise<void>;
  listPinned(
    channelId: string,
    maximum: number
  ): Promise<StoredChannelMessageRecord[]>;
  /** Recent decryptable candidates for in-process search scoring. */
  listRecentForChannels(
    channelIds: readonly string[],
    maximum: number
  ): Promise<StoredChannelMessageRecord[]>;
  addReaction(
    reaction: StoredChannelReactionRecord,
    maximumPerMessage: number
  ): Promise<boolean>;
  removeReaction(
    messageId: string,
    userId: string,
    emoji: string
  ): Promise<boolean>;
  listReactionsForMessages(
    messageIds: readonly string[]
  ): Promise<StoredChannelReactionRecord[]>;
  findAttachment(
    attachmentId: string
  ): Promise<StoredChannelAttachmentRecord | null>;
  listAttachmentsForMessages(
    messageIds: readonly string[]
  ): Promise<StoredChannelAttachmentRecord[]>;
  /** Blob references of a channel's attachments, for deletion hygiene. */
  listAttachmentBlobIds(
    channelId: string
  ): Promise<Array<{ blob_id: string; created_by: string | null }>>;
}

export interface StoredNotificationRecord {
  id: string;
  user_id: string;
  type: string;
  title: string;
  body: string | null;
  href: string | null;
  source_key: string | null;
  created_at: number;
  read_at: number | null;
}

export interface NotificationRepository {
  /**
   * Inserts unless the (user, source_key) pair already exists; prunes the
   * oldest rows beyond the per-user cap in the same transaction. Returns
   * false when deduplicated.
   */
  insertWithLimit(
    notification: StoredNotificationRecord,
    maximumPerUser: number
  ): Promise<boolean>;
  listByOwner(
    userId: string,
    options: { before?: number; limit: number; unreadOnly?: boolean }
  ): Promise<StoredNotificationRecord[]>;
  countUnread(userId: string): Promise<number>;
  markRead(
    notificationId: string,
    userId: string,
    readAt: number
  ): Promise<boolean>;
  markAllRead(userId: string, readAt: number): Promise<number>;
  deleteByOwner(notificationId: string, userId: string): Promise<boolean>;
}

export interface StoredWebhookTargetRecord {
  id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string;
  enabled: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface WebhookTargetRepository {
  list(maximum: number): Promise<StoredWebhookTargetRecord[]>;
  findById(targetId: string): Promise<StoredWebhookTargetRecord | null>;
  replaceWithLimit(
    target: StoredWebhookTargetRecord,
    maximum: number
  ): Promise<void>;
  delete(targetId: string): Promise<boolean>;
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
  ArchiveOwnedResource | 'prompt' | 'skill' | 'tool-server' | 'calendar';

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

export interface StoredModelTariffRecord {
  id: string;
  plugin_id: string;
  model: string | null;
  input_per_million: number | null;
  output_per_million: number | null;
  unit_price: number | null;
  currency: string;
  effective_from: number;
  created_by: string | null;
  created_at: number;
}

export interface ModelTariffRepository {
  listAll(maximum: number): Promise<StoredModelTariffRecord[]>;
  insert(tariff: StoredModelTariffRecord): Promise<void>;
  deleteById(tariffId: string): Promise<boolean>;
}

export interface StoredUsageBudgetRecord {
  id: string;
  name: string;
  principal_type: 'instance' | 'user' | 'group';
  principal_id: string | null;
  period: 'daily' | 'weekly' | 'monthly';
  amount_usd: number;
  mode: 'observe' | 'soft' | 'hard';
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface UsageBudgetRepository {
  listAll(maximum: number): Promise<StoredUsageBudgetRecord[]>;
  findById(budgetId: string): Promise<StoredUsageBudgetRecord | null>;
  replace(budget: StoredUsageBudgetRecord): Promise<void>;
  deleteById(budgetId: string): Promise<boolean>;
}

export interface StoredMessageFeedbackRecord {
  id: string;
  user_id: string;
  session_id: string;
  message_id: string;
  rating: number;
  /** Plain JSON array of short topic tags. */
  tags: string | null;
  /** Encrypted free-text comment. */
  comment: string | null;
  model: string | null;
  plugin_id: string | null;
  /** Encrypted JSON snapshot of the rated exchange. */
  snapshot: string | null;
  created_at: number;
  updated_at: number;
}

export interface MessageFeedbackRepository {
  /** Insert or update the caller's feedback for one message. */
  upsertByMessage(feedback: StoredMessageFeedbackRecord): Promise<void>;
  deleteByMessage(userId: string, messageId: string): Promise<boolean>;
  listByOwner(
    userId: string,
    maximum: number
  ): Promise<StoredMessageFeedbackRecord[]>;
  /** Instance-wide feedback for administrators, newest first. */
  listAll(maximum: number): Promise<StoredMessageFeedbackRecord[]>;
}

export interface StoredArenaVoteRecord {
  id: string;
  user_id: string;
  compare_group: string;
  model_a: string;
  model_b: string;
  winner: 'a' | 'b' | 'tie' | 'both-bad';
  created_at: number;
}

export interface ArenaVoteRepository {
  /** Returns false when this user already voted on the comparison. */
  insertOnce(vote: StoredArenaVoteRecord): Promise<boolean>;
  /** Deterministic replay order (created_at, id) for rating computation. */
  listAllOrdered(maximum: number): Promise<StoredArenaVoteRecord[]>;
}

export interface StoredEvalSetRecord {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  /** Encrypted JSON array of evaluation items. */
  items: string;
  created_at: number;
  updated_at: number;
}

export interface EvalSetRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredEvalSetRecord[]>;
  findByOwner(
    setId: string,
    userId: string
  ): Promise<StoredEvalSetRecord | null>;
  replaceWithLimit(set: StoredEvalSetRecord, maximum: number): Promise<void>;
  deleteByOwner(setId: string, userId: string): Promise<boolean>;
}

export interface StoredEvalRunRecord {
  id: string;
  set_id: string;
  user_id: string;
  label: string | null;
  plugin_id: string | null;
  model: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** Encrypted JSON array of per-item results. */
  results: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface EvalRunRepository {
  listByOwner(userId: string, maximum: number): Promise<StoredEvalRunRecord[]>;
  listBySet(
    setId: string,
    userId: string,
    maximum: number
  ): Promise<StoredEvalRunRecord[]>;
  findByOwner(
    runId: string,
    userId: string
  ): Promise<StoredEvalRunRecord | null>;
  insert(run: StoredEvalRunRecord): Promise<void>;
  update(
    runId: string,
    userId: string,
    changes: {
      status: StoredEvalRunRecord['status'];
      results?: string | null;
      error?: string | null;
      updated_at: number;
      completed_at?: number | null;
    }
  ): Promise<boolean>;
}

export interface ApplicationResourceRepositories {
  chatSessions: ChatSessionRepository;
  knowledgeCollections: KnowledgeCollectionRepository;
  notes: NoteRepository;
  calendars: CalendarRepository;
  calendarEvents: CalendarEventRepository;
  channels: ChannelRepository;
  channelMessages: ChannelMessageRepository;
  notifications: NotificationRepository;
  webhookTargets: WebhookTargetRepository;
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
  modelTariffs: ModelTariffRepository;
  usageBudgets: UsageBudgetRepository;
  messageFeedback: MessageFeedbackRepository;
  arenaVotes: ArenaVoteRepository;
  evalSets: EvalSetRepository;
  evalRuns: EvalRunRepository;
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
      | 'calendar'
      | 'automation'
      | 'tool-server'
      | 'prompt'
      | 'skill'
      | 'skill-file'
      | 'note-attachment'
      | 'channel'
      | 'channel-member'
      | 'channel-message'
      | 'channel-reaction'
      | 'notification'
      | 'webhook-target'
      | 'eval-set',
    readonly maximum: number
  ) {
    super(`The ${resource} storage limit of ${maximum} has been reached`);
    this.name = 'PersistenceResourceLimitError';
  }
}
