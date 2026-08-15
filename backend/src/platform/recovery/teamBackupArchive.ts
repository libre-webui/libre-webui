/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { QueryResultRow } from 'pg';

import {
  resolvePostgresRuntimeConfig,
  type PostgresRuntimeConfig,
} from '../../persistence/postgresConfig.js';
import {
  createPostgresDatabase,
  type PostgresDatabase,
  type PostgresQueryExecutor,
} from '../../persistence/postgresDatabase.js';
import { POSTGRES_MIGRATIONS } from '../../persistence/postgresMigrationRegistry.js';
import { inspectPostgresSchema } from '../../persistence/postgresSchemaInspector.js';
import { loadAppPackage } from '../../utils/packagePaths.js';
import {
  Aes256GcmKeyring,
  parseAesGcmEnvelope,
} from '../storage/aesGcmKeyring.js';
import {
  createS3EncryptedBlobStore,
  resolveS3BlobConfiguration,
  type S3BlobEnvironment,
} from '../storage/s3EncryptedBlobStore.js';
import {
  createStorageKeyringFromEnvironment,
  inspectStorageKeyConfiguration,
} from '../storage/storageFactory.js';
import { PgVectorStore } from '../storage/pgVectorStore.js';
import {
  extractBackupPayload,
  sealBackupPayload,
  stageProtectedRuntimeConfiguration,
  type BackupArchiveHeader,
  type BackupArchiveManifestInput,
  type BackupVerification,
} from './backupArchive.js';

const TEAM_INVENTORY_FORMAT = 'libre-webui-team-backup-inventory';
const TEAM_INVENTORY_VERSION = 2;
const COPY_BUFFER_BYTES = 1024 * 1024;
const DEFAULT_MAX_BLOB_OBJECTS = 250_000;
const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024 * 1024;
const MAX_DURABLE_IDENTIFIER_BYTES = 256;
const MAX_DURABLE_REFERENCE_BYTES = 2048;
const MAX_DURABLE_PLAINTEXT_BYTES = 64 * 1024;
const MAX_DURABLE_ENVELOPE_BYTES = 128 * 1024;
const MAX_DURABLE_JSON_DEPTH = 32;
const MAX_DURABLE_JSON_NODES = 10_000;
const MAX_DURABLE_PAYLOAD_RECORDS = 250_000;
const MAX_DURABLE_STREAM_HEADS = 250_000;
const MAX_DURABLE_CIPHERTEXT_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES = 16 * 1024 * 1024 * 1024;
const DURABLE_PAGE_SIZE = 128;
const DEFAULT_TOOL_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_ROLLBACK_FAILURE_DETAILS = 32;
const TOOL_PATTERN = /^(?:[A-Za-z0-9_.-]+|\/[A-Za-z0-9_./-]+)$/;
const POSTGRES_BOOTSTRAP_SCHEMAS = new Set([
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'public',
]);
const POSTGRES_BOOTSTRAP_EXTENSIONS = new Map([['plpgsql', 'pg_catalog']]);
const POSTGRES_TEMPORARY_SCHEMA_PATTERN = /^pg_(?:temp|toast_temp)_[0-9]+$/;

interface TeamBlobDatabaseRow extends QueryResultRow {
  id: string;
  owner_user_id: string;
  object_key: string;
  encrypted_bytes: string | number;
  ciphertext_sha256: string;
}

interface TeamDurableJobRow extends QueryResultRow {
  id: string;
  job_type: string;
  actor_user_id: string;
  payload_format: 'encrypted' | 'reference';
  payload: string;
}

interface TeamDurableEventRow extends QueryResultRow {
  global_cursor: string | number;
  event_id: string;
  stream_id: string;
  stream_sequence: string | number;
  event_type: string;
  subject_id: string;
  actor_user_id: string | null;
  payload_format: 'encrypted' | 'reference';
  payload: string;
}

export interface TeamDurableBackupIntegrity {
  verified: true;
  encryptedAuthenticated: true;
  streamHeadsVerified: true;
  referenceTargetsVerified: false;
  jobs: number;
  events: number;
  streams: number;
  lastGlobalCursor: number;
  globalSequenceValue: number;
  globalSequenceCalled: boolean;
  records: number;
  encryptedRecords: number;
  referenceRecords: number;
  ciphertextBytes: number;
  referenceBytes: number;
  plaintextBytes: number;
}

export interface TeamBlobBackupEntry {
  id: string;
  ownerUserId: string;
  objectKey: string;
  sourceVersionId: string;
  encryptedBytes: number;
  ciphertextSha256: string;
  payloadPath: string;
  contentType: 'application/octet-stream';
  metadata: Readonly<Record<string, string>>;
}

export interface TeamBackupInventory {
  format: typeof TEAM_INVENTORY_FORMAT;
  version: typeof TEAM_INVENTORY_VERSION;
  schemaVersion: number;
  schemaFingerprint: string;
  databaseDumpSha256: string;
  storageKeyFingerprint: string;
  s3: {
    bucket: string;
    keyPrefix: string;
    versioning: 'Enabled';
    objects: TeamBlobBackupEntry[];
    totalEncryptedBytes: number;
    totalPlaintextBytes: number;
  };
  vectors: { records: number; components: number };
  durable: TeamDurableBackupIntegrity;
}

export interface CreateTeamBackupOptions {
  outputPath: string;
  encryptionKeyPath: string;
  signingPrivateKeyPath: string;
  env?: NodeJS.ProcessEnv;
  offline: boolean;
  now?: Date;
  pgDumpCommand?: string;
  toolTimeoutMs?: number;
  maxBlobObjects?: number;
  maxBlobBytes?: number;
}

export interface RestoreTeamBackupOptions {
  archivePath: string;
  signingPublicKeyPath: string;
  encryptionKeyPath: string;
  targetEnv: NodeJS.ProcessEnv;
  apply: boolean;
  /** Required for apply; receives the merged, deployable runtime/key set. */
  configurationOutputDirectory?: string;
  pgRestoreCommand?: string;
  toolTimeoutMs?: number;
}

export interface TeamBackupResult {
  verification: BackupVerification;
  inventory: TeamBackupInventory;
}

export interface TeamRestoreResult extends TeamBackupResult {
  applied: boolean;
  configurationOutputDirectory?: string;
}

/**
 * A restore apply failed and one or more compensating cleanup operations also
 * failed. Callers must treat the target as dirty until both PostgreSQL and the
 * exact versioned S3 prefix have been inspected and cleaned.
 */
export class TeamRestoreRollbackError extends Error {
  readonly errors: readonly Error[];
  readonly rollbackFailureCount: number;

  constructor(
    originalFailure: Error,
    rollbackFailures: readonly Error[],
    rollbackFailureCount: number
  ) {
    super(
      `Team restore failed and rollback was incomplete (${rollbackFailureCount} cleanup failure${rollbackFailureCount === 1 ? '' : 's'}). ` +
        'The target may contain restored PostgreSQL data and/or immutable S3 versions. ' +
        'Do not retry until both targets have been inspected and cleaned; clean-target preflight will reject residual state.'
    );
    this.name = 'TeamRestoreRollbackError';
    this.errors = [originalFailure, ...rollbackFailures];
    this.rollbackFailureCount = rollbackFailureCount;
    Object.defineProperty(this, 'cause', {
      value: originalFailure,
      enumerable: false,
    });
  }
}

