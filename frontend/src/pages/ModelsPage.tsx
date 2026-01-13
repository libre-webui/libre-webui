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
import { ModelManager } from '@/components/ModelManager';

export const ModelsPage: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-6xl mx-auto p-6'>
        {/* Header - matching PersonasPage style */}
        <div className='text-center max-w-md mx-auto mb-8'>
          <h2
            className='libre-brand text-4xl sm:text-5xl font-normal text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa] mb-3'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            {t('models.title')}
          </h2>
          <p className='text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3] leading-relaxed'>
            {t('models.subtitle')}
          </p>
        </div>

        <ModelManager />
      </div>
    </div>
  );
};

export default ModelsPage;
