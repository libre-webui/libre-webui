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

import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify, TextDecoder } from 'node:util';

import Database from 'better-sqlite3';

import { inspectSQLiteSchema } from '../persistence/sqliteMigrations.js';
import {
  BlobStoreError,
  LocalEncryptedBlobStore,
  SqliteEncryptedVectorStore,
  VectorStoreError,
  createStorageKeyringFromEnvironment,
  inspectStorageKeyConfiguration,
  parseAesGcmEnvelope,
  type Aes256GcmKeyring,
  type BlobIntegrityVerificationOptions,
  type StorageKeyConfigurationInspection,
  type VectorIntegrityVerificationOptions,
} from '../platform/storage/index.js';
import { loadAppPackage } from '../utils/packagePaths.js';
import {
  BACKEND_DIRECTORY,
  PROJECT_DIRECTORY,
  assertNoLegacyDataDirectoryConflict,
  resolveDataDirectory,
  resolveLegacyPluginsDirectories,
  resolvePluginsDirectory,
} from '../utils/dataDirectory.js';
import {
  LegacyCiphertextIntegrityError,
  verifyLegacyCiphertextIntegrity,
  type LegacyCiphertextIntegrityLimits,
} from './legacyCiphertextIntegrity.js';

const execFileAsync = promisify(execFile);
const MAX_DIRECTORY_SCAN_ENTRIES = 1_000_000;
const MAX_DIRECTORY_SCAN_BYTES = 1024 * 1024 * 1024 * 1024;
const DURABLE_JOB_STATES = [
  'queued',
  'running',
  'succeeded',
  'cancelled',
  'dead_letter',
] as const;
const DURABLE_ATTEMPT_OUTCOMES = [
  'running',
  'succeeded',
  'retry_scheduled',
  'cancelled',
  'dead_letter',
  'abandoned',
] as const;
const MAX_DURABLE_IDENTIFIER_BYTES = 256;
const MAX_DURABLE_REFERENCE_BYTES = 2048;
const MAX_DURABLE_PLAINTEXT_BYTES = 64 * 1024;
const MAX_DURABLE_ENVELOPE_BYTES = 128 * 1024;
const MAX_DURABLE_JSON_DEPTH = 32;
const MAX_DURABLE_JSON_NODES = 10_000;
const DEFAULT_MAX_DURABLE_PAYLOAD_RECORDS = 250_000;
const DEFAULT_MAX_DURABLE_CIPHERTEXT_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES = 16 * 1024 * 1024 * 1024;

type DurableJobStateInventory = (typeof DURABLE_JOB_STATES)[number];
type DurableAttemptOutcomeInventory = (typeof DURABLE_ATTEMPT_OUTCOMES)[number];

export interface DurablePayloadIntegrityLimits {
  /** Maximum combined platform_jobs and platform_events rows. */
  maxRecords?: number;
  /** Maximum aggregate bytes of serialized encrypted envelopes. */
  maxCiphertextBytes?: number;
  /** Maximum aggregate authenticated plaintext bytes. */
  maxPlaintextBytes?: number;
}

export type WorkRuntimeBackend = 'docker' | 'kubernetes';

export interface WorkResourceInspection {
  available: boolean;
  matches: Record<string, boolean>;
  message?: string;
}

export type WorkResourceInspector = (input: {
  backend: WorkRuntimeBackend;
  resources: Array<{ taskId: string; name: string }>;
  env: NodeJS.ProcessEnv;
}) => Promise<WorkResourceInspection>;

export interface RecoveryInventoryOptions {
  dataDir?: string;
  databasePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  inspectWorkResources?: WorkResourceInspector;
  blobIntegrityLimits?: BlobIntegrityVerificationOptions;
  vectorIntegrityLimits?: VectorIntegrityVerificationOptions;
  durablePayloadIntegrityLimits?: DurablePayloadIntegrityLimits;
  legacyCiphertextIntegrityLimits?: LegacyCiphertextIntegrityLimits;
  /** Deterministic path override for isolated operational tests. */
  pluginPathLocations?: {
    backendDirectory?: string;
    projectDirectory?: string;
    bundledDirectory?: string;
    historicalWorkingDirectory?: string;
  };
  /** Explicit recovery layout override; defaults to runtime legacy paths. */
  legacyPluginsDirectories?: string[];
}

export interface EncryptionKeyInventory {
  status: 'available' | 'missing' | 'invalid' | 'conflict';
  source: 'environment' | 'data-file' | 'missing';
  fingerprint?: string;
  persistentFilePresent: boolean;
  persistentFileMatchesSelected?: boolean;
}

export interface RecoveryInventory {
  format: 'libre-webui-recovery-inventory';
  version: 1;
  generatedAt: string;
  readOnly: true;
  restoreReady: boolean;
  application: {
    name: 'libre-webui';
    version: string;
    nodeVersion: string;
    platform: string;
  };
  database: {
    backend: 'sqlite';
    path: string;
    present: boolean;
    bytes: number;
    companionFiles: Array<{
      kind: 'wal' | 'shm';
      present: boolean;
      bytes: number;
    }>;
    open: boolean;
    quickCheck: 'ok' | 'failed' | 'not-run';
    foreignKeyViolations: number | null;
    schema: {
      userVersion: number | null;
      fingerprint?: string;
      actualTableCount: number;
      ledgerPresent: boolean;
      currentVersion: number;
      targetVersion: number;
      minimumSupportedVersion: number;
      appliedMigrations: Array<{
        version: number;
        name: string;
        checksumMatches: boolean;
      }>;
      missing: string[];
    };
  };
  encryption: EncryptionKeyInventory & {
    legacyCiphertext: {
      verified: boolean;
      encryptedAuthenticated: boolean;
      records: number;
      textRecords: number;
      binaryRecords: number;
      ciphertextBytes: number;
      plaintextBytes: number;
    };
  };
  configuration: {
    storageEncryption: StorageKeyConfigurationInspection;
    secretPresence: {
      encryptionKeyEnvironment: boolean;
      jwtSecret: boolean;
      sessionSecret: boolean;
    };
  };
  storage: {
    dataDirectory: {
      path: string;
      present: boolean;
      readable: boolean;
      writable: boolean;
      files: number;
      bytes: number;
      scanErrors: number;
    };
    customPlugins: {
      path: string;
      present: boolean;
      includedInDataDirectory: boolean;
      definitions: number;
      bytes: number;
      sources: Array<{
        kind: 'configured' | 'legacy';
        path: string;
        present: boolean;
        includedInDataDirectory: boolean;
        definitions: number;
        bytes: number;
        invalidEntries: number;
      }>;
    };
    localBlobStore: {
      path: string;
      present: boolean;
      files: number;
      bytes: number;
      scanErrors: number;
    };
    embeddedBlobs: {
      generatedMedia: { records: number; bytes: number };
      voiceReferences: { records: number; bytes: number };
      documentText: { records: number; bytes: number };
    };
    embeddedVectors: {
      legacyDocumentChunks: { records: number; bytes: number };
      platform: {
        records: number;
        bytes: number;
        aclRecords: number;
        attributeRecords: number;
      };
    };
  };
  work: {
    runtimeBackend: WorkRuntimeBackend;
    tasks: number;
    tasksByStatus: Record<string, number>;
    activeRuns: number;
    activePreviews: number;
    resourcesVerified: boolean;
    workspaces: Array<{
      taskId: string;
      kind: 'docker-volume' | 'kubernetes-pvc' | 'host-path';
      name?: string;
      pathFingerprint?: string;
      present: boolean | null;
      includedInDataDirectory: false;
    }>;
  };
  jobs: {
    implementation: 'legacy-media-generation';
    total: number;
    active: number;
    byStatus: Record<string, number>;
    durableWorkerAvailable: false;
    durable: {
      substrateAvailable: boolean;
      handlerWorkerBootstrapped: false;
      externalWorkerAvailable: false;
      total: number;
      running: number;
      byState: Record<DurableJobStateInventory, number>;
      attempts: {
        total: number;
        active: number;
        byOutcome: Record<DurableAttemptOutcomeInventory, number>;
      };
      events: {
        streams: number;
        total: number;
        lastCursor: number;
      };
      payloadIntegrity: {
        verified: boolean;
        encryptedAuthenticated: boolean;
        referenceTargetsVerified: false;
        records: number;
        encryptedRecords: number;
        referenceRecords: number;
        ciphertextBytes: number;
        referenceBytes: number;
        plaintextBytes: number;
      };
    };
  };
  blockers: string[];
  warnings: string[];
  exclusions: string[];
}

