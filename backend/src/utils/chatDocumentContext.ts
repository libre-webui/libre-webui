/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
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
import { estimateTextTokens } from '../services/contextCompactionService.js';
import storageService from '../storage.js';
import { throwIfChatGenerationCancelled } from './chatCancellation.js';

/** One cited excerpt of a source document. */
export interface ChatDocumentCitation {
  chunkIndex: number;
  /** Human-readable source location (page/slide/sheet/section). */
  location?: string;
  /** Retrieval score of this excerpt within the query's ranking. */
  score?: number;
}

export interface ChatDocumentSource {
  id: string;
  filename: string;
  /** Present in retrieval mode: which excerpts contributed, best first. */
  citations?: ChatDocumentCitation[];
  /** True when the document's full content entered context. */
  full?: boolean;
}

export interface ChatDocumentContext {
  documentContext: string;
  enhancedContent: string;
  hasRelevantContext: boolean;
  /** Documents that actually contributed, deduplicated, best first. */
  sources: ChatDocumentSource[];
  /** How document context was assembled for this turn. */
  mode: 'retrieval' | 'full';
  /** Set when full-document mode was requested but exceeded the guard. */
  fullContextSkipped?: { estimatedTokens: number; maxTokens: number };
}

/**
 * Full-document mode sends entire extracted sources instead of retrieved
 * excerpts, so it needs a hard token guard. Deliberately conservative:
 * most local models run 8k-128k contexts.
 */
export const fullDocumentContextMaxTokens = (): number => {
  const raw = process.env.FULL_DOCUMENT_CONTEXT_MAX_TOKENS;
  if (raw === undefined) return 32_000;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 2_000_000) {
    throw new Error(
      'FULL_DOCUMENT_CONTEXT_MAX_TOKENS must be between 1000 and 2000000'
    );
  }
  return value;
};

export const EMPTY_CHAT_DOCUMENT_CONTEXT = (
  message: string
): ChatDocumentContext => ({
  documentContext: '',
  enhancedContent: message,
  hasRelevantContext: false,
  sources: [],
  mode: 'retrieval',
});

interface FullDocumentContextOutcome {
  context?: ChatDocumentContext;
  skipped?: { estimatedTokens: number; maxTokens: number };
}

const buildFullDocumentContext = async (
  message: string,
  sessionId: string,
  userId: string,
  knowledgeCollectionIds: string[] | undefined,
  signal?: AbortSignal
): Promise<FullDocumentContextOutcome> => {
  const documents = (
    await documentService.getDocumentsInScope(
      userId,
      sessionId,
      knowledgeCollectionIds
    )
  ).filter(document => (document.content ?? '').trim().length > 0);
  throwIfChatGenerationCancelled(signal);
  if (documents.length === 0) {
    return { context: EMPTY_CHAT_DOCUMENT_CONTEXT(message) };
  }

  const maxTokens = fullDocumentContextMaxTokens();
  const estimatedTokens = documents.reduce(
    (total, document) => total + estimateTextTokens(document.content ?? ''),
    0
  );
  if (estimatedTokens > maxTokens) {
    // Too large to send whole: fall back to retrieval, but tell the caller
    // so the client can explain why full mode did not apply.
    return { skipped: { estimatedTokens, maxTokens } };
  }

  const documentContext =
    '\n\n--- ATTACHED DOCUMENTS (full content) ---\n' +
    documents
      .map(
        document =>
          `Document: ${document.filename}\n${document.content ?? ''}\n`
      )
      .join('\n---\n') +
    '\n--- END DOCUMENTS ---\n\n';
  return {
    context: {
      documentContext,
      enhancedContent: `${documentContext}User question: ${message}`,
      hasRelevantContext: true,
      sources: documents.map(document => ({
        id: document.id,
        filename: document.filename,
        full: true,
      })),
      mode: 'full',
    },
  };
};

export async function buildChatDocumentContext(
  message: string,
  sessionId: string,
  userId: string,
  signal?: AbortSignal
): Promise<ChatDocumentContext> {
  throwIfChatGenerationCancelled(signal);
  // Documents from knowledge collections attached to this chat join the
  // session's own uploads and the user's standing uploads in the
  // searchable scope. searchDocuments picks hybrid or keyword retrieval
  // by the embedding settings, so retrieval works either way.
  const settings = (await storageService.getSession(sessionId, userId))
    ?.settings;
  const knowledgeCollectionIds = settings?.knowledgeCollectionIds;
  throwIfChatGenerationCancelled(signal);

  let fullContextSkipped: ChatDocumentContext['fullContextSkipped'];
  if (settings?.fullDocumentContext === true) {
    const outcome = await buildFullDocumentContext(
      message,
      sessionId,
      userId,
      knowledgeCollectionIds,
      signal
    );
    if (outcome.context) return outcome.context;
    fullContextSkipped = outcome.skipped;
  }
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
    return {
      ...EMPTY_CHAT_DOCUMENT_CONTEXT(message),
      ...(fullContextSkipped ? { fullContextSkipped } : {}),
    };
  }

  const sourcesById = new Map<string, ChatDocumentSource>();
  for (const chunk of relevantDocuments) {
    throwIfChatGenerationCancelled(signal);
    let source = sourcesById.get(chunk.documentId);
    if (!source) {
      source = {
        id: chunk.documentId,
        filename: chunk.filename || 'Unknown Document',
        citations: [],
      };
      sourcesById.set(chunk.documentId, source);
    }
    source.citations!.push({
      chunkIndex: chunk.chunkIndex,
      ...(chunk.location ? { location: chunk.location } : {}),
      ...(chunk.score !== undefined ? { score: chunk.score } : {}),
    });
  }

  const documentContext =
    '\n\n--- RELEVANT DOCUMENTS ---\n' +
    relevantDocuments
      .map((chunk, index) => {
        const docTitle = chunk.filename || 'Unknown Document';
        const where = chunk.location
          ? `chunk ${chunk.chunkIndex + 1}, ${chunk.location}`
          : `chunk ${chunk.chunkIndex + 1}`;
        return `Document ${index + 1}: ${docTitle} (${where})\n${chunk.content}\n`;
      })
      .join('\n---\n') +
    '\n--- END DOCUMENTS ---\n\n';

  return {
    documentContext,
    enhancedContent: `${documentContext}User question: ${message}`,
    hasRelevantContext: true,
    sources: [...sourcesById.values()],
    mode: 'retrieval',
    ...(fullContextSkipped ? { fullContextSkipped } : {}),
  };
}
