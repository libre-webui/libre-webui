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
import { ChevronUp, FileText, Globe } from 'lucide-react';
import type { ChatSession } from '@/types';
import { documentsApi } from '@/utils/api';

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

const COLLAPSED_ROWS = 6;

const hostnameOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Conversation context rail: the web sources replies drew on and the
 * documents in retrieval scope, as a quiet fixed column beside the
 * conversation on wide screens. Renders nothing while the conversation has
 * no context; per-message source chips remain the compact fallback.
 */
export const ChatSourcesPanel: React.FC<ChatSourcesPanelProps> = ({
  session,
}) => {
  const { t } = useTranslation();
  const [attachedDocuments, setAttachedDocuments] = useState<
    AttachedDocument[]
  >([]);
  const [allSources, setAllSources] = useState(false);
  const [allDocuments, setAllDocuments] = useState(false);

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

  const visibleSources = allSources
    ? webSources
    : webSources.slice(0, COLLAPSED_ROWS);
  const visibleDocuments = allDocuments
    ? documents
    : documents.slice(0, COLLAPSED_ROWS);

  const showMore = (
    hidden: number,
    expanded: boolean,
    toggle: () => void
  ): React.ReactNode =>
    (hidden > 0 || expanded) && (
      <button
        type='button'
        onClick={toggle}
        className='mt-1 flex items-center gap-1 px-1 text-[12px] text-gray-400 transition-colors hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
      >
        {expanded ? (
          <>
            <ChevronUp className='h-3 w-3' />
            {t('chatMessage.showLess', 'Show less')}
          </>
        ) : (
          `${t('chatMessage.showMore')} (${hidden})`
        )}
      </button>
    );

  return (
    <aside
      data-testid='chat-sources-panel'
      className='hidden w-72 shrink-0 flex-col gap-7 overflow-y-auto border-s border-black/[0.05] px-5 py-6 scrollbar-thin dark:border-white/[0.06] xl:flex'
    >
      {webSources.length > 0 && (
        <section>
          <h3 className='mb-2 text-[13px] font-medium text-gray-500 dark:text-dark-500'>
            {t('chat.message.sources', 'Sources')}
          </h3>
          <ul className='space-y-0.5'>
            {visibleSources.map(source => (
              <li key={source.url}>
                <a
                  href={source.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='group -mx-1 flex items-center gap-2.5 rounded-lg px-1 py-1.5 transition-colors hover:bg-black/[0.04] dark:hover:bg-white/[0.05]'
                  title={source.url}
                >
                  <Globe className='h-4 w-4 shrink-0 text-gray-400 transition-colors group-hover:text-gray-700 dark:text-dark-500 dark:group-hover:text-dark-800' />
                  <span className='min-w-0 flex-1'>
                    <span className='block truncate text-[13px] leading-snug text-gray-800 dark:text-dark-800'>
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
          {showMore(webSources.length - visibleSources.length, allSources, () =>
            setAllSources(current => !current)
          )}
        </section>
      )}

      {documents.length > 0 && (
        <section>
          <h3 className='mb-2 text-[13px] font-medium text-gray-500 dark:text-dark-500'>
            {t('settings.tabs.documents', 'Documents')}
          </h3>
          <ul className='space-y-0.5'>
            {visibleDocuments.map(doc => (
              <li
                key={doc.id}
                className='-mx-1 flex items-center gap-2.5 rounded-lg px-1 py-1.5'
                title={doc.filename}
              >
                <FileText className='h-4 w-4 shrink-0 text-gray-400 dark:text-dark-500' />
                <span
                  dir='ltr'
                  className='min-w-0 flex-1 truncate text-[13px] leading-snug text-gray-800 dark:text-dark-800'
                >
                  {doc.filename}
                </span>
                {doc.used && (
                  <span
                    aria-hidden='true'
                    className='h-1.5 w-1.5 shrink-0 rounded-full bg-primary-500'
                  />
                )}
              </li>
            ))}
          </ul>
          {showMore(
            documents.length - visibleDocuments.length,
            allDocuments,
            () => setAllDocuments(current => !current)
          )}
        </section>
      )}
    </aside>
  );
};

export default ChatSourcesPanel;
