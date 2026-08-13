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

import { createHash } from 'crypto';
import getDatabase from '../db.js';
import storageService, { type Document } from '../storage.js';
import type {
  ChatMessage,
  ChatProviderType,
  ChatSession,
  DocumentChunk,
  KnowledgeCollection,
  SessionFolder,
  UserPreferences,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { MAX_SESSION_FOLDERS_PER_USER } from '../utils/resourceLimits.js';
import preferencesService from './preferencesService.js';

const logger = createLogger('services:data-archive');

export const DATA_ARCHIVE_FORMAT = 'libre-webui-user-data';
export const DATA_ARCHIVE_VERSION = 2;

const LEGACY_ARCHIVE_FORMAT = 'libre-webui-export';
const MAX_ARCHIVE_SESSIONS = 5_000;
const MAX_ARCHIVE_MESSAGES = 100_000;
const MAX_ARCHIVE_DOCUMENTS = 5_000;
const MAX_ARCHIVE_CHUNKS = 100_000;
const MAX_ARCHIVE_FOLDERS = 100;
const MAX_ARCHIVE_COLLECTIONS = 5_000;
const MAX_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 10_000;
const MAX_CONTENT_LENGTH = 2_000_000;

export type DataArchiveMergeStrategy = 'skip' | 'overwrite';

export interface DataArchiveExclusion {
  key: string;
  reason: string;
}

export const DATA_ARCHIVE_EXCLUSIONS: DataArchiveExclusion[] = [
  {
    key: 'accountAndAuthentication',
    reason:
      'Account records, passwords, OAuth state, and sessions are never portable.',
  },
  {
    key: 'providerSecrets',
    reason:
      'Plugin credentials and encrypted plugin variables must be configured again.',
  },
  {
    key: 'voiceProfiles',
    reason:
      'Voice-cloning reference audio and transcripts require separate consent-aware handling.',
  },
  {
    key: 'personasNotesAndMemory',
    reason:
      'Personas, notes, and persona memory are not part of archive version 2.',
  },
  {
    key: 'generatedMedia',
    reason:
      'Generated image, audio, and video library files are not part of archive version 2.',
  },
  {
    key: 'work',
    reason:
      'Work tasks, runs, sandboxes, and Docker or Kubernetes volumes require a system backup.',
  },
  {
    key: 'derivedEmbeddings',
    reason:
      'Document embeddings are derived data and can be regenerated after import.',
  },
];

export interface ArchivedDocument extends Document {
  chunks: Array<Omit<DocumentChunk, 'embedding'>>;
}

export interface UserDataArchive {
  format: typeof DATA_ARCHIVE_FORMAT;
  version: typeof DATA_ARCHIVE_VERSION;
  exportedAt: string;
  preferences: Partial<UserPreferences>;
  sessionFolders: SessionFolder[];
  sessions: ChatSession[];
  knowledgeCollections: KnowledgeCollection[];
  documents: ArchivedDocument[];
  exclusions: DataArchiveExclusion[];
}

export interface ArchiveSectionResult {
  imported: number;
  overwritten: number;
  skipped: number;
}

export interface DataArchiveImportResult {
  format: typeof DATA_ARCHIVE_FORMAT;
  version: typeof DATA_ARCHIVE_VERSION;
  migratedFromVersion?: string;
  strategy: DataArchiveMergeStrategy;
  preferences: {
    imported: boolean;
    mode: 'merge' | 'replace';
  };
  sessionFolders: ArchiveSectionResult;
  sessions: ArchiveSectionResult;
  knowledgeCollections: ArchiveSectionResult;
  documents: ArchiveSectionResult;
  remappedIds: number;
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

export interface DataArchivePreflight {
  valid: true;
  format: typeof DATA_ARCHIVE_FORMAT;
  version: typeof DATA_ARCHIVE_VERSION;
  migratedFromVersion?: string;
  strategy: DataArchiveMergeStrategy;
  incoming: {
    sessionFolders: number;
    sessions: number;
    messages: number;
    knowledgeCollections: number;
    documents: number;
    documentChunks: number;
  };
  result: Omit<DataArchiveImportResult, 'preferences'>;
  warnings: string[];
  exclusions: DataArchiveExclusion[];
}

interface NormalizedArchive {
  archive: UserDataArchive;
  migratedFromVersion?: string;
  warnings: string[];
}

interface ImportPlan {
  archive: UserDataArchive;
  folderIds: Map<string, string>;
  sessionIds: Map<string, string>;
  messageIds: Map<string, string>;
  collectionIds: Map<string, string>;
  documentIds: Map<string, string>;
  chunkIds: Map<string, string>;
  result: DataArchiveImportResult;
}

class DataArchiveValidationError extends Error {
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
    this.name = 'DataArchiveValidationError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new DataArchiveValidationError(`${path} must be an object`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new DataArchiveValidationError(`${path} must be an array`);
  }
  return value;
}

function requireString(
  value: unknown,
  path: string,
  maxLength = MAX_CONTENT_LENGTH
): string {
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new DataArchiveValidationError(
      `${path} must be a string no longer than ${maxLength} characters`
    );
  }
  return value;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  maxLength = MAX_ID_LENGTH
): string {
  const result = requireString(value, path, maxLength);
  if (!result.trim()) {
    throw new DataArchiveValidationError(`${path} must not be empty`);
  }
  return result;
}

