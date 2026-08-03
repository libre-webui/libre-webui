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

export const PASSWORD_REQUIREMENTS =
  'Use at least 12 characters, no more than 72 UTF-8 bytes, with uppercase, lowercase, and a number.';

export const getPasswordPolicyError = (password: string): string | null => {
  if (password.length < 12) return 'Password must be at least 12 characters.';
  if (new TextEncoder().encode(password).length > 72) {
    return 'Password must be no more than 72 UTF-8 bytes.';
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password must contain an uppercase letter.';
  }
  if (!/[a-z]/.test(password)) {
    return 'Password must contain a lowercase letter.';
  }
  if (!/[0-9]/.test(password)) return 'Password must contain a number.';
  return null;
};
