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
import documentService, {
  DocumentResourceBusyError,
} from '../services/documentService.js';
import storageService from '../storage.js';
import { ApiResponse } from '../types/index.js';
import { createLogger } from '../utils/logger.js';
import { authenticate } from '../middleware/auth.js';
import { fetchWebpageAsText } from '../utils/webpageFetcher.js';
import { resolveDocumentFileType } from '../utils/documentExtraction.js';

const logger = createLogger('routes:documents');

const router = express.Router();
router.use(authenticate);

const requireUserId = (req: express.Request): string => {
  if (!req.user?.userId) throw new Error('Authenticated user context missing');
  return req.user.userId;
};

const requestAbortSignal = (
  req: express.Request,
  res: express.Response
): { signal: AbortSignal; cleanup: () => void } => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Document client disconnected'));
    }
  };
  const responseClosed = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', responseClosed);
  if (req.aborted || res.destroyed) abort();
  return {
    signal: controller.signal,
    cleanup: () => {
      req.off('aborted', abort);
      res.off('close', responseClosed);
    },
  };
};

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (resolveDocumentFileType(file.originalname, file.mimetype)) {
      cb(null, true);
    } else {
      cb(
        new Error(
          'Unsupported file type. Supported: PDF, text, Markdown, HTML, code, DOCX, PPTX, XLSX, and CSV files'
        )
      );
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

    const queued = await documentService.queueDocumentProcessing(
      req.file.originalname,
      req.file.buffer,
      req.file.mimetype,
      requireUserId(req),
      sessionId
    );
    const { document } = queued;

    res.status(202).json({
      success: true,
      data: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        size: document.size,
        sessionId: document.sessionId,
        uploadedAt: document.uploadedAt,
        jobId: queued.jobId,
        processingStatus: queued.deduplicated
          ? ((document.metadata?.processingStatus as string) ?? 'queued')
          : 'queued',
        ...(queued.deduplicated ? { deduplicated: true } : {}),
        // Don't send full content in response
      },
      message: queued.deduplicated
        ? 'An identical document already exists in this scope'
        : 'Document uploaded; extraction is queued',
    } as ApiResponse);
  } catch (error) {
    logger.error('Document upload error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Knowledge collections (own plus collections shared with the caller)
router.get('/collections', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const collections = await documentService.listCollectionsWithShared({
      userId,
      role: req.user?.role,
    });
    const documents = await storageService.getAllDocuments(userId);
    const sharedDocuments = await documentService.listSharedDocuments({
      userId,
      role: req.user?.role,
    });
    const countFor = (collectionId: string): number =>
      documents.filter(document => document.collectionId === collectionId)
        .length +
      sharedDocuments.filter(
        entry => entry.document.collectionId === collectionId
      ).length;
    res.json({
      success: true,
      data: collections.map(collection => ({
        ...collection,
        documentCount: countFor(collection.id),
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

router.post('/collections', async (req, res) => {
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
    await storageService.saveKnowledgeCollection(
      collection,
      requireUserId(req)
    );
    res.json({ success: true, data: collection } as ApiResponse);
  } catch (error) {
    res.status(500).json({
      success: false,
      error:
        error instanceof Error ? error.message : 'Failed to create collection',
    } as ApiResponse);
  }
});

router.delete('/collections/:collectionId', async (req, res) => {
  try {
    const deleted = await storageService.deleteKnowledgeCollection(
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
router.put('/:documentId/collection', async (req, res) => {
  try {
    const { collectionId } = req.body as { collectionId?: string | null };
    const updated = await storageService.setDocumentCollection(
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
    const queued = await documentService.queueDocumentProcessing(
      filename,
      Buffer.from(header + page.text, 'utf-8'),
      'text/plain',
      requireUserId(req),
      sessionId
    );
    const { document } = queued;

    res.status(202).json({
      success: true,
      data: {
        id: document.id,
        filename: document.filename,
        fileType: document.fileType,
        size: document.size,
        sessionId: document.sessionId,
        uploadedAt: document.uploadedAt,
        jobId: queued.jobId,
        processingStatus: 'queued',
        title: page.title,
        url: page.url,
      },
      message: 'Webpage attached; extraction is queued',
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
router.get('/session/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    const documents = await documentService.getDocuments(
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
      contentChars: doc.content?.length ?? 0,
      processingStatus: doc.metadata?.processingStatus,
      processingError: doc.metadata?.processingError,
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

// Get all documents (own plus documents in shared collections)
router.get('/', async (req, res) => {
  try {
    const userId = requireUserId(req);
    const documents = await documentService.getDocuments(userId);
    const shared = await documentService.listSharedDocuments({
      userId,
      role: req.user?.role,
    });

    // Return documents without full content
    const documentsWithoutContent = [
      ...documents.map(doc => ({
        id: doc.id,
        filename: doc.filename,
        fileType: doc.fileType,
        size: doc.size,
        sessionId: doc.sessionId,
        collectionId: doc.collectionId,
        uploadedAt: doc.uploadedAt,
        contentChars: doc.content?.length ?? 0,
        processingStatus: doc.metadata?.processingStatus,
        processingError: doc.metadata?.processingError,
      })),
      ...shared.map(entry => ({
        id: entry.document.id,
        filename: entry.document.filename,
        fileType: entry.document.fileType,
        size: entry.document.size,
        sessionId: entry.document.sessionId,
        collectionId: entry.document.collectionId,
        uploadedAt: entry.document.uploadedAt,
        contentChars: entry.document.content?.length ?? 0,
        shared: entry.shared,
      })),
    ];

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
router.delete('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const deleted = await documentService.deleteDocument(
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
  const abort = requestAbortSignal(req, res);
  try {
    const result = await documentService.regenerateAllEmbeddings(
      requireUserId(req),
      abort.signal
    );
    res.json({
      success: true,
      data: result,
      message:
        result.documentsSkipped > 0
          ? `Regenerated ${result.documentsRegenerated} documents; ${result.documentsSkipped} were deleted, disabled, or busy`
          : `Regenerated embeddings for ${result.documentsRegenerated} documents`,
    } as ApiResponse);
  } catch (error) {
    logger.error('Regenerate embeddings error:', error);
    if (req.aborted || res.destroyed) return;
    res.status(error instanceof DocumentResourceBusyError ? 409 : 500).json({
      success: false,
      error:
        error instanceof DocumentResourceBusyError
          ? error.message
          : 'Failed to regenerate embeddings',
    } as ApiResponse);
  } finally {
    abort.cleanup();
  }
});

// Stream the private, encrypted source through the configured blob backend.
// Only one explicit byte range is accepted; S3/local details never reach the
// browser and provider object URLs are never persisted or redirected to.
router.get('/:documentId/source', async (req, res) => {
  const abort = requestAbortSignal(req, res);
  try {
    const rawRange = req.headers.range;
    let range: { start: number; end?: number } | undefined;
    if (rawRange) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(rawRange.trim());
      if (!match) {
        res.status(416).set('Accept-Ranges', 'bytes').end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Number(match[2]) : undefined;
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        (end !== undefined && (!Number.isSafeInteger(end) || end < start))
      ) {
        res.status(416).set('Accept-Ranges', 'bytes').end();
        return;
      }
      range = { start, ...(end !== undefined ? { end } : {}) };
    }
    const found = await documentService.getDocumentShared(
      req.params.documentId as string,
      { userId: requireUserId(req), role: req.user?.role }
    );
    const source = found
      ? await documentService.openDocumentSource(
          req.params.documentId as string,
          found.ownerUserId,
          range,
          abort.signal
        )
      : undefined;
    if (!source) {
      res
        .status(404)
        .json({ success: false, error: 'Document source not found' });
      return;
    }
    res.status(source.range ? 206 : 200);
    res.set({
      'Content-Type': source.descriptor.contentType,
      'Content-Length': String(source.range?.length ?? source.descriptor.size),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (source.range) {
      res.set(
        'Content-Range',
        `bytes ${source.range.start}-${source.range.end}/${source.range.total}`
      );
    }
    source.body.on('error', error => {
      logger.warn('Document source stream failed', error);
      res.destroy(error instanceof Error ? error : undefined);
    });
    source.body.pipe(res);
  } catch (error) {
    if (abort.signal.aborted) return;
    if (error && typeof error === 'object' && 'code' in error) {
      if (error.code === 'invalid-range') {
        res.status(416).set('Accept-Ranges', 'bytes').end();
        return;
      }
    }
    logger.error('Document source download error:', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to read document source' });
  } finally {
    abort.cleanup();
  }
});

// Keep this parameterized route after named GET routes such as
// /embeddings/status so document IDs cannot shadow them.
router.get('/:documentId', async (req, res) => {
  try {
    const { documentId } = req.params;
    const found = await documentService.getDocumentShared(
      documentId as string,
      { userId: requireUserId(req), role: req.user?.role }
    );
    const document = found
      ? found.shared
        ? { ...found.document, shared: found.shared }
        : found.document
      : undefined;

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
