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
import { PersonaManager } from '@/components/PersonaManager';
import { Brain } from 'lucide-react';

export const PersonasPage: React.FC = () => {
  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-6xl mx-auto p-6'>
        {/* Header */}
        <div className='mb-8'>
          <div className='flex items-center gap-3 mb-4'>
            <div className='p-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-lg'>
              <Brain className='h-6 w-6 text-white' />
            </div>
            <div>
              <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100'>
                Persona Development Framework
              </h1>
              <p className='text-gray-700 dark:text-gray-300 mt-1'>
                Create, manage, and customize AI personas with advanced memory,
                adaptive learning, and tailored personalities.
              </p>
            </div>
          </div>

          {/* Features Banner */}
          <div className='bg-gradient-to-r from-blue-50 to-purple-50 dark:from-blue-900/20 dark:to-purple-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-6'>
            <div className='grid grid-cols-1 md:grid-cols-3 gap-6 text-sm'>
              <div className='flex items-start gap-3'>
                <div className='p-2 bg-blue-500 rounded-lg'>
                  <Brain className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-blue-900 dark:text-blue-400 mb-1'>
                    Semantic Memory
                  </h3>
                  <p className='text-blue-800 dark:text-blue-300 text-xs'>
                    Personas remember and learn from past conversations with
                    intelligent context retrieval
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3'>
                <div className='p-2 bg-purple-500 rounded-lg'>
                  <Brain className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-purple-900 dark:text-purple-400 mb-1'>
                    Adaptive Learning
                  </h3>
                  <p className='text-purple-800 dark:text-purple-300 text-xs'>
                    Behavior evolves based on user interactions and preferences
                    over time
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3'>
                <div className='p-2 bg-green-500 rounded-lg'>
                  <Brain className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-green-900 dark:text-green-400 mb-1'>
                    DNA Export/Import
                  </h3>
                  <p className='text-green-800 dark:text-green-300 text-xs'>
                    Share complete persona packages including memories and
                    learned behaviors
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>

        <PersonaManager />
      </div>
    </div>
  );
};

export default PersonasPage;
