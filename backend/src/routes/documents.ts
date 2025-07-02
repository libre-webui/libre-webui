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
import documentService from '../services/documentService.js';
import { ApiResponse } from '../types/index.js';

const router = express.Router();

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
    console.error('Document upload error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get documents for a session
router.get('/session/:sessionId', (req, res) => {
  try {
    const { sessionId } = req.params;
    const documents = documentService.getDocuments(sessionId);

    // Return documents without full content
    const documentsWithoutContent = documents.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      size: doc.size,
      sessionId: doc.sessionId,
      uploadedAt: doc.uploadedAt,
    }));

    res.json({
      success: true,
      data: documentsWithoutContent,
    } as ApiResponse);
  } catch (error) {
    console.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get all documents
router.get('/', (req, res) => {
  try {
    const documents = documentService.getDocuments();

    // Return documents without full content
    const documentsWithoutContent = documents.map(doc => ({
      id: doc.id,
      filename: doc.filename,
      fileType: doc.fileType,
      size: doc.size,
      sessionId: doc.sessionId,
      uploadedAt: doc.uploadedAt,
    }));

    res.json({
      success: true,
      data: documentsWithoutContent,
    } as ApiResponse);
  } catch (error) {
    console.error('Get all documents error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get document details
router.get('/:documentId', (req, res) => {
  try {
    const { documentId } = req.params;
    const document = documentService.getDocument(documentId);

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
    console.error('Get document error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Search documents
router.post('/search', (req, res) => {
  try {
    const { query, sessionId, limit } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Query is required and must be a string',
      } as ApiResponse);
      return;
    }

    const chunks = documentService.searchDocuments(query, sessionId, limit);

    res.json({
      success: true,
      data: chunks,
    } as ApiResponse);
  } catch (error) {
    console.error('Document search error:', error);
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
    const deleted = documentService.deleteDocument(documentId);

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
    console.error('Delete document error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
    } as ApiResponse);
  }
});

// Get embedding status and information
router.get('/embeddings/status', async (req, res) => {
  try {
    const embeddingInfo = await documentService.getEmbeddingModelInfo();
    res.json({
      success: true,
      data: embeddingInfo,
    } as ApiResponse);
  } catch (error) {
    console.error('Get embedding status error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get embedding status',
    } as ApiResponse);
  }
});

// Regenerate embeddings for all documents
router.post('/embeddings/regenerate', async (req, res) => {
  try {
    await documentService.regenerateAllEmbeddings();
    res.json({
      success: true,
      message: 'Embeddings regenerated successfully',
    } as ApiResponse);
  } catch (error) {
    console.error('Regenerate embeddings error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to regenerate embeddings',
    } as ApiResponse);
  }
});

export default router;
