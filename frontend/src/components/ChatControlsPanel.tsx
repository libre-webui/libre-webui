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

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { chatApi, ollamaApi } from '@/utils/api';
import { generateId } from '@/utils';
import {
  THINKING_CHOICES,
  thinkingChoiceOf,
  thinkingPreferenceOf,
} from '@/utils/thinking';
import { createLogger } from '@/utils/logger';
import { isCompactionSummaryContent } from '@/utils/contextUsage';
import type { ChatSession, GenerationOptions } from '@/types';

const logger = createLogger('components:chat-controls-panel');

type NumericOption =
  | 'temperature'
  | 'top_p'
  | 'top_k'
  | 'min_p'
  | 'num_predict'
  | 'repeat_penalty'
  | 'seed'
  | 'num_ctx';

const NUMERIC_OPTIONS: Array<{
  key: NumericOption;
  labelKey: string;
  step: string;
  min?: number;
  max?: number;
}> = [
  { key: 'temperature', labelKey: 'temperature', step: '0.1', min: 0, max: 2 },
  { key: 'top_p', labelKey: 'topP', step: '0.05', min: 0, max: 1 },
  { key: 'top_k', labelKey: 'topK', step: '1', min: 1 },
  { key: 'min_p', labelKey: 'minP', step: '0.05', min: 0, max: 1 },
  { key: 'num_predict', labelKey: 'maxTokens', step: '1' },
  { key: 'repeat_penalty', labelKey: 'repeatPenalty', step: '0.05', min: 0 },
  { key: 'seed', labelKey: 'seed', step: '1' },
  { key: 'num_ctx', labelKey: 'contextLength', step: '1' },
];

interface ChatControlsPanelProps {
  /**
   * The conversation being adjusted. Omitted on the welcome screen, where the
   * settings are kept as a draft and applied to the session once it is created.
   */
  session?: ChatSession;
  /** Model the draft applies to, when there is no session yet. */
  draftModel?: string;
  open: boolean;
  onClose: () => void;
}

