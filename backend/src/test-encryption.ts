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

import { encryptionService } from './services/encryptionService.js';
import { createLogger } from './utils/logger.js';

const logger = createLogger('encryption-test');

try {
  logger.info('Testing Database Encryption Service');
  logger.info('=====================================');

  // Test basic encryption/decryption
  const testData = 'Hello, this is sensitive data!';
  logger.info('Original:', testData);

  const encrypted = encryptionService.encrypt(testData);
  logger.info('Encrypted:', encrypted);

  const decrypted = encryptionService.decrypt(encrypted);
  logger.info('Decrypted:', decrypted);

  logger.info(
    'Basic encryption test:',
    testData === decrypted ? 'PASSED' : 'FAILED'
  );

  // Test object encryption
  const testObject = {
    message: 'Secret message',
    artifacts: [{ type: 'code', content: 'logger.debug("secret");' }],
    images: [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    ],
    statistics: { tokens: 150, duration: 1200 },
  };

  logger.info('Testing object encryption');
  logger.info('Original object:', JSON.stringify(testObject, null, 2));

  const encryptedObject = encryptionService.encryptObject(testObject);
  logger.info('Encrypted object:', encryptedObject);

  const decryptedObject = encryptionService.decryptObject(encryptedObject);
  logger.info('Decrypted object:', JSON.stringify(decryptedObject, null, 2));

  logger.info(
    'Object encryption test:',
    JSON.stringify(testObject) === JSON.stringify(decryptedObject)
      ? 'PASSED'
      : 'FAILED'
  );

  // Test empty/null values
  logger.info('Testing edge cases');
  try {
    const nullTest = encryptionService.encrypt('');
    const nullDecrypted = encryptionService.decrypt(nullTest);
    logger.info(
      'Empty string test:',
      nullDecrypted === '' ? 'PASSED' : 'FAILED'
    );
  } catch (error) {
    logger.error('Empty string test failed:', (error as Error).message);
  }

  logger.info('Encryption service is ready for production');
  logger.info(
    'All sensitive data will be encrypted before storage in the database.'
  );
} catch (error) {
  logger.error('Error running encryption tests:', error);
  process.exit(1);
}
