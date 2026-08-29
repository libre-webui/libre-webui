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

import { ArrowUp, CircleAlert, Loader2, Mic, Square, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ModelSelector } from '@/components/ModelSelector';
import { Button } from '@/components/ui';
import { useDictation } from '@/hooks/useDictation';
import type { OllamaModel } from '@/types';
import { workModelSelectionKey, type WorkModelOption } from '@/types/work';
import { cn } from '@/utils';

interface WorkComposerProps {
  models: WorkModelOption[];
  selectorModels: OllamaModel[];
  modelKey: string;
  running: boolean;
  loading: boolean;
  variant?: 'landing' | 'task';
  disabled?: boolean;
  /** Hired agents offered by the @-mention picker (excludes this task). */
  mentionAgents?: Array<{ id: string; name: string }>;
  /** Dictation ownership: a recording dies when this changes (task id). */
  dictationOwnerKey?: string;
  remoteDisclosureDismissed: boolean;
  remoteDisclosureSaving: boolean;
  onModelChange: (modelKey: string) => void | Promise<void>;
  onDismissRemoteDisclosure: () => Promise<boolean>;
  onModelsRefresh: () => void | Promise<void>;
  onSubmit: (message: string) => Promise<boolean>;
  onCancel: () => void | Promise<void>;
}

const workSelectorModelValue = (model: OllamaModel): string =>
  workModelSelectionKey({
    model: model.name,
    providerType: model.isPlugin ? 'plugin' : 'ollama',
    providerId: model.isPlugin ? model.pluginId : undefined,
  });

const workSelectorModelLabel = (model: OllamaModel): string => {
  const pathSegments = model.name.split('/').filter(Boolean);
  const modelName = pathSegments[pathSegments.length - 1] || model.name;
  const readableModelName =
    pathSegments.length > 1 ? modelName.replace(/[-_]+/g, ' ') : modelName;

  return readableModelName;
};

const modelFromOption = (option: WorkModelOption): OllamaModel => {
  const providerPrefix = `${option.model} · `;
  return {
    name: option.model,
    model: option.model,
    size: 0,
    digest: '',
    modified_at: '',
    details: {},
    isPlugin: option.providerType === 'plugin',
    pluginId: option.providerId,
    pluginName:
      option.providerType === 'plugin'
        ? option.label.startsWith(providerPrefix)
          ? option.label.slice(providerPrefix.length)
          : option.providerId
        : undefined,
  };
};

