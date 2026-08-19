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
import ReactMarkdown from 'react-markdown';
import { useTranslation } from 'react-i18next';
import { Star, X } from 'lucide-react';
import { Button } from '@/components/ui';

interface WhatsNewModalProps {
  notes: NonNullable<typeof __LATEST_RELEASE_NOTES__>;
  onDismiss: () => void;
}

export const WhatsNewModal: React.FC<WhatsNewModalProps> = ({
  notes,
  onDismiss,
}) => {
  const { t } = useTranslation();

  return (
    <>
      <div
        className='fixed inset-0 z-[60] bg-black/55 backdrop-blur-sm transition-opacity duration-200'
        onClick={onDismiss}
      />
      <div
        className='fixed inset-0 z-[60] flex items-center justify-center p-4'
        role='dialog'
        aria-modal='true'
        aria-label={t('whatsNew.title')}
        onMouseDown={event => {
          if (event.target === event.currentTarget) onDismiss();
        }}
      >
        <div className='flex max-h-[82vh] w-full max-w-2xl flex-col rounded-3xl border border-gray-200/80 bg-surface/95 shadow-2xl backdrop-blur-xl animate-scale-in dark:border-white/10 dark:bg-dark-25/95'>
          <div className='flex items-start justify-between px-6 pb-3 pt-6'>
            <div>
              <h2 className='text-xl font-semibold tracking-[-0.02em] text-gray-950 dark:text-dark-950'>
                {t('whatsNew.title')}
              </h2>
              <p className='mt-1 text-xs text-gray-500 dark:text-dark-500'>
                {t('whatsNew.releaseNotes')} · v{notes.version} · {notes.date}
              </p>
            </div>
            <button
              onClick={onDismiss}
              className='rounded-full p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-dark-600 dark:hover:bg-white/[0.06] dark:hover:text-dark-900'
              title={t('common.close')}
            >
              <X className='h-4 w-4' />
            </button>
          </div>

          <div className='scroll-region min-h-0 flex-1 overflow-y-auto px-6 py-3 scrollbar-thin'>
            <ReactMarkdown
              components={{
                h3: ({ children }) => (
                  <h3 className='mb-2 mt-5 text-[11px] font-semibold uppercase tracking-[0.1em] text-primary-600 first:mt-0 dark:text-primary-400'>
                    {children}
                  </h3>
                ),
                ul: ({ children }) => (
                  <ul className='space-y-2.5'>{children}</ul>
                ),
                li: ({ children }) => (
                  <li className='flex gap-2 text-[13.5px] leading-relaxed text-gray-700 dark:text-dark-700'>
                    <span className='mt-[7px] h-1 w-1 shrink-0 rounded-full bg-gray-300 dark:bg-dark-400' />
                    <span className='min-w-0'>{children}</span>
                  </li>
                ),
                strong: ({ children }) => (
                  <strong className='font-semibold text-gray-900 dark:text-dark-900'>
                    {children}
                  </strong>
                ),
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target='_blank'
                    rel='noreferrer'
                    className='text-primary-600 underline decoration-primary-300 underline-offset-2 hover:text-primary-700 dark:text-primary-400'
                  >
                    {children}
                  </a>
                ),
                code: ({ children }) => (
                  <code className='rounded-md border border-gray-200 bg-gray-100 px-1 py-0.5 font-mono text-[0.85em] text-gray-800 dark:border-dark-300 dark:bg-dark-200 dark:text-dark-800'>
                    {children}
                  </code>
                ),
                p: ({ children }) => (
                  <p className='mb-2 text-[13.5px] leading-relaxed text-gray-700 dark:text-dark-700'>
                    {children}
                  </p>
                ),
              }}
            >
              {notes.body}
            </ReactMarkdown>
          </div>

          <div className='flex items-center justify-between gap-3 border-t border-gray-200/70 px-6 py-4 dark:border-white/[0.08]'>
            <a
              href='https://github.com/libre-webui/libre-webui'
              target='_blank'
              rel='noopener noreferrer'
              className='inline-flex min-w-0 items-center gap-1.5 text-xs text-gray-500 transition-colors hover:text-gray-900 dark:text-dark-500 dark:hover:text-dark-900'
            >
              <Star className='h-3.5 w-3.5 shrink-0' />
              <span className='truncate'>{t('whatsNew.starAsk')}</span>
            </a>
            <Button onClick={onDismiss} size='sm'>
              {t('whatsNew.cta')}
            </Button>
          </div>
        </div>
      </div>
    </>
  );
};