interface RollbackFailureReport {
  failures: Error[];
  failureCount: number;
}

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const contextualRollbackError = (context: string, error: unknown): Error => {
  const cause = normalizeError(error);
  const failure = new Error(`${context}: ${cause.message}`);
  Object.defineProperty(failure, 'cause', {
    value: cause,
    enumerable: false,
  });
  return failure;
};

const canonicalJson = (value: unknown): string => {
  const visit = (candidate: unknown): string => {
    if (candidate === null || typeof candidate !== 'object') {
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) return `[${candidate.map(visit).join(',')}]`;
    const object = candidate as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map(key => `${JSON.stringify(key)}:${visit(object[key])}`)
      .join(',')}}`;
  };
  return visit(value);
};

const sha256 = (value: Buffer | string): string =>
  crypto.createHash('sha256').update(value).digest('hex');

const safeInteger = (value: string | number, field: string): number => {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Invalid team backup ${field}.`);
  }
  return result;
};

const validateDurableText = (
  value: unknown,
  maximum = MAX_DURABLE_IDENTIFIER_BYTES
): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maximum
  ) {
    return false;
  }
  return ![...value].some(character => {
    const point = character.codePointAt(0) ?? 0;
    return point <= 31 || point === 127;
  });
};

/** Mirrors the immutable durable-payload JSON wire contract. */
const canonicalDurableJson = (value: unknown): string => {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_DURABLE_JSON_NODES || depth > MAX_DURABLE_JSON_DEPTH) {
      throw new Error(
        'Durable payload is too complex for backup verification.'
      );
    }
    if (candidate === null) return 'null';
    if (typeof candidate === 'string' || typeof candidate === 'boolean') {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new Error('Durable payload contains a non-finite number.');
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object' || ancestors.has(candidate)) {
      throw new Error('Durable payload is not acyclic JSON.');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate.map(item => visit(item, depth + 1)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new Error('Durable payload is not plain JSON.');
      }
      const object = candidate as Record<string, unknown>;
      return `{${Object.keys(object)
        .sort()
        .map(key => `${JSON.stringify(key)}:${visit(object[key], depth + 1)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DURABLE_PLAINTEXT_BYTES) {
    throw new Error('Durable payload exceeds the backup verification limit.');
  }
  return serialized;
};

const jobAad = (id: string, type: string, actor: string): Buffer =>
  Buffer.from(`durable-job:v1\0${id}\0${type}\0${actor}`);

const eventAad = (
  id: string,
  stream: string,
  type: string,
  subject: string,
  actor: string | null
): Buffer =>
  Buffer.from(
    `durable-event:v1\0${id}\0${stream}\0${type}\0${subject}\0${actor ?? ''}`
  );

const sameDurableIntegrity = (
  actual: TeamDurableBackupIntegrity,
  expected: TeamDurableBackupIntegrity
): boolean => canonicalJson(actual) === canonicalJson(expected);

const positiveLimit = (
  value: number | undefined,
  fallback: number,
  field: string
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new Error(`Invalid team backup ${field}.`);
  }
  return selected;
};

const hashFile = (target: string): { bytes: number; sha256: string } => {
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Team backup payload must be a physical single-link file.');
  }
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let bytes = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Team backup payload changed while opening.');
    }
    let read: number;
    while (
      (read = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0
    ) {
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
    const after = fs.fstatSync(descriptor);
    if (
      bytes !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    ) {
      throw new Error('Team backup payload changed during hashing.');
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
};

const parseJsonObject = (target: string): Record<string, string> => {
  const bytes = fs.readFileSync(target);
  try {
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Protected backup configuration is invalid.');
    }
    const output: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item !== 'string') {
        throw new Error('Protected backup configuration is invalid.');
      }
      output[key] = item;
    }
    return output;
  } finally {
    bytes.fill(0);
  }
};

const postgresToolEnvironment = (
  config: PostgresRuntimeConfig,
  base: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const url = new URL(config.connectionString);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!database) throw new Error('PostgreSQL URL must name a database.');
  return {
    ...base,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGDATABASE: database,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGSSLMODE: config.sslMode,
    PGAPPNAME: `${config.applicationName}-recovery`,
    PGCONNECT_TIMEOUT: String(
      Math.max(1, Math.ceil(config.connectionTimeoutMs / 1000))
    ),
  };
};

const postgresDatabaseName = (config: PostgresRuntimeConfig): string => {
  const database = decodeURIComponent(
    new URL(config.connectionString).pathname.replace(/^\//, '')
  );
  if (!database) throw new Error('PostgreSQL URL must name a database.');
  return database;
};

const runPostgresTool = async (
  command: string,
  args: readonly string[],
  config: PostgresRuntimeConfig,
  baseEnv: NodeJS.ProcessEnv,
  timeoutMs: number
): Promise<void> => {
  if (!TOOL_PATTERN.test(command) || command.includes('..')) {
    throw new Error('PostgreSQL recovery tool path is invalid.');
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: postgresToolEnvironment(config, baseEnv),
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderrBytes = 0;
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1024 * 1024) child.kill('SIGKILL');
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      const failure = new Error(
        'Unable to start the PostgreSQL recovery tool.'
      );
      Object.defineProperty(failure, 'cause', {
        value: error,
        enumerable: false,
      });
      reject(failure);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `PostgreSQL recovery tool failed (${signal ? 'terminated' : `exit ${code ?? 'unknown'}`}).`
          )
        );
    });
  });
};

const validateToolTimeout = (value: number | undefined): number => {
  const selected = value ?? DEFAULT_TOOL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(selected) ||
    selected < 1_000 ||
    selected > 24 * 60 * 60 * 1000
  ) {
    throw new Error('PostgreSQL recovery tool timeout is invalid.');
  }
  return selected;
};

const validateTeamSelection = (env: NodeJS.ProcessEnv): void => {
  if (
    env.LIBRE_PLATFORM_MODE?.trim().toLowerCase() !== 'team' ||
    env.DATABASE_BACKEND?.trim().toLowerCase() !== 'postgres' ||
    env.BLOB_STORE_BACKEND?.trim().toLowerCase() !== 's3' ||
    env.VECTOR_STORE_BACKEND?.trim().toLowerCase() !== 'pgvector'
  ) {
    throw new Error(
      'Team backup requires team mode with PostgreSQL, S3, and PGVector selected.'
    );
  }
};

const keyFingerprint = (env: NodeJS.ProcessEnv): string => {
  const inspection = inspectStorageKeyConfiguration(env);
  if (
    inspection.status !== 'configured' ||
    inspection.keyFingerprints.length === 0
  ) {
    throw new Error(
      'Team backup requires the complete storage encryption key set.'
    );
  }
  return sha256(
    canonicalJson({
      activeKeyId: inspection.activeKeyId,
      keys: inspection.keyFingerprints,
    })
  );
};

