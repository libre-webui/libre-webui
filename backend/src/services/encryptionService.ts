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
import { fileURLToPath } from 'url';

// ESM __dirname equivalent
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Encryption service for sensitive data
 * Provides AES-256-GCM encryption for application-level encryption
 */
export class EncryptionService {
  private static instance: EncryptionService;
  private encryptionKey: Buffer;
  private algorithm = 'aes-256-gcm';

  /**
   * Automatically add the encryption key to the .env file or persistent storage
   */
  private addKeyToEnvFile(encryptionKey: string): void {
    const isDocker = process.env.DOCKER_ENV === 'true';

    if (isDocker) {
      // In Docker, store key in persistent data directory
      this.saveKeyToPersistentStorage(encryptionKey);
    } else {
      // In regular environment, store in .env file
      this.saveKeyToEnvFile(encryptionKey);
    }
  }

  /**
   * Save encryption key to persistent data directory (for Docker)
   */
  private saveKeyToPersistentStorage(encryptionKey: string): void {
    try {
      const dataDir =
        process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
      const keyPath = path.join(dataDir, '.encryption_key');

      // Ensure data directory exists
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      // Write the key to persistent storage
      fs.writeFileSync(keyPath, encryptionKey, 'utf8');
      console.info(
        `✅ Automatically saved ENCRYPTION_KEY to persistent storage: ${keyPath}`
      );
      console.info('🔐 Encryption key will persist across container restarts');
    } catch (error) {
      console.error(
        '❌ Failed to save ENCRYPTION_KEY to persistent storage:',
        error
      );
      console.warn(
        '   Please set ENCRYPTION_KEY environment variable manually:'
      );
      console.warn(`   ENCRYPTION_KEY=${encryptionKey}`);
    }
  }

  /**
   * Find the .env file location - checks multiple possible locations
   */
  private findEnvFilePath(): string {
    // Possible .env file locations in order of priority
    const possiblePaths = [
      path.join(process.cwd(), 'backend', '.env'), // Running from project root (npm run dev)
      path.join(process.cwd(), '.env'), // Running from backend directory
      path.join(__dirname, '..', '..', '.env'), // Relative to this file (backend/src/services -> backend/)
    ];

    // Find the first existing .env file
    for (const envPath of possiblePaths) {
      if (fs.existsSync(envPath)) {
        return envPath;
      }
    }

    // If no .env exists, prefer the backend/.env location if backend dir exists
    const backendEnvPath = path.join(process.cwd(), 'backend', '.env');
    const backendDir = path.dirname(backendEnvPath);
    if (fs.existsSync(backendDir)) {
      return backendEnvPath;
    }

    // Fallback to cwd/.env
    return path.join(process.cwd(), '.env');
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
          console.warn(
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
          fs.writeFileSync(envPath, envContent, 'utf8');
          console.info(
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
      fs.writeFileSync(envPath, envContent, 'utf8');
      console.info(
        `✅ Automatically added ENCRYPTION_KEY to .env file: ${envPath}`
      );
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

  /**
   * Load encryption key from persistent storage (for Docker)
   */
  private loadKeyFromPersistentStorage(): string | null {
    try {
      const dataDir =
        process.env.DATA_DIR || path.join(process.cwd(), 'backend', 'data');
      const keyPath = path.join(dataDir, '.encryption_key');

      if (fs.existsSync(keyPath)) {
        const key = fs.readFileSync(keyPath, 'utf8').trim();
        if (key.length === 64) {
          console.info(
            `✅ Loaded encryption key from persistent storage: ${keyPath}`
          );
          return key;
        }
      }
    } catch (error) {
      console.warn(
        '⚠️  Failed to load encryption key from persistent storage:',
        error
      );
    }
    return null;
  }

  private constructor() {
    // Get encryption key from environment, persistent storage, or generate one
    let keyString = process.env.ENCRYPTION_KEY;

    // If no environment variable, try loading from persistent storage in Docker
    if (!keyString && process.env.DOCKER_ENV === 'true') {
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

      console.warn(
        `⚠️  No ENCRYPTION_KEY found. Generated key: ${newKeyString}`
      );

      // Automatically add the key to appropriate storage (Docker vs regular)
      this.addKeyToEnvFile(newKeyString);

      if (process.env.DOCKER_ENV === 'true') {
        console.info('🔐 Generated encryption key saved to persistent storage');
        console.info('   Key will persist across container restarts');
      } else {
        console.info(
          '🔐 Generated encryption key has been automatically added to your .env file'
        );
        console.info('   Restart the application to use the persistent key');
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
      if (process.env.DEBUG_ENCRYPTION) {
        console.debug(
          'Decryption: Data appears to be unencrypted (no colons found)'
        );
      }
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
