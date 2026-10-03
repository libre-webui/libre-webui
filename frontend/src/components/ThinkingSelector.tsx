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

import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Brain, Check } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/utils';
import {
  THINKING_CHOICES,
  isThinkingEnabled,
  thinkingChoiceOf,
  thinkingPreferenceOf,
} from '@/utils/thinking';
import type { ThinkingPreference } from '@/types';

interface ThinkingSelectorProps {
  /** The chat's current setting, or nothing when the default applies. */
  value: ThinkingPreference | null | undefined;
  /**
   * What "default" currently resolves to — the user's pinned or global
   * setting. The button reflects the value the next reply actually runs
   * with, not just this chat's override.
   */
  inheritedValue?: ThinkingPreference | null;
  onChange: (think: ThinkingPreference | null) => void;
}

/**
 * The composer's reasoning control: one press opens the levels, because a
 * plain on/off switch cannot say how hard to think, and the levels are the
 * point of the setting.
 */
export const ThinkingSelector: React.FC<ThinkingSelectorProps> = ({
  value,
  inheritedValue,
  onChange,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const effective = value ?? inheritedValue;
  const active = isThinkingEnabled(effective);
  const effectiveChoice = thinkingChoiceOf(effective);
  const choice = thinkingChoiceOf(value);
  const inheritedChoice =
    inheritedValue === undefined || inheritedValue === null
      ? undefined
      : thinkingChoiceOf(inheritedValue);

  const menuRef = useRef<HTMLDivElement>(null);
  const triggerLabel = active
    ? t('chat.input.thinkingOn', {
        level: t(`settings.generation.thinkingLevels.${effectiveChoice}`),
      })
    : t('chat.input.thinkingOff');
  const focusTrigger = () =>
    containerRef.current?.querySelector<HTMLElement>('button')?.focus();

  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>(
      '[role="menuitemradio"]'
    );
    const target =
      Array.from(items ?? []).find(
        item => item.getAttribute('aria-checked') === 'true'
      ) ?? items?.[0];
    target?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        focusTrigger();
      }
    };
    window.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  return (
    <div ref={containerRef} className='relative shrink-0'>
      <Button
        type='button'
        variant='ghost'
        size='sm'
        onClick={() => setOpen(previous => !previous)}
        className={cn(
          'h-9 rounded-full p-0 flex items-center justify-center gap-1 touch-manipulation transition-colors duration-150',
          active ? 'w-auto px-2.5' : 'w-9',
          'text-ink-muted hover:bg-interactive-hover hover:text-ink',
          active &&
            'bg-primary-50 text-primary-600 dark:bg-primary-900/25 dark:text-primary-400'
        )}
        title={triggerLabel}
        aria-label={triggerLabel}
        aria-haspopup='menu'
        aria-expanded={open}
        aria-pressed={active}
      >
        <Brain className='h-4 w-4' aria-hidden='true' />
        {active && (
          <span className='text-[11px] font-medium'>
            {t(`settings.generation.thinkingLevels.${effectiveChoice}`)}
          </span>
        )}
      </Button>

      {open && (
        <div
          ref={menuRef}
          role='menu'
          aria-label={t('chat.controls.thinking')}
          onKeyDown={event => {
            const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
            if (!keys.includes(event.key)) return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>(
                '[role="menuitemradio"]'
              )
            );
            if (items.length === 0) return;
            event.preventDefault();
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowDown'
                    ? (index + 1) % items.length
                    : (index - 1 + items.length) % items.length;
            items[next].focus();
          }}
          className='absolute bottom-full inset-e-0 z-30 mb-2 w-48 rounded-2xl border border-black/8 bg-surface/95 p-1.5 shadow-[0_16px_48px_rgba(15,23,42,0.16)] backdrop-blur-xl animate-scale-in dark:border-white/9 dark:bg-dark-100/95'
        >
          <p className='mb-1 px-2 pt-1 text-[11px] font-medium text-ink-muted'>
            {t('chat.controls.thinking')}
          </p>
          {THINKING_CHOICES.map(option => {
            const selected = option === choice;
            return (
              <button
                key={option}
                type='button'
                role='menuitemradio'
                aria-checked={selected}
                tabIndex={-1}
                onClick={() => {
                  onChange(thinkingPreferenceOf(option));
                  setOpen(false);
                  focusTrigger();
                }}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-start text-[13px] text-gray-700 hover:bg-gray-100 dark:text-dark-800 dark:hover:bg-dark-200',
                  selected && 'text-primary-600 dark:text-primary-400'
                )}
              >
                <span className='truncate'>
                  {option === 'default' && inheritedChoice !== undefined
                    ? t('settings.generation.thinkingLevels.defaultWith', {
                        level: t(
                          `settings.generation.thinkingLevels.${inheritedChoice}`
                        ),
                      })
                    : t(`settings.generation.thinkingLevels.${option}`)}
                </span>
                {selected && (
                  <Check className='h-3.5 w-3.5 shrink-0' aria-hidden='true' />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
