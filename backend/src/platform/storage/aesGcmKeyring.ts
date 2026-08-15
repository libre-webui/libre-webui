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

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface AesGcmEnvelope {
  algorithm: 'A256GCM';
  keyId: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class StorageEncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageEncryptionError';
  }
}

const decodeBase64 = (
  value: string,
  expectedBytes: number | undefined,
  field: string
): Buffer => {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new StorageEncryptionError(`Invalid ${field} encoding`);
  }

  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new StorageEncryptionError(`Invalid ${field} encoding`);
  }
  if (expectedBytes !== undefined && decoded.length !== expectedBytes) {
    throw new StorageEncryptionError(`Invalid ${field} length`);
  }
  return decoded;
};

/**
 * Versioned AES-256-GCM keyring used by the storage foundations.
 *
 * Writes always use the active key. Reads select the key recorded in the
 * authenticated envelope, which permits deliberate key rotation without
 * silently falling back to plaintext or to the wrong key.
 */
export class Aes256GcmKeyring {
  readonly activeKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(activeKeyId: string, keys: Readonly<Record<string, Buffer>>) {
    if (!KEY_ID_PATTERN.test(activeKeyId)) {
      throw new StorageEncryptionError('Invalid active storage key ID');
    }

    const validatedKeys = new Map<string, Buffer>();
    for (const [keyId, key] of Object.entries(keys)) {
      if (!KEY_ID_PATTERN.test(keyId)) {
        throw new StorageEncryptionError(`Invalid storage key ID: ${keyId}`);
      }
      if (!Buffer.isBuffer(key) || key.length !== 32) {
        throw new StorageEncryptionError(
          `Storage key ${keyId} must contain exactly 32 bytes`
        );
      }
      validatedKeys.set(keyId, Buffer.from(key));
    }

    if (!validatedKeys.has(activeKeyId)) {
      throw new StorageEncryptionError(
        `Active storage key ${activeKeyId} is not configured`
      );
    }

    this.activeKeyId = activeKeyId;
    this.keys = validatedKeys;
  }

  encrypt(plaintext: Uint8Array, additionalData: Uint8Array): AesGcmEnvelope {
    const key = this.keys.get(this.activeKeyId);
    if (!key) {
      throw new StorageEncryptionError('Active storage key is unavailable');
    }

    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(additionalData);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);

    return {
      algorithm: 'A256GCM',
      keyId: this.activeKeyId,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  decrypt(envelope: AesGcmEnvelope, additionalData: Uint8Array): Buffer {
    if (
      envelope.algorithm !== 'A256GCM' ||
      !KEY_ID_PATTERN.test(envelope.keyId)
    ) {
      throw new StorageEncryptionError('Unsupported storage key envelope');
    }

    const key = this.keys.get(envelope.keyId);
    if (!key) {
      throw new StorageEncryptionError(
        `Storage key ${envelope.keyId} is unavailable`
      );
    }

    try {
      const iv = decodeBase64(envelope.iv, IV_BYTES, 'envelope IV');
      const tag = decodeBase64(envelope.tag, TAG_BYTES, 'authentication tag');
      const ciphertext = decodeBase64(
        envelope.ciphertext,
        undefined,
        'ciphertext'
      );
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(additionalData);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch (error) {
      if (error instanceof StorageEncryptionError) throw error;
      throw new StorageEncryptionError('Storage data authentication failed');
    }
  }
}

export const parseAesGcmEnvelope = (value: unknown): AesGcmEnvelope => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new StorageEncryptionError('Invalid storage key envelope');
  }

  const candidate = value as Partial<AesGcmEnvelope>;
  if (
    candidate.algorithm !== 'A256GCM' ||
    typeof candidate.keyId !== 'string' ||
    typeof candidate.iv !== 'string' ||
    typeof candidate.tag !== 'string' ||
    typeof candidate.ciphertext !== 'string'
  ) {
    throw new StorageEncryptionError('Invalid storage key envelope');
  }

  return {
    algorithm: candidate.algorithm,
    keyId: candidate.keyId,
    iv: candidate.iv,
    tag: candidate.tag,
    ciphertext: candidate.ciphertext,
  };
};
