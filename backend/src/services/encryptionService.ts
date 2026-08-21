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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createLogger } from '../utils/logger.js';
import {
  BACKEND_DIRECTORY,
  resolveDataDirectory,
} from '../utils/dataDirectory.js';

const logger = createLogger('encryption');

/**
 * Encryption service for sensitive data
 * Provides AES-256-GCM encryption for application-level encryption
 */
export class EncryptionService {
  private static instance: EncryptionService;
  private encryptionKey: Buffer;
  private readonly algorithm = 'aes-256-gcm' as const;
  private readonly binaryEnvelopeMagic = Buffer.from('LWB1', 'ascii');

  /**
   * Automatically add the encryption key to the .env file or persistent storage
   */
  private addKeyToStorage(encryptionKey: string): void {
    const isDocker = process.env.DOCKER_ENV === 'true';
    const hasDataDir = Boolean(process.env.DATA_DIR);

    if (isDocker || hasDataDir) {
      // In Docker or npx (DATA_DIR set), store key in persistent data directory
      this.saveKeyToPersistentStorage(encryptionKey);
    } else {
      // In regular dev environment, store in .env file
      this.saveKeyToEnvFile(encryptionKey);
    }
  }

  /**
   * Save encryption key to persistent data directory (for Docker)
   */
  private saveKeyToPersistentStorage(encryptionKey: string): void {
    try {
      const dataDir = resolveDataDirectory();
      const keyPath = path.join(dataDir, '.encryption_key');

      // Ensure data directory exists
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Write the key to persistent storage
      fs.writeFileSync(keyPath, encryptionKey, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(keyPath, 0o600);
      logger.info(
        `✅ Automatically saved ENCRYPTION_KEY to persistent storage: ${keyPath}`
      );
      logger.info('🔐 Encryption key will persist across container restarts');
    } catch (error) {
      logger.error(
        '❌ Failed to save ENCRYPTION_KEY to persistent storage:',
        error
      );
      throw new Error(
        'Unable to persist ENCRYPTION_KEY; refusing to continue with an ephemeral key'
      );
    }
  }

  /**
   * Find the .env file location - checks multiple possible locations
   */
  private findEnvFilePath(): string {
    return path.join(BACKEND_DIRECTORY, '.env');
  }

  /**
   * Save encryption key to .env file (for regular environments)
   */
  private saveKeyToEnvFile(encryptionKey: string): void {
    try {
      const envPath = this.findEnvFilePath();
      let envContent = '';

      // Read existing .env file if it exists
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');

        // Check if ENCRYPTION_KEY already exists (commented or uncommented)
        if (/^ENCRYPTION_KEY=/m.test(envContent)) {
          logger.warn(
            '⚠️  ENCRYPTION_KEY already exists in .env file, skipping auto-generation'
          );
          return;
        }

        // If there's a commented ENCRYPTION_KEY line, replace it with the actual key
        if (envContent.includes('# ENCRYPTION_KEY=')) {
          envContent = envContent.replace(
            /# ENCRYPTION_KEY=.*/,
            `ENCRYPTION_KEY=${encryptionKey}`
          );
          fs.writeFileSync(envPath, envContent, {
            encoding: 'utf8',
            mode: 0o600,
          });
          fs.chmodSync(envPath, 0o600);
          logger.info(
            `✅ Automatically added ENCRYPTION_KEY to .env file: ${envPath}`
          );
          return;
        }
      }

      // Add the encryption key to the content
      const keyLine = `\n# Database Encryption\n# 64-character encryption key for protecting sensitive data\nENCRYPTION_KEY=${encryptionKey}\n`;

      if (envContent && !envContent.endsWith('\n')) {
        envContent += '\n';
      }

      envContent += keyLine;

      // Write back to .env file
      fs.writeFileSync(envPath, envContent, {
        encoding: 'utf8',
        mode: 0o600,
      });
      fs.chmodSync(envPath, 0o600);
      logger.info(
        `✅ Automatically added ENCRYPTION_KEY to .env file: ${envPath}`
      );
    } catch (error) {
      logger.error(
        '❌ Failed to automatically add ENCRYPTION_KEY to .env file:',
        error
      );
      throw new Error(
        'Unable to persist ENCRYPTION_KEY; refusing to continue with an ephemeral key'
      );
    }
  }

