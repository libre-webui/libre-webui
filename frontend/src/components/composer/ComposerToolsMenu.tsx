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
 * The composer's tool picker: the wrench opens a menu with a master switch
 * and one checkbox per built-in tool and per registered server, so a turn
 * can run with exactly the tools the user wants. The selection only narrows
 * what the account (and the active profile) already allows.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Wrench } from 'lucide-react';
import { cn } from '@/utils';
import { Button } from '@/components/ui';
import { toolsApi, type ToolCatalogEntry } from '@/utils/api/toolsApi';
import type { ComposerToolsValue } from './composerTools';

interface ComposerToolsMenuProps {
  value: ComposerToolsValue;
  onChange: (value: ComposerToolsValue) => void;
  disabled?: boolean;
  buttonClassName?: string;
}

const toggleId = (
  current: string[] | null,
  all: string[],
  id: string
): string[] | null => {
  const selected = new Set(current ?? all);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  const next = all.filter(entry => selected.has(entry));
  return next.length === all.length ? null : next;
};

export const ComposerToolsMenu: React.FC<ComposerToolsMenuProps> = ({
  value,
  onChange,
  disabled = false,
  buttonClassName,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [catalog, setCatalog] = useState<ToolCatalogEntry[] | null>(null);
  const [available, setAvailable] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Fetched on mount for the initial availability check, then again on every
  // open: tools and servers added mid-session must appear without a reload.
  useEffect(() => {
    let cancelled = false;
    toolsApi
      .getCatalog()
      .then(response => {
        if (cancelled || !response.success || !response.data) return;
        setAvailable(response.data.available && response.data.tools.length > 0);
        setCatalog(response.data.tools);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  // The menu opens upward, so it may only be as tall as the space between
  // the trigger and the top of the viewport (like the tab bar's menus). The
  // option list scrolls inside that box; the toggle and hint stay pinned.
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const container = containerRef.current;
      if (!container) return;
      const triggerTop = container.getBoundingClientRect().top;
      // The chat pane clips its overflow, so the usable space ends at the
      // nearest clipping ancestor's top edge, not at the viewport's.
      let clipTop = 0;
      for (
        let ancestor = container.parentElement;
        ancestor && ancestor !== document.body;
        ancestor = ancestor.parentElement
      ) {
        const { overflowY, overflowX } = getComputedStyle(ancestor);
        if (overflowY !== 'visible' || overflowX !== 'visible') {
          clipTop = Math.max(clipTop, ancestor.getBoundingClientRect().top);
        }
      }
      // 8px gap above the trigger (mb-2) plus 16px breathing room at the top.
      setMaxHeight(Math.max(160, Math.floor(triggerTop - clipTop - 24)));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open]);

  if (!available || !catalog) return null;

  const builtins = catalog.filter(entry => entry.source === 'builtin');
  const serverEntries = new Map<string, string>();
  for (const entry of catalog) {
    if (entry.serverId) {
      serverEntries.set(entry.serverId, entry.serverName ?? entry.serverId);
    }
  }
  const servers = [...serverEntries.entries()];
  const builtinIds = builtins.map(entry => entry.name);
  const serverIds = servers.map(([id]) => id);
  const checkedBuiltin = new Set(value.builtinTools ?? builtinIds);
  const checkedServers = new Set(value.serverIds ?? serverIds);

  const checkboxRow = (
    key: string,
    label: string,
    hint: string | undefined,
    checked: boolean,
    onToggle: () => void
  ) => (
    <label
      key={key}
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-gray-50 dark:hover:bg-dark-100',
        !value.enabled && 'opacity-50'
      )}
      onClickCapture={
        value.enabled
          ? undefined
          : event => {
              // A dimmed row means tools are off: the first click anywhere
              // just turns them on, keeping the shown selection intact.
              event.preventDefault();
              event.stopPropagation();
              onChange({ ...value, enabled: true });
            }
      }
    >
      <input
        type='checkbox'
        checked={checked}
        disabled={!value.enabled}
        onChange={onToggle}
        data-testid='composer-tool-option'
        className='mt-0.5 h-3.5 w-3.5 accent-primary-600'
      />
      <span className='min-w-0'>
        <span
          className='block truncate text-gray-800 dark:text-gray-200'
          dir='ltr'
        >
          {label}
        </span>
        {hint && (
          <span className='block truncate text-xs text-gray-500 dark:text-gray-400'>
            {hint}
          </span>
        )}
      </span>
    </label>
  );

  return (
    <div ref={containerRef} className='relative flex-shrink-0'>
      <Button
        type='button'
        variant='ghost'
        size='sm'
        disabled={disabled}
        onClick={() => setOpen(current => !current)}
        className={cn(
          'h-9 w-9 sm:h-10 sm:w-10 p-0 rounded-full flex-shrink-0 flex items-center justify-center',
          'text-gray-500 dark:text-dark-600 hover:bg-gray-100 dark:hover:bg-dark-300',
          'transition-colors duration-150 touch-manipulation',
          value.enabled &&
            'bg-primary-50 text-primary-600 dark:bg-primary-900/25 dark:text-primary-400',
          buttonClassName
        )}
        title={
          value.enabled ? t('chat.input.toolsOn') : t('chat.input.toolsOff')
        }
        aria-pressed={value.enabled}
        aria-expanded={open}
        data-testid='composer-tools-button'
      >
        <Wrench className='h-4 w-4' />
      </Button>

      {open && (
        <div
          className='absolute bottom-full start-0 z-30 mb-2 flex w-72 flex-col rounded-xl border border-gray-200 bg-white p-2 shadow-lg dark:border-dark-200 dark:bg-dark-50'
          style={{ maxHeight }}
          data-testid='composer-tools-menu'
        >
          <label className='flex flex-shrink-0 cursor-pointer items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-gray-800 dark:text-gray-200'>
            {t('composer.toolsMenu.enable')}
            <input
              type='checkbox'
              checked={value.enabled}
              onChange={() => onChange({ ...value, enabled: !value.enabled })}
              data-testid='composer-tools-enable'
              className='h-3.5 w-3.5 accent-primary-600'
            />
          </label>

          <div
            className='min-h-0 flex-1 overflow-y-auto overscroll-contain'
            data-testid='composer-tools-options'
          >
            {builtins.length > 0 && (
              <>
                <p className='mt-1 px-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
                  {t('composer.toolsMenu.builtin')}
                </p>
                {builtins.map(entry =>
                  checkboxRow(
                    entry.name,
                    entry.name,
                    undefined,
                    checkedBuiltin.has(entry.name),
                    () =>
                      onChange({
                        ...value,
                        enabled: true,
                        builtinTools: toggleId(
                          value.builtinTools,
                          builtinIds,
                          entry.name
                        ),
                      })
                  )
                )}
              </>
            )}

            {servers.length > 0 && (
              <>
                <p className='mt-1 px-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-dark-500 rtl:tracking-normal'>
                  {t('composer.toolsMenu.servers')}
                </p>
                {servers.map(([id, name]) =>
                  checkboxRow(id, name, undefined, checkedServers.has(id), () =>
                    onChange({
                      ...value,
                      enabled: true,
                      serverIds: toggleId(value.serverIds, serverIds, id),
                    })
                  )
                )}
              </>
            )}
          </div>

          <p className='mt-1 flex-shrink-0 border-t border-gray-100 px-2 pb-0.5 pt-1.5 text-[11px] leading-4 text-gray-400 dark:border-dark-200 dark:text-dark-500'>
            {t('composer.toolsMenu.hint')}
          </p>
        </div>
      )}
    </div>
  );
};