function optionalString(
  value: unknown,
  path: string,
  maxLength = MAX_CONTENT_LENGTH
): string | undefined {
  return value === undefined || value === null
    ? undefined
    : requireString(value, path, maxLength);
}

function requireTimestamp(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new DataArchiveValidationError(`${path} must be a valid timestamp`);
  }
  return value;
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') {
    throw new DataArchiveValidationError(`${path} must be a boolean`);
  }
  return value;
}

function copyJsonRecord(value: unknown, path: string): Record<string, unknown> {
  const record = requireRecord(value, path);
  return JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
}

const preferenceKeys = new Set<keyof UserPreferences>([
  'defaultModel',
  'defaultProviderType',
  'defaultProviderId',
  'visionModel',
  'visionProviderType',
  'visionProviderId',
  'theme',
  'systemMessage',
  'generationOptions',
  'modelGenerationOptions',
  'embeddingSettings',
  'ttsSettings',
  'imageGenSettings',
  'titleSettings',
  'showUsername',
  'showFollowUpSuggestions',
  'hapticFeedbackEnabled',
  'workRemoteProviderDisclosureDismissed',
  'backgroundSettings',
]);

const objectPreferenceKeys = new Set([
  'theme',
  'generationOptions',
  'modelGenerationOptions',
  'embeddingSettings',
  'ttsSettings',
  'imageGenSettings',
  'titleSettings',
  'backgroundSettings',
]);

const stringPreferenceKeys = new Set([
  'defaultModel',
  'visionModel',
  'systemMessage',
]);

const nullableStringPreferenceKeys = new Set([
  'defaultProviderId',
  'visionProviderId',
]);

const booleanPreferenceKeys = new Set([
  'showUsername',
  'showFollowUpSuggestions',
  'hapticFeedbackEnabled',
  'workRemoteProviderDisclosureDismissed',
]);

const providerPreferenceKeys = new Set([
  'defaultProviderType',
  'visionProviderType',
]);

function normalizePreferences(
  value: unknown,
  warnings: string[]
): Partial<UserPreferences> {
  const raw = requireRecord(value, 'preferences');
  const preferences: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!preferenceKeys.has(key as keyof UserPreferences)) continue;
    if (objectPreferenceKeys.has(key)) {
      preferences[key] = copyJsonRecord(entry, `preferences.${key}`);
    } else if (stringPreferenceKeys.has(key)) {
      preferences[key] = requireString(
        entry,
        `preferences.${key}`,
        MAX_CONTENT_LENGTH
      );
    } else if (nullableStringPreferenceKeys.has(key)) {
      preferences[key] =
        entry === null
          ? null
          : requireString(entry, `preferences.${key}`, MAX_ID_LENGTH);
    } else if (booleanPreferenceKeys.has(key)) {
      if (typeof entry !== 'boolean') {
        throw new DataArchiveValidationError(
          `preferences.${key} must be a boolean`
        );
      }
      preferences[key] = entry;
    } else if (providerPreferenceKeys.has(key)) {
      if (
        entry !== null &&
        entry !== undefined &&
        !['ollama', 'plugin', 'agent'].includes(String(entry))
      ) {
        throw new DataArchiveValidationError(`preferences.${key} is invalid`);
      }
      preferences[key] = entry;
    } else {
      preferences[key] = JSON.parse(JSON.stringify(entry)) as unknown;
    }
  }

  if (isRecord(preferences.theme)) {
    const mode = preferences.theme.mode;
    if (
      mode !== undefined &&
      mode !== 'dark' &&
      mode !== 'light' &&
      mode !== 'ophelia'
    ) {
      throw new DataArchiveValidationError('preferences.theme.mode is invalid');
    }
  }

  if (
    isRecord(preferences.ttsSettings) &&
    preferences.ttsSettings.voiceProfileId
  ) {
    delete preferences.ttsSettings.voiceProfileId;
    warnings.push(
      'The selected reusable voice was cleared because voice profiles are excluded.'
    );
  }

  return preferences as Partial<UserPreferences>;
}

