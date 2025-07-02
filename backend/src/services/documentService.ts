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

import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Document, DocumentChunk } from '../types/index.js';
import ollamaService from './ollamaService.js';
import preferencesService from './preferencesService.js';

// Utility functions for vector operations
const cosineSimilarity = (a: number[], b: number[]): number => {
  if (a.length !== b.length) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
};

// Lazy load pdfjs-dist legacy build for Node.js
let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;
const getPdfjsLib = async () => {
  if (!pdfjsLib) {
    try {
      // Use the legacy build for Node.js compatibility
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjsLib = pdfjs;
      console.log('Successfully loaded pdfjs-dist legacy build');
    } catch (error) {
      console.error('Failed to load pdfjs-dist legacy:', error);
      throw new Error('PDF parsing is not available');
    }
  }
  return pdfjsLib;
};

// Lazy load pdfjs-dist legacy build for Node.js
let pdfjsLib: typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null = null;
const getPdfjsLib = async () => {
  if (!pdfjsLib) {
    try {
      // Use the legacy build for Node.js compatibility
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjsLib = pdfjs;
      console.log('Successfully loaded pdfjs-dist legacy build');
    } catch (error) {
      console.error('Failed to load pdfjs-dist legacy:', error);
      throw new Error('PDF parsing is not available');
    }
  }
  return pdfjsLib;
};

class DocumentService {
  private documents: Map<string, Document> = new Map();
  private chunks: Map<string, DocumentChunk[]> = new Map();
  private dataFile = path.join(process.cwd(), 'documents.json');
  private chunksFile = path.join(process.cwd(), 'document-chunks.json');

  constructor() {
    this.loadDocuments();
    this.loadChunks();
  }

  private loadDocuments() {
    try {
      if (fs.existsSync(this.dataFile)) {
        const data = fs.readFileSync(this.dataFile, 'utf8');
        const documentsArray: Document[] = JSON.parse(data);
        this.documents = new Map(documentsArray.map(doc => [doc.id, doc]));
        console.log(`Loaded ${documentsArray.length} documents from disk`);
      }
    } catch (error) {
      console.error('Failed to load documents:', error);
    }
  }

  private loadChunks() {
    try {
      if (fs.existsSync(this.chunksFile)) {
        const data = fs.readFileSync(this.chunksFile, 'utf8');
        const chunksData: { [key: string]: DocumentChunk[] } = JSON.parse(data);
        this.chunks = new Map(Object.entries(chunksData));
        console.log(
          `Loaded chunks for ${this.chunks.size} documents from disk`
        );
      }
    } catch (error) {
      console.error('Failed to load document chunks:', error);
    }
  }

  private saveDocuments() {
    try {
      const documentsArray = Array.from(this.documents.values());
      fs.writeFileSync(this.dataFile, JSON.stringify(documentsArray, null, 2));
    } catch (error) {
      console.error('Failed to save documents:', error);
    }
  }

  private saveChunks() {
    try {
      const chunksData = Object.fromEntries(this.chunks.entries());
      fs.writeFileSync(this.chunksFile, JSON.stringify(chunksData, null, 2));
    } catch (error) {
      console.error('Failed to save document chunks:', error);
    }
  }

