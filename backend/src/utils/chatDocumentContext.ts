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

import documentService from '../services/documentService.js';
import preferencesService from '../services/preferencesService.js';
import storageService from '../storage.js';

export interface ChatDocumentContext {
  documentContext: string;
  enhancedContent: string;
  hasRelevantContext: boolean;
}

export async function buildChatDocumentContext(
  message: string,
  sessionId: string,
  userId: string
): Promise<ChatDocumentContext> {
  let documentContext = '';
  const preferences = preferencesService.getPreferences(userId);

  if (preferences.embeddingSettings?.enabled) {
    // Documents from knowledge collections attached to this chat join the
    // session's own uploads in the searchable scope.
    const knowledgeCollectionIds = storageService.getSession(sessionId, userId)
      ?.settings?.knowledgeCollectionIds;

    const relevantDocuments = await documentService.searchDocuments(
      message,
      userId,
      sessionId,
      5,
      knowledgeCollectionIds
    );

    if (relevantDocuments.length > 0) {
      const documentsMap = new Map();
      for (const chunk of relevantDocuments) {
        if (!documentsMap.has(chunk.documentId)) {
          documentsMap.set(
            chunk.documentId,
            documentService.getDocument(chunk.documentId, userId)
          );
        }
      }

      documentContext =
        '\n\n--- RELEVANT DOCUMENTS ---\n' +
        relevantDocuments
          .map((chunk, index) => {
            const doc = documentsMap.get(chunk.documentId);
            const docTitle = doc ? doc.filename : 'Unknown Document';
            return `Document ${index + 1}: ${docTitle} (chunk ${chunk.chunkIndex + 1})\n${chunk.content}\n`;
          })
          .join('\n---\n') +
        '\n--- END DOCUMENTS ---\n\n';
    }
  }

  return {
    documentContext,
    enhancedContent: documentContext
      ? `${documentContext}User question: ${message}`
      : message,
    hasRelevantContext: Boolean(documentContext),
  };
}
