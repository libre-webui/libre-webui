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

/** Translation key for the one-sentence policy summary. */
export const PASSWORD_REQUIREMENTS_KEY = 'passwordStrength.requirements';

export interface PasswordStrength {
  checks: {
    minLength: boolean;
    withinBytes: boolean;
    hasCase: boolean;
    hasNumber: boolean;
  };
  /** Every policy requirement is met (submission would pass). */
  satisfied: boolean;
  /** 0 = empty/very weak … 4 = strong. */
  score: 0 | 1 | 2 | 3 | 4;
  level: 'weak' | 'fair' | 'good' | 'strong';
}

/** Live evaluation for the strength meter; mirrors getPasswordPolicyError. */
export const evaluatePasswordStrength = (
  password: string
): PasswordStrength => {
  const checks = {
    minLength: password.length >= 12,
    withinBytes: new TextEncoder().encode(password).length <= 72,
    hasCase: /[A-Z]/.test(password) && /[a-z]/.test(password),
    hasNumber: /[0-9]/.test(password),
  };
  const satisfied =
    checks.minLength &&
    checks.withinBytes &&
    checks.hasCase &&
    checks.hasNumber;
  const met =
    Number(checks.minLength) +
    Number(checks.hasCase) +
    Number(checks.hasNumber);
  const hasExtra = password.length >= 16 || /[^A-Za-z0-9]/.test(password);
  let score: PasswordStrength['score'];
  if (!checks.withinBytes) {
    score = 1;
  } else if (met <= 1) {
    score = password.length > 0 ? 1 : 0;
  } else if (met === 2) {
    score = 2;
  } else {
    score = hasExtra ? 4 : 3;
  }
  const level =
    score <= 1
      ? 'weak'
      : score === 2
        ? 'fair'
        : score === 3
          ? 'good'
          : 'strong';
  return { checks, satisfied, score, level };
};

/**
 * The first policy violation as a translation key, or null when the password
 * passes. Callers translate it, since this module has no i18n context.
 */
export const getPasswordPolicyErrorKey = (password: string): string | null => {
  if (password.length < 12) return 'passwordStrength.errors.minLength';
  if (new TextEncoder().encode(password).length > 72) {
    return 'passwordStrength.errors.tooLong';
  }
  if (!/[A-Z]/.test(password)) return 'passwordStrength.errors.uppercase';
  if (!/[a-z]/.test(password)) return 'passwordStrength.errors.lowercase';
  if (!/[0-9]/.test(password)) return 'passwordStrength.errors.number';
  return null;
};
