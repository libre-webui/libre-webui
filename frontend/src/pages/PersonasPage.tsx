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
import { Brain, Database, TrendingUp, Download } from 'lucide-react';

export const PersonasPage: React.FC = () => {
  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-6xl mx-auto p-6'>
        {/* Header */}
        <div className='mb-8'>
          <div className='flex items-center gap-3 mb-4'>
            <div className='p-3 bg-gradient-to-r from-primary-500 to-primary-600 rounded-lg'>
              <Brain className='h-6 w-6 text-white' />
            </div>
            <div>
              <h1 className='text-3xl font-bold text-gray-900 dark:text-gray-100'>
                Persona Development Framework
              </h1>
              <p className='text-gray-700 dark:text-gray-300 mt-1'>
                Build intelligent AI companions with persistent memory, evolving
                personalities, and advanced learning capabilities.
              </p>
            </div>
          </div>

          {/* Features Banner */}
          <div className='bg-gradient-to-r from-primary-50 to-primary-100 dark:from-primary-900/20 dark:to-primary-800/20 border border-primary-200 dark:border-primary-800 rounded-lg p-6'>
            <div className='grid grid-cols-1 md:grid-cols-3 gap-6 text-sm'>
              <div className='flex items-start gap-3'>
                <div className='p-2 bg-primary-500 rounded-lg'>
                  <Database className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-primary-900 dark:text-primary-400 mb-1'>
                    Semantic Memory
                  </h3>
                  <p className='text-primary-800 dark:text-primary-300 text-xs'>
                    Advanced memory system that learns and recalls context
                    across conversations with semantic understanding
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3'>
                <div className='p-2 bg-primary-600 rounded-lg'>
                  <TrendingUp className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-primary-900 dark:text-primary-400 mb-1'>
                    Adaptive Learning
                  </h3>
                  <p className='text-primary-800 dark:text-primary-300 text-xs'>
                    Dynamic personality evolution based on user interactions,
                    preferences, and conversation patterns
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3'>
                <div className='p-2 bg-primary-700 rounded-lg'>
                  <Download className='h-4 w-4 text-white' />
                </div>
                <div>
                  <h3 className='font-semibold text-primary-900 dark:text-primary-400 mb-1'>
                    DNA Export/Import
                  </h3>
                  <p className='text-primary-800 dark:text-primary-300 text-xs'>
                    Export and share complete persona DNA including memories,
                    learned behaviors, and personality traits
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
