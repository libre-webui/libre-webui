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

import React from 'react';
import {
  Check,
  ChevronsDownUp,
  ChevronsUpDown,
  Code2,
  Copy,
  Download,
  Eye,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/store/appStore';
import { generateId } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:ui:message-code-block');

/** Blocks longer than this render collapsed until the user expands them. */
const COLLAPSE_THRESHOLD = 24;

const DOWNLOAD_EXTENSIONS: Record<string, string> = {
  bash: 'sh',
  c: 'c',
  cpp: 'cpp',
  csharp: 'cs',
  css: 'css',
  go: 'go',
  html: 'html',
  htm: 'html',
  java: 'java',
  javascript: 'js',
  js: 'js',
  json: 'json',
  jsx: 'jsx',
  kotlin: 'kt',
  markdown: 'md',
  mermaid: 'mmd',
  php: 'php',
  python: 'py',
  py: 'py',
  ruby: 'rb',
  rust: 'rs',
  sh: 'sh',
  shell: 'sh',
  sql: 'sql',
  svg: 'svg',
  swift: 'swift',
  toml: 'toml',
  ts: 'ts',
  tsx: 'tsx',
  typescript: 'ts',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'sh',
};

type PreviewType = 'html' | 'svg' | 'mermaid';

function detectPreviewType(
  language: string | null | undefined,
  code: string
): PreviewType | null {
  const lang = (language || '').toLowerCase();
  if (lang === 'html' || lang === 'htm') return 'html';
  if (lang === 'svg') return 'svg';
  if (lang === 'mermaid') return 'mermaid';
  const head = code.slice(0, 500).toLowerCase();
  if ((!lang || lang === 'xml') && head.includes('<svg')) return 'svg';
  if (!lang && (head.includes('<!doctype html') || head.includes('<html'))) {
    return 'html';
  }
  return null;
}

interface MessageCodeBlockProps {
  code: string;
  language?: string | null;
  state: 'streaming' | 'complete';
  children: React.ReactNode;
}

export function MessageCodeBlock({
  code,
  language,
  state,
  children,
}: MessageCodeBlockProps) {
  const { t } = useTranslation();
  const openArtifactPanel = useAppStore(state => state.openArtifactPanel);
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);
  const [manualExpanded, setManualExpanded] = React.useState<boolean | null>(
    null
  );
  const resetCopiedTimerRef = React.useRef<number | null>(null);
  const copied = copiedCode === code;
  const languageLabel = language || 'text';
  const copyLabel = copied ? t('artifacts.copied') : t('artifacts.copy');
  const accessibleCopyLabel = `${copyLabel}: ${languageLabel}`;

  const lineCount = React.useMemo(
    () => (code ? code.split('\n').length : 0),
    [code]
  );
  const collapsed =
    manualExpanded === null ? lineCount > COLLAPSE_THRESHOLD : !manualExpanded;
  const previewType =
    state === 'complete' ? detectPreviewType(language, code) : null;

  React.useEffect(
    () => () => {
      if (resetCopiedTimerRef.current !== null) {
        window.clearTimeout(resetCopiedTimerRef.current);
      }
    },
    []
  );

  const handleCopy = async () => {
    if (!code) return;

    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(code);

      if (resetCopiedTimerRef.current !== null) {
        window.clearTimeout(resetCopiedTimerRef.current);
      }
      resetCopiedTimerRef.current = window.setTimeout(() => {
        setCopiedCode(null);
        resetCopiedTimerRef.current = null;
      }, 2000);
    } catch (error) {
      logger.error('Failed to copy code:', error);
    }
  };

  const handleDownload = () => {
    if (!code) return;
    const extension =
      DOWNLOAD_EXTENSIONS[(language || '').toLowerCase()] || 'txt';
    const blob = new Blob([code], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `snippet.${extension}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const handlePreview = () => {
    if (!previewType || !code) return;
    const now = Date.now();
    openArtifactPanel({
      id: generateId(),
      type: previewType,
      title: `${languageLabel} ${t('artifacts.preview')}`,
      content: code,
      language: languageLabel,
      createdAt: now,
      updatedAt: now,
    });
  };

  return (
    <div
      dir='ltr'
      data-testid='code-block'
      data-state={state}
      data-language={languageLabel}
      data-collapsed={collapsed}
      className='group relative my-4 overflow-hidden rounded-xl border border-line bg-surface-subtle text-left text-ink shadow-[0_12px_32px_rgba(13,17,23,0.1)] dark:border-white/10 dark:bg-[#0D1117] dark:text-[#E6EDF3] dark:shadow-[0_12px_32px_rgba(13,17,23,0.16)]'
    >
      <div className='flex h-10 items-center justify-between border-b border-line bg-surface-raised/70 px-3.5 dark:border-white/10 dark:bg-white/[0.035]'>
        <div className='flex min-w-0 items-center gap-2'>
          <Code2 className='h-3.5 w-3.5 shrink-0 text-ink-subtle dark:text-[#8B949E]' />
          <span className='truncate font-mono text-[11px] font-medium lowercase tracking-[-0.01em] text-ink-muted dark:text-[#B1BAC4]'>
            {languageLabel}
          </span>
        </div>

        <div className='flex items-center gap-1.5'>
          {state === 'streaming' && (
            <span
              role='status'
              aria-label={t('common.loading')}
              className='flex h-7 w-7 items-center justify-center'
            >
              <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-primary-400' />
            </span>
          )}
          {lineCount > COLLAPSE_THRESHOLD && (
            <button
              type='button'
              onClick={() => setManualExpanded(collapsed)}
              className='flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 dark:text-[#8B949E] dark:hover:bg-white/[0.08] dark:hover:text-[#E6EDF3]'
              title={
                collapsed ? t('artifacts.expand') : t('artifacts.collapse')
              }
              aria-label={
                collapsed ? t('artifacts.expand') : t('artifacts.collapse')
              }
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronsUpDown className='h-3.5 w-3.5' />
              ) : (
                <ChevronsDownUp className='h-3.5 w-3.5' />
              )}
            </button>
          )}
          <button
            type='button'
            onClick={handleDownload}
            disabled={!code}
            className='flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 disabled:cursor-default disabled:opacity-35 dark:text-[#8B949E] dark:hover:bg-white/[0.08] dark:hover:text-[#E6EDF3]'
            title={t('common.download')}
            aria-label={`${t('common.download')}: ${languageLabel}`}
          >
            <Download className='h-3.5 w-3.5' />
          </button>
          {previewType && (
            <button
              type='button'
              onClick={handlePreview}
              className='flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 dark:text-[#8B949E] dark:hover:bg-white/[0.08] dark:hover:text-[#E6EDF3]'
              title={t('artifacts.preview')}
              aria-label={`${t('artifacts.preview')}: ${languageLabel}`}
            >
              <Eye className='h-3.5 w-3.5' />
            </button>
          )}
          <button
            type='button'
            onClick={handleCopy}
            disabled={!code}
            className='flex h-7 w-7 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 disabled:cursor-default disabled:opacity-35 dark:text-[#8B949E] dark:hover:bg-white/[0.08] dark:hover:text-[#E6EDF3]'
            title={copyLabel}
            aria-label={accessibleCopyLabel}
          >
            {copied ? (
              <Check className='h-3.5 w-3.5 text-green-400' />
            ) : (
              <Copy className='h-3.5 w-3.5' />
            )}
          </button>
          <span className='sr-only' aria-live='polite'>
            {copied ? accessibleCopyLabel : ''}
          </span>
        </div>
      </div>

      {collapsed ? (
        <button
          type='button'
          onClick={() => setManualExpanded(true)}
          className='block w-full px-3.5 py-2.5 text-left font-mono text-[11px] italic text-ink-subtle transition-colors hover:bg-surface-raised/70 hover:text-ink dark:text-[#8B949E] dark:hover:bg-white/[0.035] dark:hover:text-[#E6EDF3]'
        >
          {t('chatMessage.hiddenLines', { count: lineCount })}
        </button>
      ) : (
        children
      )}
    </div>
  );
}

export default MessageCodeBlock;