const verifyDurablePayload = (
  keyring: Aes256GcmKeyring,
  row: { payload_format: 'encrypted' | 'reference'; payload: string },
  aad: Buffer,
  totals: {
    encryptedRecords: number;
    referenceRecords: number;
    ciphertextBytes: number;
    referenceBytes: number;
    plaintextBytes: number;
  }
): void => {
  const bytes = Buffer.byteLength(row.payload, 'utf8');
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new Error('Durable payload byte accounting is invalid.');
  }
  if (row.payload_format === 'reference') {
    if (!validateDurableText(row.payload, MAX_DURABLE_REFERENCE_BYTES)) {
      throw new Error('Durable payload reference is invalid.');
    }
    totals.referenceRecords += 1;
    totals.referenceBytes += bytes;
    return;
  }
  if (
    row.payload_format !== 'encrypted' ||
    bytes > MAX_DURABLE_ENVELOPE_BYTES
  ) {
    throw new Error('Durable encrypted payload envelope is invalid.');
  }
  totals.encryptedRecords += 1;
  totals.ciphertextBytes += bytes;
  let plaintext: Buffer | undefined;
  try {
    plaintext = keyring.decrypt(
      parseAesGcmEnvelope(JSON.parse(row.payload) as unknown),
      aad
    );
    if (plaintext.byteLength > MAX_DURABLE_PLAINTEXT_BYTES) {
      throw new Error('Durable payload exceeds the backup verification limit.');
    }
    totals.plaintextBytes += plaintext.byteLength;
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (canonicalDurableJson(JSON.parse(decoded) as unknown) !== decoded) {
      throw new Error('Durable payload is not canonical JSON.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Durable payload')) {
      throw error;
    }
    const failure = new Error('Durable payload authentication failed.');
    Object.defineProperty(failure, 'cause', {
      value: error,
      enumerable: false,
    });
    throw failure;
  } finally {
    plaintext?.fill(0);
  }
};

/**
 * Stream-head invariants: every event's stream must have a head, and a head
 * may never sit behind its newest retained event. A head may legitimately
 * exceed the retained events: chat cancellation commits a zero-event head as
 * its lock anchor when Stop wins before any durable event exists, and the
 * retention sweep removes aged events without rewriting heads.
 */
const verifyDurableDatabaseIntegrity = async (
  executor: PostgresQueryExecutor,
  keyring: Aes256GcmKeyring
): Promise<TeamDurableBackupIntegrity> => {
  const aggregate = await executor.query<
    {
      jobs: string | number;
      events: string | number;
      streams: string | number;
      last_global_cursor: string | number;
      encrypted_records: string | number;
      reference_records: string | number;
      ciphertext_bytes: string | number;
      reference_bytes: string | number;
      largest_envelope: string | number;
      inconsistent_heads: string | number;
    } & QueryResultRow
  >(
    `WITH payloads AS (
       SELECT payload_format, octet_length(payload) AS bytes FROM platform_jobs
       UNION ALL
       SELECT payload_format, octet_length(payload) AS bytes FROM platform_events
     ), event_groups AS (
       SELECT stream_id, MIN(stream_sequence) AS first_sequence,
              MAX(stream_sequence) AS last_sequence, COUNT(*) AS event_count
         FROM platform_events GROUP BY stream_id
     )
     SELECT
       (SELECT COUNT(*) FROM platform_jobs) AS jobs,
       (SELECT COUNT(*) FROM platform_events) AS events,
       (SELECT COUNT(*) FROM platform_event_stream_heads) AS streams,
       (SELECT COALESCE(MAX(global_cursor), 0) FROM platform_events) AS last_global_cursor,
       COALESCE(SUM((payload_format = 'encrypted')::integer), 0) AS encrypted_records,
       COALESCE(SUM((payload_format = 'reference')::integer), 0) AS reference_records,
       COALESCE(SUM(CASE WHEN payload_format = 'encrypted' THEN bytes ELSE 0 END), 0) AS ciphertext_bytes,
       COALESCE(SUM(CASE WHEN payload_format = 'reference' THEN bytes ELSE 0 END), 0) AS reference_bytes,
       COALESCE(MAX(CASE WHEN payload_format = 'encrypted' THEN bytes ELSE 0 END), 0) AS largest_envelope,
       (SELECT COUNT(*)
          FROM platform_event_stream_heads heads
          FULL OUTER JOIN event_groups events ON events.stream_id = heads.stream_id
         WHERE heads.stream_id IS NULL
            OR events.last_sequence > heads.last_sequence) AS inconsistent_heads
       FROM payloads`
  );
  const row = aggregate.rows[0];
  if (!row) throw new Error('Durable backup inventory query returned no row.');
  const jobs = safeInteger(row.jobs, 'durable job count');
  const events = safeInteger(row.events, 'durable event count');
  const streams = safeInteger(row.streams, 'durable stream count');
  const lastGlobalCursor = safeInteger(
    row.last_global_cursor,
    'durable event cursor'
  );
  const encryptedRecords = safeInteger(
    row.encrypted_records,
    'durable encrypted payload count'
  );
  const referenceRecords = safeInteger(
    row.reference_records,
    'durable reference payload count'
  );
  const ciphertextBytes = safeInteger(
    row.ciphertext_bytes,
    'durable ciphertext bytes'
  );
  const referenceBytes = safeInteger(
    row.reference_bytes,
    'durable reference bytes'
  );
  const largestEnvelope = safeInteger(
    row.largest_envelope,
    'largest durable envelope'
  );
  const inconsistentHeads = safeInteger(
    row.inconsistent_heads,
    'inconsistent durable stream heads'
  );
  const records = jobs + events;
  if (
    !Number.isSafeInteger(records) ||
    records !== encryptedRecords + referenceRecords ||
    records > MAX_DURABLE_PAYLOAD_RECORDS ||
    streams > MAX_DURABLE_STREAM_HEADS ||
    ciphertextBytes > MAX_DURABLE_CIPHERTEXT_BYTES ||
    largestEnvelope > MAX_DURABLE_ENVELOPE_BYTES ||
    encryptedRecords >
      Math.floor(
        MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES / MAX_DURABLE_PLAINTEXT_BYTES
      )
  ) {
    throw new Error(
      'Durable state exceeds bounded backup verification limits.'
    );
  }
  if (inconsistentHeads !== 0) {
    throw new Error('Durable event stream heads are not contiguous.');
  }

  const sequence = await executor.query<
    { last_value: string | number; is_called: boolean } & QueryResultRow
  >(
    `SELECT last_value, is_called
       FROM platform_events_global_cursor_seq`
  );
  const globalSequenceValue = safeInteger(
    sequence.rows[0]?.last_value ?? 0,
    'durable global cursor sequence'
  );
  const globalSequenceCalled = sequence.rows[0]?.is_called === true;
  if (
    sequence.rowCount !== 1 ||
    (events > 0 &&
      (!globalSequenceCalled || globalSequenceValue < lastGlobalCursor))
  ) {
    throw new Error('Durable global event cursor sequence is inconsistent.');
  }

  const totals = {
    encryptedRecords: 0,
    referenceRecords: 0,
    ciphertextBytes: 0,
    referenceBytes: 0,
    plaintextBytes: 0,
  };
  let afterJobId = '';
  for (;;) {
    const page = await executor.query<TeamDurableJobRow>(
      `SELECT id::text, job_type, actor_user_id, payload_format, payload
         FROM platform_jobs WHERE id::text > $1
        ORDER BY id::text LIMIT $2`,
      [afterJobId, DURABLE_PAGE_SIZE]
    );
    for (const job of page.rows) {
      if (
        !validateDurableText(job.id) ||
        !validateDurableText(job.job_type) ||
        !validateDurableText(job.actor_user_id)
      ) {
        throw new Error('Durable job identity is invalid.');
      }
      verifyDurablePayload(
        keyring,
        job,
        jobAad(job.id, job.job_type, job.actor_user_id),
        totals
      );
      afterJobId = job.id;
    }
    if (page.rows.length < DURABLE_PAGE_SIZE) break;
  }

  let afterCursor = 0;
  for (;;) {
    const page = await executor.query<TeamDurableEventRow>(
      `SELECT global_cursor, event_id::text, stream_id, stream_sequence,
              event_type, subject_id, actor_user_id, payload_format, payload
         FROM platform_events WHERE global_cursor > $1
        ORDER BY global_cursor LIMIT $2`,
      [afterCursor, DURABLE_PAGE_SIZE]
    );
    for (const event of page.rows) {
      const cursor = safeInteger(event.global_cursor, 'durable event cursor');
      if (
        cursor <= afterCursor ||
        safeInteger(event.stream_sequence, 'durable stream sequence') < 1 ||
        !validateDurableText(event.event_id) ||
        !validateDurableText(event.stream_id) ||
        !validateDurableText(event.event_type) ||
        !validateDurableText(event.subject_id) ||
        (event.actor_user_id !== null &&
          !validateDurableText(event.actor_user_id))
      ) {
        throw new Error('Durable event identity is invalid.');
      }
      verifyDurablePayload(
        keyring,
        event,
        eventAad(
          event.event_id,
          event.stream_id,
          event.event_type,
          event.subject_id,
          event.actor_user_id
        ),
        totals
      );
      afterCursor = cursor;
    }
    if (page.rows.length < DURABLE_PAGE_SIZE) break;
  }
  if (
    totals.encryptedRecords !== encryptedRecords ||
    totals.referenceRecords !== referenceRecords ||
    totals.ciphertextBytes !== ciphertextBytes ||
    totals.referenceBytes !== referenceBytes ||
    afterCursor !== lastGlobalCursor ||
    totals.plaintextBytes > MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES
  ) {
    throw new Error('Durable backup verification totals are inconsistent.');
  }
  return {
    verified: true,
    encryptedAuthenticated: true,
    streamHeadsVerified: true,
    referenceTargetsVerified: false,
    jobs,
    events,
    streams,
    lastGlobalCursor,
    globalSequenceValue,
    globalSequenceCalled,
    records,
    ...totals,
  };
};

