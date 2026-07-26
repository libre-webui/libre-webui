/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';
import { detectWorkLanguage } from '@/utils/workCode';

const SyntaxHighlighter = lazy(async () => {
  const module = await import('@/components/OptimizedSyntaxHighlighter');
  return { default: module.OptimizedSyntaxHighlighter };
});

const MAX_HIGHLIGHT_CHARACTERS = 8_000;
const MAX_HIGHLIGHT_LINES = 400;
const HIGHLIGHT_IDLE_DELAY_MS = 500;

interface WorkspaceCodeEditorProps {
  path: string;
  value: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSaveShortcut: () => void;
  onFormatShortcut: () => void;
}

export function WorkspaceCodeEditor({
  path,
  value,
  ariaLabel,
  disabled = false,
  onChange,
  onSaveShortcut,
  onFormatShortcut,
}: WorkspaceCodeEditorProps) {
  const { t } = useTranslation();
  const isDark = useAppStore(state => state.theme.mode === 'dark');
  const highlightContentRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [syntaxValue, setSyntaxValue] = useState('');
  const language = useMemo(() => detectWorkLanguage(path), [path]);
  const lineCount = useMemo(() => {
    if (value.length > MAX_HIGHLIGHT_CHARACTERS) {
      return MAX_HIGHLIGHT_LINES + 1;
    }
    let count = 1;
    for (let index = 0; index < value.length; index += 1) {
      if (value.charCodeAt(index) !== 10) continue;
      count += 1;
      if (count > MAX_HIGHLIGHT_LINES) break;
    }
    return count;
  }, [value]);
  const isLarge =
    value.length > MAX_HIGHLIGHT_CHARACTERS || lineCount > MAX_HIGHLIGHT_LINES;
  const highlightEligible = language !== 'text' && !isLarge;
  const highlighted = highlightEligible && syntaxValue === value;

  useEffect(() => {
    if (!highlightEligible) return;
    const timer = window.setTimeout(
      () => setSyntaxValue(value),
      HIGHLIGHT_IDLE_DELAY_MS
    );
    return () => window.clearTimeout(timer);
  }, [highlightEligible, path, value]);

  useLayoutEffect(() => {
    if (!highlighted || !highlightContentRef.current || !textareaRef.current) {
      return;
    }
    highlightContentRef.current.style.transform = `translate3d(${-textareaRef.current.scrollLeft}px, ${-textareaRef.current.scrollTop}px, 0)`;
  }, [highlighted, path]);

  const syncScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (!highlightContentRef.current) return;
    highlightContentRef.current.style.transform = `translate3d(${-event.currentTarget.scrollLeft}px, ${-event.currentTarget.scrollTop}px, 0)`;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const key = event.key.toLowerCase();
    if ((event.metaKey || event.ctrlKey) && key === 's') {
      event.preventDefault();
      onSaveShortcut();
      return;
    }
    if (event.altKey && event.shiftKey && key === 'f') {
      event.preventDefault();
      onFormatShortcut();
    }
  };

  return (
    <div
      dir='ltr'
      className={cn(
        'relative min-h-0 flex-1 overflow-hidden bg-surface focus-within:ring-1 focus-within:ring-inset focus-within:ring-primary-500/60',
        disabled && 'opacity-60'
      )}
      data-language={language}
      data-highlighted={highlighted ? 'true' : 'false'}
    >
      {highlighted && (
        <div
          aria-hidden='true'
          data-testid='work-file-highlight'
          className='pointer-events-none absolute inset-0 z-0 overflow-hidden'
        >
          <div
            ref={highlightContentRef}
            data-testid='work-file-highlight-content'
            className='min-h-full min-w-full origin-top-left will-change-transform'
          >
            <Suspense
              fallback={
                <pre className='m-0 min-h-full min-w-full whitespace-pre p-4 text-left font-mono text-[12px] leading-5 text-ink'>
                  {value || '\u200b'}
                </pre>
              }
            >
              <SyntaxHighlighter
                language={language}
                isDark={isDark}
                backgroundColor='transparent'
                borderRadius={0}
                customStyle={{
                  margin: 0,
                  minHeight: '100%',
                  minWidth: '100%',
                  width: 'max-content',
                  overflow: 'visible',
                  padding: '1rem',
                  fontSize: '12px',
                  lineHeight: '20px',
                  tabSize: 2,
                  whiteSpace: 'pre',
                }}
              >
                {syntaxValue || '\u200b'}
              </SyntaxHighlighter>
            </Suspense>
          </div>
        </div>
      )}

      <textarea
        ref={textareaRef}
        data-testid='work-file-editor'
        data-language={language}
        aria-label={ariaLabel}
        value={value}
        onChange={event => onChange(event.target.value)}
        onScroll={syncScroll}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        spellCheck={false}
        wrap='off'
        className={cn(
          'absolute inset-0 z-10 h-full w-full resize-none overflow-auto whitespace-pre border-0 bg-transparent p-4 text-left font-mono text-[12px] leading-5 outline-none selection:bg-primary-500/25 disabled:cursor-not-allowed',
          highlighted ? 'text-transparent caret-ink' : 'text-ink'
        )}
        style={
          highlighted
            ? {
                WebkitTextFillColor: 'transparent',
                caretColor: 'rgb(var(--color-ink))',
                tabSize: 2,
              }
            : { tabSize: 2 }
        }
      />

      {isLarge && (
        <span
          dir='auto'
          className='pointer-events-none absolute bottom-2 end-3 z-20 rounded-md border border-line bg-surface-overlay/90 px-2 py-1 text-[10px] text-ink-muted shadow-subtle'
          title={t('work.files.highlightPaused', {
            defaultValue:
              'Live highlighting is paused for large files to keep editing responsive.',
          })}
        >
          {t('work.files.plainTextLarge', {
            defaultValue: 'Plain text · large file',
          })}
        </span>
      )}
    </div>
  );
}
