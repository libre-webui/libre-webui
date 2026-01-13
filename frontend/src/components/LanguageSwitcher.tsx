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
import { Globe } from 'lucide-react';
import { supportedLanguages } from '@/i18n';

export const LanguageSwitcher: React.FC = () => {
  const { t, i18n } = useTranslation();

  const handleLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newLang = e.target.value;
    i18n.changeLanguage(newLang);
  };

  return (
    <div className='space-y-3'>
      <div className='flex items-center gap-2'>
        <Globe className='h-4 w-4 text-gray-500 dark:text-gray-400' />
        <h4 className='text-sm font-medium text-gray-900 dark:text-gray-100'>
          {t('settings.appearance.language.title')}
        </h4>
      </div>
      <p className='text-xs text-gray-500 dark:text-gray-400'>
        {t('settings.appearance.language.description')}
      </p>
      <select
        value={i18n.language}
        onChange={handleLanguageChange}
        className='w-full px-3 py-2 text-sm border border-gray-200 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-100 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500'
      >
        {supportedLanguages.map(lang => (
          <option key={lang.code} value={lang.code}>
            {lang.nativeName} ({lang.name})
          </option>
        ))}
      </select>
    </div>
  );
};

export default LanguageSwitcher;
