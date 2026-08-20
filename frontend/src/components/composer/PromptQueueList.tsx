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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown, ArrowUp, Check, Clock3, Pencil, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { chatApi } from '@/utils/api';
import { applyPromptQueueToChatStore } from '@/utils/promptQueue';
import { createLogger } from '@/utils/logger';
import type { PromptQueueEntry } from '@/types';

const logger = createLogger('components:prompt-queue');

interface PromptQueueListProps {
  sessionId: string;
  queue: PromptQueueEntry[];
}

/**
 * The prompts waiting behind the running generation: editable, reorderable,
 * removable. State lives in the session on the server, so the queue
 * survives reloads and reconnects; this component only mirrors it.
 */
export const PromptQueueList: React.FC<PromptQueueListProps> = ({
  sessionId,
  queue,
}) => {
  const { t } = useTranslation();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const apply = (next: PromptQueueEntry[]) =>
    applyPromptQueueToChatStore(sessionId, next);

  const handleRemove = async (entryId: string) => {
    try {
      const response = await chatApi.claimQueuedPrompt(sessionId, entryId);
      if (response.success && response.data) apply(response.data.queue);
    } catch (error) {
      logger.error('Failed to remove queued prompt:', error);
    }
  };

  const handleMove = async (entryId: string, direction: -1 | 1) => {
    const index = queue.findIndex(entry => entry.id === entryId);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= queue.length) return;
    const order = queue.map(entry => entry.id);
    [order[index], order[target]] = [order[target], order[index]];
    try {
      const response = await chatApi.reorderPromptQueue(sessionId, order);
      if (response.success && response.data) apply(response.data.queue);
    } catch (error) {
      logger.error('Failed to reorder the prompt queue:', error);
    }
  };

  const handleSaveEdit = async (entryId: string) => {
    const content = editDraft.trim();
    if (!content) return;
    try {
      const response = await chatApi.updateQueuedPrompt(
        sessionId,
        entryId,
        content
      );
      if (response.success && response.data) {
        apply(response.data.queue);
        setEditingId(null);
      } else {
        toast.error(response.error || t('chat.queue.updateFailed'));
      }
    } catch (error) {
      logger.error('Failed to update the queued prompt:', error);
      toast.error(t('chat.queue.updateFailed'));
    }
  };

  if (queue.length === 0) return null;

  return (
    <div
      className='mx-auto mb-1.5 w-full max-w-3xl px-1'
      data-testid='prompt-queue'
    >
      <p className='mb-1 flex items-center gap-1.5 px-1 text-[11px] font-medium text-gray-400 dark:text-dark-500'>
        <Clock3 className='h-3 w-3' />
        {t('chat.queue.title', { total: queue.length })}
      </p>
      <ul className='space-y-1'>
        {queue.map((entry, index) => (
          <li
            key={entry.id}
            className='flex items-center gap-1.5 rounded-lg border border-black/[0.06] bg-surface/70 px-2 py-1 dark:border-white/[0.08] dark:bg-dark-200/70'
            data-testid='prompt-queue-entry'
          >
            {editingId === entry.id ? (
              <>
                <input
                  autoFocus
                  value={editDraft}
                  onChange={event => setEditDraft(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === 'Enter') void handleSaveEdit(entry.id);
                    if (event.key === 'Escape') setEditingId(null);
                  }}
                  className='min-w-0 flex-1 bg-transparent text-[13px] text-gray-900 focus:outline-none dark:text-dark-900'
                  data-testid='prompt-queue-edit-input'
                />
                <button
                  type='button'
                  onClick={() => void handleSaveEdit(entry.id)}
                  className='rounded-md p-1 text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20'
                  aria-label={t('common.save')}
                >
                  <Check className='h-3.5 w-3.5' />
                </button>
              </>
            ) : (
              <>
                <span className='min-w-0 flex-1 truncate text-[13px] text-gray-700 dark:text-dark-800'>
                  {entry.content}
                </span>
                <button
                  type='button'
                  onClick={() => void handleMove(entry.id, -1)}
                  disabled={index === 0}
                  className='rounded-md p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-dark-500 dark:hover:text-dark-800'
                  aria-label={t('chat.queue.moveUp')}
                >
                  <ArrowUp className='h-3 w-3' />
                </button>
                <button
                  type='button'
                  onClick={() => void handleMove(entry.id, 1)}
                  disabled={index === queue.length - 1}
                  className='rounded-md p-1 text-gray-400 hover:text-gray-700 disabled:opacity-30 dark:text-dark-500 dark:hover:text-dark-800'
                  aria-label={t('chat.queue.moveDown')}
                >
                  <ArrowDown className='h-3 w-3' />
                </button>
                <button
                  type='button'
                  onClick={() => {
                    setEditingId(entry.id);
                    setEditDraft(entry.content);
                  }}
                  className='rounded-md p-1 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
                  aria-label={t('common.edit')}
                >
                  <Pencil className='h-3 w-3' />
                </button>
                <button
                  type='button'
                  onClick={() => void handleRemove(entry.id)}
                  className='rounded-md p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'
                  aria-label={t('common.delete')}
                >
                  <X className='h-3 w-3' />
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

export default PromptQueueList;
