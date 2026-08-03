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
import { v4 as uuidv4 } from 'uuid';
import storageService from '../storage.js';
import { ApiResponse, Note } from '../types/index.js';
import { authenticate, AuthenticatedRequest } from '../middleware/auth.js';
import {
  MAX_NOTE_CONTENT_LENGTH,
  MAX_NOTE_TITLE_LENGTH,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';

const router = express.Router();
router.use(authenticate);

const userIdOf = (req: AuthenticatedRequest): string =>
  req.user?.userId || 'default';

function sendNoteError(
  res: express.Response,
  error: unknown,
  fallback: string
) {
  if (error instanceof ResourcePolicyError) {
    res.status(error.statusCode).json({ success: false, error: error.message });
    return;
  }
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

router.get('/', (req: AuthenticatedRequest, res) => {
  try {
    res.json({
      success: true,
      data: storageService.getNotes(userIdOf(req)),
    } as ApiResponse<Note[]>);
  } catch (error) {
    sendNoteError(res, error, 'Failed to load notes');
  }
});

router.post('/', (req: AuthenticatedRequest, res) => {
  try {
    const { title, content } = req.body as {
      title?: unknown;
      content?: unknown;
    };
    const now = Date.now();
    const note: Note = {
      id: uuidv4(),
      title: readNoteField(title, 'title', MAX_NOTE_TITLE_LENGTH),
      content: readNoteField(content, 'content', MAX_NOTE_CONTENT_LENGTH),
      createdAt: now,
      updatedAt: now,
    };
    storageService.saveNote(note, userIdOf(req));
    res.json({ success: true, data: note } as ApiResponse<Note>);
  } catch (error) {
    sendNoteError(res, error, 'Failed to create note');
  }
});

router.put('/:noteId', (req: AuthenticatedRequest, res) => {
  try {
    const userId = userIdOf(req);
    const existing = storageService.getNote(
      req.params.noteId as string,
      userId
    );
    if (!existing) {
      res.status(404).json({
        success: false,
        error: 'Note not found',
      } as ApiResponse);
      return;
    }
    const { title, content } = req.body as {
      title?: unknown;
      content?: unknown;
    };
    const updated: Note = {
      ...existing,
      title:
        title !== undefined
          ? readNoteField(title, 'title', MAX_NOTE_TITLE_LENGTH)
          : existing.title,
      content:
        content !== undefined
          ? readNoteField(content, 'content', MAX_NOTE_CONTENT_LENGTH)
          : existing.content,
      updatedAt: Date.now(),
    };
    storageService.saveNote(updated, userId);
    res.json({ success: true, data: updated } as ApiResponse<Note>);
  } catch (error) {
    sendNoteError(res, error, 'Failed to update note');
  }
});

router.delete('/:noteId', (req: AuthenticatedRequest, res) => {
  try {
    const deleted = storageService.deleteNote(
      req.params.noteId as string,
      userIdOf(req)
    );
    if (!deleted) {
      res.status(404).json({
        success: false,
        error: 'Note not found',
      } as ApiResponse);
      return;
    }
    res.json({ success: true, message: 'Note deleted' } as ApiResponse);
  } catch (error) {
    sendNoteError(res, error, 'Failed to delete note');
  }
});

export default router;
