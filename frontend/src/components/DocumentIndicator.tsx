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

import React, { useEffect, useState } from 'react';
import { BookOpen } from 'lucide-react';
import { documentsApi } from '@/utils/api';
import { DocumentSummary } from '@/types';

interface DocumentIndicatorProps {
  sessionId?: string;
  className?: string;
}

export const DocumentIndicator: React.FC<DocumentIndicatorProps> = ({
  sessionId,
  className = '',
}) => {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);

  useEffect(() => {
    if (!sessionId) return;

    const loadDocuments = async () => {
      try {
        const response = await documentsApi.getDocuments(sessionId);
        if (response.success && response.data) {
          setDocuments(response.data);
        }
      } catch (error) {
        console.error('Failed to load documents:', error);
      }
    };

    loadDocuments();
  }, [sessionId]);

  if (!sessionId || documents.length === 0) {
    return null;
  }

  const totalSize = documents.reduce((sum, doc) => sum + doc.size, 0);
  const formatSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div
      className={`
        inline-flex items-center space-x-1 px-2 py-1 
        bg-blue-50 dark:bg-blue-900/20 
        border border-blue-200 dark:border-blue-800 
        rounded-md text-xs
        ${className}
      `}
      title={`${documents.length} document(s) available for context - Total: ${formatSize(totalSize)}`}
    >
      <BookOpen className='w-3 h-3 text-blue-600 dark:text-blue-400' />
      <span className='text-blue-700 dark:text-blue-300 font-medium'>
        {documents.length} doc{documents.length !== 1 ? 's' : ''}
      </span>
    </div>
  );
};

export default DocumentIndicator;