export const ChatControlsPanel: React.FC<ChatControlsPanelProps> = ({
  session,
  draftModel,
  open,
  onClose,
}) => {
  const { t } = useTranslation();
  const draftSettings = useChatStore(state => state.draftSessionSettings);
  const setDraftSessionSettings = useChatStore(
    state => state.setDraftSessionSettings
  );
  const model = session?.model ?? draftModel ?? '';
  const globalDefaults = useAppStore(
    state => state.preferences.generationOptions
  );
  const pinnedForModel = useAppStore(
    state => state.preferences.modelGenerationOptions?.[model]
  );
  const [modelDefaults, setModelDefaults] = useState<{
    options: Partial<GenerationOptions>;
    trainedContextLength?: number;
    contextCapped: boolean;
  }>({ options: {}, contextCapped: false });

  // What this model recommends for itself. Shown as the placeholder so the
  // panel reports the value a message will actually run with, rather than an
  // application default the model overrides.
  useEffect(() => {
    if (!open || !model) return;

    let cancelled = false;
    void ollamaApi
      .getModelDefaults(model)
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        setModelDefaults({
          options: response.data.options ?? {},
          trainedContextLength: response.data.trainedContextLength,
          contextCapped: Boolean(response.data.contextCapped),
        });
      })
      .catch(() => {
        // A model that cannot be inspected simply contributes nothing.
      });

    return () => {
      cancelled = true;
    };
  }, [open, model]);

  const effectiveDefaults = useMemo(
    () => ({
      ...(globalDefaults ?? {}),
      ...modelDefaults.options,
      ...(pinnedForModel ?? {}),
    }),
    [globalDefaults, modelDefaults.options, pinnedForModel]
  );

  const systemMessage = useMemo(
    () =>
      session?.messages.find(
        message =>
          message.role === 'system' &&
          !isCompactionSummaryContent(message.content)
      ),
    [session?.messages]
  );

  const [systemPrompt, setSystemPrompt] = useState(
    systemMessage?.content ?? draftSettings.systemPrompt ?? ''
  );
  const [overrides, setOverrides] = useState<Partial<GenerationOptions>>(
    session?.settings?.generationOptions ??
      draftSettings.generationOptions ??
      {}
  );
  const [saving, setSaving] = useState(false);
  const [compactionAllowed, setCompactionAllowed] = useState(
    session?.settings?.compaction !== false
  );
  const [seededSessionId, setSeededSessionId] = useState(
    session?.id ?? 'draft'
  );

  // Re-seed local form state when the panel is opened for another session.
  const seedKey = session?.id ?? 'draft';
  if (seededSessionId !== seedKey) {
    setSeededSessionId(seedKey);
    setSystemPrompt(systemMessage?.content ?? draftSettings.systemPrompt ?? '');
    setOverrides(
      session?.settings?.generationOptions ??
        draftSettings.generationOptions ??
        {}
    );
    setCompactionAllowed(session?.settings?.compaction !== false);
  }

  // A chat's own thinking setting. Absent means the model decides, which is
  // why the choice is removed rather than stored as a value.
  const setThinkingOverride = (choice: string) => {
    setOverrides(previous => {
      const next = { ...previous };
      const think = thinkingPreferenceOf(choice);
      if (think === null) delete next.think;
      else next.think = think;
      return next;
    });
  };

  const setNumericOverride = (key: NumericOption, raw: string) => {
    setOverrides(previous => {
      const next = { ...previous };
      if (raw === '') {
        delete next[key];
      } else {
        const value = Number(raw);
        if (!Number.isNaN(value)) {
          (next as Record<string, number>)[key] = value;
        }
      }
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const trimmedPrompt = systemPrompt.trim();
      const previousPrompt = systemMessage?.content ?? '';

      // Persist sampling overrides on the session.
      const cleanedOverrides = Object.fromEntries(
        Object.entries(overrides).filter(([, value]) => value !== undefined)
      ) as Partial<GenerationOptions>;
      // Preserve sibling settings (knowledge collections, provider binding):
      // this panel owns only the generation options and the compaction
      // opt-out. "Allowed" is the absence of the key, not a stored true.
      const settings = session
        ? { ...session.settings, generationOptions: cleanedOverrides }
        : Object.keys(cleanedOverrides).length > 0
          ? { generationOptions: cleanedOverrides }
          : undefined;
      if (settings && session) {
        if (compactionAllowed) delete settings.compaction;
        else settings.compaction = false;
      }

      // No session yet: keep the choices as a draft for the one about to be
      // created, so a conversation can start the way the user wants it.
      if (!session) {
        setDraftSessionSettings({
          systemPrompt: trimmedPrompt || undefined,
          generationOptions: settings?.generationOptions,
        });
        toast.success(t('chat.controls.saved'));
        onClose();
        return;
      }

      let updatedMessages = session.messages;
      if (trimmedPrompt !== previousPrompt.trim()) {
        if (systemMessage) {
          updatedMessages = trimmedPrompt
            ? session.messages.map(message =>
                message.id === systemMessage.id
                  ? { ...message, content: trimmedPrompt }
                  : message
              )
            : session.messages.filter(
                message => message.id !== systemMessage.id
              );
        } else if (trimmedPrompt) {
          updatedMessages = [
            {
              id: generateId(),
              role: 'system' as const,
              content: trimmedPrompt,
              timestamp: Date.now(),
            },
            ...session.messages,
          ];
        }
      }

      if (session.isPrivate) {
        useChatStore.setState(state => ({
          currentSession:
            state.currentSession?.id === session.id
              ? {
                  ...state.currentSession,
                  messages: updatedMessages,
                  settings,
                }
              : state.currentSession,
        }));
      } else {
        const response = await chatApi.updateSession(session.id, {
          messages: updatedMessages,
          settings,
        } as Partial<ChatSession>);
        if (!response.success || !response.data) {
          throw new Error(response.error || 'Update failed');
        }
        const updated = response.data;
        useChatStore.setState(state => ({
          sessions: state.sessions.map(item =>
            item.id === session.id ? updated : item
          ),
          currentSession:
            state.currentSession?.id === session.id
              ? updated
              : state.currentSession,
        }));
      }

      toast.success(t('chat.controls.saved'));
      onClose();
    } catch (error) {
      logger.error('Failed to save chat controls:', error);
      toast.error(t('chat.controls.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // Closed means gone: a hidden panel would still put its fields in the
  // document, where anything reading the page finds them.
  if (!open) return null;

  return (
    <div
      data-testid='chat-controls-panel'
      className='flex h-full w-[21rem] shrink-0 flex-col border-s border-black/[0.06] bg-surface/70 backdrop-blur-xl dark:border-white/[0.07] dark:bg-dark-100/70'
    >
      <div className='flex items-center justify-between px-4 pb-2 pt-4'>
        <h2 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
          {t('chat.controls.title')}
        </h2>
        <button
          onClick={onClose}
          className='rounded-full p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-900'
          title={t('common.close')}
        >
          <X className='h-4 w-4' />
        </button>
      </div>

      <div className='scroll-region min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-2 scrollbar-thin'>
        <div>
          <label className='mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'>
            {t('chat.controls.systemPrompt')}
          </label>
          <textarea
            dir='auto'
            value={systemPrompt}
            onChange={event => setSystemPrompt(event.target.value)}
            placeholder={t('chat.controls.systemPromptPlaceholder')}
            className='min-h-[110px] w-full resize-y rounded-xl border border-black/[0.08] bg-white p-2.5 text-[13px] leading-relaxed text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-50 dark:text-dark-900 dark:placeholder:text-dark-500'
          />
        </div>

        <div>
          <label
            htmlFor='chat-control-think'
            className='mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'
          >
            {t('chat.controls.thinking')}
          </label>
          <select
            id='chat-control-think'
            // The select holds this chat's own choice; picking Default must
            // stay on Default rather than snapping to the value it inherits,
            // so the inherited value is named inside the Default option.
            value={thinkingChoiceOf(overrides.think)}
            onChange={event => setThinkingOverride(event.target.value)}
            className='w-full rounded-xl border border-black/[0.08] bg-white px-2.5 py-2 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-50 dark:text-dark-900'
          >
            {THINKING_CHOICES.map(choice => (
              <option key={choice} value={choice}>
                {choice === 'default' &&
                effectiveDefaults.think !== undefined &&
                effectiveDefaults.think !== null
                  ? t('settings.generation.thinkingLevels.defaultWith', {
                      level: t(
                        `settings.generation.thinkingLevels.${thinkingChoiceOf(effectiveDefaults.think)}`
                      ),
                    })
                  : t(`settings.generation.thinkingLevels.${choice}`)}
              </option>
            ))}
          </select>
          <p className='mt-1.5 text-[11px] leading-snug text-gray-400 dark:text-dark-500'>
            {t('chat.controls.thinkingDescription')}
          </p>
        </div>

        {session && (
          <div>
            <label
              htmlFor='chat-control-compaction'
              className='mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'
            >
              {t('chat.controls.compaction')}
            </label>
            <select
              id='chat-control-compaction'
              value={compactionAllowed ? 'default' : 'off'}
              onChange={event =>
                setCompactionAllowed(event.target.value !== 'off')
              }
              className='w-full rounded-xl border border-black/[0.08] bg-white px-2.5 py-2 text-[13px] text-gray-900 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-50 dark:text-dark-900'
            >
              <option value='default'>
                {t('chat.controls.compactionDefault')}
              </option>
              <option value='off'>{t('chat.controls.compactionOff')}</option>
            </select>
            <p className='mt-1.5 text-[11px] leading-snug text-gray-400 dark:text-dark-500'>
              {t('chat.controls.compactionDescription')}
            </p>
          </div>
        )}

        <div>
          <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'>
            {t('chat.controls.advancedParams')}
          </p>
          <p className='mb-2.5 text-[11px] leading-snug text-gray-400 dark:text-dark-500'>
            {t('chat.controls.advancedParamsDescription')}
          </p>
          {modelDefaults.contextCapped &&
            modelDefaults.trainedContextLength && (
              <p className='mb-2.5 text-[11px] leading-snug text-gray-500 dark:text-dark-600'>
                {t('chat.controls.contextCapped', {
                  context: effectiveDefaults.num_ctx?.toLocaleString(),
                  trained: modelDefaults.trainedContextLength.toLocaleString(),
                })}
              </p>
            )}
          <div className='space-y-1.5'>
            {NUMERIC_OPTIONS.map(option => {
              const value = overrides[option.key];
              const globalValue = effectiveDefaults[option.key];
              const fromModel =
                modelDefaults.options[option.key] !== undefined &&
                pinnedForModel?.[option.key] === undefined;
              return (
                <div
                  key={option.key}
                  className='flex items-center justify-between gap-3'
                >
                  <label
                    htmlFor={`chat-control-${option.key}`}
                    className='text-[13px] text-gray-700 dark:text-dark-700'
                  >
                    {t(`chat.controls.params.${option.labelKey}`)}
                    {fromModel && (
                      <span
                        title={t('chat.controls.fromModelHint')}
                        className='ms-1.5 text-[10px] uppercase tracking-wide text-gray-400 dark:text-dark-500'
                      >
                        {t('chat.controls.fromModel')}
                      </span>
                    )}
                  </label>
                  <input
                    id={`chat-control-${option.key}`}
                    type='number'
                    inputMode='decimal'
                    step={option.step}
                    min={option.min}
                    max={option.max}
                    value={typeof value === 'number' ? value : ''}
                    placeholder={
                      typeof globalValue === 'number'
                        ? String(globalValue)
                        : t('common.default')
                    }
                    onChange={event =>
                      setNumericOverride(option.key, event.target.value)
                    }
                    className='w-24 rounded-lg border border-black/[0.08] bg-white px-2 py-1 text-end text-[12px] tabular-nums text-gray-900 placeholder:text-gray-400 focus:border-primary-500/40 focus:outline-none dark:border-white/[0.08] dark:bg-dark-50 dark:text-dark-900 dark:placeholder:text-dark-500'
                  />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* The floating keyboard-shortcuts control sits in this same corner on
          large screens; the extra space keeps it off these buttons. */}
      <div className='flex items-center justify-between gap-2 border-t border-black/[0.06] px-4 py-3 dark:border-white/[0.07] lg:pb-16'>
        <button
          onClick={() => {
            setOverrides({});
            setSystemPrompt(systemMessage?.content ?? '');
          }}
          className='text-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-dark-600 dark:hover:text-dark-900'
        >
          {t('common.reset')}
        </button>
        <Button onClick={() => void handleSave()} size='sm' disabled={saving}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
};
