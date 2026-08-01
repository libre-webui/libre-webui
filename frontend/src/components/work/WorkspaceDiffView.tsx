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

import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { foldWorkDiff, type WorkDiffLine } from '@/utils/workDiff';
import { cn } from '@/utils';

interface WorkspaceDiffViewProps {
  lines: WorkDiffLine[];
  ariaLabel: string;
}

export function WorkspaceDiffView({
  lines,
  ariaLabel,
}: WorkspaceDiffViewProps) {
  const { t } = useTranslation();
  const rows = useMemo(() => foldWorkDiff(lines), [lines]);

  return (
    <div
      dir='ltr'
      role='region'
      aria-label={ariaLabel}
      data-testid='work-file-diff'
      className='min-h-0 flex-1 overflow-auto bg-surface font-mono text-[12px] leading-5'
    >
      <table className='w-full border-collapse'>
        <tbody>
          {rows.map((row, index) =>
            row.type === 'fold' ? (
              <tr key={`fold-${index}`}>
                <td
                  colSpan={3}
                  className='select-none border-y border-line bg-surface-subtle/70 px-4 py-1 text-center text-[11px] text-ink-subtle'
                >
                  {t('work.files.diffFolded', {
                    count: row.count,
                    defaultValue: '{{count}} unchanged lines',
                  })}
                </td>
              </tr>
            ) : (
              <tr
                key={`line-${index}`}
                className={cn(
                  row.line.type === 'added' &&
                    'bg-[rgb(76,212,117)]/[0.12] text-ink',
                  row.line.type === 'removed' &&
                    'bg-[rgb(255,61,129)]/[0.10] text-ink-muted',
                  row.line.type === 'context' && 'text-ink-muted'
                )}
              >
                <td className='w-10 select-none px-2 text-right align-top text-[10px] tabular-nums text-ink-subtle'>
                  {row.line.beforeLine ?? ''}
                </td>
                <td className='w-10 select-none px-2 text-right align-top text-[10px] tabular-nums text-ink-subtle'>
                  {row.line.afterLine ?? ''}
                </td>
                <td className='w-full whitespace-pre-wrap break-all px-3 align-top'>
                  <span
                    aria-hidden='true'
                    className={cn(
                      'me-2 inline-block w-3 select-none text-center',
                      row.line.type === 'added' && 'text-[rgb(46,164,79)]',
                      row.line.type === 'removed' && 'text-[rgb(255,61,129)]'
                    )}
                  >
                    {row.line.type === 'added'
                      ? '+'
                      : row.line.type === 'removed'
                        ? '−'
                        : ''}
                  </span>
                  {row.line.text || '\u200b'}
                </td>
              </tr>
            )
          )}
        </tbody>
      </table>
    </div>
  );
}
