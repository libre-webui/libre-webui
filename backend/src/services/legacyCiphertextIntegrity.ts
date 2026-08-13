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

import crypto from 'node:crypto';
import { TextDecoder } from 'node:util';

import type Database from 'better-sqlite3';

const TEXT_IV_BYTES = 16;
const BINARY_IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const BINARY_MAGIC = Buffer.from('LWB1', 'ascii');
const DEFAULT_MAX_RECORDS = 1_000_000;
const DEFAULT_MAX_CIPHERTEXT_BYTES = 16 * 1024 * 1024 * 1024;
const DEFAULT_MAX_PLAINTEXT_BYTES = 16 * 1024 * 1024 * 1024;
const TEXT_ENVELOPE_PATTERN = new RegExp(
  `^[0-9a-fA-F]{${TEXT_IV_BYTES * 2}}:[0-9a-fA-F]{${AUTH_TAG_BYTES * 2}}:(?:[0-9a-fA-F]{2})*$`
);

interface TextFieldSpec {
  table: string;
  column: string;
  predicate?: string;
  requireEnvelope?: boolean;
}

const TEXT_FIELDS: readonly TextFieldSpec[] = [
  { table: 'users', column: 'email' },
  { table: 'sessions', column: 'title' },
  { table: 'sessions', column: 'settings' },
  { table: 'session_messages', column: 'content' },
  { table: 'session_messages', column: 'thinking' },
  { table: 'session_messages', column: 'provider_metadata' },
  { table: 'session_messages', column: 'images' },
  { table: 'session_messages', column: 'statistics' },
  { table: 'session_messages', column: 'artifacts' },
  { table: 'knowledge_collections', column: 'name' },
  { table: 'notes', column: 'title' },
  { table: 'notes', column: 'content' },
  { table: 'session_folders', column: 'name' },
  { table: 'user_preferences', column: 'value' },
  { table: 'documents', column: 'title' },
  { table: 'documents', column: 'content' },
  { table: 'documents', column: 'metadata' },
  { table: 'document_chunks', column: 'content' },
  { table: 'document_chunks', column: 'embedding' },
  { table: 'plugin_credentials', column: 'api_key' },
  {
    table: 'plugin_variables',
    column: 'variable_value',
    predicate: 'is_encrypted = 1',
    requireEnvelope: true,
  },
  { table: 'generated_images', column: 'prompt' },
  { table: 'generated_images', column: 'image_data' },
  { table: 'media_generation_jobs', column: 'prompt' },
] as const;

export interface LegacyCiphertextIntegrityLimits {
  /** Maximum populated legacy fields examined in one read snapshot. */
  maxRecords?: number;
  /** Maximum aggregate stored bytes examined in one read snapshot. */
  maxCiphertextBytes?: number;
  /** Maximum aggregate authenticated plaintext bytes. */
  maxPlaintextBytes?: number;
}

export interface LegacyCiphertextIntegrityVerificationOptions {
  /**
   * Recovery requires a complete v4 identity lookup backfill. Startup may
   * temporarily permit a missing token and a non-envelope legacy value after
   * the schema migration commits so the identity repository can finish the
   * encryption and deterministic-token backfill. Older releases accepted
   * arbitrary strings and used a blank value to clear this optional field.
   */
  requireIdentityLookupToken?: boolean;
}

export interface LegacyCiphertextIntegrityResult {
  verified: true;
  encryptedAuthenticated: true;
  records: number;
  textRecords: number;
  binaryRecords: number;
  ciphertextBytes: number;
  plaintextBytes: number;
}

export class LegacyCiphertextIntegrityError extends Error {
  constructor(
    readonly code: 'verification-limit' | 'integrity' | 'key-unavailable'
  ) {
    super('Legacy ciphertext recovery verification failed');
    this.name = 'LegacyCiphertextIntegrityError';
  }
}

interface ResolvedLimits {
  maxRecords: number;
  maxCiphertextBytes: number;
  maxPlaintextBytes: number;
}

interface Aggregate {
  records: number;
  bytes: number;
}

