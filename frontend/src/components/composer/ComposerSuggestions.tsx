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

/**
 * Composer command menus: a leading `/` offers the prompt library and a
 * trailing `$token` offers skills. Selecting a prompt with variables opens a
 * typed fill-in form before the rendered content replaces the draft;
 * selecting a skill inserts its `$slug` mention for the model to load.
 */

import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { BookText, Sparkles } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '@/components/ui';
import { promptsApi, skillsApi } from '@/utils/api';
import type { Prompt, PromptVariable, Skill } from '@/utils/api';

const PROMPT_TRIGGER = /^\/([a-z0-9-]*)$/;
const SKILL_TRIGGER = /(?:^|\s)\$([a-z0-9-]*)$/;
const MAX_SUGGESTIONS = 8;

export interface ComposerSuggestionsHandle {
  /** Returns true when the key event drove the menu and must not reach the input. */
  handleKeyDown(event: React.KeyboardEvent): boolean;
}

interface ComposerSuggestionsProps {
  message: string;
  disabled?: boolean;
  onApply: (message: string) => void;
}

const renderPromptContent = (
  content: string,
  variables: readonly PromptVariable[],
  values: Record<string, string>
): string =>
  content.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g,
    (token, name: string) => {
      const declared = variables.find(variable => variable.name === name);
      if (!declared) return token;
      const value = values[name];
      return value !== undefined && value !== ''
        ? value
        : (declared.default ?? '');
    }
  );

