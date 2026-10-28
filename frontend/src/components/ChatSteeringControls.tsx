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
import {
  steeringApi,
  type SteeringVector,
  type SteeringVectors,
} from '@/utils/api/steeringApi';

interface ChatSteeringControlsProps {
  model: string;
  /** The provider the chat is pinned to, when it is pinned. */
  providerId?: string;
  /** False for models no steering server can be behind (Ollama, agents). */
  enabled: boolean;
  value: Record<string, number> | undefined;
  onChange: (next: Record<string, number> | undefined) => void;
}

const SLIDER_MAX = 1;
const SLIDER_STEP = 0.05;
const FILTER_THRESHOLD = 8;

const groupKeyOf = (vector: SteeringVector) => vector.group?.trim() || '';

const capitalize = (text: string) =>
  text ? text.charAt(0).toLocaleUpperCase() + text.slice(1) : text;

/**
 * Sliders for the steering vectors a model's server offers. The server is
 * asked when the controls open for a model, since on a llama-swap proxy
 * asking can load that model; the answer decides whether this section shows
 * at all.
 */
export const ChatSteeringControls: React.FC<ChatSteeringControlsProps> = ({
  model,
  providerId,
  enabled,
  value,
  onChange,
}) => {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const requestKey = `${providerId ?? ''}\u0000${model}`;
  const [result, setResult] = useState<{
    key: string;
    data: SteeringVectors | null;
  } | null>(null);
  const [filter, setFilter] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!enabled || !model) return;
    let cancelled = false;
    steeringApi
      .getVectors(model, providerId)
      .then(response => {
        if (cancelled) return;
        setResult({
          key: requestKey,
          data: response.success && response.data ? response.data : null,
        });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, model, providerId, requestKey]);

  const loading = enabled && Boolean(model) && result?.key !== requestKey;
  const vectors = useMemo(
    () =>
      result?.key === requestKey && result.data?.supported
        ? result.data.vectors
        : [],
    [result, requestKey]
  );
  const mix = useMemo(() => value ?? {}, [value]);
  const byName = useMemo(
    () => new Map(vectors.map(vector => [vector.name, vector])),
    [vectors]
  );

  const groups = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    const ordered = new Map<string, SteeringVector[]>();
    for (const vector of vectors) {
      const haystack = [vector.label, vector.name, vector.description]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      const key = groupKeyOf(vector);
      ordered.set(key, [...(ordered.get(key) ?? []), vector]);
    }
    // Named groups alphabetically, ungrouped vectors last.
    return [...ordered.entries()].sort(([a], [b]) =>
      !a ? 1 : !b ? -1 : a.localeCompare(b, language)
    );
  }, [vectors, filter, language]);

  if (!enabled || !model) return null;

  if (loading) {
    return (
      <div>
        <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'>
          {t('chat.controls.steering.title')}
        </p>
        <p className='text-[11px] leading-snug text-ink-muted'>
          {t('chat.controls.steering.checking')}
        </p>
      </div>
    );
  }

  if (vectors.length === 0) return null;

  const setStrength = (name: string, strength: number) => {
    const next = { ...mix };
    if (strength === 0) delete next[name];
    else next[name] = strength;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  const format = (strength: number) =>
    strength.toLocaleString(language, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const labelOf = (name: string) => byName.get(name)?.label || name;
  const active = Object.entries(mix);

  return (
    <div data-testid='chat-steering-controls'>
      <div className='mb-1.5 flex items-center justify-between gap-2'>
        <p className='text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-dark-500'>
          {t('chat.controls.steering.title')}
        </p>
        {active.length > 0 && (
          <button
            type='button'
            onClick={() => onChange(undefined)}
            className='text-[11px] text-gray-500 transition-colors hover:text-gray-900 dark:text-dark-600 dark:hover:text-dark-900'
          >
            {t('common.clear')}
          </button>
        )}
      </div>
      <p className='mb-2.5 text-[11px] leading-snug text-ink-muted'>
        {t('chat.controls.steering.description')}
      </p>

      {active.length > 0 && (
        <div className='mb-2.5 flex flex-wrap gap-1.5'>
          {active.map(([name, strength]) => (
            <span
              key={name}
              className='inline-flex items-center gap-1 rounded-full bg-primary-500/10 py-0.5 ps-2 pe-1 text-[11px] text-primary-700 dark:text-primary-300'
            >
              <span>{labelOf(name)}</span>
              <span className='tabular-nums opacity-80'>
                {format(strength)}
              </span>
              <button
                type='button'
                onClick={() => setStrength(name, 0)}
                className='rounded-full p-0.5 hover:bg-primary-500/15'
                aria-label={t('chat.controls.steering.remove', {
                  name: labelOf(name),
                })}
                title={t('chat.controls.steering.remove', {
                  name: labelOf(name),
                })}
              >
                <X className='h-3 w-3' />
              </button>
            </span>
          ))}
        </div>
      )}

      {vectors.length > FILTER_THRESHOLD && (
        <input
          type='search'
          value={filter}
          onChange={event => setFilter(event.target.value)}
          placeholder={t('chat.controls.steering.filter')}
          aria-label={t('chat.controls.steering.filter')}
          className='mb-2 w-full rounded-lg border border-black/8 bg-white px-2.5 py-1.5 text-[12px] text-gray-900 placeholder:text-gray-400 focus:border-primary-500 focus:outline-hidden focus:ring-2 focus:ring-primary-500/30 dark:border-white/8 dark:bg-dark-50 dark:text-dark-900 dark:placeholder:text-dark-500'
        />
      )}

      {groups.length === 0 ? (
        <p className='text-[11px] text-ink-muted'>
          {t('chat.controls.steering.noMatches')}
        </p>
      ) : (
        <div className='space-y-1'>
          {groups.map(([group, members]) => {
            const activeInGroup = members.filter(
              vector => mix[vector.name] !== undefined
            ).length;
            const open =
              openGroups[group] ??
              (filter.trim() !== '' ||
                activeInGroup > 0 ||
                groups.length === 1);
            return (
              <details
                key={group || 'other'}
                open={open}
                onToggle={event => {
                  const isOpen = event.currentTarget.open;
                  if (isOpen !== open) {
                    setOpenGroups(previous => ({
                      ...previous,
                      [group]: isOpen,
                    }));
                  }
                }}
                className='rounded-lg border border-black/6 dark:border-white/[0.07]'
              >
                <summary className='flex cursor-pointer select-none items-center justify-between gap-2 px-2.5 py-1.5 text-[12px] font-medium text-gray-800 dark:text-dark-800'>
                  <span>
                    {group
                      ? capitalize(group)
                      : t('chat.controls.steering.otherGroup')}
                  </span>
                  <span className='text-[11px] font-normal tabular-nums text-ink-muted'>
                    {activeInGroup > 0
                      ? `${activeInGroup} / ${members.length}`
                      : members.length}
                  </span>
                </summary>
                <div className='space-y-2.5 px-2.5 pb-2.5 pt-1'>
                  {members.map(vector => {
                    const strength = mix[vector.name] ?? 0;
                    const id = `chat-steering-${vector.name}`;
                    return (
                      <div key={vector.name}>
                        <div className='flex items-baseline justify-between gap-2'>
                          <label
                            htmlFor={id}
                            title={vector.description}
                            className='min-w-0 truncate text-[13px] text-gray-700 dark:text-dark-700'
                          >
                            {vector.label || vector.name}
                          </label>
                          <span
                            className={
                              strength !== 0
                                ? 'shrink-0 text-[11px] tabular-nums text-primary-700 dark:text-primary-300'
                                : 'shrink-0 text-[11px] text-ink-muted'
                            }
                          >
                            {strength !== 0
                              ? format(strength)
                              : t('common.off')}
                          </span>
                        </div>
                        <input
                          id={id}
                          type='range'
                          min={0}
                          max={SLIDER_MAX}
                          step={SLIDER_STEP}
                          value={Math.min(Math.max(strength, 0), SLIDER_MAX)}
                          onChange={event =>
                            setStrength(
                              vector.name,
                              Math.round(Number(event.target.value) * 100) / 100
                            )
                          }
                          className='w-full accent-primary-500'
                        />
                        {vector.description && (
                          <p
                            title={vector.description}
                            className='truncate text-[11px] leading-snug text-ink-muted'
                          >
                            {vector.description}
                          </p>
                        )}
                      </div>
                    );
                  })}
                </div>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default ChatSteeringControls;
