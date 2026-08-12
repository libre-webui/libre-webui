/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'crypto';
import { getDatabaseSafe } from '../db.js';
import type { TTSConfig } from '../types/index.js';
import {
  type ValidatedTTSVoiceCloneAudio,
  validateTTSVoiceCloneAudio,
} from '../utils/ttsVoiceCloneUpload.js';
import { validatePluginModel } from '../utils/pluginValidation.js';
import { encryptionService } from './encryptionService.js';

const MAX_PROFILES_PER_USER = 50;
const MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER = 100 * 1024 * 1024;
const MAX_PROFILE_NAME_CHARACTERS = 80;
const MAX_REFERENCE_TEXT_CHARACTERS = 32_000;
const PLUGIN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

export interface VoiceProfileMetadata {
  id: string;
  name: string;
  pluginId: string;
  model: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
}

export interface VoiceProfileSecret extends VoiceProfileMetadata {
  routingFingerprint: string;
  referenceAudio: ValidatedTTSVoiceCloneAudio;
  referenceText?: string;
}

export interface CreateVoiceProfileInput {
  name: string;
  pluginId: string;
  model: string;
  routingFingerprint: string;
  referenceAudio: ValidatedTTSVoiceCloneAudio;
  referenceText?: string;
}

interface VoiceProfileRow {
  id: string;
  user_id?: string;
  name: Buffer;
  plugin_id: string;
  model: string;
  routing_fingerprint?: string;
  reference_audio?: Buffer;
  reference_text?: Buffer | null;
  audio_mime_type: string;
  audio_format?: ValidatedTTSVoiceCloneAudio['format'];
  audio_size?: number;
  created_at: number;
  updated_at: number;
}

export class VoiceProfileService {
  validateCreate(userId: string, input: CreateVoiceProfileInput): void {
    const db = this.database();
    const name = this.validateName(input.name);
    this.validatePluginId(input.pluginId);
    validatePluginModel(input.model);
    this.validateRoutingFingerprint(input.routingFingerprint);
    const referenceText = input.referenceText?.trim();
    if (referenceText && referenceText.length > MAX_REFERENCE_TEXT_CHARACTERS) {
      throw new Error(
        `Reference transcript must be at most ${MAX_REFERENCE_TEXT_CHARACTERS} characters`
      );
    }
    const count = db
      .prepare('SELECT COUNT(*) AS count FROM voice_profiles WHERE user_id = ?')
      .get(userId) as { count: number };
    if (count.count >= MAX_PROFILES_PER_USER) {
      throw new Error(
        `A maximum of ${MAX_PROFILES_PER_USER} saved voice profiles is allowed`
      );
    }
    const size = db
      .prepare(
        'SELECT COALESCE(SUM(audio_size), 0) AS total FROM voice_profiles WHERE user_id = ?'
      )
      .get(userId) as { total: number };
    if (
      size.total + input.referenceAudio.size >
      MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER
    ) {
      throw new Error(
        `Saved voice reference audio is limited to ${MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER} bytes per account`
      );
    }
    const duplicate = this.list(userId, {
      pluginId: input.pluginId,
      model: input.model,
    }).some(
      profile => profile.name.toLocaleLowerCase() === name.toLocaleLowerCase()
    );
    if (duplicate) {
      throw new Error(
        'A saved voice with this name already exists for the selected model'
      );
    }
  }

  list(
    userId: string,
    filters: { pluginId?: string; model?: string } = {}
  ): VoiceProfileMetadata[] {
    const db = this.database();
    const conditions = ['user_id = ?'];
    const values: Array<string> = [userId];
    if (filters.pluginId) {
      this.validatePluginId(filters.pluginId);
      conditions.push('plugin_id = ?');
      values.push(filters.pluginId);
    }
    if (filters.model) {
      validatePluginModel(filters.model);
      conditions.push('model = ?');
      values.push(filters.model);
    }

    const rows = db
      .prepare(
        `SELECT id, user_id, name, plugin_id, model, audio_mime_type, created_at, updated_at
         FROM voice_profiles
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, id ASC
         LIMIT ?`
      )
      .all(...values, MAX_PROFILES_PER_USER) as VoiceProfileRow[];
    return rows.map(row => this.metadataFromRow(row));
  }

