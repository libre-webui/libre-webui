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
import pdfParse from 'pdf-parse';
import { Document, DocumentChunk } from '../types/index.js';

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
        const pdfData = await pdfParse(fileBuffer);
        content = pdfData.text;
        fileType = 'pdf';
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

      // Store document and chunks
      this.documents.set(documentId, document);
      this.chunks.set(documentId, chunks);

      this.saveDocuments();
      this.saveChunks();

      console.log(
        `Processed ${fileType.toUpperCase()} document: ${fileName} (${chunks.length} chunks)`
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
    const chunkSize = 1000; // characters per chunk
    const overlap = 200; // character overlap between chunks

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

  // Simple keyword-based search for now
  // In a production system, you'd want to use vector embeddings
  searchDocuments(
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
          const matches = (chunkText.match(new RegExp(term, 'g')) || []).length;
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
  getRelevantContext(query: string, sessionId?: string): string[] {
    const relevantChunks = this.searchDocuments(query, sessionId, 3);
    return relevantChunks.map(chunk => {
      const filename =
        (chunk as DocumentChunk & { filename?: string }).filename || 'Unknown';
      return `[From: ${filename}]\n${chunk.content}`;
    });
  }
}

export default new DocumentService();