function normalizeFolder(value: unknown, index: number): SessionFolder {
  const item = requireRecord(value, `sessionFolders[${index}]`);
  return {
    id: requireNonEmptyString(item.id, `sessionFolders[${index}].id`),
    name: requireNonEmptyString(
      item.name,
      `sessionFolders[${index}].name`,
      120
    ),
    createdAt: requireTimestamp(
      item.createdAt,
      `sessionFolders[${index}].createdAt`
    ),
    updatedAt: requireTimestamp(
      item.updatedAt,
      `sessionFolders[${index}].updatedAt`
    ),
  };
}

function normalizeCollection(
  value: unknown,
  index: number
): KnowledgeCollection {
  const item = requireRecord(value, `knowledgeCollections[${index}]`);
  return {
    id: requireNonEmptyString(item.id, `knowledgeCollections[${index}].id`),
    name: requireNonEmptyString(
      item.name,
      `knowledgeCollections[${index}].name`,
      10_000
    ),
    createdAt: requireTimestamp(
      item.createdAt,
      `knowledgeCollections[${index}].createdAt`
    ),
    updatedAt: requireTimestamp(
      item.updatedAt,
      `knowledgeCollections[${index}].updatedAt`
    ),
  };
}

function normalizeMessage(
  value: unknown,
  sessionIndex: number,
  messageIndex: number
): ChatMessage {
  const path = `sessions[${sessionIndex}].messages[${messageIndex}]`;
  const item = requireRecord(value, path);
  if (!['user', 'assistant', 'system'].includes(String(item.role))) {
    throw new DataArchiveValidationError(`${path}.role is invalid`);
  }

  const message: ChatMessage = {
    id: requireNonEmptyString(item.id, `${path}.id`),
    role: item.role as ChatMessage['role'],
    content: requireString(item.content, `${path}.content`),
    timestamp: requireTimestamp(item.timestamp, `${path}.timestamp`),
  };
  message.thinking = optionalString(item.thinking, `${path}.thinking`);
  message.model = optionalString(item.model, `${path}.model`, MAX_TITLE_LENGTH);
  message.parentId = optionalString(
    item.parentId,
    `${path}.parentId`,
    MAX_ID_LENGTH
  );
  if (item.branchIndex !== undefined) {
    if (
      !Number.isSafeInteger(item.branchIndex) ||
      Number(item.branchIndex) < 0
    ) {
      throw new DataArchiveValidationError(`${path}.branchIndex is invalid`);
    }
    message.branchIndex = Number(item.branchIndex);
  }
  message.isActive = optionalBoolean(item.isActive, `${path}.isActive`);
  if (item.rating !== undefined && item.rating !== null) {
    if (item.rating !== 1 && item.rating !== -1) {
      throw new DataArchiveValidationError(`${path}.rating is invalid`);
    }
    message.rating = item.rating;
  }
  if (item.providerMetadata !== undefined) {
    message.providerMetadata = copyJsonRecord(
      item.providerMetadata,
      `${path}.providerMetadata`
    );
  }
  if (item.statistics !== undefined) {
    message.statistics = copyJsonRecord(item.statistics, `${path}.statistics`);
  }
  if (item.images !== undefined) {
    message.images = requireArray(item.images, `${path}.images`).map(
      (image, imageIndex) =>
        requireString(image, `${path}.images[${imageIndex}]`)
    );
  }
  if (item.artifacts !== undefined) {
    message.artifacts = requireArray(item.artifacts, `${path}.artifacts`).map(
      (artifact, artifactIndex) =>
        copyJsonRecord(artifact, `${path}.artifacts[${artifactIndex}]`)
    ) as unknown as ChatMessage['artifacts'];
  }
  return message;
}

