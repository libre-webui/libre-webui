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

/**
 * AES-256-GCM encryption utilities.
 *
 * Wraps the singleton EncryptionService so callers can do:
 *
 *   import { encrypt, decrypt } from './crypto.js';
 *   const cipher = encrypt(plaintext);
 *   const plain  = decrypt(cipher);
 *
 * The underlying implementation uses:
 *  - Algorithm : AES-256-GCM (authenticated encryption)
 *  - Key       : 32-byte key from ENCRYPTION_KEY env (64 hex chars)
 *  - IV        : 16 random bytes per encryption
 *  - Output    : "iv_hex:authTag_hex:ciphertext_hex"
 *
 * Sensitive fields (API keys, message content, file contents)
 * are encrypted on write and decrypted on read — callers don't
 * need to know about the underlying storage format.
 */

export {
  encryptionService,
  encryptionService as default,
  EncryptionService,
} from './services/encryptionService.js';

import {
  encryptionService,
  EncryptionService as _ES,
} from './services/encryptionService.js';

/** Encrypt a plaintext string with AES-256-GCM. */
export function encrypt(plaintext: string): string {
  return encryptionService.encrypt(plaintext);
}

/** Decrypt a ciphertext string produced by encrypt(). */
export function decrypt(ciphertext: string): string {
  return encryptionService.decrypt(ciphertext);
}

/** Encrypt a JSON-serialisable object. */
export function encryptObject(obj: Record<string, unknown>): string {
  return encryptionService.encryptObject(obj);
}

/** Decrypt back to a typed object. */
export function decryptObject<T>(ciphertext: string): T {
  return encryptionService.decryptObject<T>(ciphertext);
}

/** Check whether a string looks like encrypted data. */
export function isEncrypted(data: string): boolean {
  return encryptionService.isEncrypted(data);
}

/** Generate a fresh 32-byte hex key (for setup / key rotation). */
export { EncryptionService as _EncryptionService } from './services/encryptionService.js';
export function generateKey(): string {
  return _ES.generateKey();
}
