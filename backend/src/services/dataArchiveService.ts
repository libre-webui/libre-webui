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
import storageService, { type Document } from '../storage.js';
import { getPersistence } from '../persistence/index.js';
import type {
  ArchiveOwnedResource,
  DataArchiveApplyPlan,
  StoredChatSessionAggregate,
} from '../persistence/resourceTypes.js';
import { PersistenceResourceDeletionReservedError } from '../persistence/resourceTypes.js';
import type {
  ChatMessage,
  ChatProviderType,
  ChatSession,
  DocumentChunk,
  KnowledgeCollection,
  Note,
  SessionFolder,
  UserPreferences,
} from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import {
  MAX_NOTES_PER_USER,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  MAX_SESSION_FOLDERS_PER_USER,
} from '../utils/resourceLimits.js';
import preferencesService from './preferencesService.js';
import { encryptionService } from './encryptionService.js';

const logger = createLogger('services:data-archive');

export const DATA_ARCHIVE_FORMAT = 'libre-webui-user-data';
export const DATA_ARCHIVE_VERSION = 3;
export const DATA_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const DATA_ARCHIVE_CANONICALIZATION = 'libre-json-sort-v1';

const LEGACY_ARCHIVE_FORMAT = 'libre-webui-export';
const MAX_ARCHIVE_SESSIONS = 5_000;
const MAX_ARCHIVE_MESSAGES = 100_000;
const MAX_ARCHIVE_DOCUMENTS = 5_000;
const MAX_ARCHIVE_CHUNKS = 100_000;
const MAX_ARCHIVE_FOLDERS = MAX_SESSION_FOLDERS_PER_USER;
const MAX_ARCHIVE_NOTES = MAX_NOTES_PER_USER;
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
      'Voice-cloning reference audio is biometric data and requires separate consent-aware handling with its transcript.',
  },
  {
    key: 'personasAndMemory',
    reason: 'Personas and persona memory are not part of archive version 3.',
  },
  {
    key: 'generatedMedia',
    reason:
      'Generated image, audio, and video library files are not part of archive version 3.',
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

export interface DataArchiveIntegrity {
  algorithm: 'sha256';
  canonicalization: typeof DATA_ARCHIVE_CANONICALIZATION;
  digest: string;
}

export interface UserDataArchive {
  format: typeof DATA_ARCHIVE_FORMAT;
  version: typeof DATA_ARCHIVE_VERSION;
  exportedAt: string;
  preferences: Partial<UserPreferences>;
  sessionFolders: SessionFolder[];
  sessions: ChatSession[];
  notes: Note[];
  knowledgeCollections: KnowledgeCollection[];
  documents: ArchivedDocument[];
  exclusions: DataArchiveExclusion[];
  integrity: DataArchiveIntegrity;
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
  notes: ArchiveSectionResult;
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
    notes: number;
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
  noteIds: Map<string, string>;
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

type CanonicalJson =
  | null
  | boolean
  | number
  | string
  | CanonicalJson[]
  | { [key: string]: CanonicalJson };

function canonicalJson(value: CanonicalJson): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(entry => canonicalJson(entry)).join(',')}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function archivePayloadForIntegrity(
  value: Record<string, unknown>
): Record<string, unknown> {
  const { integrity: _integrity, ...payload } = value;
  return payload;
}

function computeArchiveDigest(value: Record<string, unknown>): string {
  const payload = archivePayloadForIntegrity(value);
  const jsonSafe = JSON.parse(JSON.stringify(payload)) as CanonicalJson;
  return createHash('sha256').update(canonicalJson(jsonSafe)).digest('hex');
}

function sealArchive(
  value: Omit<UserDataArchive, 'integrity'>
): UserDataArchive {
  const payload = value as unknown as Record<string, unknown>;
  return {
    ...value,
    integrity: {
      algorithm: 'sha256',
      canonicalization: DATA_ARCHIVE_CANONICALIZATION,
      digest: computeArchiveDigest(payload),
    },
  };
}

function verifyArchiveIntegrity(value: Record<string, unknown>): void {
  const integrity = requireRecord(value.integrity, 'integrity');
  if (integrity.algorithm !== 'sha256') {
    throw new DataArchiveValidationError(
      'integrity.algorithm must be "sha256"'
    );
  }
  if (integrity.canonicalization !== DATA_ARCHIVE_CANONICALIZATION) {
    throw new DataArchiveValidationError(
      `integrity.canonicalization must be "${DATA_ARCHIVE_CANONICALIZATION}"`
    );
  }
  const digest = requireString(integrity.digest, 'integrity.digest', 64);
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new DataArchiveValidationError(
      'integrity.digest must be a lowercase SHA-256 digest'
    );
  }
  if (digest !== computeArchiveDigest(value)) {
    throw new DataArchiveValidationError(
      'Portable archive integrity check failed; the file is incomplete or was modified'
    );
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

function normalizeNote(value: unknown, index: number): Note {
  const path = `notes[${index}]`;
  const item = requireRecord(value, path);
  return {
    id: requireNonEmptyString(item.id, `${path}.id`),
    title: requireString(item.title, `${path}.title`, MAX_NOTE_TITLE_LENGTH),
    content: requireString(
      item.content,
      `${path}.content`,
      MAX_NOTE_CONTENT_LENGTH
    ),
    createdAt: requireTimestamp(item.createdAt, `${path}.createdAt`),
    updatedAt: requireTimestamp(item.updatedAt, `${path}.updatedAt`),
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

function validateExclusions(value: unknown): void {
  const exclusions = requireArray(value, 'exclusions').map((entry, index) => {
    const item = requireRecord(entry, `exclusions[${index}]`);
    return {
      id: requireNonEmptyString(item.key, `exclusions[${index}].key`),
      reason: requireNonEmptyString(
        item.reason,
        `exclusions[${index}].reason`,
        MAX_TITLE_LENGTH
      ),
    };
  });
  assertUniqueIds(exclusions, 'exclusions');
  const keys = new Set(exclusions.map(exclusion => exclusion.id));
  for (const required of DATA_ARCHIVE_EXCLUSIONS) {
    if (!keys.has(required.key)) {
      throw new DataArchiveValidationError(
        `exclusions must declare ${required.key}`
      );
    }
  }
}

function validateRelationships(
  sessionFolders: SessionFolder[],
  sessions: ChatSession[],
  knowledgeCollections: KnowledgeCollection[],
  documents: ArchivedDocument[]
): void {
  const folderIds = new Set(sessionFolders.map(folder => folder.id));
  const sessionIds = new Set(sessions.map(session => session.id));
  const collectionIds = new Set(
    knowledgeCollections.map(collection => collection.id)
  );

  sessions.forEach((session, sessionIndex) => {
    if (session.folderId && !folderIds.has(session.folderId)) {
      throw new DataArchiveValidationError(
        `sessions[${sessionIndex}].folderId references missing session folder ${session.folderId}`
      );
    }
    session.settings?.knowledgeCollectionIds?.forEach(
      (collectionId, collectionIndex) => {
        if (!collectionIds.has(collectionId)) {
          throw new DataArchiveValidationError(
            `sessions[${sessionIndex}].settings.knowledgeCollectionIds[${collectionIndex}] references missing knowledge collection ${collectionId}`
          );
        }
      }
    );
    const messageIds = new Set(session.messages.map(message => message.id));
    session.messages.forEach((message, messageIndex) => {
      if (message.parentId && !messageIds.has(message.parentId)) {
        throw new DataArchiveValidationError(
          `sessions[${sessionIndex}].messages[${messageIndex}].parentId must reference a message in the same session`
        );
      }
    });
  });

  documents.forEach((document, documentIndex) => {
    if (document.sessionId && !sessionIds.has(document.sessionId)) {
      throw new DataArchiveValidationError(
        `documents[${documentIndex}].sessionId references missing session ${document.sessionId}`
      );
    }
    if (document.collectionId && !collectionIds.has(document.collectionId)) {
      throw new DataArchiveValidationError(
        `documents[${documentIndex}].collectionId references missing knowledge collection ${document.collectionId}`
      );
    }
  });
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
      notes: [],
      knowledgeCollections: [],
      documents: raw.documents ?? [],
    };
    warnings.push(
      'Legacy archive migrated to version 3 without integrity verification. Legacy exports did not contain folders, Notes, collections, or document chunks.'
    );
  } else if (raw.format === DATA_ARCHIVE_FORMAT && raw.version === 2) {
    migratedFromVersion = '2';
    source = {
      ...raw,
      version: DATA_ARCHIVE_VERSION,
      notes: [],
    };
    delete source.integrity;
    warnings.push(
      'Archive version 2 migrated to version 3 without integrity verification. Version 2 did not contain Notes or a checksum.'
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
  if (!migratedFromVersion) {
    verifyArchiveIntegrity(source);
    validateExclusions(source.exclusions);
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
  const notes = requireArray(source.notes, 'notes').map(normalizeNote);
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
      `Archive contains ${sessionFolders.length} session folders; the maximum is ${MAX_ARCHIVE_FOLDERS}`
    );
  }
  if (sessions.length > MAX_ARCHIVE_SESSIONS) {
    throw new DataArchiveValidationError(
      `Archive contains ${sessions.length} sessions; the maximum is ${MAX_ARCHIVE_SESSIONS}`
    );
  }
  if (messageCount > MAX_ARCHIVE_MESSAGES) {
    throw new DataArchiveValidationError(
      `Archive contains ${messageCount} messages; the maximum is ${MAX_ARCHIVE_MESSAGES}`
    );
  }
  if (notes.length > MAX_ARCHIVE_NOTES) {
    throw new DataArchiveValidationError(
      `Archive contains ${notes.length} Notes; the maximum is ${MAX_ARCHIVE_NOTES}`
    );
  }
  if (knowledgeCollections.length > MAX_ARCHIVE_COLLECTIONS) {
    throw new DataArchiveValidationError(
      `Archive contains ${knowledgeCollections.length} knowledge collections; the maximum is ${MAX_ARCHIVE_COLLECTIONS}`
    );
  }
  if (documents.length > MAX_ARCHIVE_DOCUMENTS) {
    throw new DataArchiveValidationError(
      `Archive contains ${documents.length} documents; the maximum is ${MAX_ARCHIVE_DOCUMENTS}`
    );
  }
  if (chunkCount > MAX_ARCHIVE_CHUNKS) {
    throw new DataArchiveValidationError(
      `Archive contains ${chunkCount} document chunks; the maximum is ${MAX_ARCHIVE_CHUNKS}`
    );
  }

  assertUniqueIds(sessionFolders, 'sessionFolders');
  assertUniqueIds(sessions, 'sessions');
  assertUniqueIds(notes, 'notes');
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
  validateRelationships(
    sessionFolders,
    sessions,
    knowledgeCollections,
    documents
  );

  return {
    archive: sealArchive({
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      exportedAt,
      preferences,
      sessionFolders,
      sessions,
      notes,
      knowledgeCollections,
      documents,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    }),
    migratedFromVersion,
    warnings,
  };
}

function emptySection(): ArchiveSectionResult {
  return { imported: 0, overwritten: 0, skipped: 0 };
}

const archiveRepository = () =>
  getPersistence(encryptionService).repositories.resources.archive;

async function scopedOwner(
  resource: ArchiveOwnedResource,
  id: string
): Promise<string | undefined> {
  return (await archiveRepository().ownerOf(resource, id)) ?? undefined;
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

async function resolveScopedId(
  resource: ArchiveOwnedResource,
  kind: string,
  originalId: string,
  userId: string
): Promise<{ id: string; remapped: boolean }> {
  const owner = await scopedOwner(resource, originalId);
  if (
    resource !== 'document' ||
    (owner === userId &&
      !(await archiveRepository().resourceDeletionReserved(
        'document',
        originalId
      )))
  ) {
    if (!owner || owner === userId) {
      return { id: originalId, remapped: false };
    }
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = derivedId(userId, kind, originalId, attempt);
    const candidateOwner = await scopedOwner(resource, candidate);
    const reserved =
      resource === 'document'
        ? await archiveRepository().resourceDeletionReserved(
            'document',
            candidate
          )
        : false;
    if (!reserved && (!candidateOwner || candidateOwner === userId)) {
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

async function currentUserOwns(
  resource: ArchiveOwnedResource,
  id: string,
  userId: string
): Promise<boolean> {
  return (await scopedOwner(resource, id)) === userId;
}

async function nestedOwner(
  resource: 'session-message' | 'document-chunk',
  id: string
): Promise<{ user_id: string; parent_id: string } | undefined> {
  const owner = await archiveRepository().nestedOwnerOf(resource, id);
  return owner
    ? { user_id: owner.userId, parent_id: owner.parentId }
    : undefined;
}

async function resolveNestedId(
  resource: 'session-message' | 'document-chunk',
  originalId: string,
  targetParentId: string,
  userId: string,
  kind: string
): Promise<string> {
  const existing = await nestedOwner(resource, originalId);
  if (
    !existing ||
    (existing.user_id === userId && existing.parent_id === targetParentId)
  ) {
    return originalId;
  }

  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = derivedId(userId, kind, originalId, attempt);
    const collision = await nestedOwner(resource, candidate);
    if (
      !collision ||
      (collision.user_id === userId && collision.parent_id === targetParentId)
    ) {
      return candidate;
    }
  }
  throw new DataArchiveValidationError(`Could not safely remap ${kind} ID`);
}

async function buildPlan(
  normalized: NormalizedArchive,
  strategy: DataArchiveMergeStrategy,
  userId: string
): Promise<ImportPlan> {
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
    notes: emptySection(),
    knowledgeCollections: emptySection(),
    documents: emptySection(),
    remappedIds: 0,
    warnings: [...normalized.warnings],
    exclusions: DATA_ARCHIVE_EXCLUSIONS,
  };

  const mapIds = async <T extends { id: string }>(
    values: T[],
    resource: ArchiveOwnedResource,
    kind: string,
    section: ArchiveSectionResult
  ): Promise<Map<string, string>> => {
    const mapping = new Map<string, string>();
    for (const value of values) {
      const resolved = await resolveScopedId(resource, kind, value.id, userId);
      mapping.set(value.id, resolved.id);
      if (resolved.remapped) result.remappedIds += 1;
      sectionDisposition(
        section,
        await currentUserOwns(resource, resolved.id, userId),
        strategy
      );
    }
    return mapping;
  };

  const folderIds = await mapIds(
    archive.sessionFolders,
    'session-folder',
    'folder',
    result.sessionFolders
  );
  const existingFolderCount = (await storageService.getSessionFolders(userId))
    .length;
  if (
    existingFolderCount + result.sessionFolders.imported >
    MAX_SESSION_FOLDERS_PER_USER
  ) {
    throw new DataArchiveValidationError(
      `Import would exceed the per-user limit of ${MAX_SESSION_FOLDERS_PER_USER} session folders`
    );
  }
  const sessionIds = await mapIds(
    archive.sessions,
    'session',
    'session',
    result.sessions
  );
  const noteIds = await mapIds(archive.notes, 'note', 'note', result.notes);
  const existingNoteCount = (await storageService.getNotes(userId)).length;
  if (existingNoteCount + result.notes.imported > MAX_NOTES_PER_USER) {
    throw new DataArchiveValidationError(
      `Import would exceed the per-user limit of ${MAX_NOTES_PER_USER} Notes`
    );
  }
  const collectionIds = await mapIds(
    archive.knowledgeCollections,
    'knowledge-collection',
    'collection',
    result.knowledgeCollections
  );
  const documentIds = await mapIds(
    archive.documents,
    'document',
    'document',
    result.documents
  );

  const messageIds = new Map<string, string>();
  for (const session of archive.sessions) {
    const targetSessionId = sessionIds.get(session.id)!;
    for (const message of session.messages) {
      const targetMessageId = await resolveNestedId(
        'session-message',
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
      const targetChunkId = await resolveNestedId(
        'document-chunk',
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
      `${result.remappedIds} archive IDs were deterministically remapped to preserve ownership and deletion-incarnation safety.`
    );
  }
  for (const session of archive.sessions) {
    if (
      session.personaId &&
      !(await currentUserOwns('persona', session.personaId, userId))
    ) {
      result.warnings.push(
        `Session ${session.id} will be detached from persona ${session.personaId} because personas are excluded and the target account does not already own it.`
      );
    }
  }

  return {
    archive,
    folderIds,
    sessionIds,
    messageIds,
    noteIds,
    collectionIds,
    documentIds,
    chunkIds,
    result,
  };
}

async function mapReference(
  originalId: string | null | undefined,
  mapping: Map<string, string>,
  resource: ArchiveOwnedResource,
  userId: string
): Promise<string | undefined> {
  if (!originalId) return undefined;
  return (
    mapping.get(originalId) ??
    ((await currentUserOwns(resource, originalId, userId))
      ? originalId
      : undefined)
  );
}

async function applyPlan(
  plan: ImportPlan,
  strategy: DataArchiveMergeStrategy,
  userId: string
): Promise<void> {
  const timestamp = Date.now();
  const sessions: StoredChatSessionAggregate[] = [];
  for (const archivedSession of plan.archive.sessions) {
    const targetId = plan.sessionIds.get(archivedSession.id)!;
    const settings = archivedSession.settings
      ? { ...archivedSession.settings }
      : undefined;
    if (settings?.knowledgeCollectionIds) {
      settings.knowledgeCollectionIds = (
        await Promise.all(
          settings.knowledgeCollectionIds.map(collectionId =>
            mapReference(
              collectionId,
              plan.collectionIds,
              'knowledge-collection',
              userId
            )
          )
        )
      ).filter((id): id is string => Boolean(id));
    }
    const personaId = await mapReference(
      archivedSession.personaId,
      new Map(),
      'persona',
      userId
    );
    sessions.push({
      session: {
        id: targetId,
        user_id: userId,
        title: encryptionService.encrypt(archivedSession.title),
        model: archivedSession.model,
        persona_id: personaId ?? null,
        provider_type: archivedSession.providerType ?? null,
        provider_id: archivedSession.providerId ?? null,
        created_at: archivedSession.createdAt,
        updated_at: archivedSession.updatedAt,
        archived: archivedSession.archived ? 1 : 0,
        settings: settings
          ? encryptionService.encrypt(JSON.stringify(settings))
          : null,
        folder_id:
          (await mapReference(
            archivedSession.folderId,
            plan.folderIds,
            'session-folder',
            userId
          )) ?? null,
        pinned: archivedSession.pinned ? 1 : 0,
      },
      messages: archivedSession.messages.map((message, index) => ({
        id: plan.messageIds.get(message.id)!,
        session_id: targetId,
        role: message.role,
        content: encryptionService.encrypt(message.content),
        thinking: message.thinking
          ? encryptionService.encrypt(message.thinking)
          : null,
        timestamp: message.timestamp,
        message_index: index,
        model: message.model ?? null,
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
        parent_id: message.parentId
          ? plan.messageIds.get(message.parentId)!
          : null,
        branch_index: message.branchIndex ?? 0,
        is_active: message.isActive === false ? 0 : 1,
        rating: message.rating ?? null,
      })),
    });
  }

  const atomicPlan: DataArchiveApplyPlan = {
    userId,
    strategy,
    timestamp,
    maximumNotes: MAX_NOTES_PER_USER,
    maximumSessionFolders: MAX_SESSION_FOLDERS_PER_USER,
    preferences: current =>
      storageService.transformStoredPreferences(current, preferences =>
        preferencesService.prepareImportedPreferences(
          plan.archive.preferences,
          strategy === 'overwrite' ? 'replace' : 'merge',
          preferences
        )
      ),
    sessionFolders: plan.archive.sessionFolders.map(folder => ({
      id: plan.folderIds.get(folder.id)!,
      user_id: userId,
      name: encryptionService.encrypt(folder.name),
      created_at: folder.createdAt,
      updated_at: folder.updatedAt,
    })),
    sessions,
    notes: plan.archive.notes.map(note => ({
      id: plan.noteIds.get(note.id)!,
      user_id: userId,
      title: encryptionService.encrypt(note.title),
      content: encryptionService.encrypt(note.content),
      created_at: note.createdAt,
      updated_at: note.updatedAt,
    })),
    knowledgeCollections: plan.archive.knowledgeCollections.map(collection => ({
      id: plan.collectionIds.get(collection.id)!,
      user_id: userId,
      name: encryptionService.encrypt(collection.name),
      created_at: collection.createdAt,
      updated_at: collection.updatedAt,
    })),
    documents: await Promise.all(
      plan.archive.documents.map(async archivedDocument => {
        const targetId = plan.documentIds.get(archivedDocument.id)!;
        return {
          document: {
            id: targetId,
            user_id: userId,
            filename: archivedDocument.filename,
            title: archivedDocument.title
              ? encryptionService.encrypt(archivedDocument.title)
              : null,
            content: archivedDocument.content
              ? encryptionService.encrypt(archivedDocument.content)
              : null,
            file_type: archivedDocument.fileType ?? null,
            size: archivedDocument.size ?? null,
            session_id:
              (await mapReference(
                archivedDocument.sessionId,
                plan.sessionIds,
                'session',
                userId
              )) ?? null,
            collection_id:
              (await mapReference(
                archivedDocument.collectionId,
                plan.collectionIds,
                'knowledge-collection',
                userId
              )) ?? null,
            metadata: archivedDocument.metadata
              ? encryptionService.encrypt(
                  JSON.stringify(archivedDocument.metadata)
                )
              : null,
            uploaded_at: archivedDocument.uploadedAt,
            created_at: archivedDocument.createdAt ?? timestamp,
            updated_at: timestamp,
          },
          chunks: archivedDocument.chunks.map(chunk => ({
            id: plan.chunkIds.get(chunk.id)!,
            document_id: targetId,
            chunk_index: chunk.chunkIndex,
            content: encryptionService.encrypt(chunk.content),
            start_char: chunk.startChar ?? null,
            end_char: chunk.endChar ?? null,
            embedding: null,
            created_at: timestamp,
          })),
        };
      })
    ),
  };
  await archiveRepository().applyImport(atomicPlan);
}

function assertExportIsRestorable(archive: UserDataArchive): void {
  // Run the exact importer schema and resource checks before returning a file.
  // This prevents Libre from offering an export that its own preflight rejects.
  normalizeArchive(archive);
  const serializedBytes = Buffer.byteLength(
    JSON.stringify(archive, null, 2),
    'utf8'
  );
  if (serializedBytes > DATA_ARCHIVE_MAX_BYTES) {
    throw new DataArchiveValidationError(
      `Portable archive is ${serializedBytes} bytes; the import limit is ${DATA_ARCHIVE_MAX_BYTES} bytes`
    );
  }
}

async function assertStoredCountWithinExportLimit(
  resource: 'session-folder' | 'note',
  label: string,
  maximum: number,
  userId: string
): Promise<void> {
  const count = await archiveRepository().countByOwner(resource, userId);
  if (count > maximum) {
    throw new DataArchiveValidationError(
      `Account contains ${count} ${label}; the portable archive maximum is ${maximum}`
    );
  }
}

class DataArchiveService {
  async exportUserData(userId: string): Promise<UserDataArchive> {
    // These storage readers enforce UI limits with SQL LIMIT. Check the true
    // row counts first so an inconsistent older database is never truncated.
    await assertStoredCountWithinExportLimit(
      'session-folder',
      'session folders',
      MAX_ARCHIVE_FOLDERS,
      userId
    );
    await assertStoredCountWithinExportLimit(
      'note',
      'Notes',
      MAX_ARCHIVE_NOTES,
      userId
    );
    const preferences = JSON.parse(
      JSON.stringify(await preferencesService.getPreferences(userId))
    ) as Partial<UserPreferences>;
    if (preferences.ttsSettings?.voiceProfileId) {
      delete preferences.ttsSettings.voiceProfileId;
    }
    const documents: ArchivedDocument[] = await Promise.all(
      (await storageService.getAllDocuments(userId)).map(async document => ({
        ...document,
        chunks: (await storageService.getDocumentChunks(document.id)).map(
          chunk => ({
            id: chunk.id,
            documentId: chunk.documentId,
            content: chunk.content,
            chunkIndex: chunk.chunkIndex,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
          })
        ),
      }))
    );

    const [sessionFolders, sessions, notes, knowledgeCollections] =
      await Promise.all([
        storageService.getSessionFolders(userId),
        storageService.getAllSessions(userId),
        storageService.getNotes(userId),
        storageService.getKnowledgeCollections(userId),
      ]);
    const archive = sealArchive({
      format: DATA_ARCHIVE_FORMAT,
      version: DATA_ARCHIVE_VERSION,
      exportedAt: new Date().toISOString(),
      preferences,
      sessionFolders,
      sessions,
      notes,
      knowledgeCollections,
      documents,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    });
    assertExportIsRestorable(archive);
    return archive;
  }

  async preflight(
    value: unknown,
    strategy: DataArchiveMergeStrategy,
    userId: string
  ): Promise<DataArchivePreflight> {
    const normalized = normalizeArchive(value);
    const plan = await buildPlan(normalized, strategy, userId);
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
        notes: normalized.archive.notes.length,
        knowledgeCollections: normalized.archive.knowledgeCollections.length,
        documents: normalized.archive.documents.length,
        documentChunks: chunkCount,
      },
      result,
      warnings: plan.result.warnings,
      exclusions: DATA_ARCHIVE_EXCLUSIONS,
    };
  }

  async importUserData(
    value: unknown,
    strategy: DataArchiveMergeStrategy,
    userId: string
  ): Promise<DataArchiveImportResult> {
    const normalized = normalizeArchive(value);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const plan = await buildPlan(normalized, strategy, userId);
      try {
        await applyPlan(plan, strategy, userId);
        return plan.result;
      } catch (error) {
        if (
          error instanceof PersistenceResourceDeletionReservedError &&
          attempt < 4
        ) {
          continue;
        }
        logger.error('User data archive import rolled back:', error);
        throw error;
      }
    }
    throw new DataArchiveValidationError(
      'Archive identifiers changed too frequently to import safely'
    );
  }
}

export { DataArchiveValidationError };
export default new DataArchiveService();