function normalizeSession(value: unknown, index: number): ChatSession {
  const path = `sessions[${index}]`;
  const item = requireRecord(value, path);
  const providerType = optionalString(
    item.providerType,
    `${path}.providerType`,
    20
  );
  if (
    providerType !== undefined &&
    !(['ollama', 'plugin', 'agent'] as ChatProviderType[]).includes(
      providerType as ChatProviderType
    )
  ) {
    throw new DataArchiveValidationError(`${path}.providerType is invalid`);
  }
  const messages = requireArray(item.messages, `${path}.messages`).map(
    (message, messageIndex) => normalizeMessage(message, index, messageIndex)
  );
  const session: ChatSession = {
    id: requireNonEmptyString(item.id, `${path}.id`),
    title: requireString(item.title, `${path}.title`, MAX_TITLE_LENGTH),
    model: requireNonEmptyString(item.model, `${path}.model`, MAX_TITLE_LENGTH),
    messages,
    createdAt: requireTimestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: requireTimestamp(item.updatedAt, `${path}.updatedAt`),
  };
  session.personaId = optionalString(
    item.personaId,
    `${path}.personaId`,
    MAX_ID_LENGTH
  );
  session.providerType = providerType as ChatProviderType | undefined;
  session.providerId = optionalString(
    item.providerId,
    `${path}.providerId`,
    MAX_ID_LENGTH
  );
  session.archived = optionalBoolean(item.archived, `${path}.archived`);
  session.pinned = optionalBoolean(item.pinned, `${path}.pinned`);
  session.folderId = optionalString(
    item.folderId,
    `${path}.folderId`,
    MAX_ID_LENGTH
  );
  if (item.settings !== undefined) {
    const settings = copyJsonRecord(item.settings, `${path}.settings`);
    if (settings.generationOptions !== undefined) {
      settings.generationOptions = copyJsonRecord(
        settings.generationOptions,
        `${path}.settings.generationOptions`
      );
    }
    if (settings.knowledgeCollectionIds !== undefined) {
      settings.knowledgeCollectionIds = requireArray(
        settings.knowledgeCollectionIds,
        `${path}.settings.knowledgeCollectionIds`
      ).map((collectionId, collectionIndex) =>
        requireNonEmptyString(
          collectionId,
          `${path}.settings.knowledgeCollectionIds[${collectionIndex}]`
        )
      );
    }
    session.settings = settings;
  }
  return session;
}

function normalizeChunk(
  value: unknown,
  documentId: string,
  documentIndex: number,
  chunkIndex: number
): Omit<DocumentChunk, 'embedding'> {
  const path = `documents[${documentIndex}].chunks[${chunkIndex}]`;
  const item = requireRecord(value, path);
  const startChar = Number(item.startChar ?? 0);
  const endChar = Number(item.endChar ?? 0);
  const index = Number(item.chunkIndex ?? chunkIndex);
  if (
    !Number.isSafeInteger(startChar) ||
    !Number.isSafeInteger(endChar) ||
    !Number.isSafeInteger(index) ||
    startChar < 0 ||
    endChar < 0 ||
    index < 0
  ) {
    throw new DataArchiveValidationError(`${path} has invalid offsets`);
  }
  return {
    id: requireNonEmptyString(item.id, `${path}.id`),
    documentId,
    content: requireString(item.content, `${path}.content`),
    chunkIndex: index,
    startChar,
    endChar,
  };
}

function normalizeDocument(value: unknown, index: number): ArchivedDocument {
  const path = `documents[${index}]`;
  const item = requireRecord(value, path);
  const id = requireNonEmptyString(item.id, `${path}.id`);
  const fileType = optionalString(item.fileType, `${path}.fileType`, 20);
  if (fileType !== undefined && fileType !== 'pdf' && fileType !== 'txt') {
    throw new DataArchiveValidationError(`${path}.fileType is invalid`);
  }
  const document: ArchivedDocument = {
    id,
    filename: requireNonEmptyString(
      item.filename,
      `${path}.filename`,
      MAX_TITLE_LENGTH
    ),
    uploadedAt: requireTimestamp(item.uploadedAt, `${path}.uploadedAt`),
    chunks: requireArray(item.chunks ?? [], `${path}.chunks`).map(
      (chunk, chunkIndex) => normalizeChunk(chunk, id, index, chunkIndex)
    ),
  };
  document.title = optionalString(
    item.title,
    `${path}.title`,
    MAX_TITLE_LENGTH
  );
  document.content = optionalString(item.content, `${path}.content`);
  document.fileType = fileType as Document['fileType'];
  if (item.size !== undefined && item.size !== null) {
    if (!Number.isSafeInteger(item.size) || Number(item.size) < 0) {
      throw new DataArchiveValidationError(`${path}.size is invalid`);
    }
    document.size = Number(item.size);
  }
  document.sessionId = optionalString(
    item.sessionId,
    `${path}.sessionId`,
    MAX_ID_LENGTH
  );
  document.collectionId = optionalString(
    item.collectionId,
    `${path}.collectionId`,
    MAX_ID_LENGTH
  );
  if (item.createdAt !== undefined && item.createdAt !== null) {
    document.createdAt = requireTimestamp(item.createdAt, `${path}.createdAt`);
  }
  if (item.metadata !== undefined) {
    document.metadata = copyJsonRecord(item.metadata, `${path}.metadata`);
  }
  return document;
}

