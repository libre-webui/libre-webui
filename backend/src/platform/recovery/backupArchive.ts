/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import recoveryInventoryService, {
  type RecoveryInventory,
} from '../../services/recoveryInventoryService.js';
import { loadAppPackage } from '../../utils/packagePaths.js';

const MAGIC = Buffer.from('LWBK0001', 'ascii');
const MAX_HEADER_BYTES = 16 * 1024 * 1024;
const COPY_BUFFER_BYTES = 1024 * 1024;
export const BACKUP_SECRET_NAMES = [
  'ENCRYPTION_KEY',
  'STORAGE_ENCRYPTION_KEYS',
  'STORAGE_ENCRYPTION_ACTIVE_KEY_ID',
  'JWT_SECRET',
  'SESSION_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'S3_ENDPOINT',
  'S3_REGION',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_SESSION_TOKEN',
] as const;
export const BACKUP_RUNTIME_NAMES = [
  'LIBRE_PLATFORM_MODE',
  'DATABASE_BACKEND',
  'BLOB_STORE_BACKEND',
  'BLOB_QUOTA_BYTES_PER_USER',
  'BLOB_QUOTA_RESERVATION_TTL_MS',
  'VECTOR_STORE_BACKEND',
  'COORDINATION_BACKEND',
  'REDIS_KEY_PREFIX',
  'REDIS_CONNECT_TIMEOUT_MS',
  'JOB_WORKER_MODE',
  'DATABASE_SSL_MODE',
  'POSTGRES_MIGRATION_MODE',
  'POSTGRES_POOL_MAX',
  'POSTGRES_CONNECT_TIMEOUT_MS',
  'POSTGRES_IDLE_TIMEOUT_MS',
  'POSTGRES_STATEMENT_TIMEOUT_MS',
  'POSTGRES_MIGRATION_LOCK_TIMEOUT_MS',
  'S3_BLOB_PREFIX',
  'S3_FORCE_PATH_STYLE',
] as const;

export const stageProtectedRuntimeConfiguration = (
  payloadDirectory: string,
  env: NodeJS.ProcessEnv
): void => {
  const directory = path.join(payloadDirectory, 'configuration');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const runtime = Object.fromEntries(
    BACKUP_RUNTIME_NAMES.flatMap(name =>
      env[name] ? [[name, env[name]!]] : []
    )
  );
  const secrets = Object.fromEntries(
    BACKUP_SECRET_NAMES.flatMap(name => (env[name] ? [[name, env[name]!]] : []))
  );
  fs.writeFileSync(
    path.join(directory, 'runtime.json'),
    canonicalJson(runtime),
    { mode: 0o600, flag: 'wx' }
  );
  fs.writeFileSync(
    path.join(directory, 'secrets.json'),
    canonicalJson(secrets),
    { mode: 0o600, flag: 'wx' }
  );
};

export interface BackupArchiveFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupArchiveManifest {
  format: 'libre-webui-integrated-backup';
  version: 1;
  backupId: string;
  createdAt: string;
  application: { name: string; version: string; nodeVersion: string };
  source: {
    platformMode: string;
    databaseBackend: string;
    blobBackend: string;
    vectorBackend: string;
    coordinationBackend?: string;
    jobWorkerMode?: string;
  };
  inventory: {
    format: RecoveryInventory['format'];
    version: RecoveryInventory['version'];
    schemaFingerprint?: string;
    encryptionKeyFingerprint?: string;
    schemaVersion?: number;
    databaseDumpSha256?: string;
    s3InventorySha256?: string;
    blobObjects?: number;
    vectorRecords?: number;
  };
  files: BackupArchiveFile[];
  exclusions: string[];
}

export interface BackupArchiveHeader {
  manifest: BackupArchiveManifest;
  encryption: {
    algorithm: 'aes-256-gcm';
    iv: string;
    tag: string;
    ciphertextBytes: number;
    ciphertextSha256: string;
  };
  signature: {
    algorithm: 'ed25519';
    signerFingerprint: string;
    value: string;
  };
}

export type BackupArchiveManifestInput = Omit<BackupArchiveManifest, 'files'>;

