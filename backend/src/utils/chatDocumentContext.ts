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
import storageService from '../storage.js';
import { throwIfChatGenerationCancelled } from './chatCancellation.js';

export interface ChatDocumentSource {
  id: string;
  filename: string;
}

export interface ChatDocumentContext {
  documentContext: string;
  enhancedContent: string;
  hasRelevantContext: boolean;
  /** Documents that actually contributed chunks, deduplicated, best first. */
  sources: ChatDocumentSource[];
}

export const EMPTY_CHAT_DOCUMENT_CONTEXT = (
  message: string
): ChatDocumentContext => ({
  documentContext: '',
  enhancedContent: message,
  hasRelevantContext: false,
  sources: [],
});

export async function buildChatDocumentContext(
  message: string,
  sessionId: string,
  userId: string,
  signal?: AbortSignal
): Promise<ChatDocumentContext> {
  throwIfChatGenerationCancelled(signal);
  // Documents from knowledge collections attached to this chat join the
  // session's own uploads and the user's standing uploads in the
  // searchable scope. searchDocuments picks semantic or keyword retrieval
  // by the embedding settings, so retrieval works either way.
  const knowledgeCollectionIds = (
    await storageService.getSession(sessionId, userId)
  )?.settings?.knowledgeCollectionIds;
  throwIfChatGenerationCancelled(signal);

  const relevantDocuments = await documentService.searchDocuments(
    message,
    userId,
    sessionId,
    5,
    knowledgeCollectionIds,
    signal
  );
  throwIfChatGenerationCancelled(signal);

  if (relevantDocuments.length === 0) {
    return EMPTY_CHAT_DOCUMENT_CONTEXT(message);
  }

  const documentsMap = new Map();
  const sources: ChatDocumentSource[] = [];
  for (const chunk of relevantDocuments) {
    throwIfChatGenerationCancelled(signal);
    if (!documentsMap.has(chunk.documentId)) {
      const document = await documentService.getDocument(
        chunk.documentId,
        userId
      );
      throwIfChatGenerationCancelled(signal);
      documentsMap.set(chunk.documentId, document);
      sources.push({
        id: chunk.documentId,
        filename: document?.filename || 'Unknown Document',
      });
    }
  }
  throwIfChatGenerationCancelled(signal);

  const documentContext =
    '\n\n--- RELEVANT DOCUMENTS ---\n' +
    relevantDocuments
      .map((chunk, index) => {
        const doc = documentsMap.get(chunk.documentId);
        const docTitle = doc ? doc.filename : 'Unknown Document';
        return `Document ${index + 1}: ${docTitle} (chunk ${chunk.chunkIndex + 1})\n${chunk.content}\n`;
      })
      .join('\n---\n') +
    '\n--- END DOCUMENTS ---\n\n';

  return {
    documentContext,
    enhancedContent: `${documentContext}User question: ${message}`,
    hasRelevantContext: true,
    sources,
  };
}
