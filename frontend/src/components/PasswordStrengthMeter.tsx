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

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';
import { cn } from '@/utils';
import {
  PASSWORD_REQUIREMENTS,
  evaluatePasswordStrength,
} from '@/utils/passwordPolicy';

const LEVEL_BAR_CLASSES: Record<string, string> = {
  weak: 'bg-red-500',
  fair: 'bg-amber-500',
  good: 'bg-lime-500',
  strong: 'bg-green-500',
};

const LEVEL_TEXT_CLASSES: Record<string, string> = {
  weak: 'text-red-600 dark:text-red-400',
  fair: 'text-amber-600 dark:text-amber-400',
  good: 'text-lime-600 dark:text-lime-400',
  strong: 'text-green-600 dark:text-green-400',
};

const CheckRow: React.FC<{ met: boolean; label: string }> = ({
  met,
  label,
}) => (
  <li
    className={cn(
      'flex items-center gap-1.5',
      met
        ? 'text-green-600 dark:text-green-400'
        : 'text-gray-500 dark:text-dark-500'
    )}
  >
    {met ? (
      <Check className='h-3 w-3 shrink-0' aria-hidden='true' />
    ) : (
      <X className='h-3 w-3 shrink-0' aria-hidden='true' />
    )}
    <span>{label}</span>
  </li>
);

/**
 * Live password feedback for every surface that sets a new password: a
 * four-segment strength bar plus the policy checklist, so nobody learns
 * about the 12-character rule from a rejection. Renders the static
 * requirements sentence until the user starts typing.
 */
export const PasswordStrengthMeter: React.FC<{ password: string }> = ({
  password,
}) => {
  const { t } = useTranslation();

  if (!password) {
    return (
      <p className='mt-1.5 text-xs text-gray-500 dark:text-dark-500'>
        {PASSWORD_REQUIREMENTS}
      </p>
    );
  }

  const strength = evaluatePasswordStrength(password);
  return (
    <div
      className='mt-2 space-y-1.5'
      data-testid='password-strength-meter'
      aria-live='polite'
    >
      <div className='flex items-center gap-2'>
        <div className='flex flex-1 gap-1'>
          {[1, 2, 3, 4].map(segment => (
            <div
              key={segment}
              className={cn(
                'h-1 flex-1 rounded-full transition-colors motion-reduce:transition-none',
                segment <= strength.score
                  ? LEVEL_BAR_CLASSES[strength.level]
                  : 'bg-gray-200 dark:bg-dark-300'
              )}
            />
          ))}
        </div>
        <span
          data-testid='password-strength-label'
          className={cn(
            'text-xs font-medium',
            LEVEL_TEXT_CLASSES[strength.level]
          )}
        >
          {t(`passwordStrength.levels.${strength.level}`)}
        </span>
      </div>
      <ul className='space-y-0.5 text-xs'>
        <CheckRow
          met={strength.checks.minLength}
          label={t('passwordStrength.checks.minLength')}
        />
        <CheckRow
          met={strength.checks.hasCase}
          label={t('passwordStrength.checks.hasCase')}
        />
        <CheckRow
          met={strength.checks.hasNumber}
          label={t('passwordStrength.checks.hasNumber')}
        />
        {!strength.checks.withinBytes && (
          <CheckRow met={false} label={t('passwordStrength.checks.tooLong')} />
        )}
      </ul>
    </div>
  );
};

export default PasswordStrengthMeter;
