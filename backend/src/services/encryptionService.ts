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

/**
 * Encryption service for sensitive data
 * Provides AES-256-GCM encryption for application-level encryption
 */
export class EncryptionService {
  private static instance: EncryptionService;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  /**
   * Automatically add the encryption key to the .env file
   */
  private addKeyToEnvFile(encryptionKey: string): void {
    try {
      const envPath = path.join(process.cwd(), '.env');
      let envContent = '';

      // Read existing .env file if it exists
      if (fs.existsSync(envPath)) {
        envContent = fs.readFileSync(envPath, 'utf8');

        // Check if ENCRYPTION_KEY already exists (shouldn't happen, but just in case)
        if (envContent.includes('ENCRYPTION_KEY=')) {
          console.warn(
            '⚠️  ENCRYPTION_KEY already exists in .env file, skipping auto-generation'
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
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.info(`✅ Automatically added ENCRYPTION_KEY to .env file`);
    } catch (error) {
      console.error(
        '❌ Failed to automatically add ENCRYPTION_KEY to .env file:',
        error
      );
      console.warn(
        '   Please manually add the following line to your .env file:'
      );
      console.warn(`   ENCRYPTION_KEY=${encryptionKey}`);
    }
  }

  private constructor() {
    // Get encryption key from environment or generate one
    const keyString = process.env.ENCRYPTION_KEY;
    if (keyString) {
      if (keyString.length !== 64) {
        throw new Error(
          'ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes)'
        );
      }
      this.encryptionKey = Buffer.from(keyString, 'hex');
      if (this.encryptionKey.length !== 32) {
        throw new Error('Invalid ENCRYPTION_KEY: hex decoding failed');
      }
    } else {
      // Generate a new key and automatically add it to .env file
      this.encryptionKey = crypto.randomBytes(32);
      const keyString = this.encryptionKey.toString('hex');

      console.warn(
        `⚠️  No ENCRYPTION_KEY provided. Generated key: ${keyString}`
      );

      // Automatically add the key to .env file
      this.addKeyToEnvFile(keyString);

      console.info(
        '🔐 Generated encryption key has been automatically added to your .env file'
      );
      console.info('   Restart the application to use the persistent key');
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
      // Data doesn't contain colons, likely unencrypted
      console.debug(
        'Decryption: Data appears to be unencrypted (no colons found)'
      );
      return encryptedData;
    }

    try {
      const parts = encryptedData.split(':');
      if (parts.length !== 3) {
        console.warn(
          `Decryption: Invalid format (expected 3 parts, got ${parts.length}), treating as unencrypted data`
        );
        return encryptedData;
      }

      const [ivHex, authTagHex, encrypted] = parts;

      // Validate hex format before attempting to convert
      if (!/^[a-fA-F0-9]+$/.test(ivHex) || !/^[a-fA-F0-9]+$/.test(authTagHex)) {
        console.warn(
          'Decryption: Invalid hex format, treating as unencrypted data'
        );
        return encryptedData;
      }

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
