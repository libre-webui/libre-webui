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

/**
 * Encryption service for sensitive data
 * Provides AES-256-GCM encryption for application-level encryption
 */
export class EncryptionService {
  private static instance: EncryptionService;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  private constructor() {
    // Get encryption key from environment or generate one
    const keyString = process.env.ENCRYPTION_KEY;
    if (keyString) {
      this.encryptionKey = Buffer.from(keyString, 'hex');
      if (this.encryptionKey.length !== 32) {
        throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
      }
    } else {
      // Generate a new key and log it (for development only)
      this.encryptionKey = crypto.randomBytes(32);
      console.warn(
        `⚠️  No ENCRYPTION_KEY provided. Generated key: ${this.encryptionKey.toString('hex')}`
      );
      console.warn('   Add this to your .env file for production use');
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
      console.error('Encryption error:', error);
      throw new Error('Failed to encrypt data');
    }
  }

  /**
   * Decrypt encrypted text data
   */
  public decrypt(encryptedData: string): string {
    if (!encryptedData || !encryptedData.includes(':')) {
      return encryptedData; // Return as-is if not encrypted
    }

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 3) {
        // Might be unencrypted data, return as-is for backward compatibility
        console.warn(
          'Decryption: Invalid format, treating as unencrypted data'
        );
        return encryptedData;
      }

      const [ivHex, authTagHex, encrypted] = parts;
      const iv = Buffer.from(ivHex, 'hex');
      const authTag = Buffer.from(authTagHex, 'hex');

      const decipher = crypto.createDecipheriv(
        this.algorithm,
        this.encryptionKey,
        iv
      );
      (decipher as crypto.DecipherGCM).setAuthTag(authTag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('Decryption error:', error);
      console.warn('Treating as unencrypted data for backward compatibility');
      return encryptedData; // Return original data if decryption fails
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
    return Boolean(data && data.includes(':') && data.split(':').length === 3);
  }

  /**
   * Generate a new encryption key
   */
  public static generateKey(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}

// Export singleton instance
export const encryptionService = EncryptionService.getInstance();
