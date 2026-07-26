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

import { Send, Square, Wifi, WifiOff } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkModelOption } from '@/types/work';
import { cn } from '@/utils';
import { Button } from '@/components/ui';

interface WorkComposerProps {
  models: WorkModelOption[];
  modelKey: string;
  networkEnabled: boolean;
  running: boolean;
  loading: boolean;
  disabled?: boolean;
  onModelChange: (modelKey: string) => void | Promise<void>;
  onNetworkChange: (enabled: boolean) => void | Promise<void>;
  onSubmit: (message: string) => Promise<boolean>;
  onCancel: () => void | Promise<void>;
}

export function WorkComposer({
  models,
  modelKey,
  networkEnabled,
  running,
  loading,
  disabled = false,
  onModelChange,
  onNetworkChange,
  onSubmit,
  onCancel,
}: WorkComposerProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const selectedModel = models.find(item => item.key === modelKey);
  const remoteProvider = selectedModel?.remote === true;

  const submit = async () => {
    const trimmed = message.trim();
    if (!trimmed || loading || running || disabled || !selectedModel) return;
    if (await onSubmit(trimmed)) setMessage('');
  };

  return (
    <div className='border-t border-line bg-surface-raised/95 px-3 py-3 backdrop-blur md:px-5'>
      <div className='mx-auto max-w-3xl rounded-2xl border border-line bg-surface shadow-subtle focus-within:border-primary-500 focus-within:ring-2 focus-within:ring-primary-500/15'>
        <textarea
          data-testid='work-composer-input'
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
              data-testid='work-model-select'
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

            <label
              className={cn(
                'inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-xs font-medium transition-colors',
                networkEnabled
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'border-line bg-surface-raised text-ink-muted',
                running && 'cursor-not-allowed opacity-50'
              )}
              title={t('work.composer.networkHelp', {
                defaultValue:
                  'Off by default. Enable only when this task needs network access.',
              })}
            >
              <input
                data-testid='work-network-toggle'
                type='checkbox'
                checked={networkEnabled}
                disabled={running}
                onChange={event => void onNetworkChange(event.target.checked)}
                className='sr-only'
              />
              {networkEnabled ? (
                <Wifi className='h-3.5 w-3.5' />
              ) : (
                <WifiOff className='h-3.5 w-3.5' />
              )}
              {networkEnabled
                ? t('work.composer.networkOn', { defaultValue: 'Network on' })
                : t('work.composer.networkOff', {
                    defaultValue: 'Network off',
                  })}
            </label>
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
        data-testid='work-provider-disclosure'
        className={cn(
          'mt-1.5 text-center text-[11px]',
          remoteProvider
            ? 'text-amber-700 dark:text-amber-300'
            : 'text-ink-subtle'
        )}
      >
        {remoteProvider
          ? t('work.composer.remoteHint', {
              defaultValue:
                'Remote provider: conversation and tool output are sent to the configured service. One autonomous run can make multiple provider calls and may incur charges. Workspace files stay local unless a tool returns their contents.',
            })
          : t('work.composer.hint', {
              defaultValue:
                'Each task keeps its own files and history. Review model output before using it.',
            })}
      </p>
    </div>
  );
}