  get(
    id: string,
    userId: string,
    config?: TTSConfig
  ): VoiceProfileSecret | null {
    const db = this.database();
    const row = db
      .prepare(
        `SELECT id, user_id, name, plugin_id, model, reference_audio, reference_text,
                routing_fingerprint, audio_mime_type, audio_format, audio_size,
                created_at, updated_at
         FROM voice_profiles
         WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) as VoiceProfileRow | undefined;
    if (!row?.reference_audio || !row.audio_format || !row.audio_size) {
      return null;
    }

    const referenceAudio = validateTTSVoiceCloneAudio(
      {
        buffer: encryptionService.decryptBuffer(
          row.reference_audio,
          this.additionalData(row.id, userId, 'audio')
        ),
        originalname: `reference.${row.audio_format}`,
        mimetype: row.audio_mime_type,
        size: row.audio_size,
      },
      config
    );
    if (referenceAudio.size !== row.audio_size) {
      throw new Error('Stored voice profile audio size is invalid');
    }

    const encryptedReferenceText = row.reference_text;
    const referenceText = encryptedReferenceText
      ? encryptionService
          .decryptBuffer(
            encryptedReferenceText,
            this.additionalData(row.id, userId, 'transcript')
          )
          .toString('utf8')
      : undefined;

    return {
      ...this.metadataFromRow(row),
      routingFingerprint: row.routing_fingerprint || '',
      referenceAudio,
      ...(referenceText ? { referenceText } : {}),
    };
  }

  getMetadata(id: string, userId: string): VoiceProfileMetadata | null {
    const db = this.database();
    const row = db
      .prepare(
        `SELECT id, user_id, name, plugin_id, model, audio_mime_type,
                created_at, updated_at
         FROM voice_profiles
         WHERE id = ? AND user_id = ?`
      )
      .get(id, userId) as VoiceProfileRow | undefined;
    return row ? this.metadataFromRow(row) : null;
  }

  create(userId: string, input: CreateVoiceProfileInput): VoiceProfileMetadata {
    const db = this.database();
    const name = this.validateName(input.name);
    this.validatePluginId(input.pluginId);
    validatePluginModel(input.model);
    this.validateRoutingFingerprint(input.routingFingerprint);
    const referenceAudio = validateTTSVoiceCloneAudio(input.referenceAudio);
    const referenceText = input.referenceText?.trim();
    if (referenceText && referenceText.length > MAX_REFERENCE_TEXT_CHARACTERS) {
      throw new Error(
        `Reference transcript must be at most ${MAX_REFERENCE_TEXT_CHARACTERS} characters`
      );
    }

    return db.transaction(() => {
      this.validateCreate(userId, { ...input, name, referenceAudio });

      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO voice_profiles
           (id, user_id, name, plugin_id, model, reference_audio,
            reference_text, routing_fingerprint, audio_mime_type, audio_format,
            audio_size, consent_confirmed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        id,
        userId,
        encryptionService.encryptBuffer(
          Buffer.from(name, 'utf8'),
          this.additionalData(id, userId, 'name')
        ),
        input.pluginId,
        input.model,
        encryptionService.encryptBuffer(
          referenceAudio.buffer,
          this.additionalData(id, userId, 'audio')
        ),
        referenceText
          ? encryptionService.encryptBuffer(
              Buffer.from(referenceText, 'utf8'),
              this.additionalData(id, userId, 'transcript')
            )
          : null,
        input.routingFingerprint,
        referenceAudio.mimetype,
        referenceAudio.format,
        referenceAudio.size,
        now,
        now,
        now
      );

      return {
        id,
        name,
        pluginId: input.pluginId,
        model: input.model,
        mimeType: referenceAudio.mimetype,
        createdAt: now,
        updatedAt: now,
      };
    })();
  }

  delete(id: string, userId: string): boolean {
    const db = this.database();
    return (
      db
        .prepare('DELETE FROM voice_profiles WHERE id = ? AND user_id = ?')
        .run(id, userId).changes > 0
    );
  }

  private metadataFromRow(row: VoiceProfileRow): VoiceProfileMetadata {
    if (!row.user_id) {
      throw new Error('Voice profile owner metadata is missing');
    }
    return {
      id: row.id,
      name: encryptionService
        .decryptBuffer(
          row.name,
          this.additionalData(row.id, row.user_id, 'name')
        )
        .toString('utf8'),
      pluginId: row.plugin_id,
      model: row.model,
      mimeType: row.audio_mime_type,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private validateName(value: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error('Voice profile name is required');
    }
    const name = value.trim();
    if (name.length > MAX_PROFILE_NAME_CHARACTERS) {
      throw new Error(
        `Voice profile name must be at most ${MAX_PROFILE_NAME_CHARACTERS} characters`
      );
    }
    if (/\p{C}/u.test(name)) {
      throw new Error('Voice profile name contains unsupported characters');
    }
    return name;
  }

  private validatePluginId(value: string): void {
    if (!PLUGIN_ID_PATTERN.test(value)) {
      throw new Error('Invalid TTS plugin ID');
    }
  }

  private validateRoutingFingerprint(value: string): void {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new Error('Invalid voice profile routing fingerprint');
    }
  }

  private additionalData(
    id: string,
    userId: string,
    field: 'name' | 'audio' | 'transcript'
  ): Buffer {
    return Buffer.from(`voice-profile:${id}:${userId}:${field}`, 'utf8');
  }

  private database() {
    const db = getDatabaseSafe();
    if (!db) throw new Error('Database is not available');
    return db;
  }
}

export default new VoiceProfileService();