export interface SealBackupPayloadOptions {
  payloadDirectory: string;
  outputPath: string;
  encryptionKeyPath: string;
  signingPrivateKeyPath: string;
  manifest: BackupArchiveManifestInput;
}

export interface ExtractBackupPayloadOptions extends Required<VerifyBackupArchiveOptions> {
  destinationDirectory: string;
}

export interface CreateBackupArchiveOptions {
  dataDir: string;
  outputPath: string;
  encryptionKeyPath: string;
  signingPrivateKeyPath: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /** Explicit acknowledgement that application writers have been stopped. */
  offline: boolean;
}

export interface VerifyBackupArchiveOptions {
  archivePath: string;
  signingPublicKeyPath: string;
  encryptionKeyPath?: string;
}

export interface RestoreBackupArchiveOptions extends Required<VerifyBackupArchiveOptions> {
  targetDirectory: string;
  apply: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface BackupVerification {
  header: BackupArchiveHeader;
  signatureVerified: boolean;
  ciphertextVerified: boolean;
  payloadVerified: boolean;
}

const canonicalJson = (value: unknown): string => {
  const visit = (candidate: unknown): string => {
    if (candidate === null || typeof candidate !== 'object') {
      return JSON.stringify(candidate);
    }
    if (Array.isArray(candidate)) {
      return `[${candidate.map(visit).join(',')}]`;
    }
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

const assertPhysicalFile = (target: string, label: string): fs.Stats => {
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error(`${label} must be a single-link physical file.`);
  }
  return stat;
};

const assertPhysicalDirectory = (target: string, label: string): fs.Stats => {
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a physical directory.`);
  }
  return stat;
};

const readEncryptionKey = (keyPath: string): Buffer => {
  const stat = assertPhysicalFile(keyPath, 'Backup encryption key');
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      'Backup encryption key permissions must not grant group or other access.'
    );
  }
  const value = fs.readFileSync(keyPath, 'utf8').trim();
  const key = /^[a-fA-F0-9]{64}$/.test(value)
    ? Buffer.from(value, 'hex')
    : Buffer.from(value, 'base64');
  if (key.byteLength !== 32) {
    key.fill(0);
    throw new Error('Backup encryption key must contain exactly 32 bytes.');
  }
  return key;
};

const readPrivateKey = (keyPath: string): crypto.KeyObject => {
  const stat = assertPhysicalFile(keyPath, 'Backup signing private key');
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      'Backup signing private key permissions must not grant group or other access.'
    );
  }
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Backup signing private key must be Ed25519.');
  }
  return key;
};

const readPublicKey = (keyPath: string): crypto.KeyObject => {
  assertPhysicalFile(keyPath, 'Backup signing public key');
  const key = crypto.createPublicKey(fs.readFileSync(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error('Backup signing public key must be Ed25519.');
  }
  return key;
};

const publicKeyFingerprint = (key: crypto.KeyObject): string =>
  sha256(key.export({ type: 'spki', format: 'der' })).slice(0, 32);

const safeRelativePath = (value: string): string => {
  if (
    !value ||
    value.includes('\0') ||
    value.includes('\\') ||
    path.posix.isAbsolute(value) ||
    value.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('Backup manifest contains an unsafe file path.');
  }
  return value;
};

const walkFiles = (root: string): string[] => {
  const output: string[] = [];
  const pending = [''];
  while (pending.length > 0) {
    const relativeDirectory = pending.pop()!;
    const directory = path.join(root, relativeDirectory);
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relative = path.posix.join(
        relativeDirectory.split(path.sep).join('/'),
        entry.name
      );
      const target = path.join(root, relative);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        throw new Error('Backup source contains a symbolic link.');
      }
      if (stat.isDirectory()) pending.push(relative);
      else if (stat.isFile() && stat.nlink === 1) output.push(relative);
      else
        throw new Error(
          'Backup source contains an unsupported filesystem entry.'
        );
    }
  }
  return output.sort();
};

const copyPhysicalTree = (source: string, destination: string): void => {
  assertPhysicalDirectory(source, 'Backup source data directory');
  fs.mkdirSync(destination, { recursive: true, mode: 0o700 });
  for (const relative of walkFiles(source)) {
    const input = path.join(source, relative);
    const output = path.join(destination, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.copyFileSync(input, output, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(output, 0o600);
  }
};

const hashPhysicalFile = (
  target: string
): { bytes: number; sha256: string } => {
  const expected = assertPhysicalFile(target, 'Backup payload file');
  const descriptor = fs.openSync(
    target,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    const opened = fs.fstatSync(descriptor);
    if (
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino ||
      opened.nlink !== 1
    ) {
      throw new Error('Backup payload changed during inspection.');
    }
    let bytesRead: number;
    while (
      (bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0
    ) {
      hash.update(buffer.subarray(0, bytesRead));
      bytes += bytesRead;
    }
    const finished = fs.fstatSync(descriptor);
    if (
      bytes !== expected.size ||
      finished.size !== expected.size ||
      finished.mtimeMs !== expected.mtimeMs
    ) {
      throw new Error('Backup payload changed during inspection.');
    }
    return { bytes, sha256: hash.digest('hex') };
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
};

const inspectFiles = (root: string): BackupArchiveFile[] =>
  walkFiles(root).map(relative => {
    const target = path.join(root, relative);
    return {
      path: safeRelativePath(relative.split(path.sep).join('/')),
      ...hashPhysicalFile(target),
    };
  });

const assertSourceMatchesStagedData = (
  source: string,
  files: BackupArchiveFile[]
): void => {
  const expected = files
    .filter(file => file.path.startsWith('data/'))
    .map(file => ({ ...file, path: file.path.slice('data/'.length) }));
  const actual = inspectFiles(source);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(
      'Backup source changed while it was being copied; no archive was published.'
    );
  }
};

const writeAll = (descriptor: number, value: Buffer): void => {
  let offset = 0;
  while (offset < value.byteLength) {
    offset += fs.writeSync(
      descriptor,
      value,
      offset,
      value.byteLength - offset
    );
  }
};

const writeHeaderAndCiphertext = (
  destination: string,
  header: BackupArchiveHeader,
  ciphertextPath: string
): void => {
  const serializedHeader = Buffer.from(canonicalJson(header), 'utf8');
  if (serializedHeader.byteLength > MAX_HEADER_BYTES) {
    throw new Error('Backup manifest exceeds the supported size.');
  }
  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32BE(serializedHeader.byteLength);
  const output = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    0o600
  );
  try {
    writeAll(output, MAGIC);
    writeAll(output, headerLength);
    writeAll(output, serializedHeader);
    const input = fs.openSync(ciphertextPath, fs.constants.O_RDONLY);
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    try {
      let bytesRead: number;
      while (
        (bytesRead = fs.readSync(input, buffer, 0, buffer.length, null)) > 0
      ) {
        writeAll(output, buffer.subarray(0, bytesRead));
      }
    } finally {
      buffer.fill(0);
      fs.closeSync(input);
    }
    fs.fsyncSync(output);
  } finally {
    serializedHeader.fill(0);
    fs.closeSync(output);
  }
};

const parseHeader = (
  archivePath: string
): { header: BackupArchiveHeader; payloadOffset: number; bytes: number } => {
  const stat = assertPhysicalFile(archivePath, 'Backup archive');
  const descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY);
  try {
    const prefix = Buffer.alloc(MAGIC.byteLength + 4);
    if (
      fs.readSync(descriptor, prefix, 0, prefix.length, 0) !== prefix.length
    ) {
      throw new Error('Backup archive header is truncated.');
    }
    if (!prefix.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error('Backup archive magic is invalid.');
    }
    const length = prefix.readUInt32BE(MAGIC.byteLength);
    if (length < 2 || length > MAX_HEADER_BYTES) {
      throw new Error('Backup archive header size is invalid.');
    }
    const bytes = Buffer.alloc(length);
    if (fs.readSync(descriptor, bytes, 0, length, prefix.length) !== length) {
      throw new Error('Backup archive header is truncated.');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } finally {
      bytes.fill(0);
    }
    const header = parsed as BackupArchiveHeader;
    if (
      !header ||
      header.manifest?.format !== 'libre-webui-integrated-backup' ||
      header.manifest.version !== 1 ||
      header.encryption?.algorithm !== 'aes-256-gcm' ||
      header.signature?.algorithm !== 'ed25519' ||
      !Array.isArray(header.manifest.files)
    ) {
      throw new Error('Backup archive header contract is invalid.');
    }
    if (
      !/^[a-f0-9]{64}$/.test(header.encryption.ciphertextSha256) ||
      typeof header.encryption.iv !== 'string' ||
      typeof header.encryption.tag !== 'string' ||
      typeof header.signature.value !== 'string' ||
      !/^[a-f0-9]{32}$/.test(header.signature.signerFingerprint)
    ) {
      throw new Error('Backup archive cryptographic metadata is invalid.');
    }
    const seen = new Set<string>();
    for (const file of header.manifest.files) {
      safeRelativePath(file.path);
      if (seen.has(file.path))
        throw new Error('Backup manifest contains a duplicate path.');
      seen.add(file.path);
      if (
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256)
      ) {
        throw new Error('Backup manifest contains invalid file metadata.');
      }
    }
    const payloadOffset = prefix.length + length;
    if (
      !Number.isSafeInteger(header.encryption.ciphertextBytes) ||
      header.encryption.ciphertextBytes < 0 ||
      payloadOffset + header.encryption.ciphertextBytes !== stat.size
    ) {
      throw new Error('Backup ciphertext size does not match its manifest.');
    }
    return { header, payloadOffset, bytes: stat.size };
  } finally {
    fs.closeSync(descriptor);
  }
};

const signedValue = (header: BackupArchiveHeader): Buffer =>
  Buffer.from(
    canonicalJson({ manifest: header.manifest, encryption: header.encryption }),
    'utf8'
  );

const ciphertextDigest = (
  archivePath: string,
  offset: number,
  length: number
): string => {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(archivePath, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  try {
    let position = offset;
    let remaining = length;
    while (remaining > 0) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, remaining),
        position
      );
      if (bytesRead <= 0) throw new Error('Backup ciphertext is truncated.');
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
    return hash.digest('hex');
  } finally {
    buffer.fill(0);
    fs.closeSync(descriptor);
  }
};

const verifyHeader = (
  archivePath: string,
  signingPublicKeyPath: string
): { header: BackupArchiveHeader; payloadOffset: number } => {
  const parsed = parseHeader(archivePath);
  const publicKey = readPublicKey(signingPublicKeyPath);
  if (
    parsed.header.signature.signerFingerprint !==
    publicKeyFingerprint(publicKey)
  ) {
    throw new Error('Backup signer does not match the trusted public key.');
  }
  const value = signedValue(parsed.header);
  try {
    if (
      !crypto.verify(
        null,
        value,
        publicKey,
        Buffer.from(parsed.header.signature.value, 'base64')
      )
    ) {
      throw new Error('Backup manifest signature verification failed.');
    }
  } finally {
    value.fill(0);
  }
  const actualDigest = ciphertextDigest(
    archivePath,
    parsed.payloadOffset,
    parsed.header.encryption.ciphertextBytes
  );
  if (
    !crypto.timingSafeEqual(
      Buffer.from(actualDigest, 'hex'),
      Buffer.from(parsed.header.encryption.ciphertextSha256, 'hex')
    )
  ) {
    throw new Error('Backup ciphertext checksum verification failed.');
  }
  return { header: parsed.header, payloadOffset: parsed.payloadOffset };
};

const decryptInto = (
  archivePath: string,
  payloadOffset: number,
  header: BackupArchiveHeader,
  encryptionKeyPath: string,
  destination: string
): void => {
  const key = readEncryptionKey(encryptionKeyPath);
  const iv = Buffer.from(header.encryption.iv, 'base64');
  const tag = Buffer.from(header.encryption.tag, 'base64');
  if (iv.byteLength !== 12 || tag.byteLength !== 16) {
    key.fill(0);
    throw new Error('Backup encryption envelope is invalid.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
    authTagLength: 16,
  });
  const aad = Buffer.from(canonicalJson(header.manifest), 'utf8');
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  const input = fs.openSync(archivePath, fs.constants.O_RDONLY);
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let fileIndex = 0;
  let fileDescriptor: number | undefined;
  let fileRemaining = 0;
  let fileHash = crypto.createHash('sha256');

  const openNext = (): void => {
    while (fileIndex < header.manifest.files.length) {
      const file = header.manifest.files[fileIndex];
      const target = path.join(
        destination,
        ...safeRelativePath(file.path).split('/')
      );
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fileDescriptor = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
        0o600
      );
      fileRemaining = file.bytes;
      fileHash = crypto.createHash('sha256');
      if (fileRemaining > 0) return;
      fs.closeSync(fileDescriptor);
      fileDescriptor = undefined;
      if (fileHash.digest('hex') !== file.sha256) {
        throw new Error('Restored backup file checksum verification failed.');
      }
      fileIndex += 1;
    }
  };

  const consume = (plaintext: Buffer): void => {
    let offset = 0;
    while (offset < plaintext.byteLength) {
      if (fileDescriptor === undefined) openNext();
      if (fileDescriptor === undefined) {
        throw new Error('Backup plaintext exceeds its file manifest.');
      }
      const length = Math.min(fileRemaining, plaintext.byteLength - offset);
      const slice = plaintext.subarray(offset, offset + length);
      writeAll(fileDescriptor, slice);
      fileHash.update(slice);
      offset += length;
      fileRemaining -= length;
      if (fileRemaining === 0) {
        fs.fsyncSync(fileDescriptor);
        fs.closeSync(fileDescriptor);
        fileDescriptor = undefined;
        const expected = header.manifest.files[fileIndex];
        if (fileHash.digest('hex') !== expected.sha256) {
          throw new Error('Restored backup file checksum verification failed.');
        }
        fileIndex += 1;
      }
    }
  };

  try {
    openNext();
    let position = payloadOffset;
    let remaining = header.encryption.ciphertextBytes;
    while (remaining > 0) {
      const bytesRead = fs.readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, remaining),
        position
      );
      if (bytesRead <= 0) throw new Error('Backup ciphertext is truncated.');
      const plaintext = decipher.update(buffer.subarray(0, bytesRead));
      try {
        consume(plaintext);
      } finally {
        plaintext.fill(0);
      }
      position += bytesRead;
      remaining -= bytesRead;
    }
    const final = decipher.final();
    try {
      consume(final);
    } finally {
      final.fill(0);
    }
    openNext();
    if (
      fileDescriptor !== undefined ||
      fileIndex !== header.manifest.files.length
    ) {
      throw new Error('Backup plaintext is shorter than its file manifest.');
    }
  } finally {
    if (fileDescriptor !== undefined) fs.closeSync(fileDescriptor);
    buffer.fill(0);
    aad.fill(0);
    key.fill(0);
    fs.closeSync(input);
  }
};

const readJsonObject = (target: string): Record<string, string> => {
  const bytes = fs.readFileSync(target);
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Restored backup configuration is invalid.');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).flatMap(
        ([key, value]) => (typeof value === 'string' ? [[key, value]] : [])
      )
    );
  } finally {
    bytes.fill(0);
  }
};

const collectRestoreInventory = async (
  restoreRoot: string,
  baseEnv: NodeJS.ProcessEnv
): Promise<RecoveryInventory> => {
  const secrets = readJsonObject(
    path.join(restoreRoot, 'configuration', 'secrets.json')
  );
  const runtime = readJsonObject(
    path.join(restoreRoot, 'configuration', 'runtime.json')
  );
  return recoveryInventoryService.collect({
    dataDir: path.join(restoreRoot, 'data'),
    env: {
      ...baseEnv,
      ...runtime,
      ...secrets,
      DATA_DIR: path.join(restoreRoot, 'data'),
      // The archive owns only this restored data tree. Never let a caller's
      // historical PLUGINS_DIR make preflight inspect or mutate another tree.
      PLUGINS_DIR: path.join(restoreRoot, 'data', 'plugins'),
    },
    legacyPluginsDirectories: [],
  });
};

export const generateBackupKeys = (
  directory: string
): {
  encryptionKeyPath: string;
  signingPrivateKeyPath: string;
  signingPublicKeyPath: string;
} => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPhysicalDirectory(directory, 'Backup key directory');
  const encryptionKeyPath = path.join(directory, 'backup-encryption.key');
  const signingPrivateKeyPath = path.join(
    directory,
    'backup-signing-private.pem'
  );
  const signingPublicKeyPath = path.join(
    directory,
    'backup-signing-public.pem'
  );
  for (const target of [
    encryptionKeyPath,
    signingPrivateKeyPath,
    signingPublicKeyPath,
  ]) {
    if (fs.existsSync(target))
      throw new Error('Backup key output already exists.');
  }
  const encryptionKey = crypto.randomBytes(32);
  const pair = crypto.generateKeyPairSync('ed25519');
  try {
    fs.writeFileSync(encryptionKeyPath, `${encryptionKey.toString('hex')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.writeFileSync(
      signingPrivateKeyPath,
      pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      { mode: 0o600, flag: 'wx' }
    );
    fs.writeFileSync(
      signingPublicKeyPath,
      pair.publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o644, flag: 'wx' }
    );
  } finally {
    encryptionKey.fill(0);
  }
  return { encryptionKeyPath, signingPrivateKeyPath, signingPublicKeyPath };
};

export const inspectBackupArchive = (
  archivePath: string
): BackupArchiveHeader => parseHeader(archivePath).header;

export const verifyBackupArchive = (
  options: VerifyBackupArchiveOptions
): BackupVerification => {
  const verified = verifyHeader(
    options.archivePath,
    options.signingPublicKeyPath
  );
  let payloadVerified = false;
  if (options.encryptionKeyPath) {
    const scratch = fs.mkdtempSync(
      path.join(os.tmpdir(), 'libre-backup-verify-')
    );
    const destination = path.join(scratch, 'payload');
    try {
      decryptInto(
        options.archivePath,
        verified.payloadOffset,
        verified.header,
        options.encryptionKeyPath,
        destination
      );
      payloadVerified = true;
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    header: verified.header,
    signatureVerified: true,
    ciphertextVerified: true,
    payloadVerified,
  };
};

/**
 * Seal an already-staged, physical payload tree into the common signed and
 * encrypted archive format. Callers are responsible for producing a
 * consistent staged snapshot before invoking this boundary.
 */
export const sealBackupPayload = (
  options: SealBackupPayloadOptions
): BackupVerification => {
  assertPhysicalDirectory(options.payloadDirectory, 'Backup payload directory');
  if (fs.existsSync(options.outputPath)) {
    throw new Error('Backup output already exists.');
  }
  const payload = path.resolve(options.payloadDirectory);
  const output = path.resolve(options.outputPath);
  const relativeOutput = path.relative(payload, output);
  if (
    relativeOutput === '' ||
    (!relativeOutput.startsWith(`..${path.sep}`) &&
      relativeOutput !== '..' &&
      !path.isAbsolute(relativeOutput))
  ) {
    throw new Error('Backup output must be outside the staged payload.');
  }
  const files = inspectFiles(payload);
  const manifest: BackupArchiveManifest = { ...options.manifest, files };
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(parent, '.libre-backup-seal-'));
  const ciphertextPath = path.join(scratch, 'ciphertext.partial');
  const outputPartial = `${output}.partial-${process.pid}-${crypto.randomUUID()}`;
  const key = readEncryptionKey(options.encryptionKeyPath);
  try {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const aad = Buffer.from(canonicalJson(manifest), 'utf8');
    cipher.setAAD(aad);
    const ciphertext = fs.openSync(
      ciphertextPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    const ciphertextHash = crypto.createHash('sha256');
    let ciphertextBytes = 0;
    try {
      for (const file of files) {
        const input = fs.openSync(
          path.join(payload, ...file.path.split('/')),
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
        );
        const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
        try {
          let bytesRead: number;
          while (
            (bytesRead = fs.readSync(input, buffer, 0, buffer.length, null)) > 0
          ) {
            const encrypted = cipher.update(buffer.subarray(0, bytesRead));
            try {
              writeAll(ciphertext, encrypted);
              ciphertextHash.update(encrypted);
              ciphertextBytes += encrypted.byteLength;
            } finally {
              encrypted.fill(0);
            }
          }
        } finally {
          buffer.fill(0);
          fs.closeSync(input);
        }
      }
      const final = cipher.final();
      try {
        writeAll(ciphertext, final);
        ciphertextHash.update(final);
        ciphertextBytes += final.byteLength;
      } finally {
        final.fill(0);
      }
      fs.fsyncSync(ciphertext);
    } finally {
      aad.fill(0);
      fs.closeSync(ciphertext);
    }

    const privateKey = readPrivateKey(options.signingPrivateKeyPath);
    const publicKey = crypto.createPublicKey(privateKey);
    const unsigned = {
      manifest,
      encryption: {
        algorithm: 'aes-256-gcm' as const,
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        ciphertextBytes,
        ciphertextSha256: ciphertextHash.digest('hex'),
      },
    };
    const signed = Buffer.from(canonicalJson(unsigned), 'utf8');
    let signature: string;
    try {
      signature = crypto.sign(null, signed, privateKey).toString('base64');
    } finally {
      signed.fill(0);
    }
    const header: BackupArchiveHeader = {
      ...unsigned,
      signature: {
        algorithm: 'ed25519',
        signerFingerprint: publicKeyFingerprint(publicKey),
        value: signature,
      },
    };
    writeHeaderAndCiphertext(outputPartial, header, ciphertextPath);
    fs.renameSync(outputPartial, output);
    const directory = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    const publicPath = path.join(scratch, 'verify-public.pem');
    fs.writeFileSync(
      publicPath,
      publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o600, flag: 'wx' }
    );
    return verifyBackupArchive({
      archivePath: output,
      signingPublicKeyPath: publicPath,
      encryptionKeyPath: options.encryptionKeyPath,
    });
  } finally {
    key.fill(0);
    fs.rmSync(outputPartial, { force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

/** Decrypt and authenticate an archive into a caller-owned fresh directory. */
export const extractBackupPayload = (
  options: ExtractBackupPayloadOptions
): { header: BackupArchiveHeader; verification: BackupVerification } => {
  const destination = path.resolve(options.destinationDirectory);
  if (fs.existsSync(destination)) {
    throw new Error('Backup extraction target must not exist.');
  }
  const parsed = verifyHeader(
    options.archivePath,
    options.signingPublicKeyPath
  );
  try {
    decryptInto(
      options.archivePath,
      parsed.payloadOffset,
      parsed.header,
      options.encryptionKeyPath,
      destination
    );
    return {
      header: parsed.header,
      verification: {
        header: parsed.header,
        signatureVerified: true,
        ciphertextVerified: true,
        payloadVerified: true,
      },
    };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
};

export const createBackupArchive = async (
  options: CreateBackupArchiveOptions
): Promise<BackupVerification> => {
  if (!options.offline) {
    throw new Error(
      'Integrated backup creation requires --offline after all application and worker processes are stopped.'
    );
  }
  if (fs.existsSync(options.outputPath)) {
    throw new Error('Backup output already exists.');
  }
  const resolvedDataDir = path.resolve(options.dataDir);
  const resolvedOutput = path.resolve(options.outputPath);
  const relativeOutput = path.relative(resolvedDataDir, resolvedOutput);
  if (
    relativeOutput === '' ||
    (!relativeOutput.startsWith(`..${path.sep}`) &&
      relativeOutput !== '..' &&
      !path.isAbsolute(relativeOutput))
  ) {
    throw new Error(
      'Backup output must be outside the application data directory.'
    );
  }
  const env = options.env ?? process.env;
  if (
    env.LIBRE_PLATFORM_MODE?.trim().toLowerCase() === 'team' ||
    env.DATABASE_BACKEND?.trim().toLowerCase() === 'postgres' ||
    env.BLOB_STORE_BACKEND?.trim().toLowerCase() === 's3' ||
    env.VECTOR_STORE_BACKEND?.trim().toLowerCase() === 'pgvector'
  ) {
    throw new Error(
      'The filesystem backup command is solo-only; use the coordinated team backup command.'
    );
  }
  const inventory = await recoveryInventoryService.collect({
    dataDir: options.dataDir,
    env,
    // Integrated archives stage only the configured data root. Historical
    // package plugin locations are compatibility inputs supplied by the
    // runtime image, not operator state to copy from the host package tree.
    legacyPluginsDirectories: [],
  });
  if (!inventory.restoreReady) {
    throw new Error(
      `Recovery inventory blocked backup creation: ${inventory.blockers.join('; ')}`
    );
  }
  const parent = path.dirname(path.resolve(options.outputPath));
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(parent, '.libre-backup-'));
  const staged = path.join(scratch, 'payload');
  try {
    fs.mkdirSync(staged, { mode: 0o700 });
    copyPhysicalTree(options.dataDir, path.join(staged, 'data'));
    stageProtectedRuntimeConfiguration(staged, env);
    assertSourceMatchesStagedData(options.dataDir, inspectFiles(staged));
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
        platformMode: env.LIBRE_PLATFORM_MODE || 'solo',
        databaseBackend: env.DATABASE_BACKEND || 'sqlite',
        blobBackend: env.BLOB_STORE_BACKEND || 'local',
        vectorBackend: env.VECTOR_STORE_BACKEND || 'embedded',
      },
      inventory: {
        format: inventory.format,
        version: inventory.version,
        ...(inventory.database.schema.fingerprint
          ? { schemaFingerprint: inventory.database.schema.fingerprint }
          : {}),
        ...(inventory.encryption.fingerprint
          ? { encryptionKeyFingerprint: inventory.encryption.fingerprint }
          : {}),
      },
      exclusions: [...inventory.exclusions],
    };
    return sealBackupPayload({
      payloadDirectory: staged,
      outputPath: options.outputPath,
      encryptionKeyPath: options.encryptionKeyPath,
      signingPrivateKeyPath: options.signingPrivateKeyPath,
      manifest,
    });
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

export const restoreBackupArchive = async (
  options: RestoreBackupArchiveOptions
): Promise<{
  applied: boolean;
  targetDirectory: string;
  inventory: RecoveryInventory;
  verification: BackupVerification;
}> => {
  const target = path.resolve(options.targetDirectory);
  if (fs.existsSync(target)) {
    const stat = assertPhysicalDirectory(target, 'Restore target');
    if (stat && fs.readdirSync(target).length > 0) {
      throw new Error('Restore target must not exist or must be empty.');
    }
    fs.rmdirSync(target);
  }
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const verification = verifyBackupArchive({
    archivePath: options.archivePath,
    signingPublicKeyPath: options.signingPublicKeyPath,
  });
  const parsed = verifyHeader(
    options.archivePath,
    options.signingPublicKeyPath
  );
  const scratch = fs.mkdtempSync(path.join(parent, '.libre-restore-'));
  let applied = false;
  try {
    const payload = path.join(scratch, 'payload');
    decryptInto(
      options.archivePath,
      parsed.payloadOffset,
      parsed.header,
      options.encryptionKeyPath,
      payload
    );
    const inventory = await collectRestoreInventory(
      payload,
      options.env ?? process.env
    );
    if (!inventory.restoreReady) {
      throw new Error(
        `Restored payload failed recovery verification (${inventory.blockers.length} blocker(s)).`
      );
    }
    if (options.apply) {
      fs.renameSync(payload, target);
      const directory = fs.openSync(parent, fs.constants.O_RDONLY);
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
      applied = true;
    }
    return {
      applied,
      targetDirectory: target,
      inventory,
      verification: { ...verification, payloadVerified: true },
    };
  } finally {
    if (!applied) fs.rmSync(target, { recursive: true, force: true });
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

export const verifyRestoredBackup = async (
  targetDirectory: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<RecoveryInventory> => {
  const target = path.resolve(targetDirectory);
  assertPhysicalDirectory(target, 'Restored backup root');
  const inventory = await collectRestoreInventory(target, env);
  if (!inventory.restoreReady) {
    throw new Error(
      `Restored environment failed verification (${inventory.blockers.length} blocker(s)).`
    );
  }
  return inventory;
};
