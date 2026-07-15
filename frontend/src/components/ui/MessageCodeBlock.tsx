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
import { Check, Code2, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:ui:message-code-block');

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
  const [copiedCode, setCopiedCode] = React.useState<string | null>(null);
  const resetCopiedTimerRef = React.useRef<number | null>(null);
  const copied = copiedCode === code;
  const languageLabel = language || 'text';
  const copyLabel = copied ? t('artifacts.copied') : t('artifacts.copy');
  const accessibleCopyLabel = `${copyLabel}: ${languageLabel}`;

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

  return (
    <div
      dir='ltr'
      data-testid='code-block'
      data-state={state}
      data-language={languageLabel}
      className='group relative my-4 overflow-hidden rounded-xl border border-white/10 bg-[#0D1117] text-left text-[#E6EDF3] shadow-[0_12px_32px_rgba(13,17,23,0.16)]'
    >
      <div className='flex h-10 items-center justify-between border-b border-white/10 bg-white/[0.035] px-3.5'>
        <div className='flex min-w-0 items-center gap-2'>
          <Code2 className='h-3.5 w-3.5 shrink-0 text-[#8B949E]' />
          <span className='truncate font-mono text-[11px] font-medium lowercase tracking-[-0.01em] text-[#B1BAC4]'>
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
          <button
            type='button'
            onClick={handleCopy}
            disabled={!code}
            className='flex h-7 w-7 items-center justify-center rounded-md text-[#8B949E] transition-colors hover:bg-white/[0.08] hover:text-[#E6EDF3] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-400/70 disabled:cursor-default disabled:opacity-35'
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

      {children}
    </div>
  );
}

export default MessageCodeBlock;