const validateDatabaseSnapshot = async (
  executor: PostgresQueryExecutor,
  keyring: Aes256GcmKeyring
): Promise<{
  schemaVersion: number;
  schemaFingerprint: string;
  blobs: TeamBlobDatabaseRow[];
  durable: TeamDurableBackupIntegrity;
}> => {
  const ledger = await executor.query<
    {
      version: number;
      name: string;
      checksum: string;
      minimum_compatible_version: number;
    } & QueryResultRow
  >(
    `SELECT version, name, checksum, minimum_compatible_version
       FROM libre_schema_migrations ORDER BY version`
  );
  if (
    ledger.rows.length !== POSTGRES_MIGRATIONS.length ||
    !POSTGRES_MIGRATIONS.every(
      (migration, index) =>
        Number(ledger.rows[index]?.version) === migration.version &&
        ledger.rows[index]?.name === migration.name &&
        ledger.rows[index]?.checksum === migration.checksum &&
        Number(ledger.rows[index]?.minimum_compatible_version) ===
          migration.minimumCompatibleVersion
    )
  ) {
    throw new Error('PostgreSQL migration ledger is not backup-compatible.');
  }
  const state = await executor.query<
    {
      status: string;
      current_version: number;
      target_version: number;
      schema_fingerprint: string | null;
    } & QueryResultRow
  >(
    `SELECT status, current_version, target_version, schema_fingerprint
       FROM libre_schema_compatibility WHERE singleton = 1`
  );
  const target = POSTGRES_MIGRATIONS.length;
  if (
    state.rowCount !== 1 ||
    state.rows[0]?.status !== 'compatible' ||
    Number(state.rows[0]?.current_version) !== target ||
    Number(state.rows[0]?.target_version) !== target ||
    !state.rows[0]?.schema_fingerprint
  ) {
    throw new Error('PostgreSQL schema is not quiesced at the backup target.');
  }
  const structure = await inspectPostgresSchema(executor, POSTGRES_MIGRATIONS);
  if (
    !structure.compatible ||
    structure.fingerprint !== state.rows[0].schema_fingerprint
  ) {
    throw new Error('PostgreSQL schema structure is not backup-compatible.');
  }
  const activity = await executor.query<
    {
      running_jobs: string | number;
      running_attempts: string | number;
      active_work_runs: string | number;
      active_previews: string | number;
      deleting_blobs: string | number;
    } & QueryResultRow
  >(
    `SELECT
       (SELECT COUNT(*) FROM platform_jobs WHERE state = 'running') AS running_jobs,
       (SELECT COUNT(*) FROM platform_job_attempts WHERE outcome = 'running') AS running_attempts,
       (SELECT COUNT(*) FROM work_runs WHERE status IN ('queued', 'preparing', 'running')) AS active_work_runs,
       (SELECT COUNT(*) FROM work_tasks WHERE preview_status IN ('starting', 'running')) AS active_previews,
       (SELECT COUNT(*) FROM platform_blob_objects WHERE state = 'deleting') AS deleting_blobs`
  );
  const active = activity.rows[0];
  if (
    !active ||
    safeInteger(active.running_jobs, 'running job count') > 0 ||
    safeInteger(active.running_attempts, 'running attempt count') > 0 ||
    safeInteger(active.active_work_runs, 'active Work run count') > 0 ||
    safeInteger(active.active_previews, 'active Work preview count') > 0 ||
    safeInteger(active.deleting_blobs, 'deleting blob count') > 0
  ) {
    throw new Error(
      'Team backup requires no running work or incomplete blob deletion.'
    );
  }
  const blobs = await executor.query<TeamBlobDatabaseRow>(
    `SELECT id, owner_user_id, object_key, encrypted_bytes, ciphertext_sha256
       FROM platform_blob_objects WHERE state = 'ready' ORDER BY id`
  );
  const durable = await verifyDurableDatabaseIntegrity(executor, keyring);
  return {
    schemaVersion: target,
    schemaFingerprint: structure.fingerprint,
    blobs: blobs.rows,
    durable,
  };
};

const assertBucketVersioning = async (
  client: S3Client,
  bucket: string
): Promise<void> => {
  const versioning = await client.send(
    new GetBucketVersioningCommand({ Bucket: bucket })
  );
  if (versioning.Status !== 'Enabled') {
    throw new Error('Team backup requires S3 bucket versioning to be enabled.');
  }
};

const bodyIterable = (body: unknown): AsyncIterable<Uint8Array> => {
  if (
    !body ||
    typeof body !== 'object' ||
    !(Symbol.asyncIterator in body) ||
    typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] !==
      'function'
  ) {
    throw new Error('S3 returned a non-streaming backup object.');
  }
  return body as AsyncIterable<Uint8Array>;
};