const VariableFillForm: React.FC<{
  prompt: Prompt;
  onCancel: () => void;
  onInsert: (rendered: string) => void;
}> = ({ prompt, onCancel, onInsert }) => {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      prompt.variables.map(variable => [
        variable.name,
        variable.default ?? (variable.type === 'boolean' ? 'false' : ''),
      ])
    )
  );
  const missing = prompt.variables.filter(
    variable =>
      variable.required === true &&
      (values[variable.name] === undefined || values[variable.name] === '')
  );

  return (
    <div className='p-3'>
      <div className='text-sm font-medium text-gray-700 dark:text-gray-200'>
        {t('composer.variables.title', { title: prompt.title })}
      </div>
      <div className='mt-2 flex max-h-56 flex-col gap-2 overflow-y-auto'>
        {prompt.variables.map(variable => (
          <label key={variable.name} className='flex flex-col gap-1 text-xs'>
            <span className='text-gray-500 dark:text-gray-400' dir='ltr'>
              {variable.label || variable.name}
              {variable.required ? ' *' : ''}
            </span>
            {variable.type === 'select' ? (
              <select
                value={values[variable.name] ?? ''}
                onChange={event =>
                  setValues(prev => ({
                    ...prev,
                    [variable.name]: event.target.value,
                  }))
                }
                className='rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-dark-300 dark:bg-dark-100'
              >
                <option value=''>—</option>
                {(variable.options ?? []).map(option => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : variable.type === 'boolean' ? (
              <select
                value={values[variable.name] ?? 'false'}
                onChange={event =>
                  setValues(prev => ({
                    ...prev,
                    [variable.name]: event.target.value,
                  }))
                }
                className='rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-dark-300 dark:bg-dark-100'
              >
                <option value='true'>{t('common.yes')}</option>
                <option value='false'>{t('common.no')}</option>
              </select>
            ) : (
              <input
                type={variable.type === 'number' ? 'number' : 'text'}
                value={values[variable.name] ?? ''}
                onChange={event =>
                  setValues(prev => ({
                    ...prev,
                    [variable.name]: event.target.value,
                  }))
                }
                className='rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-dark-300 dark:bg-dark-100'
              />
            )}
          </label>
        ))}
      </div>
      <div className='mt-3 flex items-center justify-end gap-2'>
        <Button size='sm' variant='ghost' onClick={onCancel}>
          {t('composer.variables.cancel')}
        </Button>
        <Button
          size='sm'
          disabled={missing.length > 0}
          title={
            missing.length > 0
              ? t('composer.variables.required', {
                  name: missing[0]?.name ?? '',
                })
              : undefined
          }
          onClick={() =>
            onInsert(
              renderPromptContent(prompt.content, prompt.variables, values)
            )
          }
        >
          {t('composer.variables.insert')}
        </Button>
      </div>
    </div>
  );
};

export const ComposerSuggestions = forwardRef<
  ComposerSuggestionsHandle,
  ComposerSuggestionsProps
>(({ message, disabled = false, onApply }, ref) => {
  const { t } = useTranslation();
  const [prompts, setPrompts] = useState<Prompt[] | null>(null);
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const [fillPrompt, setFillPrompt] = useState<Prompt | null>(null);
  const loadingRef = useRef({ prompts: false, skills: false });

  const promptMatch = disabled ? null : PROMPT_TRIGGER.exec(message);
  const skillMatch =
    disabled || promptMatch ? null : SKILL_TRIGGER.exec(message);

  // Refetch on every menu open (the trigger appearing), not once per mount:
  // a prompt or skill imported mid-session must show up in the next menu.
  // A stale list keeps rendering while the refresh is in flight.
  const promptMenuOpen = promptMatch !== null;
  const skillMenuOpen = skillMatch !== null;

  useEffect(() => {
    if (!promptMenuOpen || loadingRef.current.prompts) return;
    loadingRef.current.prompts = true;
    promptsApi
      .list()
      .then(response => {
        setPrompts(previous =>
          response.success && response.data ? response.data : (previous ?? [])
        );
      })
      .catch(() => setPrompts(previous => previous ?? []))
      .finally(() => {
        loadingRef.current.prompts = false;
      });
  }, [promptMenuOpen]);

  useEffect(() => {
    if (!skillMenuOpen || loadingRef.current.skills) return;
    loadingRef.current.skills = true;
    skillsApi
      .list()
      .then(response => {
        setSkills(previous =>
          response.success && response.data ? response.data : (previous ?? [])
        );
      })
      .catch(() => setSkills(previous => previous ?? []))
      .finally(() => {
        loadingRef.current.skills = false;
      });
  }, [skillMenuOpen]);

  const suggestions = useMemo(() => {
    if (promptMatch) {
      const filter = promptMatch[1];
      return (prompts ?? [])
        .filter(prompt => prompt.slug.startsWith(filter))
        .slice(0, MAX_SUGGESTIONS)
        .map(prompt => ({
          kind: 'prompt' as const,
          key: prompt.id,
          slug: prompt.slug,
          label: prompt.title,
          detail: prompt.description,
          prompt,
        }));
    }
    if (skillMatch) {
      const filter = skillMatch[1];
      return (skills ?? [])
        .filter(skill => skill.enabled && skill.slug.startsWith(filter))
        .slice(0, MAX_SUGGESTIONS)
        .map(skill => ({
          kind: 'skill' as const,
          key: skill.id,
          slug: skill.slug,
          label: skill.name,
          detail: skill.description,
          skill,
        }));
    }
    return [];
  }, [promptMatch, skillMatch, prompts, skills]);

  // Adjust selection state when the draft changes, during render rather than
  // in an effect, so the menu never paints one frame with a stale highlight.
  const [lastMessage, setLastMessage] = useState(message);
  if (message !== lastMessage) {
    setLastMessage(message);
    setHighlighted(0);
    if (!promptMatch && fillPrompt) setFillPrompt(null);
  }

  const applySelection = (index: number): void => {
    const selection = suggestions[index];
    if (!selection) return;
    if (selection.kind === 'prompt') {
      if (selection.prompt.variables.length > 0) {
        setFillPrompt(selection.prompt);
        return;
      }
      onApply(selection.prompt.content);
      return;
    }
    if (skillMatch) {
      const start = message.length - (skillMatch[1].length + 1);
      onApply(`${message.slice(0, start)}$${selection.slug} `);
    }
  };

  useImperativeHandle(ref, () => ({
    handleKeyDown(event: React.KeyboardEvent): boolean {
      if (fillPrompt) {
        if (event.key === 'Escape') {
          event.preventDefault();
          setFillPrompt(null);
          return true;
        }
        // The fill form owns Enter while it is open.
        return event.key === 'Enter';
      }
      if (suggestions.length === 0) return false;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setHighlighted(index => (index + 1) % suggestions.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setHighlighted(
          index => (index - 1 + suggestions.length) % suggestions.length
        );
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        applySelection(highlighted);
        return true;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        onApply(message);
        return true;
      }
      return false;
    },
  }));

  if (fillPrompt) {
    return (
      <div
        className='absolute bottom-full left-0 z-30 mb-2 w-full max-w-md rounded-xl border border-gray-200 bg-white shadow-lg dark:border-dark-200 dark:bg-dark-50'
        data-testid='composer-variable-form'
      >
        <VariableFillForm
          prompt={fillPrompt}
          onCancel={() => setFillPrompt(null)}
          onInsert={rendered => {
            setFillPrompt(null);
            onApply(rendered);
          }}
        />
      </div>
    );
  }

  // A bare trigger with an empty library gets a pointer instead of silence.
  const activeTrigger = promptMatch ? 'prompt' : skillMatch ? 'skill' : null;
  const libraryLoaded = promptMatch ? prompts !== null : skills !== null;
  const bareTrigger = promptMatch
    ? promptMatch[1] === ''
    : skillMatch
      ? skillMatch[1] === ''
      : false;
  if (suggestions.length === 0) {
    if (activeTrigger && libraryLoaded && bareTrigger) {
      return (
        <div
          className='absolute bottom-full left-0 z-30 mb-2 w-full max-w-md rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 shadow-lg dark:border-dark-200 dark:bg-dark-50 dark:text-gray-400'
          data-testid='composer-suggestions-empty'
        >
          {activeTrigger === 'prompt'
            ? t('composer.promptMenu.empty')
            : t('composer.skillMenu.empty')}
        </div>
      );
    }
    return null;
  }

  return (
    <div
      role='listbox'
      aria-label={
        promptMatch
          ? t('composer.promptMenu.label')
          : t('composer.skillMenu.label')
      }
      className='absolute bottom-full left-0 z-30 mb-2 w-full max-w-md overflow-hidden rounded-xl border border-gray-200 bg-white shadow-lg dark:border-dark-200 dark:bg-dark-50'
      data-testid='composer-suggestions'
    >
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.key}
          type='button'
          role='option'
          aria-selected={index === highlighted}
          onMouseEnter={() => setHighlighted(index)}
          onMouseDown={event => {
            event.preventDefault();
            applySelection(index);
          }}
          className={cn(
            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm',
            index === highlighted
              ? 'bg-gray-100 dark:bg-dark-200'
              : 'bg-transparent'
          )}
        >
          {suggestion.kind === 'prompt' ? (
            <BookText className='h-3.5 w-3.5 shrink-0 text-gray-400' />
          ) : (
            <Sparkles className='h-3.5 w-3.5 shrink-0 text-gray-400' />
          )}
          <span className='font-mono text-xs text-gray-500' dir='ltr'>
            {suggestion.kind === 'prompt' ? '/' : '$'}
            {suggestion.slug}
          </span>
          <span className='truncate text-gray-700 dark:text-gray-200'>
            {suggestion.label}
          </span>
          {suggestion.detail && (
            <span className='ml-auto hidden max-w-[40%] truncate text-xs text-gray-400 sm:block'>
              {suggestion.detail}
            </span>
          )}
        </button>
      ))}
    </div>
  );
});
ComposerSuggestions.displayName = 'ComposerSuggestions';
