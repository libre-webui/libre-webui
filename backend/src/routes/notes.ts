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

import express from 'express';
import multer from 'multer';
import { ApiResponse } from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import type { AuthzActor } from '../services/authorizationService.js';
import {
  addAttachment,
  assistNote,
  createNote,
  deleteAttachment,
  deleteNote,
  getNote,
  listAttachments,
  listNotes,
  listRevisions,
  NoteError,
  openAttachment,
  restoreRevision,
  updateNote,
} from '../services/noteService.js';
import {
  MAX_NOTE_ATTACHMENT_BYTES,
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('routes:notes');

const router = express.Router();
router.use(authenticate);

const actorOf = (req: AuthenticatedRequest): AuthzActor => ({
  userId: req.user?.userId || 'default',
  ...(req.user?.role !== undefined ? { role: req.user.role } : {}),
});

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_NOTE_ATTACHMENT_BYTES },
});

function sendNoteError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (error instanceof NoteError || error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
  logger.error(fallback, error);
  res.status(500).json({
    success: false,
    error: error instanceof Error ? error.message : fallback,
  } as ApiResponse);
}

function readNoteField(
  value: unknown,
  field: 'title' | 'content',
  maximum: number
): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') {
    throw new ResourcePolicyError(`${field} must be a string`, 400);
  }
  if (value.length > maximum) {
    throw new ResourcePolicyError(
      `${field} exceeds the maximum length of ${maximum} characters`,
      400
    );
  }
  return value;
}

router.get('/', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await listNotes(actorOf(req)),
    } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to load notes');
  }
});

router.get('/:noteId', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await getNote(actorOf(req), req.params.noteId as string),
    } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to load note');
  }
});

router.post('/', async (req: AuthenticatedRequest, res) => {
  try {
    const { title, content } = req.body as {
      title?: unknown;
      content?: unknown;
    };
    const note = await createNote(actorOf(req), {
      title: readNoteField(title, 'title', MAX_NOTE_TITLE_LENGTH),
      content: readNoteField(content, 'content', MAX_NOTE_CONTENT_LENGTH),
    });
    res.json({ success: true, data: note } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to create note');
  }
});

router.put('/:noteId', async (req: AuthenticatedRequest, res) => {
  try {
    const { title, content, pinned } = req.body as {
      title?: unknown;
      content?: unknown;
      pinned?: unknown;
    };
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      throw new ResourcePolicyError('pinned must be a boolean', 400);
    }
    const updated = await updateNote(
      actorOf(req),
      req.params.noteId as string,
      {
        ...(title !== undefined
          ? { title: readNoteField(title, 'title', MAX_NOTE_TITLE_LENGTH) }
          : {}),
        ...(content !== undefined
          ? {
              content: readNoteField(
                content,
                'content',
                MAX_NOTE_CONTENT_LENGTH
              ),
            }
          : {}),
        ...(pinned !== undefined ? { pinned } : {}),
      }
    );
    res.json({ success: true, data: updated } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to update note');
  }
});

router.delete('/:noteId', async (req: AuthenticatedRequest, res) => {
  try {
    await deleteNote(actorOf(req), req.params.noteId as string);
    res.json({ success: true, message: 'Note deleted' } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to delete note');
  }
});

router.get('/:noteId/revisions', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await listRevisions(actorOf(req), req.params.noteId as string),
    } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to load revisions');
  }
});

router.post(
  '/:noteId/revisions/:revisionId/restore',
  async (req: AuthenticatedRequest, res) => {
    try {
      const restored = await restoreRevision(
        actorOf(req),
        req.params.noteId as string,
        req.params.revisionId as string
      );
      res.json({ success: true, data: restored } as ApiResponse);
    } catch (error) {
      sendNoteError(res, error, 'Failed to restore revision');
    }
  }
);

router.get('/:noteId/attachments', async (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: await listAttachments(actorOf(req), req.params.noteId as string),
    } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to load attachments');
  }
});

router.post(
  '/:noteId/attachments',
  attachmentUpload.single('attachment'),
  async (req: AuthenticatedRequest, res) => {
    try {
      if (!req.file) {
        res
          .status(400)
          .json({ success: false, error: 'No file uploaded' } as ApiResponse);
        return;
      }
      const attachment = await addAttachment(
        actorOf(req),
        req.params.noteId as string,
        {
          buffer: req.file.buffer,
          filename: req.file.originalname,
          contentType: req.file.mimetype || 'application/octet-stream',
        }
      );
      res.status(201).json({ success: true, data: attachment } as ApiResponse);
    } catch (error) {
      sendNoteError(res, error, 'Failed to add attachment');
    }
  }
);

router.get(
  '/:noteId/attachments/:attachmentId',
  async (req: AuthenticatedRequest, res) => {
    try {
      const { attachment, body } = await openAttachment(
        actorOf(req),
        req.params.noteId as string,
        req.params.attachmentId as string
      );
      res.setHeader('Content-Type', attachment.contentType);
      res.setHeader('Content-Length', String(attachment.size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(attachment.filename)}"`
      );
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      body.body.on('error', error => {
        logger.error('Attachment stream failed:', error);
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      body.body.pipe(res);
    } catch (error) {
      sendNoteError(res, error, 'Failed to read attachment');
    }
  }
);

router.delete(
  '/:noteId/attachments/:attachmentId',
  async (req: AuthenticatedRequest, res) => {
    try {
      await deleteAttachment(
        actorOf(req),
        req.params.noteId as string,
        req.params.attachmentId as string
      );
      res.json({ success: true, message: 'Attachment deleted' } as ApiResponse);
    } catch (error) {
      sendNoteError(res, error, 'Failed to delete attachment');
    }
  }
);

router.post('/:noteId/assist', async (req: AuthenticatedRequest, res) => {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) {
      controller.abort(new Error('Note assist client disconnected'));
    }
  };
  req.once('aborted', abort);
  res.once('close', () => {
    if (!res.writableEnded) abort();
  });
  try {
    const { instruction, model, providerType, providerId } = req.body as {
      instruction?: unknown;
      model?: unknown;
      providerType?: unknown;
      providerId?: unknown;
    };
    if (typeof instruction !== 'string' || typeof model !== 'string') {
      throw new ResourcePolicyError('instruction and model are required', 400);
    }
    const proposal = await assistNote(
      actorOf(req),
      req.params.noteId as string,
      {
        instruction,
        model,
        providerType: typeof providerType === 'string' ? providerType : null,
        providerId: typeof providerId === 'string' ? providerId : null,
      },
      controller.signal
    );
    if (controller.signal.aborted) return;
    res.json({ success: true, data: proposal } as ApiResponse);
  } catch (error) {
    if (controller.signal.aborted) return;
    sendNoteError(res, error, 'Failed to generate the note edit');
  }
});

export default router;