const copyVersionedS3Objects = async (
  client: S3Client,
  bucket: string,
  keyPrefix: string,
  rows: readonly TeamBlobDatabaseRow[],
  payloadDirectory: string,
  maxObjects: number,
  maxBytes: number
): Promise<{ objects: TeamBlobBackupEntry[]; totalEncryptedBytes: number }> => {
  if (rows.length > maxObjects) {
    throw new Error('Team backup exceeds the configured S3 object limit.');
  }
  const objectDirectory = path.join(payloadDirectory, 'team', 's3');
  fs.mkdirSync(objectDirectory, { recursive: true, mode: 0o700 });
  const objects: TeamBlobBackupEntry[] = [];
  let totalEncryptedBytes = 0;
  for (const [index, row] of rows.entries()) {
    const encryptedBytes = safeInteger(row.encrypted_bytes, 'blob byte count');
    totalEncryptedBytes += encryptedBytes;
    if (
      !Number.isSafeInteger(totalEncryptedBytes) ||
      totalEncryptedBytes > maxBytes
    ) {
      throw new Error('Team backup exceeds the configured S3 byte limit.');
    }
    if (
      !row.object_key.startsWith(`${keyPrefix}/v1/`) ||
      !/^[a-f0-9]{64}$/.test(row.ciphertext_sha256)
    ) {
      throw new Error('PostgreSQL contains an invalid S3 blob descriptor.');
    }
    const head = await client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: row.object_key })
    );
    if (!head.VersionId) {
      throw new Error('An S3 blob has no immutable version identifier.');
    }
    if (
      head.ContentLength !== encryptedBytes ||
      head.ContentType !== 'application/octet-stream' ||
      head.Metadata?.['libre-format'] !== '1'
    ) {
      throw new Error('An S3 blob does not match its PostgreSQL descriptor.');
    }
    const response = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: row.object_key,
        VersionId: head.VersionId,
      })
    );
    if (response.VersionId !== head.VersionId) {
      throw new Error('S3 returned a different object version during backup.');
    }
    const relative = `team/s3/${String(index).padStart(8, '0')}.blob`;
    const target = path.join(payloadDirectory, ...relative.split('/'));
    const descriptor = fs.openSync(
      target,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    const hash = crypto.createHash('sha256');
    let written = 0;
    try {
      for await (const value of bodyIterable(response.Body)) {
        const bytes = Buffer.from(
          value.buffer,
          value.byteOffset,
          value.byteLength
        );
        let offset = 0;
        while (offset < bytes.byteLength) {
          offset += fs.writeSync(
            descriptor,
            bytes,
            offset,
            bytes.byteLength - offset
          );
        }
        hash.update(bytes);
        written += bytes.byteLength;
      }
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
      (response.Body as { destroy?: () => void } | undefined)?.destroy?.();
    }
    if (
      written !== encryptedBytes ||
      hash.digest('hex') !== row.ciphertext_sha256
    ) {
      throw new Error('Versioned S3 ciphertext failed backup verification.');
    }
    objects.push({
      id: row.id,
      ownerUserId: row.owner_user_id,
      objectKey: row.object_key,
      sourceVersionId: head.VersionId,
      encryptedBytes,
      ciphertextSha256: row.ciphertext_sha256,
      payloadPath: relative,
      contentType: 'application/octet-stream',
      metadata: Object.freeze({ 'libre-format': '1' }),
    });
  }
  return { objects, totalEncryptedBytes };
};

const writeTeamInventory = (
  payloadDirectory: string,
  inventory: TeamBackupInventory
): void => {
  fs.writeFileSync(
    path.join(payloadDirectory, 'team', 'inventory.json'),
    canonicalJson(inventory),
    { mode: 0o600, flag: 'wx' }
  );
};

const parseTeamInventory = (
  payloadDirectory: string,
  header: BackupArchiveHeader
): TeamBackupInventory => {
  const bytes = fs.readFileSync(
    path.join(payloadDirectory, 'team', 'inventory.json')
  );
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as TeamBackupInventory;
    if (
      parsed?.format !== TEAM_INVENTORY_FORMAT ||
      parsed.version !== TEAM_INVENTORY_VERSION ||
      !Number.isSafeInteger(parsed.schemaVersion) ||
      parsed.schemaVersion <= 0 ||
      !/^[a-f0-9]{64}$/.test(parsed.schemaFingerprint) ||
      !/^[a-f0-9]{64}$/.test(parsed.databaseDumpSha256) ||
      !/^[a-f0-9]{64}$/.test(parsed.storageKeyFingerprint) ||
      parsed.s3?.versioning !== 'Enabled' ||
      !Array.isArray(parsed.s3.objects) ||
      !Number.isSafeInteger(parsed.s3.totalEncryptedBytes) ||
      parsed.s3.totalEncryptedBytes < 0 ||
      !Number.isSafeInteger(parsed.s3.totalPlaintextBytes) ||
      parsed.s3.totalPlaintextBytes < 0 ||
      !Number.isSafeInteger(parsed.vectors?.records) ||
      !Number.isSafeInteger(parsed.vectors?.components) ||
      parsed.vectors.records < 0 ||
      parsed.vectors.components < 0 ||
      parsed.durable?.verified !== true ||
      parsed.durable.encryptedAuthenticated !== true ||
      parsed.durable.streamHeadsVerified !== true ||
      parsed.durable.referenceTargetsVerified !== false ||
      ![
        parsed.durable.jobs,
        parsed.durable.events,
        parsed.durable.streams,
        parsed.durable.lastGlobalCursor,
        parsed.durable.globalSequenceValue,
        parsed.durable.records,
        parsed.durable.encryptedRecords,
        parsed.durable.referenceRecords,
        parsed.durable.ciphertextBytes,
        parsed.durable.referenceBytes,
        parsed.durable.plaintextBytes,
      ].every(value => Number.isSafeInteger(value) && value >= 0) ||
      typeof parsed.durable.globalSequenceCalled !== 'boolean' ||
      parsed.durable.records !==
        parsed.durable.encryptedRecords + parsed.durable.referenceRecords ||
      parsed.durable.records !== parsed.durable.jobs + parsed.durable.events ||
      parsed.durable.jobs + parsed.durable.events >
        MAX_DURABLE_PAYLOAD_RECORDS ||
      parsed.durable.streams > MAX_DURABLE_STREAM_HEADS ||
      parsed.durable.ciphertextBytes > MAX_DURABLE_CIPHERTEXT_BYTES ||
      parsed.durable.plaintextBytes > MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES ||
      (parsed.durable.events > 0 &&
        (!parsed.durable.globalSequenceCalled ||
          parsed.durable.lastGlobalCursor < 1 ||
          parsed.durable.globalSequenceValue < parsed.durable.lastGlobalCursor))
    ) {
      throw new Error('Team backup inventory is invalid.');
    }
    const seenIds = new Set<string>();
    const seenKeys = new Set<string>();
    let total = 0;
    for (const entry of parsed.s3.objects) {
      if (
        typeof entry.id !== 'string' ||
        typeof entry.ownerUserId !== 'string' ||
        typeof entry.objectKey !== 'string' ||
        !entry.objectKey.startsWith(`${parsed.s3.keyPrefix}/v1/`) ||
        typeof entry.sourceVersionId !== 'string' ||
        !entry.sourceVersionId ||
        !Number.isSafeInteger(entry.encryptedBytes) ||
        entry.encryptedBytes < 0 ||
        !/^[a-f0-9]{64}$/.test(entry.ciphertextSha256) ||
        !/^team\/s3\/[0-9]{8}\.blob$/.test(entry.payloadPath) ||
        entry.contentType !== 'application/octet-stream' ||
        entry.metadata?.['libre-format'] !== '1' ||
        seenIds.has(entry.id) ||
        seenKeys.has(entry.objectKey)
      ) {
        throw new Error('Team backup S3 inventory is invalid.');
      }
      seenIds.add(entry.id);
      seenKeys.add(entry.objectKey);
      total += entry.encryptedBytes;
      const file = hashFile(
        path.join(payloadDirectory, ...entry.payloadPath.split('/'))
      );
      if (
        file.bytes !== entry.encryptedBytes ||
        file.sha256 !== entry.ciphertextSha256
      ) {
        throw new Error('Team backup S3 payload does not match its inventory.');
      }
    }
    if (total !== parsed.s3.totalEncryptedBytes) {
      throw new Error('Team backup S3 inventory byte total is invalid.');
    }
    const dump = hashFile(path.join(payloadDirectory, 'team', 'postgres.dump'));
    if (dump.sha256 !== parsed.databaseDumpSha256) {
      throw new Error('Team PostgreSQL dump does not match its inventory.');
    }
    if (
      header.manifest.source.platformMode !== 'team' ||
      header.manifest.source.databaseBackend !== 'postgres' ||
      header.manifest.source.blobBackend !== 's3' ||
      header.manifest.source.vectorBackend !== 'pgvector' ||
      header.manifest.inventory.schemaVersion !== parsed.schemaVersion ||
      header.manifest.inventory.schemaFingerprint !==
        parsed.schemaFingerprint ||
      header.manifest.inventory.databaseDumpSha256 !==
        parsed.databaseDumpSha256 ||
      header.manifest.inventory.blobObjects !== parsed.s3.objects.length ||
      header.manifest.inventory.vectorRecords !== parsed.vectors.records
    ) {
      throw new Error('Team archive header and protected inventory disagree.');
    }
    return parsed;
  } finally {
    bytes.fill(0);
  }
};

