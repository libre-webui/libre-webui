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

import { ChevronsUpDown } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  foldWorkDiff,
  type WorkDiffLine,
  type WorkDiffRow,
} from '@/utils/workDiff';
import { cn } from '@/utils';

interface WorkspaceDiffViewProps {
  lines: WorkDiffLine[];
  ariaLabel: string;
}

function DiffLineRow({ line }: { line: WorkDiffLine }) {
  return (
    <tr
      className={cn(
        line.type === 'added' && 'bg-[rgb(76,212,117)]/[0.12] text-ink',
        line.type === 'removed' && 'bg-[rgb(255,61,129)]/[0.10] text-ink-muted',
        line.type === 'context' && 'text-ink-muted'
      )}
    >
      <td className='w-10 select-none px-2 text-right align-top text-[10px] tabular-nums text-ink-subtle'>
        {line.beforeLine ?? ''}
      </td>
      <td className='w-10 select-none px-2 text-right align-top text-[10px] tabular-nums text-ink-subtle'>
        {line.afterLine ?? ''}
      </td>
      <td className='w-full whitespace-pre-wrap break-all px-3 align-top'>
        <span
          aria-hidden='true'
          className={cn(
            'me-2 inline-block w-3 select-none text-center',
            line.type === 'added' && 'text-[rgb(46,164,79)]',
            line.type === 'removed' && 'text-[rgb(255,61,129)]'
          )}
        >
          {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ''}
        </span>
        {line.text || '\u200b'}
      </td>
    </tr>
  );
}

const NO_EXPANDED_FOLDS: ReadonlySet<number> = new Set();

// Hunks of a parsed git patch skip the unchanged middle of the file entirely,
// so those hidden lines cannot be expanded; a static divider still marks the
// jump. Folds built from full file content stay expandable.
const rowGaps = (rows: WorkDiffRow[]): number[] => {
  let previous: WorkDiffLine | null = null;
  return rows.map(row => {
    const line = row.type === 'line' ? row.line : row.lines[0];
    const before = previous;
    previous = row.type === 'line' ? row.line : row.lines[row.lines.length - 1];
    if (!before || !line) return 0;
    if (line.beforeLine !== undefined && before.beforeLine !== undefined) {
      return line.beforeLine - before.beforeLine - 1;
    }
    if (line.afterLine !== undefined && before.afterLine !== undefined) {
      return line.afterLine - before.afterLine - 1;
    }
    return 0;
  });
};

export function WorkspaceDiffTable({ lines }: { lines: WorkDiffLine[] }) {
  const { t } = useTranslation();
  const rows = useMemo(() => foldWorkDiff(lines), [lines]);
  const gaps = useMemo(() => rowGaps(rows), [rows]);
  // Folds are addressed by their row index in the folded layout. The set is
  // tied to the rows it was built for, so a new diff starts fully folded.
  const [expandedFor, setExpandedFor] = useState<{
    rows: unknown;
    set: ReadonlySet<number>;
  }>({ rows: null, set: NO_EXPANDED_FOLDS });
  const expanded =
    expandedFor.rows === rows ? expandedFor.set : NO_EXPANDED_FOLDS;
  const expandFold = (index: number) =>
    setExpandedFor({ rows, set: new Set(expanded).add(index) });

  return (
    <table className='w-full border-collapse'>
      <tbody>
        {rows.map((row, index) => {
          const gap = gaps[index];
          return (
            <Fragment key={`row-${index}`}>
              {gap > 0 && (
                <tr data-testid='work-diff-gap'>
                  <td
                    colSpan={3}
                    className='select-none border-y border-line bg-surface-subtle/70 px-4 py-1 text-center text-[11px] text-ink-subtle'
                  >
                    {t('work.files.diffFolded', {
                      count: gap,
                      defaultValue: '{{count}} unchanged lines',
                    })}
                  </td>
                </tr>
              )}
              {renderRow(row, index)}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );

  function renderRow(row: (typeof rows)[number], index: number) {
    return row.type === 'fold' ? (
      expanded.has(index) ? (
        <Fragment key={`fold-${index}`}>
          {row.lines.map((line, lineIndex) => (
            <DiffLineRow key={lineIndex} line={line} />
          ))}
        </Fragment>
      ) : (
        <tr key={`fold-${index}`}>
          <td colSpan={3} className='p-0'>
            <button
              type='button'
              data-testid='work-diff-fold'
              onClick={() => expandFold(index)}
              className='flex w-full select-none items-center justify-center gap-1.5 border-y border-line bg-surface-subtle/70 px-4 py-1 text-[11px] text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink'
            >
              <ChevronsUpDown className='h-3 w-3 shrink-0' />
              {t('work.files.diffFolded', {
                count: row.count,
                defaultValue: '{{count}} unchanged lines',
              })}
            </button>
          </td>
        </tr>
      )
    ) : (
      <DiffLineRow key={`line-${index}`} line={row.line} />
    );
  }
}

export function WorkspaceDiffView({
  lines,
  ariaLabel,
}: WorkspaceDiffViewProps) {
  return (
    <div
      dir='ltr'
      role='region'
      aria-label={ariaLabel}
      data-testid='work-file-diff'
      className='min-h-0 flex-1 overflow-auto bg-surface font-mono text-[12px] leading-5'
    >
      <WorkspaceDiffTable lines={lines} />
    </div>
  );
}
