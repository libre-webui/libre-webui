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
import { getDatabaseSafe } from '../db.js';
import {
  GeneratedImage,
  GeneratedMedia,
  GeneratedMediaKind,
} from '../types/index.js';
import { encryptionService } from './encryptionService.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:gallery-service');

interface SaveImageParams {
  prompt: string;
  model: string;
  imageData: string;
  size?: string;
  quality?: string;
}

interface GetImagesParams {
  limit?: number;
  offset?: number;
}

interface GetImagesResult {
  images: GeneratedImage[];
  total: number;
}

interface SaveMediaParams {
  kind: GeneratedMediaKind;
  prompt: string;
  model: string;
  pluginId?: string;
  mediaData: string;
  mimeType: string;
  size?: string;
  quality?: string;
  metadata?: Record<string, unknown>;
}

interface GetMediaParams extends GetImagesParams {
  kind?: GeneratedMediaKind;
}

interface GetMediaResult {
  media: GeneratedMedia[];
  total: number;
}

class GalleryService {
  /**
   * Save a generated image to the gallery
   */
  saveImage(userId: string, params: SaveImageParams): GeneratedImage | null {
    const db = getDatabaseSafe();
    if (!db) {
      logger.error('Database not available for saving image');
      return null;
    }

    try {
      const id = uuidv4();
      const createdAt = Date.now();

      // Encrypt the image data and prompt before storing
      const encryptedImageData = encryptionService.encrypt(params.imageData);
      const encryptedPrompt = encryptionService.encrypt(params.prompt);

      db.prepare(
        `
        INSERT INTO generated_images
          (id, user_id, kind, prompt, model, image_data, mime_type, size, quality, created_at)
        VALUES (?, ?, 'image', ?, ?, ?, ?, ?, ?, ?)
        `
      ).run(
        id,
        userId,
        encryptedPrompt,
        params.model,
        encryptedImageData,
        inferImageMimeType(params.imageData),
        params.size || null,
        params.quality || null,
        createdAt
      );

      return {
        id,
        userId,
        prompt: params.prompt,
        model: params.model,
        imageData: params.imageData,
        size: params.size,
        quality: params.quality,
        createdAt,
      };
    } catch (error) {
      logger.error('Error saving image to gallery:', error);
      return null;
    }
  }

