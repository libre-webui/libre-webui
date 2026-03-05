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
import { GeneratedImage } from '../types/index.js';
import { encryptionService } from './encryptionService.js';

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

class GalleryService {
  async saveImage(
    userId: string,
    params: SaveImageParams
  ): Promise<GeneratedImage | null> {
    const db = getDatabaseSafe();
    if (!db) {
      console.error('Database not available for saving image');
      return null;
    }

    try {
      const id = uuidv4();
      const createdAt = Date.now();
      const encryptedImageData = encryptionService.encrypt(params.imageData);
      const encryptedPrompt = encryptionService.encrypt(params.prompt);

      await db.run(
        `INSERT INTO generated_images (id, user_id, prompt, model, image_data, size, quality, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        encryptedPrompt,
        params.model,
        encryptedImageData,
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
      console.error('Error saving image to gallery:', error);
      return null;
    }
  }

  async getImages(
    userId: string,
    params: GetImagesParams = {}
  ): Promise<GetImagesResult> {
    const db = getDatabaseSafe();
    if (!db) return { images: [], total: 0 };

    try {
      const limit = params.limit || 20;
      const offset = params.offset || 0;

      const countResult = await db.get<{ total: number }>(
        'SELECT COUNT(*) as total FROM generated_images WHERE user_id = ?',
        userId
      );

      const rows = await db.all<{
        id: string;
        user_id: string;
        prompt: string;
        model: string;
        image_data: string;
        size: string | null;
        quality: string | null;
        created_at: number;
      }>(
        `SELECT id, user_id, prompt, model, image_data, size, quality, created_at
         FROM generated_images WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        userId,
        limit,
        offset
      );

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

      return { images, total: countResult?.total ?? 0 };
    } catch (error) {
      console.error('Error getting images from gallery:', error);
      return { images: [], total: 0 };
    }
  }

  async getImage(
    imageId: string,
    userId: string
  ): Promise<GeneratedImage | null> {
    const db = getDatabaseSafe();
    if (!db) return null;

    try {
      const row = await db.get<{
        id: string;
        user_id: string;
        prompt: string;
        model: string;
        image_data: string;
        size: string | null;
        quality: string | null;
        created_at: number;
      }>(
        `SELECT id, user_id, prompt, model, image_data, size, quality, created_at
         FROM generated_images WHERE id = ? AND user_id = ?`,
        imageId,
        userId
      );
      if (!row) return null;

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
      console.error('Error getting image from gallery:', error);
      return null;
    }
  }

  async deleteImage(imageId: string, userId: string): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      const result = await db.run(
        'DELETE FROM generated_images WHERE id = ? AND user_id = ?',
        imageId,
        userId
      );
      return result.changes > 0;
    } catch (error) {
      console.error('Error deleting image from gallery:', error);
      return false;
    }
  }

  async deleteAllImages(userId: string): Promise<boolean> {
    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      await db.run('DELETE FROM generated_images WHERE user_id = ?', userId);
      return true;
    } catch (error) {
      console.error('Error deleting all images from gallery:', error);
      return false;
    }
  }
}

export default new GalleryService();