function assertUniqueIds(items: Array<{ id: string }>, path: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) {
      throw new DataArchiveValidationError(
        `${path} contains duplicate ID ${item.id}`
      );
    }
    ids.add(item.id);
  }
}

function normalizeArchive(value: unknown): NormalizedArchive {
  const raw = requireRecord(value, 'archive');
  const warnings: string[] = [];
  let migratedFromVersion: string | undefined;
  let source = raw;

  if (raw.format === LEGACY_ARCHIVE_FORMAT) {
    migratedFromVersion = String(raw.version ?? '1.0');
    source = {
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      exportedAt: raw.exportedAt,
      preferences: raw.preferences,
      sessionFolders: [],
      sessions: raw.sessions ?? [],
      knowledgeCollections: [],
      documents: raw.documents ?? [],
    };
    warnings.push(
      'Legacy archive migrated to version 2. Legacy exports did not contain folders, collections, or document chunks.'
    );
  }

  if (source.format !== DATA_ARCHIVE_FORMAT) {
    throw new DataArchiveValidationError(
      'Unrecognized Libre WebUI archive format'
    );
  }
  if (source.version !== DATA_ARCHIVE_VERSION) {
    throw new DataArchiveValidationError(
      `Unsupported archive version ${String(source.version)}; expected ${DATA_ARCHIVE_VERSION}`
    );
  }

  const exportedAt = requireString(source.exportedAt, 'exportedAt', 100);
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw new DataArchiveValidationError('exportedAt must be an ISO date');
  }
  const preferences = normalizePreferences(source.preferences, warnings);
  const sessionFolders = requireArray(
    source.sessionFolders,
    'sessionFolders'
  ).map(normalizeFolder);
  const sessions = requireArray(source.sessions, 'sessions').map(
    normalizeSession
  );
  const knowledgeCollections = requireArray(
    source.knowledgeCollections,
    'knowledgeCollections'
  ).map(normalizeCollection);
  const documents = requireArray(source.documents, 'documents').map(
    normalizeDocument
  );

  const messageCount = sessions.reduce(
    (count, session) => count + session.messages.length,
    0
  );
  const chunkCount = documents.reduce(
    (count, document) => count + document.chunks.length,
    0
  );
  if (sessionFolders.length > MAX_ARCHIVE_FOLDERS) {
    throw new DataArchiveValidationError(
      'Archive contains too many session folders'
    );
  }
  if (sessions.length > MAX_ARCHIVE_SESSIONS) {
    throw new DataArchiveValidationError('Archive contains too many sessions');
  }
  if (messageCount > MAX_ARCHIVE_MESSAGES) {
    throw new DataArchiveValidationError('Archive contains too many messages');
  }
  if (knowledgeCollections.length > MAX_ARCHIVE_COLLECTIONS) {
    throw new DataArchiveValidationError(
      'Archive contains too many knowledge collections'
    );
  }
  if (documents.length > MAX_ARCHIVE_DOCUMENTS) {
    throw new DataArchiveValidationError('Archive contains too many documents');
  }
  if (chunkCount > MAX_ARCHIVE_CHUNKS) {
    throw new DataArchiveValidationError(
      'Archive contains too many document chunks'
    );
  }

  assertUniqueIds(sessionFolders, 'sessionFolders');
  assertUniqueIds(sessions, 'sessions');
  assertUniqueIds(knowledgeCollections, 'knowledgeCollections');
  assertUniqueIds(documents, 'documents');
  assertUniqueIds(
    sessions.flatMap(session => session.messages),
    'messages'
  );
  assertUniqueIds(
    documents.flatMap(document => document.chunks),
    'document chunks'
  );

  return {
    archive: {
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      exportedAt,
      preferences,
      sessionFolders,
      sessions,
      knowledgeCollections,
      documents,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    },
    migratedFromVersion,
    warnings,
  };
}