  async processDocument(
    fileName: string,
    fileBuffer: Buffer,
    mimeType: string,
    sessionId?: string
  ): Promise<Document> {
    const documentId = uuidv4();
    let content = '';
    let fileType: 'pdf' | 'txt';

    try {
      if (mimeType === 'application/pdf') {
        try {
          const pdfLib = await getPdfjsLib();
          // Convert Buffer to Uint8Array for pdfjs-dist compatibility
          const uint8Array = new Uint8Array(fileBuffer);
          const pdfDocument = await pdfLib.getDocument({ data: uint8Array })
            .promise;
          const numPages = pdfDocument.numPages;
          let textContent = '';

          for (let pageNum = 1; pageNum <= numPages; pageNum++) {
            const page = await pdfDocument.getPage(pageNum);
            const pageText = await page.getTextContent();
            const pageContent = pageText.items
              .map(item => ('str' in item ? item.str : ''))
              .join(' ');
            textContent += pageContent + '\n\n';
          }

          content = textContent.trim();
          fileType = 'pdf';
        } catch (pdfError) {
          console.error('PDF parsing error:', pdfError);
          throw new Error(
            `Failed to parse PDF: ${pdfError instanceof Error ? pdfError.message : 'Unknown PDF error'}`
          );
        }
      } else if (mimeType === 'text/plain') {
        content = fileBuffer.toString('utf-8');
        fileType = 'txt';
      } else {
        throw new Error(`Unsupported file type: ${mimeType}`);
      }

      const document: Document = {
        id: documentId,
        filename: fileName,
        content,
        fileType,
        size: fileBuffer.length,
        sessionId,
        uploadedAt: Date.now(),
      };

      // Process the document into chunks
      const chunks = this.chunkDocument(document);

      // Generate embeddings for chunks if enabled
      const chunksWithEmbeddings =
        await this.generateEmbeddingsForChunks(chunks);

      // Store document and chunks
      this.documents.set(documentId, document);
      this.chunks.set(documentId, chunksWithEmbeddings);

      this.saveDocuments();
      this.saveChunks();

      console.log(
        `Processed ${fileType.toUpperCase()} document: ${fileName} (${chunksWithEmbeddings.length} chunks)`
      );
      return document;
    } catch (error) {
      console.error('Error processing document:', error);
      throw new Error(
        `Failed to process document: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  private chunkDocument(document: Document): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const preferences = preferencesService.getPreferences();
    const chunkSize = preferences.embeddingSettings?.chunkSize || 1000; // characters per chunk
    const overlap = preferences.embeddingSettings?.chunkOverlap || 200; // character overlap between chunks

    const text = document.content.trim();
    if (!text) return chunks;

    // Helper function to calculate overlap word count based on character overlap
    const calculateOverlapWordCount = (
      overlapChars: number,
      averageWordLength: number = 5
    ): number => {
      return Math.floor(overlapChars / averageWordLength);
    };

    // Split by paragraphs first, then by sentences if needed
    const paragraphs = text.split(/\n\s*\n/).filter((p: string) => p.trim());

    let currentChunk = '';
    let chunkIndex = 0;
    let currentOffset = 0; // Track character position in original text

    for (const paragraph of paragraphs) {
      const paragraphText = paragraph.trim();

      // If adding this paragraph would exceed chunk size, save current chunk
      if (
        currentChunk &&
        currentChunk.length + paragraphText.length > chunkSize
      ) {
        if (currentChunk.trim()) {
          const chunkStart = currentOffset - currentChunk.length;
          const chunkEnd = currentOffset;

          chunks.push({
            id: uuidv4(),
            documentId: document.id,
            content: currentChunk.trim(),
            chunkIndex: chunkIndex++,
            startChar: Math.max(0, chunkStart),
            endChar: chunkEnd,
          });
        }

        // Start new chunk with overlap from previous chunk
        const words = currentChunk.split(' ');
        const overlapWords = words.slice(-calculateOverlapWordCount(overlap));
        currentChunk = overlapWords.join(' ') + '\n\n' + paragraphText;
        currentOffset += paragraphText.length + 2; // +2 for \n\n
      } else {
        // Add paragraph to current chunk
        if (currentChunk) {
          currentChunk += '\n\n' + paragraphText;
          currentOffset += paragraphText.length + 2; // +2 for \n\n
        } else {
          currentChunk = paragraphText;
          currentOffset += paragraphText.length;
        }
      }
    }

    // Add the final chunk
    if (currentChunk.trim()) {
      const chunkStart = currentOffset - currentChunk.length;
      const chunkEnd = currentOffset;

      chunks.push({
        id: uuidv4(),
        documentId: document.id,
        content: currentChunk.trim(),
        chunkIndex: chunkIndex,
        startChar: Math.max(0, chunkStart),
        endChar: chunkEnd,
      });
    }

    return chunks;
  }

  private async generateEmbeddingForText(
    text: string
  ): Promise<number[] | null> {
    try {
      const preferences = preferencesService.getPreferences();
      if (!preferences.embeddingSettings.enabled) {
        return null;
      }

      const response = await ollamaService.generateEmbeddings({
        model: preferences.embeddingSettings.model,
        input: text,
      });

      return response.embeddings[0] || null;
    } catch (error) {
      console.error('Failed to generate embedding:', error);
      return null;
    }
  }

  private async generateEmbeddingsForChunks(
    chunks: DocumentChunk[]
  ): Promise<DocumentChunk[]> {
    const preferences = preferencesService.getPreferences();
    if (!preferences.embeddingSettings.enabled) {
      return chunks;
    }

    console.log(`Generating embeddings for ${chunks.length} chunks...`);
    const chunksWithEmbeddings: DocumentChunk[] = [];

    for (const chunk of chunks) {
      const embedding = await this.generateEmbeddingForText(chunk.content);
      chunksWithEmbeddings.push({
        ...chunk,
        embedding: embedding || undefined,
      });
    }

    console.log(
      `Generated embeddings for ${chunksWithEmbeddings.filter(c => c.embedding).length} chunks`
    );
    return chunksWithEmbeddings;
  }

  // Method to regenerate embeddings for all existing documents
  async regenerateAllEmbeddings(): Promise<void> {
    const preferences = preferencesService.getPreferences();
    if (!preferences.embeddingSettings.enabled) {
      console.log('Embeddings are disabled, skipping regeneration');
      return;
    }

    console.log('Starting to regenerate embeddings for all documents...');
    let processedChunks = 0;
    let totalChunks = 0;

    for (const [documentId, chunks] of this.chunks.entries()) {
      totalChunks += chunks.length;
      const chunksWithEmbeddings =
        await this.generateEmbeddingsForChunks(chunks);
      this.chunks.set(documentId, chunksWithEmbeddings);
      processedChunks += chunksWithEmbeddings.filter(c => c.embedding).length;
    }

    this.saveChunks();
    console.log(
      `Regenerated embeddings for ${processedChunks}/${totalChunks} chunks`
    );
  }

  // Method to get embedding model information
  async getEmbeddingModelInfo(): Promise<{
    available: boolean;
    model: string;
    chunksWithEmbeddings: number;
    totalChunks: number;
  }> {
    const preferences = preferencesService.getPreferences();
    let chunksWithEmbeddings = 0;
    let totalChunks = 0;

    for (const chunks of this.chunks.values()) {
      totalChunks += chunks.length;
      chunksWithEmbeddings += chunks.filter(c => c.embedding).length;
    }

    return {
      available: preferences.embeddingSettings.enabled,
      model: preferences.embeddingSettings.model,
      chunksWithEmbeddings,
      totalChunks,
    };
  }

  getDocument(documentId: string): Document | undefined {
    return this.documents.get(documentId);
  }

  getDocuments(sessionId?: string): Document[] {
    const allDocs = Array.from(this.documents.values());
    if (sessionId) {
      return allDocs.filter(doc => doc.sessionId === sessionId);
    }
    return allDocs.sort((a, b) => b.uploadedAt - a.uploadedAt);
  }

  getDocumentChunks(documentId: string): DocumentChunk[] {
    return this.chunks.get(documentId) || [];
  }

  deleteDocument(documentId: string): boolean {
    const deleted = this.documents.delete(documentId);
    this.chunks.delete(documentId);

    if (deleted) {
      this.saveDocuments();
      this.saveChunks();
    }

    return deleted;
  }

  // Enhanced search with semantic similarity using embeddings
  async searchDocuments(
    query: string,
    sessionId?: string,
    limit = 5
  ): Promise<DocumentChunk[]> {
    const preferences = preferencesService.getPreferences();

    // Use semantic search if embeddings are enabled
    if (preferences.embeddingSettings.enabled) {
      return this.semanticSearchDocuments(query, sessionId, limit);
    }

    // Fall back to keyword search
    return this.keywordSearchDocuments(query, sessionId, limit);
  }

  private async semanticSearchDocuments(
    query: string,
    sessionId?: string,
    limit = 5
  ): Promise<DocumentChunk[]> {
    try {
      // Generate embedding for the query
      const queryEmbedding = await this.generateEmbeddingForText(query);
      if (!queryEmbedding) {
        console.warn(
          'Failed to generate query embedding, falling back to keyword search'
        );
        return this.keywordSearchDocuments(query, sessionId, limit);
      }

      const preferences = preferencesService.getPreferences();
      const results: {
        chunk: DocumentChunk;
        similarity: number;
        document: Document;
      }[] = [];

      for (const [documentId, documentChunks] of this.chunks.entries()) {
        const document = this.documents.get(documentId);
        if (!document) continue;

        // Filter by session if specified
        if (sessionId && document.sessionId !== sessionId) continue;

        for (const chunk of documentChunks) {
          if (!chunk.embedding) continue;

          const similarity = cosineSimilarity(queryEmbedding, chunk.embedding);

          // Only include chunks above similarity threshold
          if (similarity >= preferences.embeddingSettings.similarityThreshold) {
            results.push({ chunk, similarity, document });
          }
        }
      }

      // Sort by similarity score and return top results
      return results
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map(result => ({
          ...result.chunk,
          filename: result.document.filename, // Add filename for context
        })) as DocumentChunk[];
    } catch (error) {
      console.error(
        'Semantic search failed, falling back to keyword search:',
        error
      );
      return this.keywordSearchDocuments(query, sessionId, limit);
    }
  }

  private keywordSearchDocuments(
    query: string,
    sessionId?: string,
    limit = 5
  ): DocumentChunk[] {
    const searchTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter(term => term.length > 2);
    const results: {
      chunk: DocumentChunk;
      score: number;
      document: Document;
    }[] = [];

    for (const [documentId, documentChunks] of this.chunks.entries()) {
      const document = this.documents.get(documentId);
      if (!document) continue;

      // Filter by session if specified
      if (sessionId && document.sessionId !== sessionId) continue;

      for (const chunk of documentChunks) {
        const chunkText = chunk.content.toLowerCase();
        let score = 0;

        // Simple scoring based on term frequency
        for (const term of searchTerms) {
          // Escape special regex characters to prevent injection
          const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const matches = (chunkText.match(new RegExp(escapedTerm, 'gi')) || [])
            .length;
          score += matches;
        }

        if (score > 0) {
          results.push({ chunk, score, document });
        }
      }
    }

    // Sort by score and return top results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(result => ({
        ...result.chunk,
        filename: result.document.filename, // Add filename for context
      })) as DocumentChunk[];
  }

  // Get relevant context for RAG
  async getRelevantContext(
    query: string,
    sessionId?: string
  ): Promise<string[]> {
    const relevantChunks = await this.searchDocuments(query, sessionId, 3);
    return relevantChunks.map(
      (chunk: DocumentChunk & { filename?: string }) => {
        const filename = chunk.filename || 'Unknown';
        return `[From: ${filename}]\n${chunk.content}`;
      }
    );
  }
}

export default new DocumentService();