  /**
   * Load encryption key from persistent storage (for Docker)
   */
  private loadKeyFromPersistentStorage(): string | null {
    try {
      const dataDir = resolveDataDirectory();
      const keyPath = path.join(dataDir, '.encryption_key');

      if (fs.existsSync(keyPath)) {
        const key = fs.readFileSync(keyPath, 'utf8').trim();
        if (key.length === 64) {
          logger.info(
            `✅ Loaded encryption key from persistent storage: ${keyPath}`
          );
          return key;
        }
      }
    } catch (error) {
      logger.warn(
        '⚠️  Failed to load encryption key from persistent storage:',
        error
      );
    }
    return null;
  }

  private constructor() {
    // Get encryption key from environment, persistent storage, or generate one
    let keyString = process.env.ENCRYPTION_KEY;

    // A persistent key is valid for every launch mode. Restricting this lookup
    // to Docker or an explicit DATA_DIR could generate a replacement key when
    // the same canonical data directory is opened from a different entrypoint.
    if (!keyString) {
      const persistentKey = this.loadKeyFromPersistentStorage();
      if (persistentKey) {
        keyString = persistentKey;
      }
    }

    if (keyString) {
      if (keyString.length !== 64) {
        throw new Error(
          `ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes). Current length: ${keyString.length}`
        );
      }
      this.encryptionKey = Buffer.from(keyString, 'hex');
      if (this.encryptionKey.length !== 32) {
        throw new Error('Invalid ENCRYPTION_KEY: hex decoding failed');
      }
    } else {
      // Generate a new key and automatically add it to appropriate storage
      this.encryptionKey = crypto.randomBytes(32);
      const newKeyString = this.encryptionKey.toString('hex');

      logger.warn('⚠️  No ENCRYPTION_KEY found. Generated a new key.');

      // Automatically add the key to appropriate storage (Docker/npx vs dev)
      try {
        this.addKeyToStorage(newKeyString);
      } catch (error) {
        this.encryptionKey.fill(0);
        throw error;
      }

      if (process.env.DOCKER_ENV === 'true' || process.env.DATA_DIR) {
        logger.info('🔐 Generated encryption key saved to persistent storage');
        logger.info('   Key will persist across restarts');
      } else {
        logger.info(
          '🔐 Generated encryption key has been automatically added to your .env file'
        );
        logger.info('   Restart the application to use the persistent key');
      }
    }
  }

  public static getInstance(): EncryptionService {
    if (!EncryptionService.instance) {
      EncryptionService.instance = new EncryptionService();
    }
    return EncryptionService.instance;
  }

