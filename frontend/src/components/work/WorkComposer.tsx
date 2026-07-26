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

import { CircleAlert, Send, Square, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkModelOption } from '@/types/work';
import { Button } from '@/components/ui';

interface WorkComposerProps {
  models: WorkModelOption[];
  modelKey: string;
  running: boolean;
  loading: boolean;
  disabled?: boolean;
  remoteDisclosureDismissed: boolean;
  remoteDisclosureSaving: boolean;
  onModelChange: (modelKey: string) => void | Promise<void>;
  onDismissRemoteDisclosure: () => Promise<boolean>;
  onSubmit: (message: string) => Promise<boolean>;
  onCancel: () => void | Promise<void>;
}

export function WorkComposer({
  models,
  modelKey,
  running,
  loading,
  disabled = false,
  remoteDisclosureDismissed,
  remoteDisclosureSaving,
  onModelChange,
  onDismissRemoteDisclosure,
  onSubmit,
  onCancel,
}: WorkComposerProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const modelSelectRef = useRef<HTMLSelectElement>(null);
  const selectedModel = models.find(item => item.key === modelKey);
  const remoteProvider = selectedModel?.remote === true;

  const dismissRemoteDisclosure = async () => {
    if (await onDismissRemoteDisclosure()) {
      modelSelectRef.current?.focus();
    }
  };

  const submit = async () => {
    const trimmed = message.trim();
    if (!trimmed || loading || running || disabled || !selectedModel) return;
    if (await onSubmit(trimmed)) setMessage('');
  };

  return (
    <div className='relative shrink-0 border-t border-line bg-surface-raised/95 px-3 py-3 backdrop-blur md:px-5'>
      {remoteProvider && !remoteDisclosureDismissed && (
        <div className='absolute inset-x-3 bottom-full z-30 mx-auto mb-3 max-w-3xl md:inset-x-5'>
          <aside
            data-testid='work-provider-disclosure-popover'
            aria-labelledby='work-provider-disclosure-title'
            aria-live='polite'
            className='relative rounded-2xl border border-warning-500/40 bg-surface-overlay p-3 pe-10 shadow-overlay backdrop-blur dark:border-warning-500/45'
          >
            <button
              type='button'
              onClick={() => void dismissRemoteDisclosure()}
              disabled={remoteDisclosureSaving}
              className='absolute end-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-warning-500/20 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-warning-500 disabled:cursor-wait disabled:opacity-50'
              aria-label={t('work.composer.remoteDismissLabel', {
                defaultValue: 'Dismiss remote provider notice',
              })}
            >
              <X className='h-4 w-4' />
            </button>
            <div className='flex items-start gap-3'>
              <div className='mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-warning-500/20'>
                <CircleAlert
                  data-testid='work-provider-disclosure-accent'
                  className='h-4 w-4 text-warning-500'
                  aria-hidden='true'
                />
              </div>
              <div className='min-w-0 flex-1'>
                <p
                  id='work-provider-disclosure-title'
                  className='text-sm font-semibold text-ink'
                >
                  {t('work.composer.remoteTitle', {
                    defaultValue: 'Remote provider',
                  })}
                </p>
                <p className='mt-0.5 text-xs leading-relaxed text-ink-muted'>
                  {t('work.composer.remoteHint', {
                    defaultValue:
                      'Conversation and tool output are sent to the configured service. One autonomous run can make multiple provider calls and may incur charges. Workspace files stay local unless a tool returns their contents.',
                  })}
                </p>
                <div className='mt-2.5 flex justify-end'>
                  <Button
                    data-testid='work-provider-disclosure-dismiss'
                    type='button'
                    variant='ghost'
                    size='sm'
                    loading={remoteDisclosureSaving}
                    className='h-7 border-warning-500 bg-warning-500 px-2.5 text-xs text-[#3d120c] hover:bg-warning-500/90 hover:text-[#3d120c]'
                    onClick={() => void dismissRemoteDisclosure()}
                  >
                    {t('work.composer.remoteDismiss', {
                      defaultValue: 'Dismiss',
                    })}
                  </Button>
                </div>
              </div>
            </div>
          </aside>
        </div>
      )}

      <div className='mx-auto max-w-3xl rounded-2xl border border-line bg-surface shadow-subtle focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/15'>
        <textarea
          data-testid='work-composer-input'
          dir='auto'
          value={message}
          onChange={event => setMessage(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          disabled={disabled || running}
          rows={3}
          className='block max-h-48 min-h-[5rem] w-full resize-none bg-transparent px-4 pt-3 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-subtle disabled:cursor-not-allowed disabled:opacity-60'
          placeholder={t('work.composer.placeholder', {
            defaultValue: 'Describe what you want to build or change…',
          })}
        />
        <div className='flex flex-wrap items-center justify-between gap-2 px-2.5 pb-2.5'>
          <div className='flex min-w-0 flex-1 flex-wrap items-center gap-2'>
            <select
              ref={modelSelectRef}
              data-testid='work-model-select'
              dir='auto'
              value={modelKey}
              onChange={event => void onModelChange(event.target.value)}
              disabled={running || models.length === 0}
              className='h-8 min-w-0 max-w-56 rounded-lg border border-line bg-surface-raised px-2 text-xs font-medium text-ink outline-none focus:border-primary-500'
              aria-label={t('work.composer.model', {
                defaultValue: 'Work model',
              })}
            >
              {models.length === 0 && (
                <option value=''>
                  {t('work.composer.noModels', {
                    defaultValue: 'No Work-compatible models',
                  })}
                </option>
              )}
              {models.map(item => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>

          {running ? (
            <Button
              data-testid='work-cancel-button'
              variant='danger'
              size='sm'
              loading={loading}
              onClick={() => void onCancel()}
            >
              <Square className='h-3.5 w-3.5 fill-current' />
              {t('work.composer.cancel', { defaultValue: 'Stop' })}
            </Button>
          ) : (
            <Button
              data-testid='work-submit-button'
              size='sm'
              loading={loading}
              disabled={disabled || !message.trim() || !selectedModel}
              onClick={() => void submit()}
            >
              <Send className='h-3.5 w-3.5' />
              {t('work.composer.send', { defaultValue: 'Run' })}
            </Button>
          )}
        </div>
      </div>
      <p
        data-testid='work-composer-hint'
        className='mt-1.5 text-center text-[11px] text-ink-subtle'
      >
        {t('work.composer.hint', {
          defaultValue:
            'Each task keeps its own files and history. Review model output before using it.',
        })}
      </p>
    </div>
  );
}
