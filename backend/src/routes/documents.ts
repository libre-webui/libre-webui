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

import express from 'express';
import multer from 'multer';
import { v4 as uuidv4 } from 'uuid';
import documentService from '../services/documentService.js';
import storageService from '../storage.js';
import { ApiResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { authenticate } from '../middleware/auth.js';
import { fetchWebpageAsText } from '../utils/webpageFetcher.js';

const logger = createLogger('routes:documents');

const router = express.Router();
router.use(authenticate);

const requireUserId = (req: express.Request): string => {
  if (!req.user?.userId) throw new Error('Authenticated user context missing');
  return req.user.userId;
};

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow only PDF and TXT files
    if (file.mimetype === 'application/pdf' || file.mimetype === 'text/plain') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and TXT files are allowed'));
    }
  },
});

// Upload document
router.post('/upload', upload.single('document'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({
        success: false,
        error: 'No file uploaded',
      } as ApiResponse);
      return;
    }

    const { sessionId } = req.body;

    const document = await documentService.processDocument(
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype,
      requireUserId(req),
      sessionId
    );

    res.json({
      success: true,
      data: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        size: document.size,
        sessionId: document.sessionId,
        uploadedAt: document.uploadedAt,
        // Don't send full content in response
      },
      message: 'Document uploaded and processed successfully',
    } as ApiResponse);
  } catch (error) {
    logger.error('Document upload error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Knowledge collections
router.get('/collections', (req, res) => {
  try {
    const userId = requireUserId(req);
    const collections = storageService.getKnowledgeCollections(userId);
    const documents = storageService.getAllDocuments(userId);
    res.json({
      success: true,
      data: collections.map(collection => ({
        ...collection,
        documentCount: documents.filter(
          document => document.collectionId === collection.id
        ).length,
      })),
    } as ApiResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to load collections',
    } as ApiResponse);
  }
});

router.post('/collections', (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || !name.trim()) {
      res.status(400).json({
        success: false,
        error: 'Name is required',
      } as ApiResponse);
      return;
    }
    const now = Date.now();
    const collection = {
      id: uuidv4(),
      name: name.trim().slice(0, 100),
      createdAt: now,
      updatedAt: now,
    };
    storageService.saveKnowledgeCollection(collection, requireUserId(req));
    res.json({ success: true, data: collection } as ApiResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create collection',
    } as ApiResponse);
  }
});

router.delete('/collections/:collectionId', (req, res) => {
  try {
    const deleted = storageService.deleteKnowledgeCollection(
      req.params.collectionId as string,
      requireUserId(req)
    );
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Collection not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, message: 'Collection deleted' } as ApiResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to delete collection',
    } as ApiResponse);
  }
});

// Assign a document to a collection (or remove it with collectionId: null)
router.put('/:documentId/collection', (req, res) => {
  try {
    const { collectionId } = req.body as { collectionId?: string | null };
    const updated = storageService.setDocumentCollection(
      req.params.documentId as string,
      collectionId || null,
      requireUserId(req)
    );
    if (!updated) {
      res.status(404).json({
        success: false,
        error: 'Document not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, message: 'Document updated' } as ApiResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to update document',
    } as ApiResponse);
  }
});

// Attach a public webpage as a text document
router.post('/fetch-url', async (req, res) => {
  try {
    const { url, sessionId } = req.body as {
      url?: string;
      sessionId?: string;
    };
    if (!url || typeof url !== 'string') {
      res.status(400).json({
        success: false,
        error: 'URL is required',
      } as ApiResponse);
      return;
    }

    const page = await fetchWebpageAsText(url);
    const hostname = new URL(page.url).hostname;
    const filename = `${(page.title || hostname).slice(0, 80)}.txt`;

    const header = `${page.title ? `${page.title}\n` : ''}Source: ${page.url}\n\n`;
    const document = await documentService.processDocument(
      filename,
      Buffer.from(header + page.text, 'utf-8'),
      'text/plain',
      requireUserId(req),
      sessionId
    );

    res.json({
      success: true,
      data: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        size: document.size,
        sessionId: document.sessionId,
        uploadedAt: document.uploadedAt,
        title: page.title,
        url: page.url,
      },
      message: 'Webpage attached successfully',
    } as ApiResponse);
  } catch (error) {
    logger.error('Webpage attach error:', error);
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get documents for a session
router.get('/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const documents = documentService.getDocuments(
      requireUserId(req),
      sessionId
    );

    // Return documents without full content
    const documentsWithoutContent = documents.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      size: doc.size,
      sessionId: doc.sessionId,
      collectionId: doc.collectionId,
      uploadedAt: doc.uploadedAt,
    }));

    res.json({
      success: true,
      data: documentsWithoutContent,
    } as ApiResponse);
  } catch (error) {
    logger.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get all documents
router.get('/', (req, res) => {
  try {
    const documents = documentService.getDocuments(requireUserId(req));

    // Return documents without full content
    const documentsWithoutContent = documents.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      size: doc.size,
      sessionId: doc.sessionId,
      collectionId: doc.collectionId,
      uploadedAt: doc.uploadedAt,
    }));

    res.json({
      success: true,
      data: documentsWithoutContent,
    } as ApiResponse);
  } catch (error) {
    logger.error('Get all documents error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Search documents
router.post('/search', async (req, res) => {
  try {
    const { query, sessionId, limit } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Query is required and must be a string',
      } as ApiResponse);
      return;
    }

    const chunks = await documentService.searchDocuments(
      query,
      requireUserId(req),
      sessionId,
      limit
    );

    res.json({
      success: true,
      data: chunks,
    } as ApiResponse);
  } catch (error) {
    logger.error('Document search error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Delete document
router.delete('/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const deleted = documentService.deleteDocument(
      documentId,
      requireUserId(req)
    );

    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Document not found',
      } as ApiResponse);
      return;
    }

    res.json({
      success: true,
      message: 'Document deleted successfully',
    } as ApiResponse);
  } catch (error) {
    logger.error('Delete document error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get embedding status and information
router.get('/embeddings/status', async (req, res) => {
  try {
    const embeddingInfo = await documentService.getEmbeddingModelInfo(
      requireUserId(req)
    );
    res.json({
      success: true,
      data: embeddingInfo,
    } as ApiResponse);
  } catch (error) {
    logger.error('Get embedding status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get embedding status',
    } as ApiResponse);
  }
});

// Regenerate embeddings for all documents
router.post('/embeddings/regenerate', async (req, res) => {
  try {
    await documentService.regenerateAllEmbeddings(requireUserId(req));
    res.json({
      success: true,
      message: 'Embeddings regenerated successfully',
    } as ApiResponse);
  } catch (error) {
    logger.error('Regenerate embeddings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to regenerate embeddings',
    } as ApiResponse);
  }
});

// Keep this parameterized route after named GET routes such as
// /embeddings/status so document IDs cannot shadow them.
router.get('/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const document = documentService.getDocument(
      documentId,
      requireUserId(req)
    );

    if (!document) {
      res.status(404).json({
        success: false,
        error: 'Document not found',
      } as ApiResponse);
      return;
    }

    res.json({
      success: true,
      data: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        size: document.size,
        sessionId: document.sessionId,
        uploadedAt: document.uploadedAt,
        // Include content for individual document request
        content: document.content,
      },
    } as ApiResponse);
  } catch (error) {
    logger.error('Get document error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

export default router;