interface VoiceProfileRow {
  id: string;
  user_id: string;
  name: Buffer;
  reference_audio: Buffer;
  reference_text: Buffer | null;
}

const quoteIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`;

const positiveSafeInteger = (
  value: number | undefined,
  fallback: number
): number => {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new LegacyCiphertextIntegrityError('verification-limit');
  }
  return selected;
};

const resolveLimits = (
  limits: LegacyCiphertextIntegrityLimits
): ResolvedLimits => ({
  maxRecords: positiveSafeInteger(limits.maxRecords, DEFAULT_MAX_RECORDS),
  maxCiphertextBytes: positiveSafeInteger(
    limits.maxCiphertextBytes,
    DEFAULT_MAX_CIPHERTEXT_BYTES
  ),
  maxPlaintextBytes: positiveSafeInteger(
    limits.maxPlaintextBytes,
    DEFAULT_MAX_PLAINTEXT_BYTES
  ),
});

const addBounded = (left: number, right: number, maximum: number): number => {
  const result = left + right;
  if (!Number.isSafeInteger(result) || right < 0 || result > maximum) {
    throw new LegacyCiphertextIntegrityError('verification-limit');
  }
  return result;
};

const exactTextEnvelope = (value: string): boolean =>
  TEXT_ENVELOPE_PATTERN.test(value);

const resemblesTextEnvelope = (value: string): boolean => {
  const parts = value.split(':');
  if (parts.length !== 3) return false;
  const [iv, tag] = parts;
  // Once either fixed-width envelope field is present, malformed hex must not
  // turn authenticated data into an accepted legacy plaintext row.
  return iv.length === TEXT_IV_BYTES * 2 || tag.length === AUTH_TAG_BYTES * 2;
};

const resemblesEncryptedEmailEnvelope = (value: string): boolean => {
  const parts = value.split(':');
  return (
    parts.length === 3 &&
    (parts[0]?.length === TEXT_IV_BYTES * 2 ||
      parts[1]?.length === AUTH_TAG_BYTES * 2 ||
      parts.every(part => /^[a-fA-F0-9]*$/.test(part)))
  );
};

const decryptTextStrict = (value: string, key: Buffer): Buffer => {
  if (!exactTextEnvelope(value)) {
    throw new LegacyCiphertextIntegrityError('integrity');
  }
  const [ivHex, authTagHex, ciphertextHex] = value.split(':');
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(ivHex, 'hex')
    ) as crypto.DecipherGCM;
    decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextHex, 'hex')),
      decipher.final(),
    ]);
  } catch {
    throw new LegacyCiphertextIntegrityError('integrity');
  }
};

const decryptBinaryStrict = (
  value: Buffer,
  key: Buffer,
  additionalData: Buffer
): Buffer => {
  const minimumBytes = BINARY_MAGIC.length + BINARY_IV_BYTES + AUTH_TAG_BYTES;
  if (
    value.length < minimumBytes ||
    !value.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)
  ) {
    throw new LegacyCiphertextIntegrityError('integrity');
  }
  const ivStart = BINARY_MAGIC.length;
  const tagStart = ivStart + BINARY_IV_BYTES;
  const ciphertextStart = tagStart + AUTH_TAG_BYTES;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      value.subarray(ivStart, tagStart)
    ) as crypto.DecipherGCM;
    decipher.setAAD(additionalData);
    decipher.setAuthTag(value.subarray(tagStart, ciphertextStart));
    return Buffer.concat([
      decipher.update(value.subarray(ciphertextStart)),
      decipher.final(),
    ]);
  } catch {
    throw new LegacyCiphertextIntegrityError('integrity');
  }
};

const tableColumns = (
  database: Database.Database,
  table: string,
  tables: ReadonlySet<string>
): ReadonlySet<string> => {
  if (!tables.has(table)) return new Set();
  return new Set(
    (
      database
        .prepare(`PRAGMA table_info(${quoteIdentifier(table)})`)
        .all() as Array<{ name: string }>
    ).map(column => column.name)
  );
};

/**
 * Authenticates every recognizable legacy AES-GCM field and every saved voice
 * envelope without returning or logging plaintext. Plaintext rows from older
 * schema generations remain compatible, except fields carrying an explicit
 * encrypted marker and voice-profile fields whose schema requires envelopes.
 */
export const verifyLegacyCiphertextIntegrity = (
  database: Database.Database,
  encryptionKey: Buffer | undefined,
  limits: LegacyCiphertextIntegrityLimits = {},
  options: LegacyCiphertextIntegrityVerificationOptions = {}
): LegacyCiphertextIntegrityResult => {
  const resolvedLimits = resolveLimits(limits);
  const requireIdentityLookupToken = options.requireIdentityLookupToken ?? true;
  if (encryptionKey && encryptionKey.length !== 32) {
    throw new LegacyCiphertextIntegrityError('key-unavailable');
  }
  const key = encryptionKey ? Buffer.from(encryptionKey) : undefined;

  try {
    return database.transaction(() => {
      const tables = new Set(
        (
          database
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
            )
            .all() as Array<{ name: string }>
        ).map(row => row.name)
      );
      const columnCache = new Map<string, ReadonlySet<string>>();
      const columnsFor = (table: string): ReadonlySet<string> => {
        const cached = columnCache.get(table);
        if (cached) return cached;
        const columns = tableColumns(database, table, tables);
        columnCache.set(table, columns);
        return columns;
      };
      const selectedTextFields = TEXT_FIELDS.filter(spec => {
        const columns = columnsFor(spec.table);
        if (!columns.has(spec.column)) return false;
        // Identity email has stricter damaged-envelope handling in every
        // schema generation and, from v4 onward, a keyed lookup invariant.
        if (spec.table === 'users' && spec.column === 'email') return false;
        return !spec.predicate || columns.has('is_encrypted');
      });
      const verifyIdentityEmails = columnsFor('users').has('email');
      const verifyEmailLookups = columnsFor('users').has('email_lookup');
      const voiceColumns = columnsFor('voice_profiles');
      const verifyVoiceProfiles = [
        'id',
        'user_id',
        'name',
        'reference_audio',
        'reference_text',
      ].every(column => voiceColumns.has(column));

      let selectedRecords = 0;
      let selectedBytes = 0;
      for (const spec of selectedTextFields) {
        const table = quoteIdentifier(spec.table);
        const column = quoteIdentifier(spec.column);
        const where = `${column} IS NOT NULL AND LENGTH(${column}) > 0${spec.predicate ? ` AND ${spec.predicate}` : ''}`;
        const aggregate = database
          .prepare(
            `SELECT COUNT(*) AS records, COALESCE(SUM(LENGTH(CAST(${column} AS BLOB))), 0) AS bytes FROM ${table} WHERE ${where}`
          )
          .get() as Aggregate;
        selectedRecords = addBounded(
          selectedRecords,
          Number(aggregate.records),
          resolvedLimits.maxRecords
        );
        selectedBytes = addBounded(
          selectedBytes,
          Number(aggregate.bytes),
          resolvedLimits.maxCiphertextBytes
        );
      }
      if (verifyIdentityEmails) {
        const aggregate = database
          .prepare(
            `SELECT COUNT(*) AS records,
                    COALESCE(SUM(COALESCE(LENGTH(CAST(email AS BLOB)), 0) +
                                 ${verifyEmailLookups ? 'COALESCE(LENGTH(CAST(email_lookup AS BLOB)), 0)' : '0'}), 0) AS bytes
             FROM users
             WHERE email IS NOT NULL${verifyEmailLookups ? ' OR email_lookup IS NOT NULL' : ''}`
          )
          .get() as Aggregate;
        selectedRecords = addBounded(
          selectedRecords,
          Number(aggregate.records),
          resolvedLimits.maxRecords
        );
        selectedBytes = addBounded(
          selectedBytes,
          Number(aggregate.bytes),
          resolvedLimits.maxCiphertextBytes
        );
      }
      if (verifyVoiceProfiles) {
        const aggregate = database
          .prepare(
            `SELECT
               COUNT(name) + COUNT(reference_audio) + COUNT(reference_text) AS records,
               COALESCE(SUM(LENGTH(name) + LENGTH(reference_audio) + COALESCE(LENGTH(reference_text), 0)), 0) AS bytes
             FROM voice_profiles`
          )
          .get() as Aggregate;
        selectedRecords = addBounded(
          selectedRecords,
          Number(aggregate.records),
          resolvedLimits.maxRecords
        );
        selectedBytes = addBounded(
          selectedBytes,
          Number(aggregate.bytes),
          resolvedLimits.maxCiphertextBytes
        );
      }

      let textRecords = 0;
      let binaryRecords = 0;
      let ciphertextBytes = 0;
      let plaintextBytes = 0;
      const fatalUtf8 = new TextDecoder('utf-8', { fatal: true });
      const authenticateText = (value: string): void => {
        if (!key) {
          throw new LegacyCiphertextIntegrityError('key-unavailable');
        }
        const plaintext = decryptTextStrict(value, key);
        try {
          textRecords += 1;
          ciphertextBytes = addBounded(
            ciphertextBytes,
            Buffer.byteLength(value, 'utf8'),
            resolvedLimits.maxCiphertextBytes
          );
          plaintextBytes = addBounded(
            plaintextBytes,
            plaintext.length,
            resolvedLimits.maxPlaintextBytes
          );
        } catch (error) {
          if (error instanceof LegacyCiphertextIntegrityError) throw error;
          throw new LegacyCiphertextIntegrityError('integrity');
        } finally {
          plaintext.fill(0);
        }
      };
      const authenticateBinary = (
        value: unknown,
        additionalData: Buffer
      ): void => {
        if (!Buffer.isBuffer(value) || !key) {
          throw new LegacyCiphertextIntegrityError(
            key ? 'integrity' : 'key-unavailable'
          );
        }
        const plaintext = decryptBinaryStrict(value, key, additionalData);
        try {
          binaryRecords += 1;
          ciphertextBytes = addBounded(
            ciphertextBytes,
            value.length,
            resolvedLimits.maxCiphertextBytes
          );
          plaintextBytes = addBounded(
            plaintextBytes,
            plaintext.length,
            resolvedLimits.maxPlaintextBytes
          );
        } catch (error) {
          if (error instanceof LegacyCiphertextIntegrityError) throw error;
          throw new LegacyCiphertextIntegrityError('integrity');
        } finally {
          plaintext.fill(0);
          additionalData.fill(0);
        }
      };

      for (const spec of selectedTextFields) {
        const table = quoteIdentifier(spec.table);
        const column = quoteIdentifier(spec.column);
        const where = `${column} IS NOT NULL AND LENGTH(${column}) > 0${spec.predicate ? ` AND ${spec.predicate}` : ''}`;
        const rows = database
          .prepare(`SELECT ${column} AS value FROM ${table} WHERE ${where}`)
          .iterate() as Iterable<{ value: unknown }>;
        for (const row of rows) {
          if (typeof row.value !== 'string') {
            throw new LegacyCiphertextIntegrityError('integrity');
          }
          if (exactTextEnvelope(row.value)) {
            authenticateText(row.value);
          } else if (spec.requireEnvelope || resemblesTextEnvelope(row.value)) {
            throw new LegacyCiphertextIntegrityError('integrity');
          }
        }
      }

      if (verifyIdentityEmails) {
        const rows = database
          .prepare(
            `SELECT email, ${verifyEmailLookups ? 'email_lookup' : 'NULL AS email_lookup'}
             FROM users
             WHERE email IS NOT NULL${verifyEmailLookups ? ' OR email_lookup IS NOT NULL' : ''}
             ORDER BY id`
          )
          .iterate() as Iterable<{
          email: unknown;
          email_lookup: unknown;
        }>;
        for (const row of rows) {
          if (row.email === null) {
            if (row.email_lookup !== null) {
              throw new LegacyCiphertextIntegrityError('integrity');
            }
            continue;
          }
          if (
            typeof row.email !== 'string' ||
            (!verifyEmailLookups && row.email_lookup !== null) ||
            (row.email_lookup !== null &&
              (typeof row.email_lookup !== 'string' ||
                !/^[0-9a-f]{64}$/.test(row.email_lookup))) ||
            (verifyEmailLookups &&
              row.email_lookup === null &&
              requireIdentityLookupToken)
          ) {
            throw new LegacyCiphertextIntegrityError('integrity');
          }
          if (!verifyEmailLookups) {
            if (exactTextEnvelope(row.email)) {
              authenticateText(row.email);
            } else if (resemblesEncryptedEmailEnvelope(row.email)) {
              throw new LegacyCiphertextIntegrityError('integrity');
            }
            continue;
          }
          const permitInterruptedPlaintext =
            !requireIdentityLookupToken && row.email_lookup === null;
          if (!exactTextEnvelope(row.email)) {
            if (
              !permitInterruptedPlaintext ||
              resemblesEncryptedEmailEnvelope(row.email)
            ) {
              throw new LegacyCiphertextIntegrityError('integrity');
            }
            // The identity repository will preserve and encrypt this legacy
            // value, or normalize it to NULL when blank, before serving.
            continue;
          }
          if (!key) {
            throw new LegacyCiphertextIntegrityError('key-unavailable');
          }
          const plaintext = decryptTextStrict(row.email, key);
          try {
            const decodedEmail = fatalUtf8.decode(plaintext);
            const expectedLookup = crypto
              .createHmac('sha256', key)
              .update('libre:identity-email:v1\0', 'utf8')
              .update(decodedEmail, 'utf8')
              .digest();
            if (typeof row.email_lookup === 'string') {
              const storedLookup = Buffer.from(row.email_lookup, 'hex');
              if (!crypto.timingSafeEqual(expectedLookup, storedLookup)) {
                throw new LegacyCiphertextIntegrityError('integrity');
              }
            }
            textRecords += 1;
            ciphertextBytes = addBounded(
              ciphertextBytes,
              Buffer.byteLength(row.email, 'utf8'),
              resolvedLimits.maxCiphertextBytes
            );
            plaintextBytes = addBounded(
              plaintextBytes,
              plaintext.length,
              resolvedLimits.maxPlaintextBytes
            );
          } catch (error) {
            if (error instanceof LegacyCiphertextIntegrityError) throw error;
            throw new LegacyCiphertextIntegrityError('integrity');
          } finally {
            plaintext.fill(0);
          }
        }
      }

      if (verifyVoiceProfiles) {
        const rows = database
          .prepare(
            `SELECT id, user_id, name, reference_audio, reference_text
             FROM voice_profiles
             ORDER BY id`
          )
          .iterate() as Iterable<VoiceProfileRow>;
        for (const row of rows) {
          if (typeof row.id !== 'string' || typeof row.user_id !== 'string') {
            throw new LegacyCiphertextIntegrityError('integrity');
          }
          authenticateBinary(
            row.name,
            Buffer.from(`voice-profile:${row.id}:${row.user_id}:name`, 'utf8')
          );
          authenticateBinary(
            row.reference_audio,
            Buffer.from(`voice-profile:${row.id}:${row.user_id}:audio`, 'utf8')
          );
          if (row.reference_text !== null) {
            authenticateBinary(
              row.reference_text,
              Buffer.from(
                `voice-profile:${row.id}:${row.user_id}:transcript`,
                'utf8'
              )
            );
          }
        }
      }

      const records = textRecords + binaryRecords;
      if (!Number.isSafeInteger(records)) {
        throw new LegacyCiphertextIntegrityError('verification-limit');
      }
      return {
        verified: true,
        encryptedAuthenticated: true,
        records,
        textRecords,
        binaryRecords,
        ciphertextBytes,
        plaintextBytes,
      } as const;
    })();
  } catch (error) {
    if (error instanceof LegacyCiphertextIntegrityError) throw error;
    throw new LegacyCiphertextIntegrityError('integrity');
  } finally {
    key?.fill(0);
  }
};
