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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, ChevronUp, FileText, Globe, X } from 'lucide-react';
import type { ChatSession } from '@/types';
import { chatApi, documentsApi } from '@/utils/api';
import { useChatStore } from '@/store/chatStore';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:chat-sources-panel');

interface WebSource {
  title: string;
  url: string;
}

interface RagCitation {
  chunkIndex: number;
  location?: string;
}

interface RagSource {
  id: string;
  filename: string;
  citations?: RagCitation[];
  full?: boolean;
}

interface AttachedDocument {
  id: string;
  filename: string;
  contentChars?: number;
}

interface ChatSourcesPanelProps {
  session: ChatSession;
}

const COLLAPSED_ROWS = 6;
const EMPTY_DOCUMENTS: AttachedDocument[] = [];

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
  // Keyed by session so switching chats never shows another chat's
  // attachments; private sessions derive an empty list without state work.
  const [attached, setAttached] = useState<{
    sessionId: string;
    docs: AttachedDocument[];
  }>({ sessionId: '', docs: EMPTY_DOCUMENTS });
  const attachedDocuments =
    !session.isPrivate && attached.sessionId === session.id
      ? attached.docs
      : EMPTY_DOCUMENTS;
  const [allSources, setAllSources] = useState(false);
  const [allDocuments, setAllDocuments] = useState(false);
  // Below xl the rail has no room; the same content opens as a bottom
  // sheet from a compact trigger, matching the app's mobile pattern.
  const [sheetOpen, setSheetOpen] = useState(false);

  const { webSources, ragSources, fullContextSkipped } = useMemo(() => {
    const web = new Map<string, WebSource>();
    const rag = new Map<string, RagSource>();
    let skipped: { estimatedTokens: number; maxTokens: number } | undefined;
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
              ...(Array.isArray(source.citations)
                ? {
                    citations: source.citations.filter(
                      (citation): citation is RagCitation =>
                        !!citation &&
                        typeof citation === 'object' &&
                        typeof (citation as RagCitation).chunkIndex === 'number'
                    ),
                  }
                : {}),
              ...(source.full === true ? { full: true } : {}),
            });
          }
        }
      }
      // The most recent turn's verdict wins; older skips are stale.
      const rawSkip = metadata?.ragFullContextSkipped as
        { estimatedTokens?: unknown; maxTokens?: unknown } | undefined;
      if (
        rawSkip &&
        typeof rawSkip.estimatedTokens === 'number' &&
        typeof rawSkip.maxTokens === 'number'
      ) {
        skipped = {
          estimatedTokens: rawSkip.estimatedTokens,
          maxTokens: rawSkip.maxTokens,
        };
      } else if (metadata?.ragSources) {
        skipped = undefined;
      }
    }
    return {
      webSources: Array.from(web.values()),
      ragSources: Array.from(rag.values()),
      fullContextSkipped: skipped,
    };
  }, [session.messages]);

  // Documents attached to this chat, whether or not retrieval has used
  // them yet. Private sessions have no persisted attachments.
  useEffect(() => {
    if (session.isPrivate) return;
    let cancelled = false;
    const load = () => {
      documentsApi
        .getDocuments(session.id)
        .then(response => {
          if (cancelled || !response.success || !Array.isArray(response.data))
            return;
          setAttached({
            sessionId: session.id,
            docs: response.data.map(doc => ({
              id: doc.id,
              filename: doc.filename,
              contentChars: doc.contentChars,
            })),
          });
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
    const merged = new Map<
      string,
      AttachedDocument & {
        used: boolean;
        citations?: RagCitation[];
        full?: boolean;
      }
    >();
    for (const doc of attachedDocuments) {
      merged.set(doc.id, { ...doc, used: false });
    }
    for (const source of ragSources) {
      merged.set(source.id, {
        ...(merged.get(source.id) ?? {}),
        id: source.id,
        filename: source.filename,
        used: true,
        ...(source.citations?.length ? { citations: source.citations } : {}),
        ...(source.full ? { full: true } : {}),
      });
    }
    return Array.from(merged.values());
  }, [attachedDocuments, ragSources]);

  const fullDocumentContext = session.settings?.fullDocumentContext === true;
  const estimatedTokens = useMemo(
    () =>
      attachedDocuments.reduce(
        (total, doc) => total + Math.ceil((doc.contentChars ?? 0) / 4),
        0
      ),
    [attachedDocuments]
  );

  const toggleFullDocumentContext = async () => {
    const settings = {
      ...session.settings,
      fullDocumentContext: fullDocumentContext ? undefined : true,
    };
    useChatStore.setState(state => ({
      currentSession:
        state.currentSession?.id === session.id
          ? { ...state.currentSession, settings }
          : state.currentSession,
      sessions: state.sessions.map(existing =>
        existing.id === session.id ? { ...existing, settings } : existing
      ),
    }));
    if (session.isPrivate) return;
    try {
      await chatApi.updateSession(session.id, {
        settings,
      } as Partial<ChatSession>);
    } catch (error) {
      logger.error('Failed to update the full-document setting:', error);
    }
  };

  const citationSummary = (citations: RagCitation[]): string => {
    const labels: string[] = [];
    for (const citation of citations) {
      const label = citation.location ?? `#${citation.chunkIndex + 1}`;
      if (!labels.includes(label)) labels.push(label);
      if (labels.length >= 4) break;
    }
    return labels.join(' · ');
  };

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

  const sections = (
    <>
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
                className='-mx-1 rounded-lg px-1 py-1.5'
                title={doc.filename}
              >
                <span className='flex items-center gap-2.5'>
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
                </span>
                {doc.full ? (
                  <span
                    className='ms-[26px] block truncate text-[11px] text-gray-400 dark:text-dark-500'
                    data-testid='chat-source-citation'
                  >
                    {t('documents.fullDocument', 'Full document')}
                  </span>
                ) : doc.citations?.length ? (
                  <span
                    className='ms-[26px] block truncate text-[11px] text-gray-400 dark:text-dark-500'
                    data-testid='chat-source-citation'
                  >
                    {citationSummary(doc.citations)}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {showMore(
            documents.length - visibleDocuments.length,
            allDocuments,
            () => setAllDocuments(current => !current)
          )}
          <label className='mt-3 flex cursor-pointer items-center gap-2 px-1 text-[12px] text-gray-500 dark:text-dark-500'>
            <input
              type='checkbox'
              checked={fullDocumentContext}
              onChange={toggleFullDocumentContext}
              data-testid='full-document-context-toggle'
              className='h-3.5 w-3.5 rounded border-gray-300 text-primary-600 focus:ring-primary-500 dark:border-dark-400'
            />
            <span className='min-w-0 flex-1'>
              {t('documents.fullContextToggle', 'Send full documents')}
              {fullDocumentContext && estimatedTokens > 0 && (
                <span className='ms-1 text-gray-400 dark:text-dark-500'>
                  {t('documents.fullContextEstimate', {
                    tokens: estimatedTokens.toLocaleString(),
                  })}
                </span>
              )}
            </span>
          </label>
          {fullDocumentContext && fullContextSkipped && (
            <p
              className='mt-1 px-1 text-[11px] text-amber-600 dark:text-amber-400'
              data-testid='full-document-context-warning'
            >
              {t('documents.fullContextTooLarge')}
            </p>
          )}
        </section>
      )}
    </>
  );

  return (
    <>
      <aside
        data-testid='chat-sources-panel'
        className='hidden w-72 shrink-0 flex-col gap-7 overflow-y-auto border-s border-black/[0.05] px-5 py-6 scrollbar-thin dark:border-white/[0.06] xl:flex'
      >
        {sections}
      </aside>

      {/* Compact trigger below xl, sitting under the chat controls button */}
      <button
        type='button'
        onClick={() => setSheetOpen(true)}
        data-testid='chat-sources-trigger'
        className='absolute end-3 top-[4.25rem] z-20 flex h-8 w-8 items-center justify-center rounded-full border border-black/[0.07] bg-surface/65 text-gray-500 backdrop-blur-md transition-colors duration-150 hover:bg-surface-raised hover:text-gray-950 dark:border-white/[0.08] dark:bg-dark-200/65 dark:text-dark-600 dark:hover:bg-dark-200 dark:hover:text-dark-950 xl:hidden'
        title={t('chat.message.sources', 'Sources')}
        aria-haspopup='dialog'
        aria-expanded={sheetOpen}
      >
        <BookOpen className='h-3.5 w-3.5' />
        <span className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-primary-500 px-1 text-[9px] font-semibold tabular-nums text-white shadow-sm'>
          {webSources.length + documents.length}
        </span>
      </button>

      {sheetOpen &&
        createPortal(
          <div className='fixed inset-0 z-[80] xl:hidden'>
            <button
              type='button'
              className='absolute inset-0 bg-black/35 backdrop-blur-[2px]'
              onClick={() => setSheetOpen(false)}
              aria-label={t('common.close')}
            />
            <div
              role='dialog'
              aria-modal='true'
              aria-label={t('chat.message.sources', 'Sources')}
              className='absolute inset-x-3 bottom-3 max-h-[75vh] overflow-y-auto rounded-2xl border border-black/[0.08] bg-surface p-5 shadow-[0_20px_70px_rgba(0,0,0,0.3)] scrollbar-thin dark:border-white/[0.09] dark:bg-dark-100'
              data-testid='chat-sources-sheet'
            >
              <div className='mb-3 flex items-center justify-between'>
                <p className='text-sm font-semibold text-gray-900 dark:text-dark-900'>
                  {t('chat.message.sources', 'Sources')}
                </p>
                <button
                  type='button'
                  onClick={() => setSheetOpen(false)}
                  className='rounded-md p-1.5 text-gray-400 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-800'
                  aria-label={t('common.close')}
                >
                  <X className='h-4 w-4' />
                </button>
              </div>
              <div className='flex flex-col gap-6'>{sections}</div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};

export default ChatSourcesPanel;