export const createTeamBackupArchive = async (
  options: CreateTeamBackupOptions
): Promise<TeamBackupResult> => {
  if (!options.offline) {
    throw new Error(
      'Team backup requires --offline after every application and worker replica is stopped.'
    );
  }
  const env = options.env ?? process.env;
  validateTeamSelection(env);
  const keySetFingerprint = keyFingerprint(env);
  const postgresConfig = resolvePostgresRuntimeConfig(env);
  const s3Config = resolveS3BlobConfiguration(env as S3BlobEnvironment);
  const timeoutMs = validateToolTimeout(options.toolTimeoutMs);
  const maxObjects = positiveLimit(
    options.maxBlobObjects,
    DEFAULT_MAX_BLOB_OBJECTS,
    'object limit'
  );
  const maxBytes = positiveLimit(
    options.maxBlobBytes,
    DEFAULT_MAX_BLOB_BYTES,
    'byte limit'
  );
  const output = path.resolve(options.outputPath);
  if (fs.existsSync(output)) throw new Error('Backup output already exists.');
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(parent, '.libre-team-backup-'));
  const payload = path.join(scratch, 'payload');
  fs.mkdirSync(path.join(payload, 'team'), { recursive: true, mode: 0o700 });
  const dumpPath = path.join(payload, 'team', 'postgres.dump');
  // A pg_dump wrapper may execute in a rootful container with this scratch
  // directory bind-mounted from the host. Create the output inode as the
  // Libre process first so pg_dump only truncates it and cannot leave behind
  // a root-owned file that the host process is unable to secure or remove.
  fs.writeFileSync(dumpPath, '', { flag: 'wx', mode: 0o600 });
  const database = createPostgresDatabase(postgresConfig);
  const s3Client = new S3Client(s3Config.clientConfig);
  const keyring = createStorageKeyringFromEnvironment(env);
  try {
    await assertBucketVersioning(s3Client, s3Config.bucket);
    let databaseInventory:
      Awaited<ReturnType<typeof validateDatabaseSnapshot>> | undefined;
    await database.withClient(async client => {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        databaseInventory = await validateDatabaseSnapshot(client, keyring);
        const snapshot = await client.query<{ snapshot: string }>(
          'SELECT pg_export_snapshot() AS snapshot'
        );
        const snapshotId = snapshot.rows[0]?.snapshot;
        if (!snapshotId || !/^[A-Za-z0-9:-]+$/.test(snapshotId)) {
          throw new Error('PostgreSQL did not export a safe backup snapshot.');
        }
        await runPostgresTool(
          options.pgDumpCommand ?? env.POSTGRES_DUMP_COMMAND ?? 'pg_dump',
          [
            '--format=custom',
            '--no-owner',
            '--no-privileges',
            `--snapshot=${snapshotId}`,
            `--file=${dumpPath}`,
          ],
          postgresConfig,
          env,
          timeoutMs
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
    if (!databaseInventory) {
      throw new Error('PostgreSQL backup snapshot produced no inventory.');
    }
    fs.chmodSync(dumpPath, 0o600);

    // Authenticate every source object and every PGVector record before
    // sealing the exported snapshot. These checks are intentionally bounded.
    const blobStore = createS3EncryptedBlobStore({
      database,
      keyring,
      env: env as S3BlobEnvironment,
    });
    const blobIntegrity = await blobStore.verifyIntegrity({
      maxObjects,
      maxEncryptedBytes: maxBytes,
      maxPlaintextBytes: maxBytes,
    });
    if (blobIntegrity.objects !== databaseInventory.blobs.length) {
      throw new Error(
        'S3 integrity count changed outside the database snapshot.'
      );
    }
    const vectors = await new PgVectorStore({ database }).verifyIntegrity();
    const copied = await copyVersionedS3Objects(
      s3Client,
      s3Config.bucket,
      s3Config.keyPrefix,
      databaseInventory.blobs,
      payload,
      maxObjects,
      maxBytes
    );
    const dump = hashFile(dumpPath);
    const inventory: TeamBackupInventory = {
      format: TEAM_INVENTORY_FORMAT,
      version: TEAM_INVENTORY_VERSION,
      schemaVersion: databaseInventory.schemaVersion,
      schemaFingerprint: databaseInventory.schemaFingerprint,
      databaseDumpSha256: dump.sha256,
      storageKeyFingerprint: keySetFingerprint,
      s3: {
        bucket: s3Config.bucket,
        keyPrefix: s3Config.keyPrefix,
        versioning: 'Enabled',
        objects: copied.objects,
        totalEncryptedBytes: copied.totalEncryptedBytes,
        totalPlaintextBytes: blobIntegrity.plaintextBytes,
      },
      vectors,
      durable: databaseInventory.durable,
    };
    writeTeamInventory(payload, inventory);
    stageProtectedRuntimeConfiguration(payload, env);
    const pkg = loadAppPackage(import.meta.url);
    const manifest: BackupArchiveManifestInput = {
      format: 'libre-webui-integrated-backup',
      version: 1,
      backupId: crypto.randomUUID(),
      createdAt: (options.now ?? new Date()).toISOString(),
      application: {
        name: 'libre-webui',
        version: pkg.version || 'unknown',
        nodeVersion: process.version,
      },
      source: {
        platformMode: 'team',
        databaseBackend: 'postgres',
        blobBackend: 's3',
        vectorBackend: 'pgvector',
        coordinationBackend: env.COORDINATION_BACKEND || 'redis',
        jobWorkerMode: env.JOB_WORKER_MODE || 'external',
      },
      inventory: {
        format: 'libre-webui-recovery-inventory',
        version: 1,
        schemaFingerprint: inventory.schemaFingerprint,
        encryptionKeyFingerprint: inventory.storageKeyFingerprint,
        schemaVersion: inventory.schemaVersion,
        databaseDumpSha256: inventory.databaseDumpSha256,
        s3InventorySha256: sha256(canonicalJson(inventory.s3)),
        blobObjects: inventory.s3.objects.length,
        vectorRecords: inventory.vectors.records,
      },
      exclusions: [
        'Redis cache, presence, leases, and wake-up notifications are reconstructed from canonical SQL state.',
        'External Work workspace volumes require their own coordinated storage snapshot.',
      ],
    };
    const verification = sealBackupPayload({
      payloadDirectory: payload,
      outputPath: output,
      encryptionKeyPath: options.encryptionKeyPath,
      signingPrivateKeyPath: options.signingPrivateKeyPath,
      manifest,
    });
    return { verification, inventory };
  } finally {
    s3Client.destroy();
    await database.close().catch(() => undefined);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

const assertCleanTargetDatabase = async (
  database: PostgresDatabase
): Promise<void> => {
  const schemas = await database.query<
    { schema_name: string } & QueryResultRow
  >(`SELECT nspname AS schema_name FROM pg_namespace ORDER BY nspname`);
  if (
    schemas.rows.some(
      row =>
        !POSTGRES_BOOTSTRAP_SCHEMAS.has(row.schema_name) &&
        !POSTGRES_TEMPORARY_SCHEMA_PATTERN.test(row.schema_name)
    )
  ) {
    throw new Error(
      'Team restore requires a clean PostgreSQL database with only bootstrap schemas.'
    );
  }

  const extensions = await database.query<
    { extension_name: string; schema_name: string } & QueryResultRow
  >(
    `SELECT extension.extname AS extension_name,
            namespace.nspname AS schema_name
       FROM pg_extension extension
       JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
      ORDER BY extension.extname`
  );
  if (
    extensions.rows.some(
      row =>
        POSTGRES_BOOTSTRAP_EXTENSIONS.get(row.extension_name) !==
        row.schema_name
    )
  ) {
    throw new Error(
      'Team restore requires a clean PostgreSQL database with only bootstrap extensions.'
    );
  }

  const relations = await database.query<
    {
      relation_oid: string;
      schema_name: string;
      extension_name: string | null;
    } & QueryResultRow
  >(
    `SELECT relation.oid::text AS relation_oid,
            namespace.nspname AS schema_name,
            extension.extname AS extension_name
       FROM pg_class relation
       JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       LEFT JOIN pg_depend extension_dependency
         ON extension_dependency.classid = 'pg_class'::regclass
        AND extension_dependency.objid = relation.oid
        AND extension_dependency.deptype = 'e'
       LEFT JOIN pg_extension extension
         ON extension.oid = extension_dependency.refobjid`
  );
  if (
    relations.rows.some(row => {
      if (POSTGRES_TEMPORARY_SCHEMA_PATTERN.test(row.schema_name)) return false;
      const extensionSchema = row.extension_name
        ? POSTGRES_BOOTSTRAP_EXTENSIONS.get(row.extension_name)
        : undefined;
      if (extensionSchema === row.schema_name) return false;
      return (
        !POSTGRES_BOOTSTRAP_SCHEMAS.has(row.schema_name) ||
        Number(row.relation_oid) >= 16_384
      );
    })
  ) {
    throw new Error('Team restore requires a clean PostgreSQL database.');
  }
};

const assertCleanTargetPrefix = async (
  client: S3Client,
  bucket: string,
  prefix: string
): Promise<void> => {
  await assertBucketVersioning(client, bucket);
  const page = await client.send(
    new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: `${prefix}/`,
      MaxKeys: 1,
    })
  );
  if (
    (page.Versions?.length ?? 0) > 0 ||
    (page.DeleteMarkers?.length ?? 0) > 0
  ) {
    throw new Error('Team restore requires an empty versioned S3 prefix.');
  }
};

const rollbackTargetDatabase = async (
  database: PostgresDatabase
): Promise<void> => {
  await database.transaction(async client => {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public AUTHORIZATION CURRENT_USER');
  });
};

const restoreS3Objects = async (
  client: S3Client,
  bucket: string,
  payload: string,
  inventory: TeamBackupInventory,
  uploaded: Array<{ key: string; versionId: string }>
): Promise<void> => {
  for (const entry of inventory.s3.objects) {
    const target = path.join(payload, ...entry.payloadPath.split('/'));
    const result = await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: entry.objectKey,
        Body: fs.createReadStream(target),
        ContentLength: entry.encryptedBytes,
        ContentType: entry.contentType,
        Metadata: { ...entry.metadata },
        ChecksumSHA256: Buffer.from(entry.ciphertextSha256, 'hex').toString(
          'base64'
        ),
      })
    );
    if (!result.VersionId) {
      throw new Error(
        'Restored S3 object has no immutable version identifier.'
      );
    }
    // Record the exact immutable version before any later verification can
    // fail. The caller owns this journal, so a rejection in the middle of the
    // loop still leaves every completed PUT available for rollback.
    uploaded.push({ key: entry.objectKey, versionId: result.VersionId });
    const head = await client.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: entry.objectKey,
        VersionId: result.VersionId,
      })
    );
    if (
      head.ContentLength !== entry.encryptedBytes ||
      head.Metadata?.['libre-format'] !== '1'
    ) {
      throw new Error('Restored S3 object failed metadata verification.');
    }
  }
};

