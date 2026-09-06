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
import { ChevronDown } from 'lucide-react';
import { cn } from '@/utils';
import {
  changeAppLanguage,
  normalizeLanguageCode,
  supportedLanguages,
} from '@/i18n';

/**
 * Language setting row: label and description on the left, a pill-shaped
 * select on the right.
 */
export const LanguageSwitcher: React.FC<{ compact?: boolean }> = ({
  compact = false,
}) => {
  const { t, i18n } = useTranslation();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    void changeAppLanguage(newLang);
  };

  return (
    <div className={cn('flex items-center gap-4', !compact && 'py-4')}>
      <div className={cn('min-w-0 flex-1', compact && 'sr-only')}>
        <h4 className='text-sm leading-[22px] text-ink'>
          {t('settings.appearance.language.title')}
        </h4>
        <p className='mt-0.5 text-xs text-ink-subtle'>
          {t('settings.appearance.language.description')}
        </p>
      </div>
      <div className='relative shrink-0'>
        <select
          data-testid='language-switcher-select'
          aria-label={t('settings.appearance.language.title')}
          value={normalizeLanguageCode(i18n.language)}
          onChange={handleLanguageChange}
          className={cn(
            compact ? 'max-w-[140px]' : 'max-w-[220px]',
            'h-9 cursor-pointer appearance-none rounded-full bg-surface-subtle pe-9 ps-3.5 text-sm text-ink transition-colors hover:bg-hover-solid focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
          )}
        >
          {supportedLanguages.map(lang => (
            <option key={lang.code} value={lang.code}>
              {compact ? lang.nativeName : `${lang.nativeName} (${lang.name})`}
            </option>
          ))}
        </select>
        <ChevronDown className='pointer-events-none absolute end-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted' />
      </div>
    </div>
  );
};

export default LanguageSwitcher;