interface DirectorySize {
  files: number;
  bytes: number;
  errors: number;
}

interface CountAndBytes {
  records: number;
  bytes: number;
}

interface WorkTaskRow {
  id: string;
  status: string;
  volume_name: string;
  host_path: string | null;
}

interface DurableJobPayloadRow {
  id: string;
  job_type: string;
  actor_user_id: string;
  payload_format: 'encrypted' | 'reference';
  payload: string;
}

interface DurableEventPayloadRow {
  event_id: string;
  stream_id: string;
  event_type: string;
  subject_id: string;
  actor_user_id: string | null;
  payload_format: 'encrypted' | 'reference';
  payload: string;
}

interface DurablePayloadIntegrityResult {
  verified: boolean;
  records: number;
  encryptedRecords: number;
  referenceRecords: number;
  ciphertextBytes: number;
  referenceBytes: number;
  plaintextBytes: number;
}

class DurablePayloadIntegrityError extends Error {
  constructor(readonly code: 'verification-limit' | 'integrity') {
    super('Durable payload recovery verification failed');
    this.name = 'DurablePayloadIntegrityError';
  }
}

const unique = (values: string[]): string[] => [...new Set(values)];

const safeStat = (target: string): fs.Stats | null => {
  try {
    return fs.statSync(target);
  } catch {
    return null;
  }
};

const safeLstat = (target: string): fs.Stats | null => {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
};

type SQLiteSourceKind = 'database' | 'WAL' | 'SHM';

interface SQLiteSourceInspection {
  kind: SQLiteSourceKind;
  path: string;
  status:
    | 'regular'
    | 'missing'
    | 'unreadable'
    | 'symbolic-link'
    | 'non-regular'
    | 'hard-linked';
  stat: fs.Stats | null;
}

const inspectSQLiteSource = (
  kind: SQLiteSourceKind,
  sourcePath: string,
  rejectHardLinks: boolean
): SQLiteSourceInspection => {
  let stat: fs.Stats;
  try {
    // lstat is deliberate: stat would silently accept a database or
    // companion symlink and could copy a file outside the recovery source.
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    return {
      kind,
      path: sourcePath,
      status:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'missing'
          : 'unreadable',
      stat: null,
    };
  }
  if (stat.isSymbolicLink()) {
    return { kind, path: sourcePath, status: 'symbolic-link', stat };
  }
  if (!stat.isFile()) {
    return { kind, path: sourcePath, status: 'non-regular', stat };
  }
  if (rejectHardLinks && stat.nlink !== 1) {
    return { kind, path: sourcePath, status: 'hard-linked', stat };
  }
  return { kind, path: sourcePath, status: 'regular', stat };
};

const sqliteSourceBlocker = (
  source: SQLiteSourceInspection
): string | undefined => {
  const label =
    source.kind === 'database' ? 'database' : `${source.kind} companion file`;
  switch (source.status) {
    case 'unreadable':
      return `The SQLite ${label} path could not be inspected without following links.`;
    case 'symbolic-link':
      return `The SQLite ${label} path is a symbolic link; recovery refuses to follow it.`;
    case 'non-regular':
      return `The SQLite ${label} path is not a regular file.`;
    case 'hard-linked':
      return `The SQLite ${label} has multiple hard links; a volume-only snapshot cannot prove that it owns the source file.`;
    default:
      return undefined;
  }
};

const copyInspectedSQLiteSource = (
  source: SQLiteSourceInspection,
  destination: string,
  rejectHardLinks: boolean
): void => {
  if (source.status !== 'regular' || !source.stat) {
    throw new Error('SQLite recovery source was not validated');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const sourceDescriptor = fs.openSync(
    source.path,
    fs.constants.O_RDONLY | noFollow
  );
  let destinationDescriptor: number | undefined;
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    const openedStat = fs.fstatSync(sourceDescriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== source.stat.dev ||
      openedStat.ino !== source.stat.ino ||
      (rejectHardLinks && openedStat.nlink !== 1)
    ) {
      throw new Error('SQLite recovery source changed during inspection');
    }
    destinationDescriptor = fs.openSync(
      destination,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    let bytesRead: number;
    while (
      (bytesRead = fs.readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.length,
        null
      )) > 0
    ) {
      let offset = 0;
      while (offset < bytesRead) {
        offset += fs.writeSync(
          destinationDescriptor,
          buffer,
          offset,
          bytesRead - offset
        );
      }
    }
    fs.fsyncSync(destinationDescriptor);
  } finally {
    buffer.fill(0);
    if (destinationDescriptor !== undefined) {
      fs.closeSync(destinationDescriptor);
    }
    fs.closeSync(sourceDescriptor);
  }
};

const physicalOrResolvedPath = (target: string): string => {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return path.resolve(target);
  }
};

const isPathWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(
    physicalOrResolvedPath(root),
    physicalOrResolvedPath(candidate)
  );
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

const containsSymlinkPathComponent = (target: string): boolean => {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const component of resolved.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const stat = safeLstat(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
};

const containsSymlinkPathComponentFromRoot = (
  root: string,
  target: string
): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return containsSymlinkPathComponent(resolvedTarget);
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const stat = safeLstat(current);
    if (!stat) return false;
    if (stat.isSymbolicLink()) return true;
  }
  return false;
};

const canAccess = (target: string, mode: number): boolean => {
  try {
    fs.accessSync(target, mode);
    return true;
  } catch {
    return false;
  }
};

const scanDirectory = (root: string): DirectorySize => {
  const totals: DirectorySize = { files: 0, bytes: 0, errors: 0 };
  const pending = [root];
  let entriesSeen = 0;
  let limitExceeded = false;
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    let directory: fs.Dir | undefined;
    try {
      directory = fs.opendirSync(current);
    } catch {
      totals.errors += 1;
      continue;
    }
    try {
      let entry: fs.Dirent | null;
      while ((entry = directory.readSync()) !== null) {
        entriesSeen += 1;
        if (entriesSeen > MAX_DIRECTORY_SCAN_ENTRIES) {
          totals.errors += 1;
          limitExceeded = true;
          break;
        }
        const entryPath = path.join(current, entry.name);
        try {
          // Resolve the named entry without following symlinks so a concurrent
          // replacement cannot redirect recovery inventory outside its root.
          const entryStat = fs.lstatSync(entryPath);
          if (entryStat.isDirectory() && !entryStat.isSymbolicLink()) {
            pending.push(entryPath);
          } else if (entryStat.isFile() && !entryStat.isSymbolicLink()) {
            totals.files += 1;
            totals.bytes += entryStat.size;
            if (
              !Number.isSafeInteger(totals.bytes) ||
              totals.bytes > MAX_DIRECTORY_SCAN_BYTES
            ) {
              totals.errors += 1;
              limitExceeded = true;
              break;
            }
          }
        } catch {
          totals.errors += 1;
        }
      }
    } catch {
      totals.errors += 1;
    } finally {
      try {
        directory.closeSync();
      } catch {
        totals.errors += 1;
      }
    }
    if (limitExceeded) break;
  }
  return totals;
};

interface PluginDirectoryInspection {
  path: string;
  present: boolean;
  definitions: number;
  bytes: number;
  invalidEntries: number;
  unsafePath: boolean;
}