const removeUploadedVersions = async (
  client: S3Client,
  bucket: string,
  uploaded: readonly { key: string; versionId: string }[]
): Promise<RollbackFailureReport> => {
  const failures: Error[] = [];
  let failureCount = 0;
  for (let offset = 1; offset <= uploaded.length; offset += 1) {
    const item = uploaded[uploaded.length - offset];
    if (!item) continue;
    try {
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: item.key,
          VersionId: item.versionId,
        })
      );
    } catch (error) {
      failureCount += 1;
      if (failures.length < MAX_ROLLBACK_FAILURE_DETAILS) {
        failures.push(
          contextualRollbackError(
            `S3 rollback failed for key ${JSON.stringify(item.key)} version ${JSON.stringify(item.versionId)}`,
            error
          )
        );
      }
    }
  }
  if (failureCount > failures.length) {
    failures.push(
      new Error(
        `S3 rollback had ${failureCount - failures.length} additional cleanup failure${failureCount - failures.length === 1 ? '' : 's'}.`
      )
    );
  }
  return { failures, failureCount };
};

const restoredEnvironment = (
  payload: string,
  target: NodeJS.ProcessEnv
): NodeJS.ProcessEnv => {
  const runtime = parseJsonObject(
    path.join(payload, 'configuration', 'runtime.json')
  );
  const secrets = parseJsonObject(
    path.join(payload, 'configuration', 'secrets.json')
  );
  return {
    ...runtime,
    ...secrets,
    ...target,
    LIBRE_PLATFORM_MODE: 'team',
    DATABASE_BACKEND: 'postgres',
    BLOB_STORE_BACKEND: 's3',
    VECTOR_STORE_BACKEND: 'pgvector',
  };
};

