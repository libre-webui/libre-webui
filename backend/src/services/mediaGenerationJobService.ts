/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'crypto';
import { getDatabaseSafe } from '../db.js';
import { encryptionService } from './encryptionService.js';

export interface MediaGenerationJob {
  id: string;
  userId: string;
  providerJobId: string;
  pluginId: string;
  model: string;
  prompt: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  options: Record<string, unknown>;
  galleryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

type JobRow = {
  id: string;
  user_id: string;
  provider_job_id: string;
  plugin_id: string;
  model: string;
  prompt: string;
  status: MediaGenerationJob['status'];
  options_json: string | null;
  gallery_id: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
};

class MediaGenerationJobService {
  create(
    userId: string,
    input: Omit<
      MediaGenerationJob,
      'id' | 'userId' | 'status' | 'createdAt' | 'updatedAt'
    >
  ): MediaGenerationJob {
    const db = getDatabaseSafe();
    if (!db) throw new Error('Database is not available');
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `DELETE FROM media_generation_jobs
       WHERE status IN ('completed', 'failed') AND updated_at < ?`
    ).run(now - 30 * 24 * 60 * 60 * 1000);
    db.prepare(
      `INSERT INTO media_generation_jobs
         (id, user_id, provider_job_id, plugin_id, model, prompt, status,
          options_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
    ).run(
      id,
      userId,
      input.providerJobId,
      input.pluginId,
      input.model,
      encryptionService.encrypt(input.prompt),
      JSON.stringify(input.options || {}),
      now,
      now
    );
    return {
      id,
      userId,
      providerJobId: input.providerJobId,
      pluginId: input.pluginId,
      model: input.model,
      prompt: input.prompt,
      status: 'pending',
      options: input.options || {},
      createdAt: now,
      updatedAt: now,
    };
  }

  get(id: string, userId: string): MediaGenerationJob | null {
    const db = getDatabaseSafe();
    if (!db) return null;
    const row = db
      .prepare(
        `SELECT * FROM media_generation_jobs WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) as JobRow | undefined;
    return row ? fromRow(row) : null;
  }

  list(
    userId: string,
    options: { limit?: number; activeOnly?: boolean } = {}
  ): MediaGenerationJob[] {
    const db = getDatabaseSafe();
    if (!db) return [];
    const limit = Math.min(Math.max(options.limit ?? 20, 1), 100);
    const rows = db
      .prepare(
        `SELECT * FROM media_generation_jobs
         WHERE user_id = ?
           ${options.activeOnly ? "AND status IN ('pending', 'in_progress')" : ''}
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`
      )
      .all(userId, limit) as JobRow[];
    return rows.map(fromRow);
  }

  remove(id: string, userId: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;
    return (
      db
        .prepare(
          'DELETE FROM media_generation_jobs WHERE id = ? AND user_id = ?'
        )
        .run(id, userId).changes > 0
    );
  }

  update(
    id: string,
    userId: string,
    status: MediaGenerationJob['status'],
    fields: { galleryId?: string; error?: string } = {}
  ): void {
    const db = getDatabaseSafe();
    if (!db) throw new Error('Database is not available');
    db.prepare(
      `UPDATE media_generation_jobs
       SET status = ?, gallery_id = COALESCE(?, gallery_id),
           error = COALESCE(?, error), updated_at = ?
       WHERE id = ? AND user_id = ?`
    ).run(
      status,
      fields.galleryId || null,
      fields.error || null,
      Date.now(),
      id,
      userId
    );
  }
}

function fromRow(row: JobRow): MediaGenerationJob {
  let options: Record<string, unknown> = {};
  try {
    const parsed = row.options_json ? JSON.parse(row.options_json) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      options = parsed;
    }
  } catch {
    options = {};
  }
  return {
    id: row.id,
    userId: row.user_id,
    providerJobId: row.provider_job_id,
    pluginId: row.plugin_id,
    model: row.model,
    prompt: encryptionService.decrypt(row.prompt),
    status: row.status,
    options,
    ...(row.gallery_id ? { galleryId: row.gallery_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export default new MediaGenerationJobService();