const inspectPluginDirectory = (
  directoryPath: string,
  trustedRoot: string
): PluginDirectoryInspection => {
  const result: PluginDirectoryInspection = {
    path: directoryPath,
    present: false,
    definitions: 0,
    bytes: 0,
    invalidEntries: 0,
    unsafePath: false,
  };
  if (containsSymlinkPathComponentFromRoot(trustedRoot, directoryPath)) {
    result.present = true;
    result.invalidEntries = 1;
    result.unsafePath = true;
    return result;
  }
  const directoryStat = safeLstat(directoryPath);
  if (!directoryStat) return result;
  result.present = true;
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    result.invalidEntries = 1;
    return result;
  }
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const entryPath = path.join(directoryPath, entry.name);
      const entryStat = safeLstat(entryPath);
      if (!entryStat || !entryStat.isFile() || entryStat.isSymbolicLink()) {
        result.invalidEntries += 1;
        continue;
      }
      result.definitions += 1;
      result.bytes += entryStat.size;
    }
  } catch {
    result.invalidEntries += 1;
  }
  return result;
};

const keyFingerprint = (hexKey: string): string =>
  crypto
    .createHash('sha256')
    .update(Buffer.from(hexKey, 'hex'))
    .digest('hex')
    .slice(0, 16);

const validEncryptionKey = (value: string | undefined): value is string =>
  Boolean(value && /^[a-fA-F0-9]{64}$/.test(value.trim()));

/** Read only key identity metadata. The selected key is never returned. */
export const inspectEncryptionKey = (
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env
): EncryptionKeyInventory => {
  const environmentKey = env.ENCRYPTION_KEY?.trim();
  const persistentPath = path.join(dataDir, '.encryption_key');
  const persistentStat = safeLstat(persistentPath);
  const persistentFilePresent = Boolean(persistentStat);
  let persistentKey: string | undefined;
  const persistentFileSafe = Boolean(
    persistentStat?.isFile() &&
    !persistentStat.isSymbolicLink() &&
    persistentStat.nlink === 1
  );
  if (persistentFilePresent && !persistentFileSafe) {
    return {
      status: 'invalid',
      source: 'data-file',
      persistentFilePresent: true,
    };
  }
  if (persistentStat && persistentFileSafe) {
    let descriptor: number | undefined;
    let keyBytes: Buffer | undefined;
    try {
      descriptor = fs.openSync(
        persistentPath,
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
      );
      const openedStat = fs.fstatSync(descriptor);
      if (
        !openedStat.isFile() ||
        openedStat.nlink !== 1 ||
        openedStat.dev !== persistentStat.dev ||
        openedStat.ino !== persistentStat.ino
      ) {
        return {
          status: 'invalid',
          source: 'data-file',
          persistentFilePresent: true,
        };
      }
      keyBytes = fs.readFileSync(descriptor);
      persistentKey = keyBytes.toString('utf8').trim();
    } catch {
      return {
        status: 'invalid',
        source: 'data-file',
        persistentFilePresent: true,
      };
    } finally {
      keyBytes?.fill(0);
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  if (environmentKey) {
    if (!validEncryptionKey(environmentKey)) {
      return {
        status: 'invalid',
        source: 'environment',
        persistentFilePresent,
      };
    }
    const matches = persistentFilePresent
      ? Boolean(
          persistentKey &&
          validEncryptionKey(persistentKey) &&
          crypto.timingSafeEqual(
            Buffer.from(persistentKey, 'hex'),
            Buffer.from(environmentKey, 'hex')
          )
        )
      : undefined;
    return {
      status: matches === false ? 'conflict' : 'available',
      source: 'environment',
      fingerprint: keyFingerprint(environmentKey),
      persistentFilePresent,
      ...(matches === undefined
        ? {}
        : { persistentFileMatchesSelected: matches }),
    };
  }

  if (persistentFilePresent && !persistentKey) {
    return {
      status: 'invalid',
      source: 'data-file',
      persistentFilePresent: true,
    };
  }

  if (persistentKey) {
    if (!validEncryptionKey(persistentKey)) {
      return {
        status: 'invalid',
        source: 'data-file',
        persistentFilePresent: true,
      };
    }
    return {
      status: 'available',
      source: 'data-file',
      fingerprint: keyFingerprint(persistentKey),
      persistentFilePresent: true,
      persistentFileMatchesSelected: true,
    };
  }

  return {
    status: 'missing',
    source: 'missing',
    persistentFilePresent: false,
  };
};

const defaultWorkResourceInspector: WorkResourceInspector = async input => {
  if (input.resources.length === 0) {
    return { available: true, matches: {} };
  }
  if (input.backend !== 'docker') {
    return {
      available: false,
      matches: {},
      message: 'Kubernetes PVC presence requires an in-cluster recovery check.',
    };
  }
  const command = input.env.WORK_DOCKER_COMMAND?.trim() || 'docker';
  try {
    const { stdout: volumeList } = await execFileAsync(
      command,
      [
        'volume',
        'ls',
        '--filter',
        'label=ai.libre-webui.managed=true',
        '--format',
        '{{.Name}}',
      ],
      { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
    );
    const managedNames = new Set(
      volumeList
        .split(/\r?\n/)
        .map(name => name.trim())
        .filter(Boolean)
    );
    const candidates = input.resources.filter(resource =>
      managedNames.has(resource.name)
    );
    const discovered = new Map<string, string>();
    if (candidates.length > 0) {
      const { stdout: volumeDetails } = await execFileAsync(
        command,
        [
          'volume',
          'inspect',
          '--format',
          '{{.Name}}\t{{index .Labels "ai.libre-webui.managed"}}\t{{index .Labels "ai.libre-webui.task"}}',
          ...candidates.map(resource => resource.name),
        ],
        { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }
      );
      for (const line of volumeDetails.split(/\r?\n/)) {
        const [name, managed, taskId, ...unexpected] = line.split('\t');
        if (
          unexpected.length === 0 &&
          name?.trim() &&
          managed?.trim() === 'true' &&
          taskId?.trim()
        ) {
          discovered.set(name.trim(), taskId.trim());
        }
      }
    }
    return {
      available: true,
      matches: Object.fromEntries(
        input.resources.map(resource => [
          resource.taskId,
          discovered.get(resource.name) === resource.taskId,
        ])
      ),
    };
  } catch {
    return {
      available: false,
      matches: {},
      message: 'The Docker volume inventory could not be read.',
    };
  }
};

const countAndBytes = (
  database: Database.Database,
  sql: string
): CountAndBytes => {
  const row = database.prepare(sql).get() as
    { records: number; bytes: number } | undefined;
  return {
    records: Number(row?.records || 0),
    bytes: Number(row?.bytes || 0),
  };
};

const groupedCounts = (
  database: Database.Database,
  table: string
): Record<string, number> => {
  const rows = database
    .prepare(`SELECT status, COUNT(*) AS count FROM ${table} GROUP BY status`)
    .all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
};

const emptyCountAndBytes = (): CountAndBytes => ({ records: 0, bytes: 0 });

const zeroCounts = <const Values extends readonly string[]>(
  values: Values
): Record<Values[number], number> =>
  Object.fromEntries(values.map(value => [value, 0])) as Record<
    Values[number],
    number
  >;

const groupedKnownCounts = <const Values extends readonly string[]>(
  database: Database.Database,
  table: string,
  column: string,
  values: Values
): Record<Values[number], number> => {
  const result = zeroCounts(values);
  const known = new Set<string>(values);
  const rows = database
    .prepare(
      `SELECT ${column} AS value, COUNT(*) AS count FROM ${table} GROUP BY ${column}`
    )
    .all() as Array<{ value: string; count: number }>;
  for (const row of rows) {
    if (!known.has(row.value)) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    result[row.value as Values[number]] = Number(row.count);
  }
  return result;
};

const requireRecoveryLimit = (
  value: number | undefined,
  fallback: number
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1) {
    throw new DurablePayloadIntegrityError('verification-limit');
  }
  return selected;
};

const validateDurableText = (
  value: unknown,
  maxBytes = MAX_DURABLE_IDENTIFIER_BYTES
): value is string => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return false;
  }
  return ![...value].some(character => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
};

/** Mirrors the immutable v3 durable-payload wire contract for recovery. */
const canonicalDurableJson = (value: unknown): string => {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (candidate: unknown, depth: number): string => {
    nodes += 1;
    if (nodes > MAX_DURABLE_JSON_NODES || depth > MAX_DURABLE_JSON_DEPTH) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    if (candidate === null) return 'null';
    if (typeof candidate === 'string') return JSON.stringify(candidate);
    if (typeof candidate === 'boolean') return candidate ? 'true' : 'false';
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new DurablePayloadIntegrityError('integrity');
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== 'object' || ancestors.has(candidate)) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${Array.from(candidate, item => visit(item, depth + 1)).join(',')}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new DurablePayloadIntegrityError('integrity');
      }
      const record = candidate as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map(key => `${JSON.stringify(key)}:${visit(record[key], depth + 1)}`)
        .join(',')}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  const serialized = visit(value, 0);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_DURABLE_PLAINTEXT_BYTES) {
    throw new DurablePayloadIntegrityError('integrity');
  }
  return serialized;
};