function emptySection(): ArchiveSectionResult {
  return { imported: 0, overwritten: 0, skipped: 0 };
}

function scopedOwner(table: string, id: string): string | undefined {
  const row = getDatabase()
    .prepare(`SELECT user_id FROM ${table} WHERE id = ?`)
    .get(id) as { user_id: string } | undefined;
  return row?.user_id;
}

function derivedId(
  userId: string,
  kind: string,
  originalId: string,
  attempt = 0
): string {
  const digest = createHash('sha256')
    .update(`${userId}\0${kind}\0${originalId}\0${attempt}`)
    .digest('hex')
    .slice(0, 32);
  return `import-${kind}-${digest}`;
}

function resolveScopedId(
  table: string,
  kind: string,
  originalId: string,
  userId: string
): { id: string; remapped: boolean } {
  const owner = scopedOwner(table, originalId);
  if (!owner || owner === userId) return { id: originalId, remapped: false };

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = derivedId(userId, kind, originalId, attempt);
    const candidateOwner = scopedOwner(table, candidate);
    if (!candidateOwner || candidateOwner === userId) {
      return { id: candidate, remapped: true };
    }
  }
  throw new DataArchiveValidationError(`Could not safely remap ${kind} ID`);
}

function sectionDisposition(
  section: ArchiveSectionResult,
  exists: boolean,
  strategy: DataArchiveMergeStrategy
): void {
  if (!exists) section.imported += 1;
  else if (strategy === 'skip') section.skipped += 1;
  else section.overwritten += 1;
}

function currentUserOwns(table: string, id: string, userId: string): boolean {
  return scopedOwner(table, id) === userId;
}

function nestedOwner(
  table: 'session_messages' | 'document_chunks',
  ownerJoin: 'sessions' | 'documents',
  parentColumn: 'session_id' | 'document_id',
  id: string
): { user_id: string; parent_id: string } | undefined {
  return getDatabase()
    .prepare(
      `SELECT owner.user_id, child.${parentColumn} AS parent_id
       FROM ${table} child
       JOIN ${ownerJoin} owner ON owner.id = child.${parentColumn}
       WHERE child.id = ?`
    )
    .get(id) as { user_id: string; parent_id: string } | undefined;
}

function resolveNestedId(
  table: 'session_messages' | 'document_chunks',
  ownerJoin: 'sessions' | 'documents',
  parentColumn: 'session_id' | 'document_id',
  originalId: string,
  targetParentId: string,
  userId: string,
  kind: string
): string {
  const existing = nestedOwner(table, ownerJoin, parentColumn, originalId);
  if (
    !existing ||
    (existing.user_id === userId && existing.parent_id === targetParentId)
  ) {
    return originalId;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = derivedId(userId, kind, originalId, attempt);
    const collision = nestedOwner(table, ownerJoin, parentColumn, candidate);
    if (
      !collision ||
      (collision.user_id === userId && collision.parent_id === targetParentId)
    ) {
      return candidate;
    }
  }
  throw new DataArchiveValidationError(`Could not safely remap ${kind} ID`);
}

