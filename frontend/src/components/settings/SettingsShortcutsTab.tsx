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

import { useTranslation } from 'react-i18next';
import { isMac } from '@/utils';

interface ShortcutRow {
  labelKey: string;
  /** Key names, already ordered; `mod` becomes ⌘ or Ctrl per platform. */
  keys: string[];
}

interface ShortcutGroup {
  titleKey: string;
  rows: ShortcutRow[];
}

/**
 * Every shortcut the application listens for, written out by hand.
 *
 * They are spread across the global handler, the command palette, the
 * composer and the Work editor, so there is no single list to read them
 * from — keep this in step when a shortcut is added or changed.
 */
const shortcutGroups: ShortcutGroup[] = [
  {
    titleKey: 'keyboard.groups.general',
    rows: [
      { labelKey: 'keyboard.openPalette', keys: ['mod', 'K'] },
      { labelKey: 'keyboard.openSettings', keys: ['mod', ','] },
      { labelKey: 'keyboard.toggleDarkMode', keys: ['mod', 'D'] },
      { labelKey: 'keyboard.showShortcuts', keys: ['?'] },
      { labelKey: 'keyboard.closeModals', keys: ['Esc'] },
    ],
  },
  {
    titleKey: 'keyboard.groups.navigation',
    rows: [
      { labelKey: 'keyboard.toggleSidebar', keys: ['mod', 'B'] },
      { labelKey: 'keyboard.newChat', keys: ['mod', '⇧', 'O'] },
      { labelKey: 'keyboard.newWork', keys: ['mod', '⇧', 'U'] },
    ],
  },
  {
    titleKey: 'keyboard.groups.chat',
    rows: [
      { labelKey: 'keyboard.actions.sendMessage', keys: ['↩'] },
      { labelKey: 'keyboard.actions.newLine', keys: ['⇧', '↩'] },
      { labelKey: 'keyboard.actions.saveEdit', keys: ['↩'] },
      { labelKey: 'keyboard.actions.cancelEdit', keys: ['Esc'] },
    ],
  },
  {
    titleKey: 'keyboard.groups.workspace',
    rows: [
      { labelKey: 'keyboard.actions.saveFile', keys: ['mod', 'S'] },
      { labelKey: 'keyboard.actions.formatCode', keys: ['⌥', '⇧', 'F'] },
    ],
  },
];

export function SettingsShortcutsTab() {
  const { t } = useTranslation();
  const modifier = isMac() ? '⌘' : 'Ctrl';
  const alt = isMac() ? '⌥' : 'Alt';

  const label = (key: string) => {
    if (key === 'mod') return modifier;
    if (key === '⌥') return alt;
    return key;
  };

  return (
    <div className='space-y-6'>
      <div>
        <h3 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
          {t('keyboard.title')}
        </h3>
        <p className='mt-1 text-sm text-gray-600 dark:text-gray-400'>
          {t('keyboard.description')}
        </p>
      </div>

      {shortcutGroups.map(group => (
        <div key={group.titleKey}>
          <h4 className='mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400'>
            {t(group.titleKey)}
          </h4>
          <div className='divide-y divide-gray-200 overflow-hidden rounded-lg border border-gray-200 dark:divide-dark-300 dark:border-dark-300'>
            {group.rows.map(row => (
              <div
                key={`${group.titleKey}-${row.labelKey}`}
                className='flex items-center justify-between gap-4 bg-white px-4 py-2.5 dark:bg-dark-100'
              >
                <span className='text-sm text-gray-700 dark:text-gray-300'>
                  {t(row.labelKey)}
                </span>
                <span className='flex shrink-0 items-center gap-1'>
                  {row.keys.map((key, index) => (
                    <kbd
                      key={`${row.labelKey}-${key}-${index}`}
                      className='rounded border border-gray-300 bg-gray-100 px-2 py-1 font-mono text-xs text-gray-700 dark:border-dark-400 dark:bg-dark-200 dark:text-gray-300'
                    >
                      {label(key)}
                    </kbd>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