const verifyDurablePayloadIntegrity = (
  database: Database.Database,
  keyring: Aes256GcmKeyring | undefined,
  options: DurablePayloadIntegrityLimits = {}
): DurablePayloadIntegrityResult => {
  const maxRecords = requireRecoveryLimit(
    options.maxRecords,
    DEFAULT_MAX_DURABLE_PAYLOAD_RECORDS
  );
  const maxCiphertextBytes = requireRecoveryLimit(
    options.maxCiphertextBytes,
    DEFAULT_MAX_DURABLE_CIPHERTEXT_BYTES
  );
  const maxPlaintextBytes = requireRecoveryLimit(
    options.maxPlaintextBytes,
    DEFAULT_MAX_DURABLE_PLAINTEXT_AGGREGATE_BYTES
  );
  const aggregate = database
    .prepare(
      `WITH payloads AS (
         SELECT payload_format, LENGTH(CAST(payload AS BLOB)) AS bytes
           FROM platform_jobs
         UNION ALL
         SELECT payload_format, LENGTH(CAST(payload AS BLOB)) AS bytes
           FROM platform_events
       )
       SELECT COUNT(*) AS records,
              COALESCE(SUM(payload_format = 'encrypted'), 0) AS encrypted_records,
              COALESCE(SUM(payload_format = 'reference'), 0) AS reference_records,
              COALESCE(SUM(CASE WHEN payload_format = 'encrypted' THEN bytes ELSE 0 END), 0) AS ciphertext_bytes,
              COALESCE(SUM(CASE WHEN payload_format = 'reference' THEN bytes ELSE 0 END), 0) AS reference_bytes,
              COALESCE(MAX(CASE WHEN payload_format = 'encrypted' THEN bytes ELSE 0 END), 0) AS largest_envelope
         FROM payloads`
    )
    .get() as {
    records: number;
    encrypted_records: number;
    reference_records: number;
    ciphertext_bytes: number;
    reference_bytes: number;
    largest_envelope: number;
  };
  const records = Number(aggregate.records);
  const encryptedRecords = Number(aggregate.encrypted_records);
  const referenceRecords = Number(aggregate.reference_records);
  const ciphertextBytes = Number(aggregate.ciphertext_bytes);
  const referenceBytes = Number(aggregate.reference_bytes);
  const largestEnvelope = Number(aggregate.largest_envelope);
  const aggregateValues = [
    records,
    encryptedRecords,
    referenceRecords,
    ciphertextBytes,
    referenceBytes,
    largestEnvelope,
  ];
  if (
    aggregateValues.some(value => !Number.isSafeInteger(value) || value < 0) ||
    records !== encryptedRecords + referenceRecords
  ) {
    throw new DurablePayloadIntegrityError('integrity');
  }
  if (
    records > maxRecords ||
    ciphertextBytes > maxCiphertextBytes ||
    largestEnvelope > MAX_DURABLE_ENVELOPE_BYTES ||
    encryptedRecords >
      Math.floor(maxPlaintextBytes / MAX_DURABLE_PLAINTEXT_BYTES)
  ) {
    throw new DurablePayloadIntegrityError('verification-limit');
  }
  if (encryptedRecords > 0 && !keyring) {
    throw new DurablePayloadIntegrityError('integrity');
  }

  let plaintextBytes = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const verify = (
    payloadFormat: 'encrypted' | 'reference',
    payload: string,
    aad: Buffer
  ): void => {
    if (payloadFormat === 'reference') {
      if (!validateDurableText(payload, MAX_DURABLE_REFERENCE_BYTES)) {
        throw new DurablePayloadIntegrityError('integrity');
      }
      return;
    }
    if (payloadFormat !== 'encrypted' || !keyring) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    let plaintext: Buffer | undefined;
    try {
      plaintext = keyring.decrypt(
        parseAesGcmEnvelope(JSON.parse(payload) as unknown),
        aad
      );
      if (plaintext.byteLength > MAX_DURABLE_PLAINTEXT_BYTES) {
        throw new DurablePayloadIntegrityError('integrity');
      }
      plaintextBytes += plaintext.byteLength;
      if (
        !Number.isSafeInteger(plaintextBytes) ||
        plaintextBytes > maxPlaintextBytes
      ) {
        throw new DurablePayloadIntegrityError('verification-limit');
      }
      const decoded = decoder.decode(plaintext);
      const parsed = JSON.parse(decoded) as unknown;
      if (canonicalDurableJson(parsed) !== decoded) {
        throw new DurablePayloadIntegrityError('integrity');
      }
    } catch (error) {
      if (error instanceof DurablePayloadIntegrityError) throw error;
      throw new DurablePayloadIntegrityError('integrity');
    } finally {
      plaintext?.fill(0);
    }
  };

  const jobs = database
    .prepare(
      `SELECT id, job_type, actor_user_id, payload_format, payload
         FROM platform_jobs`
    )
    .iterate() as IterableIterator<DurableJobPayloadRow>;
  for (const row of jobs) {
    if (
      !validateDurableText(row.id) ||
      !validateDurableText(row.job_type) ||
      !validateDurableText(row.actor_user_id)
    ) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    verify(
      row.payload_format,
      row.payload,
      Buffer.from(
        `durable-job:v1\0${row.id}\0${row.job_type}\0${row.actor_user_id}`
      )
    );
  }

  const events = database
    .prepare(
      `SELECT event_id, stream_id, event_type, subject_id, actor_user_id,
              payload_format, payload
         FROM platform_events`
    )
    .iterate() as IterableIterator<DurableEventPayloadRow>;
  for (const row of events) {
    if (
      !validateDurableText(row.event_id) ||
      !validateDurableText(row.stream_id) ||
      !validateDurableText(row.event_type) ||
      !validateDurableText(row.subject_id) ||
      (row.actor_user_id !== null && !validateDurableText(row.actor_user_id))
    ) {
      throw new DurablePayloadIntegrityError('integrity');
    }
    verify(
      row.payload_format,
      row.payload,
      Buffer.from(
        `durable-event:v1\0${row.event_id}\0${row.stream_id}\0${row.event_type}\0${row.subject_id}\0${row.actor_user_id ?? ''}`
      )
    );
  }

  const inconsistentHeads = Number(
    (
      database
        .prepare(
          `SELECT COUNT(*) AS count
             FROM platform_event_stream_heads AS heads
             LEFT JOIN (
               SELECT stream_id,
                      MIN(stream_sequence) AS first_sequence,
                      MAX(stream_sequence) AS last_sequence,
                      COUNT(*) AS event_count
                 FROM platform_events GROUP BY stream_id
             ) AS events ON events.stream_id = heads.stream_id
            WHERE heads.last_sequence != COALESCE(events.last_sequence, 0)
               OR (heads.last_sequence = 0 AND COALESCE(events.event_count, 0) != 0)
               OR (heads.last_sequence > 0 AND (
                    events.first_sequence != 1
                    OR events.event_count != heads.last_sequence
                  ))`
        )
        .get() as { count: number }
    ).count
  );
  if (inconsistentHeads !== 0) {
    throw new DurablePayloadIntegrityError('integrity');
  }

  return {
    verified: true,
    records,
    encryptedRecords,
    referenceRecords,
    ciphertextBytes,
    referenceBytes,
    plaintextBytes,
  };
};