function buildPlan(
  normalized: NormalizedArchive,
  strategy: DataArchiveMergeStrategy,
  userId: string
): ImportPlan {
  const { archive } = normalized;
  const result: DataArchiveImportResult = {
    format: DATA_ARCHIVE_FORMAT,
    version: DATA_ARCHIVE_VERSION,
    migratedFromVersion: normalized.migratedFromVersion,
    strategy,
    preferences: {
      imported: true,
      mode: strategy === 'overwrite' ? 'replace' : 'merge',
    },
    sessionFolders: emptySection(),
    sessions: emptySection(),
    knowledgeCollections: emptySection(),
    documents: emptySection(),
    remappedIds: 0,
    warnings: [...normalized.warnings],
    exclusions: DATA_ARCHIVE_EXCLUSIONS,
  };

  const mapIds = <T extends { id: string }>(
    values: T[],
    table: string,
    kind: string,
    section: ArchiveSectionResult
  ): Map<string, string> => {
    const mapping = new Map<string, string>();
    for (const value of values) {
      const resolved = resolveScopedId(table, kind, value.id, userId);
      mapping.set(value.id, resolved.id);
      if (resolved.remapped) result.remappedIds += 1;
      sectionDisposition(
        section,
        currentUserOwns(table, resolved.id, userId),
        strategy
      );
    }
    return mapping;
  };

  const folderIds = mapIds(
    archive.sessionFolders,
    'session_folders',
    'folder',
    result.sessionFolders
  );
  const existingFolderCount = storageService.getSessionFolders(userId).length;
  if (
    existingFolderCount + result.sessionFolders.imported >
    MAX_SESSION_FOLDERS_PER_USER
  ) {
    throw new DataArchiveValidationError(
      `Import would exceed the per-user limit of ${MAX_SESSION_FOLDERS_PER_USER} session folders`
    );
  }
  const sessionIds = mapIds(
    archive.sessions,
    'sessions',
    'session',
    result.sessions
  );
  const collectionIds = mapIds(
    archive.knowledgeCollections,
    'knowledge_collections',
    'collection',
    result.knowledgeCollections
  );
  const documentIds = mapIds(
    archive.documents,
    'documents',
    'document',
    result.documents
  );

  const messageIds = new Map<string, string>();
  for (const session of archive.sessions) {
    const targetSessionId = sessionIds.get(session.id)!;
    for (const message of session.messages) {
      const targetMessageId = resolveNestedId(
        'session_messages',
        'sessions',
        'session_id',
        message.id,
        targetSessionId,
        userId,
        'message'
      );
      messageIds.set(message.id, targetMessageId);
      if (targetMessageId !== message.id) result.remappedIds += 1;
    }
  }

  const chunkIds = new Map<string, string>();
  for (const document of archive.documents) {
    const targetDocumentId = documentIds.get(document.id)!;
    for (const chunk of document.chunks) {
      const targetChunkId = resolveNestedId(
        'document_chunks',
        'documents',
        'document_id',
        chunk.id,
        targetDocumentId,
        userId,
        'chunk'
      );
      chunkIds.set(chunk.id, targetChunkId);
      if (targetChunkId !== chunk.id) result.remappedIds += 1;
    }
  }

  if (result.remappedIds > 0) {
    result.warnings.push(
      `${result.remappedIds} archive IDs were deterministically remapped because another user already owns them.`
    );
  }

  return {
    archive,
    folderIds,
    sessionIds,
    messageIds,
    collectionIds,
    documentIds,
    chunkIds,
    result,
  };
}

function mapReference(
  originalId: string | null | undefined,
  mapping: Map<string, string>,
  table: string,
  userId: string
): string | undefined {
  if (!originalId) return undefined;
  return (
    mapping.get(originalId) ??
    (currentUserOwns(table, originalId, userId) ? originalId : undefined)
  );
}