  /**
   * Encrypt sensitive text data
   */
  public encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    try {
      const iv = crypto.randomBytes(16); // 16 bytes for AES
      const cipher = crypto.createCipheriv(
        this.algorithm,
        this.encryptionKey,
        iv
      );

      let encrypted = cipher.update(plaintext, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      const authTag = (cipher as crypto.CipherGCM).getAuthTag();

      // Combine IV, auth tag, and encrypted data
      return (
        iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted
      );
    } catch (error) {
      logger.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  private parseTextEnvelope(encryptedData: string): {
    iv: Buffer;
    authTag: Buffer;
    encrypted: string;
  } {
    const parts = encryptedData.split(':');
    const [ivHex, authTagHex, encrypted] = parts;
    if (
      parts.length !== 3 ||
      !ivHex ||
      !authTagHex ||
      encrypted === undefined ||
      !/^[a-fA-F0-9]{32}$/.test(ivHex) ||
      !/^[a-fA-F0-9]{32}$/.test(authTagHex) ||
      !/^(?:[a-fA-F0-9]{2})*$/.test(encrypted)
    ) {
      throw new Error('Invalid encrypted text data');
    }
    return {
      iv: Buffer.from(ivHex, 'hex'),
      authTag: Buffer.from(authTagHex, 'hex'),
      encrypted,
    };
  }

  /**
   * Decrypt a canonical text envelope without the legacy plaintext fallback.
   * Persistence boundaries use this form so a wrong key or damaged identity
   * value can never be returned to an API as if it were an email address.
   */
  public decryptAuthenticated(encryptedData: string): string {
    const { iv, authTag, encrypted } = this.parseTextEnvelope(encryptedData);
    try {
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        iv,
        { authTagLength: 16 }
      );
      (decipher as crypto.DecipherGCM).setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      logger.error('Authenticated text decryption failed');
      throw new Error('Failed to decrypt authenticated text data');
    }
  }

  /**
   * Decrypt encrypted text data
   */
  public decrypt(encryptedData: string): string {
    if (!encryptedData || !encryptedData.includes(':')) {
      // Data doesn't contain colons, likely unencrypted
      if (process.env.DEBUG_ENCRYPTION) {
        logger.debug(
          'Decryption: Data appears to be unencrypted (no colons found)'
        );
      }
      return encryptedData;
    }

    try {
      return this.decryptAuthenticated(encryptedData);
    } catch (error) {
      logger.error('Decryption error:', error);
      logger.warn('Treating as unencrypted data for backward compatibility');
      return encryptedData; // Return original data if decryption fails
    }
  }

  /**
   * Encrypt arbitrary bytes in a versioned AES-256-GCM envelope.
   *
   * Binary payloads must not be converted to text before encryption: doing so
   * can corrupt audio and other non-UTF-8 data. The envelope is self-checking
   * and intentionally has no plaintext fallback.
   */
  public encryptBuffer(plaintext: Buffer, additionalData?: Buffer): Buffer {
    try {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(
        this.algorithm,
        this.encryptionKey,
        iv
      ) as crypto.CipherGCM;
      if (additionalData) cipher.setAAD(additionalData);
      const encrypted = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      const authTag = cipher.getAuthTag();

      return Buffer.concat([this.binaryEnvelopeMagic, iv, authTag, encrypted]);
    } catch (error) {
      logger.error('Binary encryption error:', error);
      throw new Error('Failed to encrypt binary data');
    }
  }

  /**
   * Decrypt bytes produced by encryptBuffer(). Authentication failures are
   * fatal so corrupted or plaintext data can never be mistaken for a secret.
   */
  public decryptBuffer(encryptedData: Buffer, additionalData?: Buffer): Buffer {
    const magicLength = this.binaryEnvelopeMagic.length;
    const ivLength = 12;
    const authTagLength = 16;
    const minimumLength = magicLength + ivLength + authTagLength;

    if (
      encryptedData.length < minimumLength ||
      !encryptedData.subarray(0, magicLength).equals(this.binaryEnvelopeMagic)
    ) {
      throw new Error('Invalid encrypted binary data');
    }

    try {
      const ivStart = magicLength;
      const tagStart = ivStart + ivLength;
      const encryptedStart = tagStart + authTagLength;
      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        encryptedData.subarray(ivStart, tagStart),
        { authTagLength }
      ) as crypto.DecipherGCM;
      if (additionalData) decipher.setAAD(additionalData);
      decipher.setAuthTag(encryptedData.subarray(tagStart, encryptedStart));

      return Buffer.concat([
        decipher.update(encryptedData.subarray(encryptedStart)),
        decipher.final(),
      ]);
    } catch (error) {
      logger.error('Binary decryption error:', error);
      throw new Error('Failed to decrypt binary data');
    }
  }

  /**
   * Encrypt JSON objects
   */
  public encryptObject(obj: Record<string, unknown>): string {
    return this.encrypt(JSON.stringify(obj));
  }

  /**
   * Decrypt JSON objects
   */
  public decryptObject<T>(encryptedData: string): T {
    const decrypted = this.decrypt(encryptedData);
    return JSON.parse(decrypted);
  }

  /**
   * Check if data appears to be encrypted
   */
  public isEncrypted(data: string): boolean {
    try {
      this.parseTextEnvelope(data);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Produce an equality-only lookup token for an identity email. Randomized
   * ciphertext remains the stored value; this keyed token restores atomic
   * uniqueness without exposing the address or using deterministic encryption.
   */
  public lookupToken(plaintext: string): string {
    return crypto
      .createHmac('sha256', this.encryptionKey)
      .update('libre:identity-email:v1\0', 'utf8')
      .update(plaintext, 'utf8')
      .digest('hex');
  }

  /**
   * Domain-separated variant of {@link lookupToken} for other equality-only
   * lookups (MFA recovery codes, passkey credential ids, push endpoints).
   * The purpose string keeps tokens from one domain unusable in another.
   */
  public purposeLookupToken(purpose: string, plaintext: string): string {
    return crypto
      .createHmac('sha256', this.encryptionKey)
      .update(`libre:${purpose}:v1\0`, 'utf8')
      .update(plaintext, 'utf8')
      .digest('hex');
  }

  /**
   * Generate a new encryption key
   */
  public static generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Get the current encryption key (for first-time setup display)
   * WARNING: Only use this during first-time setup when showing the key to the admin
   */
  public getKeyForDisplay(): string {
    return this.encryptionKey.toString('hex');
  }
}

// Export singleton instance
export const encryptionService = EncryptionService.getInstance();