export class RecoveryInventoryService {
  constructor(
    private readonly defaults: Pick<
      RecoveryInventoryOptions,
      'pluginPathLocations' | 'legacyPluginsDirectories'
    > = {}
  ) {}

  async collect(
    options: RecoveryInventoryOptions = {}
  ): Promise<RecoveryInventory> {
    const env = options.env || process.env;
    const dataDir = options.dataDir
      ? path.resolve(options.dataDir)
      : options.databasePath
        ? path.dirname(path.resolve(options.databasePath))
        : options.cwd && !env.DATA_DIR?.trim()
          ? path.resolve(options.cwd, 'backend', 'data')
          : resolveDataDirectory(env);
    const databasePath = path.resolve(
      options.databasePath || path.join(dataDir, 'data.sqlite')
    );
    const now = options.now || new Date();
    const blockers: string[] = [];
    const warnings: string[] = [];
    const exclusions: string[] = [
      'External model files and provider-managed data are not stored in the Libre WebUI data directory.',
      'Secret values are excluded; only configuration presence and the encryption-key fingerprint are reported.',
    ];
    if (!options.dataDir && !options.databasePath) {
      try {
        assertNoLegacyDataDirectoryConflict(
          env,
          options.cwd
            ? {
                defaultDataDirectory: path.resolve(
                  options.cwd,
                  'backend',
                  'data'
                ),
                legacyDataDirectory: path.resolve(
                  options.cwd,
                  'backend',
                  'backend',
                  'data'
                ),
              }
            : undefined
        );
      } catch (error) {
        blockers.push(
          error instanceof Error
            ? error.message
            : 'A legacy data-directory conflict was detected.'
        );
      }
    }
    const dataStat = safeStat(dataDir);
    const dataPresent = Boolean(dataStat?.isDirectory());
    const dataReadable = dataPresent && canAccess(dataDir, fs.constants.R_OK);
    const dataWritable =
      dataPresent && canAccess(dataDir, fs.constants.W_OK | fs.constants.X_OK);
    const dataSize = dataPresent
      ? scanDirectory(dataDir)
      : { files: 0, bytes: 0, errors: 0 };
    if (!dataPresent)
      blockers.push('The configured data directory is missing.');
    else {
      if (!dataReadable)
        blockers.push('The configured data directory is not readable.');
      if (!dataWritable) {
        warnings.push(
          'The configured data directory is read-only; this is valid for a quiesced recovery source but not for a running application.'
        );
      }
      if (dataSize.errors > 0) {
        blockers.push(
          `${dataSize.errors} data-directory entr${dataSize.errors === 1 ? 'y could' : 'ies could'} not be inventoried.`
        );
      }
    }

    const encryption = inspectEncryptionKey(dataDir, env);
    const storageEnvironment = {
      ...env,
      DATA_DIR: dataDir,
    };
    const storageEncryption =
      inspectStorageKeyConfiguration(storageEnvironment);
    let storageKeyring:
      ReturnType<typeof createStorageKeyringFromEnvironment> | undefined;
    if (encryption.status === 'missing') {
      blockers.push(
        'No persistent encryption key was found; encrypted records cannot be recovered reliably.'
      );
    } else if (encryption.status === 'invalid') {
      blockers.push(
        'The selected encryption key is not a 64-character hexadecimal key.'
      );
    } else if (encryption.status === 'conflict') {
      blockers.push(
        'The environment encryption key differs from the key file in the data directory.'
      );
    }
    if (storageEncryption.status === 'invalid') {
      blockers.push(
        'The platform storage encryption keyring configuration is invalid.'
      );
    } else if (storageEncryption.status === 'missing') {
      warnings.push(
        'The platform storage keyring is not configured; encrypted platform blob and vector adapters cannot be enabled.'
      );
    } else {
      try {
        storageKeyring =
          createStorageKeyringFromEnvironment(storageEnvironment);
      } catch {
        blockers.push(
          'The platform storage encryption keyring changed or became unavailable during recovery inspection.'
        );
      }
    }
    if (env.NODE_ENV === 'production' && !env.JWT_SECRET?.trim()) {
      blockers.push(
        'JWT_SECRET is not configured persistently; restored sessions would not survive a restart.'
      );
    } else if (!env.JWT_SECRET?.trim()) {
      warnings.push('JWT_SECRET is not configured persistently.');
    }

    const walPath = `${databasePath}-wal`;
    const shmPath = `${databasePath}-shm`;
    const volumeDatabaseSelection = options.databasePath === undefined;
    const databaseSource = inspectSQLiteSource(
      'database',
      databasePath,
      volumeDatabaseSelection
    );
    const walSource = inspectSQLiteSource(
      'WAL',
      walPath,
      volumeDatabaseSelection
    );
    const shmSource = inspectSQLiteSource(
      'SHM',
      shmPath,
      volumeDatabaseSelection
    );
    const sqliteSources = [databaseSource, walSource, shmSource];
    for (const source of sqliteSources) {
      const blocker = sqliteSourceBlocker(source);
      if (blocker) blockers.push(blocker);
    }
    let canonicalDatabaseLocation = true;
    if (volumeDatabaseSelection) {
      const expectedDatabasePath = path.resolve(dataDir, 'data.sqlite');
      if (databasePath !== expectedDatabasePath) {
        canonicalDatabaseLocation = false;
      } else if (databaseSource.status === 'regular' && dataPresent) {
        try {
          const expectedPhysicalPath = path.join(
            fs.realpathSync.native(dataDir),
            'data.sqlite'
          );
          canonicalDatabaseLocation =
            fs.realpathSync.native(databasePath) === expectedPhysicalPath;
        } catch {
          canonicalDatabaseLocation = false;
        }
      }
      if (!canonicalDatabaseLocation) {
        blockers.push(
          'The default SQLite database is not the canonical DATA_DIR/data.sqlite file.'
        );
      }
    }
    const databaseStat = databaseSource.stat;
    const walStat = walSource.stat;
    const shmStat = shmSource.stat;
    let databaseOpen = false;
    let quickCheck: RecoveryInventory['database']['quickCheck'] = 'not-run';
    let foreignKeyViolations: number | null = null;
    let userVersion: number | null = null;
    let schemaFingerprint: string | undefined;
    let actualTableCount = 0;
    let ledgerPresent = false;
    let currentSchemaVersion = 0;
    let targetSchemaVersion = 0;
    let minimumSupportedSchemaVersion = 0;
    let appliedMigrations: RecoveryInventory['database']['schema']['appliedMigrations'] =
      [];
    let missingSchema: string[] = [];
    let generatedMedia = emptyCountAndBytes();
    let voiceReferences = emptyCountAndBytes();
    let documentText = emptyCountAndBytes();
    let legacyDocumentVectors = emptyCountAndBytes();
    let platformVectors = emptyCountAndBytes();
    let platformVectorAclRecords = 0;
    let platformVectorAttributeRecords = 0;
    let workTasks: WorkTaskRow[] = [];
    let tasksByStatus: Record<string, number> = {};
    let activeRuns = 0;
    let activePreviews = 0;
    let mediaJobsByStatus: Record<string, number> = {};
    let mediaJobTotal = 0;
    let mediaJobActive = 0;
    let durableSubstrateAvailable = false;
    let durableJobsByState = zeroCounts(DURABLE_JOB_STATES);
    let durableJobTotal = 0;
    let durableJobRunning = 0;
    let durableAttemptsByOutcome = zeroCounts(DURABLE_ATTEMPT_OUTCOMES);
    let durableAttemptTotal = 0;
    let durableAttemptActive = 0;
    let durableEventStreams = 0;
    let durableEventTotal = 0;
    let durableEventLastCursor = 0;
    let durablePayloadIntegrity: RecoveryInventory['jobs']['durable']['payloadIntegrity'] =
      {
        verified: false,
        encryptedAuthenticated: false,
        referenceTargetsVerified: false,
        records: 0,
        encryptedRecords: 0,
        referenceRecords: 0,
        ciphertextBytes: 0,
        referenceBytes: 0,
        plaintextBytes: 0,
      };
    let legacyCiphertext: RecoveryInventory['encryption']['legacyCiphertext'] =
      {
        verified: false,
        encryptedAuthenticated: false,
        records: 0,
        textRecords: 0,
        binaryRecords: 0,
        ciphertextBytes: 0,
        plaintextBytes: 0,
      };

    const sqliteSourcesValid =
      canonicalDatabaseLocation &&
      databaseSource.status === 'regular' &&
      [walSource, shmSource].every(source =>
        ['regular', 'missing'].includes(source.status)
      );
    if (databaseSource.status === 'missing') {
      blockers.push('The SQLite database file is missing.');
    } else if (sqliteSourcesValid) {
      let database: Database.Database | undefined;
      let inspectionDirectory: string | undefined;
      try {
        // A readonly WAL connection can still update shared-memory metadata.
        // Always inspect a private DB/WAL/SHM snapshot so the inventory never
        // mutates a writable or read-only recovery source.
        inspectionDirectory = fs.mkdtempSync(
          path.join(os.tmpdir(), 'libre-recovery-sqlite-')
        );
        const inspectionDatabasePath = path.join(
          inspectionDirectory,
          path.basename(databasePath)
        );
        for (const [source, suffix] of [
          [databaseSource, ''],
          [walSource, '-wal'],
          [shmSource, '-shm'],
        ] as const) {
          if (source.status === 'regular') {
            copyInspectedSQLiteSource(
              source,
              `${inspectionDatabasePath}${suffix}`,
              volumeDatabaseSelection
            );
          }
        }
        database = new Database(inspectionDatabasePath, {
          readonly: true,
          fileMustExist: true,
        });
        databaseOpen = true;
        const integrityRows = database.pragma('quick_check') as Array<
          Record<string, unknown>
        >;
        const integrityValues = integrityRows.flatMap(row =>
          Object.values(row).map(value => String(value))
        );
        quickCheck =
          integrityValues.length === 1 &&
          integrityValues[0].toLowerCase() === 'ok'
            ? 'ok'
            : 'failed';
        if (quickCheck !== 'ok') {
          blockers.push('SQLite quick-check reported database corruption.');
        }
        foreignKeyViolations = (
          database.pragma('foreign_key_check') as Array<Record<string, unknown>>
        ).length;
        if (foreignKeyViolations > 0) {
          blockers.push(
            `SQLite reported ${foreignKeyViolations} foreign-key violation${foreignKeyViolations === 1 ? '' : 's'}.`
          );
        }
        const versionRows = database.pragma('user_version') as Array<{
          user_version: number;
        }>;
        userVersion = Number(versionRows[0]?.user_version || 0);
        const schemaRows = database
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
          )
          .all() as Array<{ name: string; sql: string | null }>;
        actualTableCount = schemaRows.length;
        const actualTables = new Set(schemaRows.map(row => row.name));
        const schemaInspection = inspectSQLiteSchema(database);
        ledgerPresent = schemaInspection.ledgerPresent;
        currentSchemaVersion = schemaInspection.currentVersion;
        targetSchemaVersion = schemaInspection.targetVersion;
        minimumSupportedSchemaVersion =
          schemaInspection.minimumSupportedVersion;
        appliedMigrations = schemaInspection.appliedMigrations.map(
          migration => ({
            version: migration.version,
            name: migration.name,
            checksumMatches: migration.checksumMatches,
          })
        );
        missingSchema = schemaInspection.missing;
        if (!schemaInspection.compatible) {
          blockers.push(
            schemaInspection.reason ||
              'The SQLite schema is not compatible with this application version.'
          );
        }
        schemaFingerprint = crypto
          .createHash('sha256')
          .update(
            schemaRows.map(row => `${row.name}:${row.sql || ''}`).join('\n')
          )
          .digest('hex');

        let legacyKey: Buffer | undefined;
        if (encryption.status === 'available') {
          const environmentKey = env.ENCRYPTION_KEY?.trim();
          const selectedKey = environmentKey
            ? environmentKey
            : fs
                .readFileSync(path.join(dataDir, '.encryption_key'), 'utf8')
                .trim();
          legacyKey = Buffer.from(selectedKey, 'hex');
        }
        try {
          legacyCiphertext = verifyLegacyCiphertextIntegrity(
            database,
            legacyKey,
            options.legacyCiphertextIntegrityLimits
          );
        } catch (error) {
          blockers.push(
            error instanceof LegacyCiphertextIntegrityError &&
              error.code === 'verification-limit'
              ? 'Legacy application ciphertext exceeds bounded recovery integrity verification limits.'
              : error instanceof LegacyCiphertextIntegrityError &&
                  error.code === 'key-unavailable'
                ? 'Legacy application ciphertext is present but no usable application encryption key is available.'
                : 'Legacy application ciphertext failed read-only integrity verification with the configured application encryption key.'
          );
        } finally {
          legacyKey?.fill(0);
        }

        if (actualTables.has('generated_images')) {
          generatedMedia = countAndBytes(
            database,
            'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(image_data)), 0) AS bytes FROM generated_images'
          );
        }
        if (actualTables.has('voice_profiles')) {
          voiceReferences = countAndBytes(
            database,
            'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(reference_audio)), 0) AS bytes FROM voice_profiles'
          );
        }
        if (actualTables.has('documents')) {
          documentText = countAndBytes(
            database,
            'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(content)), 0) AS bytes FROM documents'
          );
        }
        if (actualTables.has('document_chunks')) {
          legacyDocumentVectors = countAndBytes(
            database,
            'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes FROM document_chunks WHERE embedding IS NOT NULL'
          );
        }
        if (actualTables.has('platform_vector_entries')) {
          platformVectors = countAndBytes(
            database,
            'SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(embedding)), 0) AS bytes FROM platform_vector_entries'
          );
        }
        if (actualTables.has('platform_vector_acl')) {
          platformVectorAclRecords = Number(
            (
              database
                .prepare('SELECT COUNT(*) AS count FROM platform_vector_acl')
                .get() as { count: number }
            ).count
          );
        }
        if (actualTables.has('platform_vector_attributes')) {
          platformVectorAttributeRecords = Number(
            (
              database
                .prepare(
                  'SELECT COUNT(*) AS count FROM platform_vector_attributes'
                )
                .get() as { count: number }
            ).count
          );
        }
        if (platformVectors.records > 0 && schemaInspection.compatible) {
          if (!storageKeyring) {
            blockers.push(
              'Platform vector ciphertext is present but no usable storage keyring is available.'
            );
          } else {
            try {
              new SqliteEncryptedVectorStore({
                database,
                keyring: storageKeyring,
              }).verifyIntegrity(options.vectorIntegrityLimits);
            } catch (error) {
              blockers.push(
                error instanceof VectorStoreError &&
                  error.code === 'verification-limit'
                  ? 'Platform vector storage exceeds bounded recovery integrity verification limits.'
                  : 'Platform vector ciphertext failed read-only integrity verification with the configured storage keys.'
              );
            }
          }
        }
        if (actualTables.has('work_tasks')) {
          workTasks = database
            .prepare(
              'SELECT id, status, volume_name, host_path FROM work_tasks ORDER BY id'
            )
            .all() as WorkTaskRow[];
          tasksByStatus = groupedCounts(database, 'work_tasks');
          activePreviews = Number(
            (
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM work_tasks WHERE preview_status IN ('starting', 'running')"
                )
                .get() as { count: number }
            ).count
          );
          if (activePreviews > 0) {
            blockers.push(
              `${activePreviews} Work preview${activePreviews === 1 ? ' is' : 's are'} active; stop previews before taking a recovery snapshot.`
            );
          }
        }
        if (actualTables.has('work_runs')) {
          activeRuns = Number(
            (
              database
                .prepare(
                  "SELECT COUNT(*) AS count FROM work_runs WHERE status IN ('queued', 'preparing', 'running')"
                )
                .get() as { count: number }
            ).count
          );
          if (activeRuns > 0) {
            blockers.push(
              `${activeRuns} Work run${activeRuns === 1 ? ' is' : 's are'} active; quiesce Work before taking a recovery snapshot.`
            );
          }
        }
        if (actualTables.has('media_generation_jobs')) {
          mediaJobsByStatus = groupedCounts(database, 'media_generation_jobs');
          mediaJobTotal = Object.values(mediaJobsByStatus).reduce(
            (sum, count) => sum + count,
            0
          );
          mediaJobActive =
            (mediaJobsByStatus.pending || 0) +
            (mediaJobsByStatus.in_progress || 0);
          if (mediaJobActive > 0) {
            blockers.push(
              `${mediaJobActive} media generation job${mediaJobActive === 1 ? ' is' : 's are'} active; wait for completion before taking a recovery snapshot.`
            );
          }
        }
        const durableTables = [
          'platform_jobs',
          'platform_job_attempts',
          'platform_event_stream_heads',
          'platform_events',
        ];
        durableSubstrateAvailable =
          schemaInspection.compatible &&
          durableTables.every(table => actualTables.has(table));
        if (durableSubstrateAvailable) {
          try {
            const durableDatabase = database;
            durableDatabase.transaction(() => {
              durableJobsByState = groupedKnownCounts(
                durableDatabase,
                'platform_jobs',
                'state',
                DURABLE_JOB_STATES
              );
              durableJobTotal = Object.values(durableJobsByState).reduce(
                (sum, count) => sum + count,
                0
              );
              durableJobRunning = durableJobsByState.running;
              durableAttemptsByOutcome = groupedKnownCounts(
                durableDatabase,
                'platform_job_attempts',
                'outcome',
                DURABLE_ATTEMPT_OUTCOMES
              );
              durableAttemptTotal = Object.values(
                durableAttemptsByOutcome
              ).reduce((sum, count) => sum + count, 0);
              durableAttemptActive = durableAttemptsByOutcome.running;
              const eventCounts = durableDatabase
                .prepare(
                  `SELECT COUNT(*) AS total,
                          COALESCE(MAX(global_cursor), 0) AS last_cursor
                     FROM platform_events`
                )
                .get() as { total: number; last_cursor: number };
              durableEventTotal = Number(eventCounts.total);
              durableEventLastCursor = Number(eventCounts.last_cursor);
              durableEventStreams = Number(
                (
                  durableDatabase
                    .prepare(
                      'SELECT COUNT(*) AS count FROM platform_event_stream_heads'
                    )
                    .get() as { count: number }
                ).count
              );
              const verified = verifyDurablePayloadIntegrity(
                durableDatabase,
                storageKeyring,
                options.durablePayloadIntegrityLimits
              );
              durablePayloadIntegrity = {
                ...verified,
                encryptedAuthenticated: true,
                referenceTargetsVerified: false,
              };
            })();
          } catch (error) {
            blockers.push(
              error instanceof DurablePayloadIntegrityError &&
                error.code === 'verification-limit'
                ? 'Durable job and event payloads exceed bounded recovery integrity verification limits.'
                : 'Durable job or event payload integrity verification failed with the configured storage keys.'
            );
          }
          if (durableJobRunning > 0) {
            blockers.push(
              `${durableJobRunning} durable job${durableJobRunning === 1 ? ' is' : 's are'} running; quiesce durable workers before taking a recovery snapshot.`
            );
          }
          if (durableAttemptActive !== durableJobRunning) {
            blockers.push(
              'Durable running-job and active-attempt counts are inconsistent.'
            );
          }
          warnings.push(
            'The durable job/event substrate is available, but no domain handler worker is bootstrapped.'
          );
          if (durablePayloadIntegrity.referenceRecords > 0) {
            warnings.push(
              'Opaque durable payload references were syntax-checked, but their target existence and authorization could not be verified.'
            );
          }
        }
      } catch {
        blockers.push(
          'The SQLite database could not be opened or checked read-only.'
        );
        quickCheck = 'failed';
      } finally {
        database?.close();
        if (inspectionDirectory) {
          fs.rmSync(inspectionDirectory, { recursive: true, force: true });
        }
      }
    }

    const configuredRuntimeBackend =
      env.WORK_RUNTIME_BACKEND?.trim() || 'docker';
    const runtimeBackend: WorkRuntimeBackend =
      configuredRuntimeBackend === 'kubernetes' ? 'kubernetes' : 'docker';
    if (!['docker', 'kubernetes'].includes(configuredRuntimeBackend)) {
      blockers.push(
        `WORK_RUNTIME_BACKEND is invalid; expected docker or kubernetes.`
      );
    }
    const externalWorkTasks = workTasks.filter(task => !task.host_path);
    const inspectWorkResources =
      options.inspectWorkResources || defaultWorkResourceInspector;
    const resourceInspection = await inspectWorkResources({
      backend: runtimeBackend,
      resources: externalWorkTasks.map(task => ({
        taskId: task.id,
        name: task.volume_name,
      })),
      env,
    });
    const workspaces: RecoveryInventory['work']['workspaces'] = workTasks.map(
      task => {
        if (task.host_path) {
          return {
            taskId: task.id,
            kind: 'host-path' as const,
            pathFingerprint: crypto
              .createHash('sha256')
              .update(path.resolve(task.host_path))
              .digest('hex')
              .slice(0, 16),
            present: Boolean(safeStat(task.host_path)),
            includedInDataDirectory: false as const,
          };
        }
        return {
          taskId: task.id,
          kind:
            runtimeBackend === 'kubernetes'
              ? ('kubernetes-pvc' as const)
              : ('docker-volume' as const),
          name: task.volume_name,
          present: resourceInspection.available
            ? Boolean(resourceInspection.matches[task.id])
            : null,
          includedInDataDirectory: false as const,
        };
      }
    );
    const invalidWorkspaces = workspaces.filter(
      workspace => workspace.present === false
    ).length;
    if (invalidWorkspaces > 0) {
      blockers.push(
        `${invalidWorkspaces} expected Work workspace${invalidWorkspaces === 1 ? ' is missing or has' : 's are missing or have'} mismatched ownership metadata.`
      );
    }
    if (externalWorkTasks.length > 0 && !resourceInspection.available) {
      blockers.push(
        resourceInspection.message ||
          'External Work workspace presence could not be verified.'
      );
    }
    const hostWorkspaces = workspaces.filter(
      workspace => workspace.kind === 'host-path'
    );
    if (hostWorkspaces.length > 0) {
      exclusions.push(
        `${hostWorkspaces.length} host-bound Work workspace${hostWorkspaces.length === 1 ? ' is' : 's are'} outside the Libre WebUI data directory and require a separate backup.`
      );
    }
    if (externalWorkTasks.length > 0) {
      exclusions.push(
        `${externalWorkTasks.length} Work ${runtimeBackend === 'kubernetes' ? 'PVC' : 'Docker volume'} workspace${externalWorkTasks.length === 1 ? ' is' : 's are'} outside the Libre WebUI data directory and require a coordinated snapshot.`
      );
    }

    const pluginLocations =
      options.pluginPathLocations || this.defaults.pluginPathLocations || {};
    const backendDirectory =
      pluginLocations.backendDirectory || BACKEND_DIRECTORY;
    const projectDirectory =
      pluginLocations.projectDirectory || PROJECT_DIRECTORY;
    const pluginsPath = resolvePluginsDirectory(env, dataDir, backendDirectory);
    const bundledPluginsDirectory = path.resolve(
      pluginLocations.bundledDirectory || path.join(projectDirectory, 'plugins')
    );
    const pluginSourcePaths = [
      { kind: 'configured' as const, path: path.resolve(pluginsPath) },
      ...(
        options.legacyPluginsDirectories ??
        this.defaults.legacyPluginsDirectories ??
        resolveLegacyPluginsDirectories(env, {
          backendDirectory,
          projectDirectory,
          historicalWorkingDirectory:
            pluginLocations.historicalWorkingDirectory || process.cwd(),
        })
      ).map(legacyPath => ({
        kind: 'legacy' as const,
        path: path.resolve(legacyPath),
      })),
    ].filter(source => source.path !== bundledPluginsDirectory);
    const seenPluginPaths = new Set<string>();
    const pluginSources: RecoveryInventory['storage']['customPlugins']['sources'] =
      [];
    for (const source of pluginSourcePaths) {
      if (seenPluginPaths.has(source.path)) continue;
      seenPluginPaths.add(source.path);
      const lexicalInsideDataDirectory = (() => {
        const relative = path.relative(dataDir, source.path);
        return (
          relative === '' ||
          (relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative))
        );
      })();
      const inspection = inspectPluginDirectory(
        source.path,
        lexicalInsideDataDirectory
          ? dataDir
          : source.kind === 'legacy' && source.path.startsWith(backendDirectory)
            ? backendDirectory
            : path.dirname(source.path)
      );
      const includedInDataDirectory =
        !inspection.unsafePath && isPathWithin(dataDir, source.path);
      pluginSources.push({
        kind: source.kind,
        ...inspection,
        includedInDataDirectory,
      });
      if (inspection.invalidEntries > 0) {
        blockers.push(
          `${inspection.invalidEntries} custom plugin ${inspection.invalidEntries === 1 ? 'entry is' : 'entries are'} symlinked, non-regular, or unreadable; recovery refuses to follow or omit it.`
        );
      }
      if (!includedInDataDirectory && inspection.definitions > 0) {
        exclusions.push(
          `${source.kind === 'legacy' ? 'A legacy' : 'The configured'} custom plugin directory is outside the Libre WebUI data directory and requires a separate backup.`
        );
        blockers.push(
          `${inspection.definitions} custom plugin definition${inspection.definitions === 1 ? ' is' : 's are'} outside the configured data directory; coordinate a separate plugin snapshot before backup.`
        );
      }
    }
    const configuredPluginSource = pluginSources.find(
      source =>
        source.kind === 'configured' &&
        source.path === path.resolve(pluginsPath)
    );
    const pluginsIncludedInDataDirectory = Boolean(
      configuredPluginSource?.includedInDataDirectory
    );
    const pluginsStat = safeLstat(pluginsPath);
    const pluginFiles = configuredPluginSource?.definitions || 0;
    const pluginBytes = configuredPluginSource?.bytes || 0;
    const localBlobStorePath = path.join(dataDir, 'blobs');
    // Do not follow a blob-root symlink even for inventory counts. The
    // integrity verifier below reports the non-physical root as a blocker.
    const localBlobStoreStat = safeLstat(localBlobStorePath);
    const localBlobStoreSize = localBlobStoreStat?.isDirectory()
      ? scanDirectory(localBlobStorePath)
      : { files: 0, bytes: 0, errors: 0 };
    if (localBlobStoreSize.errors > 0) {
      blockers.push(
        `${localBlobStoreSize.errors} local blob-store entr${localBlobStoreSize.errors === 1 ? 'y could' : 'ies could'} not be inventoried.`
      );
    }
    if (localBlobStoreStat) {
      if (!storageKeyring) {
        if (localBlobStoreSize.files > 0) {
          blockers.push(
            'Local encrypted blob data is present but no usable storage keyring is available.'
          );
        }
      } else {
        try {
          await new LocalEncryptedBlobStore({
            rootDirectory: localBlobStorePath,
            keyring: storageKeyring,
          }).verifyIntegrity(options.blobIntegrityLimits);
        } catch (error) {
          blockers.push(
            error instanceof BlobStoreError &&
              error.code === 'verification-limit'
              ? 'Local blob storage exceeds bounded recovery integrity verification limits.'
              : 'Local blob ciphertext failed read-only integrity verification with the configured storage keys.'
          );
        }
      }
    }

    const inventory: RecoveryInventory = {
      format: 'libre-webui-recovery-inventory',
      version: 1,
      generatedAt: now.toISOString(),
      readOnly: true,
      restoreReady: false,
      application: {
        name: 'libre-webui',
        version: loadAppPackage(import.meta.url).version || '0.0.0',
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`,
      },
      database: {
        backend: 'sqlite',
        path: databasePath,
        present: Boolean(databaseStat?.isFile()),
        bytes: databaseStat?.size || 0,
        companionFiles: [
          {
            kind: 'wal',
            present: Boolean(walStat?.isFile()),
            bytes: walStat?.size || 0,
          },
          {
            kind: 'shm',
            present: Boolean(shmStat?.isFile()),
            bytes: shmStat?.size || 0,
          },
        ],
        open: databaseOpen,
        quickCheck,
        foreignKeyViolations,
        schema: {
          userVersion,
          ...(schemaFingerprint ? { fingerprint: schemaFingerprint } : {}),
          actualTableCount,
          ledgerPresent,
          currentVersion: currentSchemaVersion,
          targetVersion: targetSchemaVersion,
          minimumSupportedVersion: minimumSupportedSchemaVersion,
          appliedMigrations,
          missing: missingSchema,
        },
      },
      encryption: { ...encryption, legacyCiphertext },
      configuration: {
        storageEncryption,
        secretPresence: {
          encryptionKeyEnvironment: Boolean(env.ENCRYPTION_KEY?.trim()),
          jwtSecret: Boolean(env.JWT_SECRET?.trim()),
          sessionSecret: Boolean(env.SESSION_SECRET?.trim()),
        },
      },
      storage: {
        dataDirectory: {
          path: dataDir,
          present: dataPresent,
          readable: dataReadable,
          writable: dataWritable,
          files: dataSize.files,
          bytes: dataSize.bytes,
          scanErrors: dataSize.errors,
        },
        customPlugins: {
          path: pluginsPath,
          present: Boolean(
            pluginsStat?.isDirectory() && !pluginsStat.isSymbolicLink()
          ),
          includedInDataDirectory: pluginsIncludedInDataDirectory,
          definitions: pluginFiles,
          bytes: pluginBytes,
          sources: pluginSources,
        },
        localBlobStore: {
          path: localBlobStorePath,
          present: Boolean(localBlobStoreStat?.isDirectory()),
          files: localBlobStoreSize.files,
          bytes: localBlobStoreSize.bytes,
          scanErrors: localBlobStoreSize.errors,
        },
        embeddedBlobs: { generatedMedia, voiceReferences, documentText },
        embeddedVectors: {
          legacyDocumentChunks: legacyDocumentVectors,
          platform: {
            ...platformVectors,
            aclRecords: platformVectorAclRecords,
            attributeRecords: platformVectorAttributeRecords,
          },
        },
      },
      work: {
        runtimeBackend,
        tasks: workTasks.length,
        tasksByStatus,
        activeRuns,
        activePreviews,
        resourcesVerified:
          externalWorkTasks.length === 0 ||
          (resourceInspection.available &&
            externalWorkTasks.every(
              task => resourceInspection.matches[task.id] === true
            )),
        workspaces,
      },
      jobs: {
        implementation: 'legacy-media-generation',
        total: mediaJobTotal,
        active: mediaJobActive,
        byStatus: mediaJobsByStatus,
        durableWorkerAvailable: false,
        durable: {
          substrateAvailable: durableSubstrateAvailable,
          handlerWorkerBootstrapped: false,
          externalWorkerAvailable: false,
          total: durableJobTotal,
          running: durableJobRunning,
          byState: durableJobsByState,
          attempts: {
            total: durableAttemptTotal,
            active: durableAttemptActive,
            byOutcome: durableAttemptsByOutcome,
          },
          events: {
            streams: durableEventStreams,
            total: durableEventTotal,
            lastCursor: durableEventLastCursor,
          },
          payloadIntegrity: durablePayloadIntegrity,
        },
      },
      blockers: unique(blockers),
      warnings: unique(warnings),
      exclusions: unique(exclusions),
    };
    inventory.restoreReady = inventory.blockers.length === 0;
    return inventory;
  }
}

export const recoveryInventoryService = new RecoveryInventoryService();
export default recoveryInventoryService;
