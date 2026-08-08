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
import { BookOpen, FileText, Globe, X } from 'lucide-react';
import type { ChatSession } from '@/types';
import { documentsApi } from '@/utils/api';
import { cn } from '@/utils';

interface WebSource {
  title: string;
  url: string;
}

interface RagSource {
  id: string;
  filename: string;
}

interface AttachedDocument {
  id: string;
  filename: string;
}

interface ChatSourcesPanelProps {
  session: ChatSession;
}

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Conversation-level context panel: every web source the replies cited and
 * every document retrieval has drawn on, plus the documents attached to
 * the chat. Collapsed to a corner button; hidden entirely while there is
 * nothing to show.
 */
export const ChatSourcesPanel: React.FC<ChatSourcesPanelProps> = ({
  session,
}) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [attachedDocuments, setAttachedDocuments] = useState<
    AttachedDocument[]
  >([]);

  const { webSources, ragSources } = useMemo(() => {
    const web = new Map<string, WebSource>();
    const rag = new Map<string, RagSource>();
    for (const message of session.messages) {
      const metadata = message.providerMetadata;
      if (Array.isArray(metadata?.webSearchSources)) {
        for (const raw of metadata.webSearchSources as unknown[]) {
          const source = raw as Partial<WebSource> | null;
          if (source && typeof source.url === 'string' && source.url) {
            web.set(source.url, {
              url: source.url,
              title:
                typeof source.title === 'string' && source.title
                  ? source.title
                  : source.url,
            });
          }
        }
      }
      if (Array.isArray(metadata?.ragSources)) {
        for (const raw of metadata.ragSources as unknown[]) {
          const source = raw as Partial<RagSource> | null;
          if (source && typeof source.id === 'string' && source.id) {
            rag.set(source.id, {
              id: source.id,
              filename:
                typeof source.filename === 'string' && source.filename
                  ? source.filename
                  : source.id,
            });
          }
        }
      }
    }
    return {
      webSources: Array.from(web.values()),
      ragSources: Array.from(rag.values()),
    };
  }, [session.messages]);

  // Documents attached to this chat, whether or not retrieval has used
  // them yet. Private sessions have no persisted attachments.
  useEffect(() => {
    if (session.isPrivate) {
      setAttachedDocuments([]);
      return;
    }
    let cancelled = false;
    const load = () => {
      documentsApi
        .getDocuments(session.id)
        .then(response => {
          if (cancelled || !response.success || !Array.isArray(response.data))
            return;
          setAttachedDocuments(
            response.data.map(doc => ({ id: doc.id, filename: doc.filename }))
          );
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('libre:documents-updated', load);
    return () => {
      cancelled = true;
      window.removeEventListener('libre:documents-updated', load);
    };
  }, [session.id, session.isPrivate]);

  const documents = useMemo(() => {
    const merged = new Map<string, AttachedDocument & { used: boolean }>();
    for (const doc of attachedDocuments) {
      merged.set(doc.id, { ...doc, used: false });
    }
    for (const source of ragSources) {
      merged.set(source.id, {
        id: source.id,
        filename: source.filename,
        used: true,
      });
    }
    return Array.from(merged.values());
  }, [attachedDocuments, ragSources]);

  if (webSources.length === 0 && documents.length === 0) return null;

  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(current => !current)}
        data-testid='chat-sources-toggle'
        className={cn(
          'absolute end-4 top-16 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-black/[0.07] bg-surface/65 text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 sm:end-6',
          open && 'text-primary-600 dark:text-primary-400'
        )}
        title={t('chat.message.sources', 'Sources')}
        aria-expanded={open}
      >
        <BookOpen className='h-4 w-4' />
        <span className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary-500 px-1 text-[9px] font-semibold tabular-nums text-white shadow-sm'>
          {webSources.length + documents.length}
        </span>
      </button>

      {open && (
        <aside
          data-testid='chat-sources-panel'
          className='absolute end-4 top-[6.75rem] z-20 flex max-h-[70vh] w-80 flex-col overflow-y-auto rounded-2xl border border-black/[0.08] bg-surface/95 p-4 shadow-[0_16px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl animate-scale-in scrollbar-thin dark:border-white/[0.09] dark:bg-dark-100/95 sm:end-6'
        >
          <div className='mb-1 flex items-center justify-between'>
            <h3 className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
              {t('chat.message.sources', 'Sources')}
            </h3>
            <button
              type='button'
              onClick={() => setOpen(false)}
              className='rounded-md p-1 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
              aria-label={t('common.close')}
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>

          {webSources.length > 0 && (
            <ul className='mb-1 space-y-0.5'>
              {webSources.map(source => (
                <li key={source.url}>
                  <a
                    href={source.url}
                    target='_blank'
                    rel='noopener noreferrer'
                    className='group flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-gray-100 dark:hover:bg-dark-200'
                    title={source.url}
                  >
                    <Globe className='h-4 w-4 shrink-0 text-gray-400 group-hover:text-primary-500 dark:text-dark-500' />
                    <span className='min-w-0 flex-1'>
                      <span className='block truncate text-[13px] text-gray-800 dark:text-dark-800'>
                        {source.title}
                      </span>
                      <span
                        dir='ltr'
                        className='block truncate text-[11px] text-gray-400 dark:text-dark-500'
                      >
                        {hostnameOf(source.url)}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}

          {documents.length > 0 && (
            <>
              <h4 className='mb-1 mt-3 border-t border-black/[0.06] pt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-400 dark:border-white/[0.07] dark:text-dark-500 rtl:tracking-normal'>
                {t('settings.tabs.documents', 'Documents')}
              </h4>
              <ul className='space-y-0.5'>
                {documents.map(doc => (
                  <li
                    key={doc.id}
                    className='flex items-center gap-2.5 rounded-lg px-2 py-1.5'
                    title={doc.filename}
                  >
                    <FileText className='h-4 w-4 shrink-0 text-gray-400 dark:text-dark-500' />
                    <span className='min-w-0 flex-1 truncate text-[13px] text-gray-800 dark:text-dark-800'>
                      {doc.filename}
                    </span>
                    {doc.used && (
                      <span
                        className='h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500'
                        title={t('chat.message.sources', 'Sources')}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}
    </>
  );
};

export default ChatSourcesPanel;
