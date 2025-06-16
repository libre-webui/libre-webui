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
import { ModelManager } from '@/components/ModelManager';

export const ModelsPage: React.FC = () => {
  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-6xl mx-auto p-6'>
        <div className='mb-8'>
          <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100 mb-2'>
            Model Management
          </h1>
          <p className='text-gray-700 dark:text-gray-300'>
            Manage your Ollama models, download new ones, and monitor system
            resources.
          </p>
        </div>

        <ModelManager />
      </div>
    </div>
  );
};

export default ModelsPage;