export function WorkComposer({
  models,
  selectorModels,
  modelKey,
  running,
  loading,
  variant = 'task',
  disabled = false,
  mentionAgents,
  dictationOwnerKey,
  remoteDisclosureDismissed,
  remoteDisclosureSaving,
  onModelChange,
  onDismissRemoteDisclosure,
  onModelsRefresh,
  onSubmit,
  onCancel,
}: WorkComposerProps) {
  const { t } = useTranslation();
  const [message, setMessage] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Dictated text appends to whatever was typed before the mic started.
  const dictationBaseRef = useRef('');
  const dictation = useDictation({
    onStart: () => {
      dictationBaseRef.current = textareaRef.current?.value ?? '';
    },
    onText: text => {
      const base = dictationBaseRef.current;
      setMessage(base ? `${base} ${text}` : text);
    },
    ownerKey: dictationOwnerKey,
  });
  const dictationActive = dictation.phase !== 'idle';
  const desktopModelTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileModelTriggerRef = useRef<HTMLButtonElement>(null);
  const selectedModel = models.find(item => item.key === modelKey);
  const remoteProvider = selectedModel?.remote === true;
  const landing = variant === 'landing';
  const effectiveSelectorModels = useMemo(() => {
    const availableValues = new Set(selectorModels.map(workSelectorModelValue));
    const persistedModels = models
      .filter(option => !availableValues.has(option.key))
      .map(modelFromOption);
    return [...selectorModels, ...persistedModels];
  }, [models, selectorModels]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
  }, [message]);

  const dismissRemoteDisclosure = async () => {
    if (await onDismissRemoteDisclosure()) {
      const triggers = [
        desktopModelTriggerRef.current,
        mobileModelTriggerRef.current,
      ];
      const visibleTrigger = triggers.find(
        trigger => trigger && trigger.offsetParent !== null
      );
      (visibleTrigger || desktopModelTriggerRef.current)?.focus();
    }
  };

  const changeModel = (value: string) => {
    const option =
      models.find(item => item.key === value) ||
      models.find(
        item => item.providerType === 'ollama' && item.model === value
      );
    if (option) void onModelChange(option.key);
  };

  const submit = async () => {
    const trimmed = message.trim();
    // A running task still accepts messages: they reach the agent at its
    // next round without stopping the run.
    if (!trimmed || loading || disabled || (!running && !selectedModel)) {
      return;
    }
    if (await onSubmit(trimmed)) setMessage('');
  };

  // @-mention picker over the user's other hired agents. The mention is
  // plain text; the agent's roster and message_agent tool do the rest.
  const [mention, setMention] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const detectMention = (value: string, caret: number) => {
    if (!mentionAgents?.length) {
      setMention(null);
      return;
    }
    const match = /(?:^|\s)@([^\n@]{0,60})$/.exec(value.slice(0, caret));
    if (!match) {
      setMention(null);
      return;
    }
    const query = match[1];
    setMention({ start: caret - query.length - 1, end: caret, query });
    setMentionIndex(0);
  };
  const mentionMatches =
    mention === null
      ? []
      : (mentionAgents ?? []).filter(agent =>
          agent.name
            .toLowerCase()
            .startsWith(mention.query.trimStart().toLowerCase())
        );
  const mentionOpen = mention !== null && mentionMatches.length > 0;
  const applyMention = (agent: { id: string; name: string }) => {
    if (!mention) return;
    const next = `${message.slice(0, mention.start)}@${agent.name} ${message.slice(mention.end)}`;
    const caret = mention.start + agent.name.length + 2;
    setMessage(next);
    setMention(null);
    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  };

  return (
    <div
      data-testid={landing ? 'work-landing-composer' : 'work-task-composer'}
      data-variant={variant}
      className={cn(
        'relative shrink-0',
        landing
          ? 'mt-10 w-full'
          : 'border-t border-line bg-surface/95 px-3 py-3 backdrop-blur md:px-5'
      )}
    >
      {remoteProvider && !remoteDisclosureDismissed && (
        <div
          className={cn(
            'absolute inset-x-3 z-30 mx-auto max-w-3xl md:inset-x-5',
            'bottom-full mb-3'
          )}
        >
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

      <form
        className='relative mx-auto w-full max-w-3xl'
        onSubmit={event => {
          event.preventDefault();
          void submit();
        }}
      >
        {mentionOpen && (
          <div
            data-testid='work-mention-menu'
            role='listbox'
            aria-label={t('work.composer.mentionAgents', {
              defaultValue: 'Mention an agent',
            })}
            className='absolute bottom-full start-2 z-40 mb-2 w-64 overflow-hidden rounded-xl border border-line bg-surface-overlay shadow-overlay backdrop-blur'
          >
            {mentionMatches.slice(0, 6).map((agent, index) => (
              <button
                key={agent.id}
                type='button'
                role='option'
                aria-selected={index === mentionIndex}
                data-testid='work-mention-option'
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-2 text-start text-sm transition-colors',
                  index === mentionIndex
                    ? 'bg-primary-500/10 text-ink'
                    : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                )}
                onMouseDown={event => {
                  event.preventDefault();
                  applyMention(agent);
                }}
              >
                <span dir='auto' className='truncate'>
                  @{agent.name}
                </span>
              </button>
            ))}
          </div>
        )}
        <div
          data-testid='work-composer-surface'
          className={cn(
            'rounded-[24px] border p-2.5 transition-[border-color,box-shadow,background-color] duration-200',
            'border-black/[0.08] bg-surface dark:border-white/[0.09] dark:bg-surface-subtle',
            'shadow-lv2 focus-within:shadow-lv3'
          )}
        >
          <textarea
            ref={textareaRef}
            data-testid='work-composer-input'
            dir='auto'
            value={message}
            onChange={event => {
              setMessage(event.target.value);
              detectMention(
                event.target.value,
                event.target.selectionStart ?? event.target.value.length
              );
            }}
            onClick={event =>
              detectMention(
                event.currentTarget.value,
                event.currentTarget.selectionStart ??
                  event.currentTarget.value.length
              )
            }
            onBlur={() => setMention(null)}
            onKeyDown={event => {
              if (mentionOpen) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const shown = Math.min(mentionMatches.length, 6);
                  setMentionIndex(current =>
                    event.key === 'ArrowDown'
                      ? (current + 1) % shown
                      : (current - 1 + shown) % shown
                  );
                  return;
                }
                if (event.key === 'Enter' || event.key === 'Tab') {
                  event.preventDefault();
                  applyMention(mentionMatches[mentionIndex]);
                  return;
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setMention(null);
                  return;
                }
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
            disabled={disabled}
            rows={1}
            className='m-0 block max-h-[160px] min-h-9 w-full resize-none overflow-y-auto rounded-none border-0 bg-transparent px-2 pt-1.5 pb-2 text-[0.9375rem] leading-relaxed text-ink shadow-none outline-none placeholder:text-ink-subtle focus:border-0 focus:bg-transparent focus:ring-0 disabled:cursor-not-allowed disabled:opacity-60'
            placeholder={t('work.composer.placeholder', {
              defaultValue: 'Describe what you want to build or change…',
            })}
          />

          <div className='flex items-center justify-end gap-1.5'>
            <div className='hidden shrink-0 sm:block'>
              <ModelSelector
                models={effectiveSelectorModels}
                selectedModel={modelKey}
                onModelChange={event => changeModel(event.target.value)}
                onModelsRefresh={() => void onModelsRefresh()}
                getModelValue={workSelectorModelValue}
                getModelLabel={workSelectorModelLabel}
                getModelTitle={model => model.name}
                triggerRef={desktopModelTriggerRef}
                triggerTestId='work-model-selector-trigger'
                selectTestId='work-model-select'
                ariaLabel={t('work.composer.model', {
                  defaultValue: 'Work model',
                })}
                disabled={running || models.length === 0}
                className='min-w-[150px] max-w-[230px]'
                compact
              />
            </div>

            {dictation.supported && (
              <Button
                data-testid='work-voice-input'
                type='button'
                variant='ghost'
                size='sm'
                disabled={disabled}
                aria-pressed={dictationActive}
                className={cn(
                  'flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full p-0 transition-colors duration-150',
                  dictationActive
                    ? 'animate-pulse bg-red-50 text-red-500 dark:bg-red-900/20'
                    : 'text-ink-muted hover:bg-surface-subtle hover:text-ink'
                )}
                title={
                  dictationActive
                    ? t('chat.input.voiceStop')
                    : t('chat.input.voiceInput')
                }
                aria-label={
                  dictationActive
                    ? t('chat.input.voiceStop')
                    : t('chat.input.voiceInput')
                }
                onClick={() => void dictation.toggle()}
              >
                {dictation.phase === 'starting' ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : dictation.phase === 'transcribing' ? (
                  <Square className='h-4 w-4 fill-current' />
                ) : (
                  <Mic className='h-4 w-4' />
                )}
              </Button>
            )}
            {running && (
              <Button
                data-testid='work-cancel-button'
                type='button'
                variant='ghost'
                size='sm'
                disabled={loading}
                className='flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full bg-error-500/15 p-0 text-error-600 transition-colors duration-150 hover:bg-error-500/25 dark:text-error-400 sm:h-10 sm:w-10'
                title={t('work.composer.cancel', { defaultValue: 'Stop' })}
                aria-label={t('work.composer.cancel', {
                  defaultValue: 'Stop',
                })}
                onClick={() => void onCancel()}
              >
                {loading ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Square className='h-4 w-4 fill-current' />
                )}
              </Button>
            )}
            {
              <Button
                data-testid='work-submit-button'
                type='submit'
                variant='ghost'
                size='sm'
                disabled={
                  loading ||
                  disabled ||
                  !message.trim() ||
                  (!running && !selectedModel)
                }
                className={cn(
                  'flex h-9 w-9 shrink-0 touch-manipulation items-center justify-center rounded-full p-0 transition-colors duration-150',
                  'bg-primary-500 text-white hover:bg-primary-400',
                  'disabled:bg-primary-300/50 disabled:text-white/80 dark:disabled:bg-primary-800/60 dark:disabled:text-white/40 disabled:hover:bg-primary-300/50 dark:disabled:hover:bg-primary-800/60'
                )}
                title={t('work.composer.send', { defaultValue: 'Run' })}
                aria-label={t('work.composer.send', {
                  defaultValue: 'Run',
                })}
              >
                {loading ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <ArrowUp className='h-4 w-4' />
                )}
              </Button>
            }
          </div>
        </div>
      </form>

      <div className='mx-auto mt-3 w-full max-w-3xl sm:hidden'>
        <ModelSelector
          models={effectiveSelectorModels}
          selectedModel={modelKey}
          onModelChange={event => changeModel(event.target.value)}
          onModelsRefresh={() => void onModelsRefresh()}
          getModelValue={workSelectorModelValue}
          getModelLabel={workSelectorModelLabel}
          getModelTitle={model => model.name}
          triggerRef={mobileModelTriggerRef}
          triggerTestId='work-model-selector-trigger-mobile'
          selectTestId='work-model-select-mobile'
          ariaLabel={t('work.composer.model', {
            defaultValue: 'Work model',
          })}
          disabled={running || models.length === 0}
          className='w-full'
          compact
        />
      </div>
    </div>
  );
}
