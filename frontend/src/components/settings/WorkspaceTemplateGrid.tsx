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

export interface WorkspaceTemplateCard {
  id: string;
  name: string;
  description: string;
  /** Optional third quiet line, e.g. a slug or destination preview. */
  meta?: string;
}

/**
 * Starter-template grid shared by the prompts, skills, and tools tabs,
 * mirroring the automations template cards: picking one opens the create
 * form prefilled, nothing is saved until the user submits.
 */
export const WorkspaceTemplateGrid: React.FC<{
  title: string;
  cards: WorkspaceTemplateCard[];
  testId: string;
  onPick: (id: string) => void;
}> = ({ title, cards, testId, onPick }) => {
  if (cards.length === 0) return null;
  return (
    <div className='mt-8'>
      <p className='mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
        {title}
      </p>
      <div className='grid gap-2 sm:grid-cols-2'>
        {cards.map(card => (
          <button
            key={card.id}
            type='button'
            onClick={() => onPick(card.id)}
            data-testid={testId}
            className='rounded-2xl border border-black/[0.06] bg-white/40 px-4 py-3 text-start transition-colors hover:bg-white/80 dark:border-white/[0.07] dark:bg-dark-100/40 dark:hover:bg-dark-100/80'
          >
            <p className='text-[13px] font-medium text-gray-900 dark:text-dark-900'>
              {card.name}
            </p>
            <p className='mt-0.5 text-[12px] text-gray-500 dark:text-dark-500'>
              {card.description}
            </p>
            {card.meta && (
              <p
                className='mt-1.5 font-mono text-[11px] text-gray-400 dark:text-dark-500'
                dir='ltr'
              >
                {card.meta}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
};