  saveMedia(userId: string, params: SaveMediaParams): GeneratedMedia | null {
    const db = getDatabaseSafe();
    if (!db) return null;

    try {
      const id = uuidv4();
      const createdAt = Date.now();
      db.prepare(
        `INSERT INTO generated_images
           (id, user_id, kind, prompt, model, plugin_id, image_data,
            mime_type, size, quality, metadata, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        params.kind,
        encryptionService.encrypt(params.prompt),
        params.model,
        params.pluginId || null,
        encryptionService.encrypt(params.mediaData),
        params.mimeType,
        params.size || null,
        params.quality || null,
        params.metadata ? JSON.stringify(params.metadata) : null,
        createdAt
      );
      return { id, userId, createdAt, ...params };
    } catch (error) {
      logger.error('Error saving generated media:', error);
      return null;
    }
  }

  /**
   * Get user's images with pagination
   */
  getImages(userId: string, params: GetImagesParams = {}): GetImagesResult {
    const db = getDatabaseSafe();
    if (!db) {
      return { images: [], total: 0 };
    }

    try {
      const limit = params.limit || 20;
      const offset = params.offset || 0;

      // Get total count
      const countResult = db
        .prepare(
          `SELECT COUNT(*) as total FROM generated_images
           WHERE user_id = ? AND kind = 'image'`
        )
        .get(userId) as { total: number };

      // Get paginated images
      const rows = db
        .prepare(
          `
          SELECT id, user_id, prompt, model, image_data, size, quality, created_at
          FROM generated_images
          WHERE user_id = ? AND kind = 'image'
          ORDER BY created_at DESC
          LIMIT ? OFFSET ?
          `
        )
        .all(userId, limit, offset) as Array<{
        id: string;
        user_id: string;
        prompt: string;
        model: string;
        image_data: string;
        size: string | null;
        quality: string | null;
        created_at: number;
      }>;

      const images: GeneratedImage[] = rows.map(row => ({
        id: row.id,
        userId: row.user_id,
        prompt: encryptionService.decrypt(row.prompt),
        model: row.model,
        imageData: encryptionService.decrypt(row.image_data),
        size: row.size || undefined,
        quality: row.quality || undefined,
        createdAt: row.created_at,
      }));

      return {
        images,
        total: countResult.total,
      };
    } catch (error) {
      logger.error('Error getting images from gallery:', error);
      return { images: [], total: 0 };
    }
  }

  getMedia(userId: string, params: GetMediaParams = {}): GetMediaResult {
    const db = getDatabaseSafe();
    if (!db) return { media: [], total: 0 };

    try {
      const limit = params.limit || 20;
      const offset = params.offset || 0;
      const where = params.kind
        ? 'WHERE user_id = ? AND kind = ?'
        : 'WHERE user_id = ?';
      const bindings = params.kind ? [userId, params.kind] : [userId];
      const count = db
        .prepare(`SELECT COUNT(*) as total FROM generated_images ${where}`)
        .get(...bindings) as { total: number };
      const rows = db
        .prepare(
          `SELECT id, user_id, kind, prompt, model, plugin_id, image_data,
                  mime_type, size, quality, metadata, created_at
           FROM generated_images
           ${where}
           ORDER BY created_at DESC
           LIMIT ? OFFSET ?`
        )
        .all(...bindings, limit, offset) as GeneratedMediaRow[];
      return {
        media: rows.map(toGeneratedMedia),
        total: count.total,
      };
    } catch (error) {
      logger.error('Error getting generated media:', error);
      return { media: [], total: 0 };
    }
  }

  getMediaItem(mediaId: string, userId: string): GeneratedMedia | null {
    const db = getDatabaseSafe();
    if (!db) return null;
    try {
      const row = db
        .prepare(
          `SELECT id, user_id, kind, prompt, model, plugin_id, image_data,
                  mime_type, size, quality, metadata, created_at
           FROM generated_images
           WHERE id = ? AND user_id = ?`
        )
        .get(mediaId, userId) as GeneratedMediaRow | undefined;
      return row ? toGeneratedMedia(row) : null;
    } catch (error) {
      logger.error('Error getting generated media item:', error);
      return null;
    }
  }

  /**
   * Get a single image by ID
   */
  getImage(imageId: string, userId: string): GeneratedImage | null {
    const db = getDatabaseSafe();
    if (!db) {
      return null;
    }

    try {
      const row = db
        .prepare(
          `
          SELECT id, user_id, prompt, model, image_data, size, quality, created_at
          FROM generated_images
          WHERE id = ? AND user_id = ? AND kind = 'image'
          `
        )
        .get(imageId, userId) as
        | {
            id: string;
            user_id: string;
            prompt: string;
            model: string;
            image_data: string;
            size: string | null;
            quality: string | null;
            created_at: number;
          }
        | undefined;

      if (!row) {
        return null;
      }

      return {
        id: row.id,
        userId: row.user_id,
        prompt: encryptionService.decrypt(row.prompt),
        model: row.model,
        imageData: encryptionService.decrypt(row.image_data),
        size: row.size || undefined,
        quality: row.quality || undefined,
        createdAt: row.created_at,
      };
    } catch (error) {
      logger.error('Error getting image from gallery:', error);
      return null;
    }
  }

  /**
   * Delete an image from the gallery
   */
  deleteImage(imageId: string, userId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) {
      return false;
    }

    try {
      // Verify ownership before deleting
      const result = db
        .prepare(
          `DELETE FROM generated_images
           WHERE id = ? AND user_id = ? AND kind = 'image'`
        )
        .run(imageId, userId);

      return result.changes > 0;
    } catch (error) {
      logger.error('Error deleting image from gallery:', error);
      return false;
    }
  }

  /**
   * Delete all images for a user
   */
  deleteAllImages(userId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) {
      return false;
    }

    try {
      db.prepare(
        `DELETE FROM generated_images WHERE user_id = ? AND kind = 'image'`
      ).run(userId);
      return true;
    } catch (error) {
      logger.error('Error deleting all images from gallery:', error);
      return false;
    }
  }

  deleteMedia(mediaId: string, userId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      return (
        db
          .prepare('DELETE FROM generated_images WHERE id = ? AND user_id = ?')
          .run(mediaId, userId).changes > 0
      );
    } catch (error) {
      logger.error('Error deleting generated media:', error);
      return false;
    }
  }
}

interface GeneratedMediaRow {
  id: string;
  user_id: string;
  kind: GeneratedMediaKind;
  prompt: string;
  model: string;
  plugin_id: string | null;
  image_data: string;
  mime_type: string;
  size: string | null;
  quality: string | null;
  metadata: string | null;
  created_at: number;
}

function toGeneratedMedia(row: GeneratedMediaRow): GeneratedMedia {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    prompt: encryptionService.decrypt(row.prompt),
    model: row.model,
    ...(row.plugin_id ? { pluginId: row.plugin_id } : {}),
    mediaData: encryptionService.decrypt(row.image_data),
    mimeType: row.mime_type,
    ...(row.size ? { size: row.size } : {}),
    ...(row.quality ? { quality: row.quality } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: row.created_at,
  };
}

function inferImageMimeType(imageData: string): string {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,/i.exec(imageData);
  return match?.[1]?.toLowerCase() || 'image/png';
}

export default new GalleryService();
