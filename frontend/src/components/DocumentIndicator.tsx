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

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, FileText, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { documentsApi } from '@/utils/api';
import { DocumentSummary } from '@/types';
import { formatFileSize } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:document-indicator');

interface DocumentIndicatorProps {
  sessionId?: string;
  className?: string;
}

/**
 * Shows which documents join this chat's context — the session's own uploads
 * plus the user's standing uploads (no session, no collection) — and lets
 * each one be removed. Removal deletes the document and its embeddings, so a
 * standing document disappears from every chat, not just this one.
 */
export const DocumentIndicator: React.FC<DocumentIndicatorProps> = ({
  sessionId,
  className = '',
}) => {
  const { t } = useTranslation();
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [open, setOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const loadDocuments = useCallback(async () => {
    try {
      const response = await documentsApi.getDocuments();
      if (response.success && response.data) {
        setDocuments(
          response.data.filter(
            document =>
              (sessionId && document.sessionId === sessionId) ||
              (!document.sessionId && !document.collectionId)
          )
        );
      }
    } catch (error) {
      logger.error('Failed to load documents:', error);
    }
  }, [sessionId]);

  useEffect(() => {
    void loadDocuments();
    const handleDocumentsUpdated = () => void loadDocuments();
    window.addEventListener('libre:documents-updated', handleDocumentsUpdated);
    return () =>
      window.removeEventListener(
        'libre:documents-updated',
        handleDocumentsUpdated
      );
  }, [loadDocuments]);

  useEffect(() => {
    if (!open) return;
    const handleOutsideClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setPendingDelete(null);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [open]);

  if (documents.length === 0) {
    return null;
  }

  const handleRemove = async (documentId: string) => {
    setPendingDelete(null);
    try {
      const response = await documentsApi.deleteDocument(documentId);
      if (!response.success) throw new Error(response.error);
      window.dispatchEvent(new Event('libre:documents-updated'));
    } catch (error) {
      logger.error('Failed to delete document:', error);
      toast.error(t('settings.documents.library.deleteFailed'));
    }
  };

  const totalSize = documents.reduce((sum, doc) => sum + doc.size, 0);

  return (
    <div ref={containerRef} className={`relative inline-block ${className}`}>
      {open && (
        <div className='absolute bottom-full left-0 z-50 mb-2 w-80 max-w-[85vw] rounded-xl border border-gray-200 bg-white p-2 shadow-lg dark:border-dark-300 dark:bg-dark-100'>
          <p className='px-2 pb-1.5 pt-1 text-xs font-medium text-gray-500 dark:text-dark-600'>
            {t('chat.documents.title')}
          </p>
          <div className='max-h-56 overflow-y-auto'>
            {documents.map(document => (
              <div
                key={document.id}
                className='flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-dark-200'
              >
                {pendingDelete === document.id ? (
                  <>
                    <p className='min-w-0 flex-1 truncate text-xs text-red-700 dark:text-red-300'>
                      {t('settings.documents.library.deleteConfirm', {
                        name: document.filename,
                      })}
                    </p>
                    <button
                      onClick={() => void handleRemove(document.id)}
                      className='shrink-0 text-xs font-medium text-red-600 underline underline-offset-2 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300'
                    >
                      {t('common.delete')}
                    </button>
                    <button
                      onClick={() => setPendingDelete(null)}
                      className='shrink-0 text-xs text-gray-500 hover:text-gray-700 dark:text-dark-600 dark:hover:text-dark-800'
                    >
                      {t('common.cancel')}
                    </button>
                  </>
                ) : (
                  <>
                    <FileText className='h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-dark-500' />
                    <div className='min-w-0 flex-1'>
                      <p className='truncate text-xs text-gray-900 dark:text-dark-900'>
                        {document.filename}
                      </p>
                      <p className='text-[10px] text-gray-400 dark:text-dark-500'>
                        {formatFileSize(document.size)}
                        {' · '}
                        {document.sessionId
                          ? t('settings.documents.library.chatScope')
                          : t('settings.documents.library.everyChatScope')}
                      </p>
                    </div>
                    <button
                      onClick={() => setPendingDelete(document.id)}
                      className='shrink-0 text-gray-400 transition-colors hover:text-red-500 dark:text-dark-500'
                      title={t('common.delete')}
                    >
                      <X className='h-3.5 w-3.5' />
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      <button
        type='button'
        onClick={() => {
          setOpen(previous => !previous);
          setPendingDelete(null);
        }}
        className='
          inline-flex items-center space-x-1 px-2 py-1
          bg-blue-50 dark:bg-blue-900/20
          border border-blue-200 dark:border-blue-800
          rounded-md text-xs
          transition-colors hover:bg-blue-100 dark:hover:bg-blue-900/40
        '
        title={`${t('chat.documents.title')} - ${formatFileSize(totalSize)}`}
      >
        <BookOpen className='w-3 h-3 text-blue-600 dark:text-blue-400' />
        <span className='text-blue-700 dark:text-blue-300 font-medium'>
          {documents.length} doc{documents.length !== 1 ? 's' : ''}
        </span>
      </button>
    </div>
  );
};

export default DocumentIndicator;