function applyPlan(
  plan: ImportPlan,
  strategy: DataArchiveMergeStrategy,
  userId: string
): void {
  preferencesService.importData(
    {
      format: DATA_ARCHIVE_FORMAT,
      version: String(DATA_ARCHIVE_VERSION),
      preferences: plan.archive.preferences,
      exportedAt: plan.archive.exportedAt,
    },
    strategy === 'overwrite' ? 'replace' : 'merge',
    userId
  );

  for (const folder of plan.archive.sessionFolders) {
    const targetId = plan.folderIds.get(folder.id)!;
    if (
      strategy === 'skip' &&
      currentUserOwns('session_folders', targetId, userId)
    ) {
      continue;
    }
    storageService.saveSessionFolder({ ...folder, id: targetId }, userId);
  }

  for (const collection of plan.archive.knowledgeCollections) {
    const targetId = plan.collectionIds.get(collection.id)!;
    if (
      strategy === 'skip' &&
      currentUserOwns('knowledge_collections', targetId, userId)
    ) {
      continue;
    }
    storageService.saveKnowledgeCollection(
      { ...collection, id: targetId },
      userId
    );
  }

  for (const archivedSession of plan.archive.sessions) {
    const targetId = plan.sessionIds.get(archivedSession.id)!;
    if (strategy === 'skip' && currentUserOwns('sessions', targetId, userId)) {
      continue;
    }
    const settings = archivedSession.settings
      ? { ...archivedSession.settings }
      : undefined;
    if (settings?.knowledgeCollectionIds) {
      settings.knowledgeCollectionIds = settings.knowledgeCollectionIds
        .map(collectionId =>
          mapReference(
            collectionId,
            plan.collectionIds,
            'knowledge_collections',
            userId
          )
        )
        .filter((id): id is string => Boolean(id));
    }
    const personaId = mapReference(
      archivedSession.personaId,
      new Map(),
      'personas',
      userId
    );
    if (archivedSession.personaId && !personaId) {
      plan.result.warnings.push(
        `Session ${archivedSession.id} was detached from an unavailable persona.`
      );
    }
    storageService.saveSession(
      {
        ...archivedSession,
        id: targetId,
        personaId,
        folderId: mapReference(
          archivedSession.folderId,
          plan.folderIds,
          'session_folders',
          userId
        ),
        settings,
        messages: archivedSession.messages.map(message => ({
          ...message,
          id: plan.messageIds.get(message.id)!,
          parentId: message.parentId
            ? plan.messageIds.get(message.parentId)
            : undefined,
        })),
      },
      userId
    );
  }

  for (const archivedDocument of plan.archive.documents) {
    const targetId = plan.documentIds.get(archivedDocument.id)!;
    if (strategy === 'skip' && currentUserOwns('documents', targetId, userId)) {
      continue;
    }
    const { chunks, ...document } = archivedDocument;
    storageService.saveDocument(
      {
        ...document,
        id: targetId,
        sessionId: mapReference(
          archivedDocument.sessionId,
          plan.sessionIds,
          'sessions',
          userId
        ),
        collectionId: mapReference(
          archivedDocument.collectionId,
          plan.collectionIds,
          'knowledge_collections',
          userId
        ),
      },
      userId
    );
    storageService.saveDocumentChunks(
      targetId,
      chunks.map(chunk => ({
        ...chunk,
        id: plan.chunkIds.get(chunk.id)!,
        documentId: targetId,
      }))
    );
  }
}

class DataArchiveService {
  exportUserData(userId: string): UserDataArchive {
    const preferences = JSON.parse(
      JSON.stringify(preferencesService.getPreferences(userId))
    ) as Partial<UserPreferences>;
    if (preferences.ttsSettings?.voiceProfileId) {
      delete preferences.ttsSettings.voiceProfileId;
    }
    const documents: ArchivedDocument[] = storageService
      .getAllDocuments(userId)
      .map(document => ({
        ...document,
        chunks: storageService.getDocumentChunks(document.id).map(chunk => ({
          id: chunk.id,
          documentId: chunk.documentId,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          startChar: chunk.startChar,
          endChar: chunk.endChar,
        })),
      }));

    return {
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      preferences,
      sessionFolders: storageService.getSessionFolders(userId),
      sessions: storageService.getAllSessions(userId),
      knowledgeCollections: storageService.getKnowledgeCollections(userId),
      documents,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    };
  }

  preflight(
    value: unknown,
    strategy: DataArchiveMergeStrategy,
    userId: string
  ): DataArchivePreflight {
    const normalized = normalizeArchive(value);
    const plan = buildPlan(normalized, strategy, userId);
    const messageCount = normalized.archive.sessions.reduce(
      (count, session) => count + session.messages.length,
      0
    );
    const chunkCount = normalized.archive.documents.reduce(
      (count, document) => count + document.chunks.length,
      0
    );
    const { preferences: _preferences, ...result } = plan.result;
    return {
      valid: true,
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      migratedFromVersion: normalized.migratedFromVersion,
      strategy,
      incoming: {
        sessionFolders: normalized.archive.sessionFolders.length,
        sessions: normalized.archive.sessions.length,
        messages: messageCount,
        knowledgeCollections: normalized.archive.knowledgeCollections.length,
        documents: normalized.archive.documents.length,
        documentChunks: chunkCount,
      },
      result,
      warnings: plan.result.warnings,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    };
  }

  importUserData(
    value: unknown,
    strategy: DataArchiveMergeStrategy,
    userId: string
  ): DataArchiveImportResult {
    const normalized = normalizeArchive(value);
    const transaction = getDatabase().transaction(() => {
      const plan = buildPlan(normalized, strategy, userId);
      applyPlan(plan, strategy, userId);
      return plan.result;
    });

    try {
      return transaction();
    } catch (error) {
      logger.error('User data archive import rolled back:', error);
      throw error;
    }
  }
}

export { DataArchiveValidationError };
export default new DataArchiveService();