const syncPhysicalFile = (target: string): void => {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const syncPhysicalDirectory = (target: string): void => {
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY || 0) |
      (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
};

const publishRestoredConfiguration = (
  targetDirectory: string,
  env: NodeJS.ProcessEnv
): string => {
  const requested = path.resolve(targetDirectory);
  const requestedParent = path.dirname(requested);
  if (!fs.existsSync(requestedParent)) {
    throw new Error(
      'Restored configuration parent must already exist as a physical directory.'
    );
  }
  const parent = fs.realpathSync(requestedParent);
  const target = path.join(parent, path.basename(requested));
  if (fs.existsSync(target)) {
    throw new Error('Restored configuration target must not already exist.');
  }
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(
      'Restored configuration parent must be a physical directory.'
    );
  }
  const staging = fs.mkdtempSync(path.join(parent, '.libre-team-config-'));
  try {
    stageProtectedRuntimeConfiguration(staging, env);
    const configuration = path.join(staging, 'configuration');
    for (const name of ['runtime.json', 'secrets.json']) {
      syncPhysicalFile(path.join(configuration, name));
    }
    syncPhysicalDirectory(configuration);
    fs.renameSync(configuration, target);
    syncPhysicalDirectory(staging);
    syncPhysicalDirectory(parent);
    return target;
  } catch (error) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      try {
        syncPhysicalDirectory(parent);
      } catch {
        // Preserve the original publication error; the caller still rolls
        // back PostgreSQL and exact S3 versions.
      }
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
};

export const restoreTeamBackupArchive = async (
  options: RestoreTeamBackupOptions
): Promise<TeamRestoreResult> => {
  validateTeamSelection(options.targetEnv);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'libre-team-restore-'));
  const payload = path.join(scratch, 'payload');
  const extracted = extractBackupPayload({
    archivePath: options.archivePath,
    signingPublicKeyPath: options.signingPublicKeyPath,
    encryptionKeyPath: options.encryptionKeyPath,
    destinationDirectory: payload,
  });
  const inventory = parseTeamInventory(payload, extracted.header);
  const env = restoredEnvironment(payload, options.targetEnv);
  if (keyFingerprint(env) !== inventory.storageKeyFingerprint) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      'Restored storage key set does not match the signed inventory.'
    );
  }
  if (options.apply && !options.configurationOutputDirectory?.trim()) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      'Team restore apply requires a new protected configuration output directory.'
    );
  }
  const postgresConfig = resolvePostgresRuntimeConfig(options.targetEnv);
  const s3Config = resolveS3BlobConfiguration(
    options.targetEnv as S3BlobEnvironment
  );
  if (s3Config.keyPrefix !== inventory.s3.keyPrefix) {
    fs.rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      'Target S3 prefix must match the protected backup inventory.'
    );
  }
  const database = createPostgresDatabase(postgresConfig);
  const client = new S3Client(s3Config.clientConfig);
  const uploaded: Array<{ key: string; versionId: string }> = [];
  let databaseRollbackArmed = false;
  try {
    await assertCleanTargetDatabase(database);
    await assertCleanTargetPrefix(client, s3Config.bucket, s3Config.keyPrefix);
    if (!options.apply) {
      return {
        applied: false,
        verification: extracted.verification,
        inventory,
      };
    }
    // A recovery tool can commit its single transaction and then terminate or
    // report a non-zero status before this process observes success. From this
    // point onward the PostgreSQL outcome is therefore unknown on every
    // failure, even when runPostgresTool rejects. Resetting an already-clean
    // public schema is safe; skipping cleanup after an unobserved commit is not.
    databaseRollbackArmed = true;
    await restoreS3Objects(
      client,
      s3Config.bucket,
      payload,
      inventory,
      uploaded
    );
    await runPostgresTool(
      options.pgRestoreCommand ??
        options.targetEnv.POSTGRES_RESTORE_COMMAND ??
        'pg_restore',
      [
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-privileges',
        `--dbname=${postgresDatabaseName(postgresConfig)}`,
        path.join(payload, 'team', 'postgres.dump'),
      ],
      postgresConfig,
      options.targetEnv,
      validateToolTimeout(options.toolTimeoutMs)
    );
    const keyring = createStorageKeyringFromEnvironment(env);
    const restored = await validateDatabaseSnapshot(database, keyring);
    if (
      restored.schemaVersion !== inventory.schemaVersion ||
      restored.schemaFingerprint !== inventory.schemaFingerprint ||
      restored.blobs.length !== inventory.s3.objects.length ||
      !sameDurableIntegrity(restored.durable, inventory.durable)
    ) {
      throw new Error(
        'Restored PostgreSQL state does not match the signed inventory.'
      );
    }
    const store = createS3EncryptedBlobStore({
      database,
      keyring,
      env: options.targetEnv as S3BlobEnvironment,
    });
    const blobResult = await store.verifyIntegrity({
      maxObjects: Math.max(1, inventory.s3.objects.length),
      maxEncryptedBytes: Math.max(1, inventory.s3.totalEncryptedBytes),
      maxPlaintextBytes: Math.max(1, inventory.s3.totalPlaintextBytes),
    });
    const vectorResult = await new PgVectorStore({ database }).verifyIntegrity({
      maxRecords: Math.max(1, inventory.vectors.records),
      maxComponents: Math.max(1, inventory.vectors.components),
    });
    if (
      blobResult.objects !== inventory.s3.objects.length ||
      blobResult.encryptedBytes !== inventory.s3.totalEncryptedBytes ||
      blobResult.plaintextBytes !== inventory.s3.totalPlaintextBytes ||
      vectorResult.records !== inventory.vectors.records ||
      vectorResult.components !== inventory.vectors.components
    ) {
      throw new Error(
        'Restored storage integrity totals do not match the backup.'
      );
    }
    const configurationOutputDirectory = publishRestoredConfiguration(
      options.configurationOutputDirectory!,
      env
    );
    return {
      applied: true,
      verification: extracted.verification,
      inventory,
      configurationOutputDirectory,
    };
  } catch (error) {
    const originalFailure = normalizeError(error);
    const rollback = await removeUploadedVersions(
      client,
      s3Config.bucket,
      uploaded
    );
    if (databaseRollbackArmed) {
      try {
        await rollbackTargetDatabase(database);
      } catch (rollbackError) {
        rollback.failureCount += 1;
        rollback.failures.push(
          contextualRollbackError(
            'PostgreSQL restore rollback failed',
            rollbackError
          )
        );
      }
    }
    if (rollback.failureCount > 0) {
      throw new TeamRestoreRollbackError(
        originalFailure,
        rollback.failures,
        rollback.failureCount
      );
    }
    throw error;
  } finally {
    client.destroy();
    await database.close().catch(() => undefined);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};
