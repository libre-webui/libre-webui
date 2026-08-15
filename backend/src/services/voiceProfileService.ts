/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { randomUUID } from 'crypto';
import { getPersistence } from '../persistence/index.js';
import type { StoredVoiceProfile } from '../persistence/extensionTypes.js';
import { VoiceProfileLimitError } from '../persistence/extensionTypes.js';
import { createVoiceProfileNameLookup } from '../persistence/voiceProfileNameLookup.js';
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

export class VoiceProfileService {
  async validateCreate(
    userId: string,
    input: CreateVoiceProfileInput
  ): Promise<void> {
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
    const profiles = await this.repository().list(
      userId,
      {},
      MAX_PROFILES_PER_USER
    );
    if (profiles.length >= MAX_PROFILES_PER_USER) {
      throw new Error(
        `A maximum of ${MAX_PROFILES_PER_USER} saved voice profiles is allowed`
      );
    }
    const totalAudioBytes = profiles.reduce(
      (total, profile) => total + profile.audio_size,
      0
    );
    if (
      totalAudioBytes + input.referenceAudio.size >
      MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER
    ) {
      throw new Error(
        `Saved voice reference audio is limited to ${MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER} bytes per account`
      );
    }
    const nameLookup = createVoiceProfileNameLookup(encryptionService, name);
    const duplicate = profiles.some(
      profile =>
        profile.plugin_id === input.pluginId &&
        profile.model === input.model &&
        profile.name_lookup === nameLookup
    );
    if (duplicate) {
      throw new Error(
        'A saved voice with this name already exists for the selected model'
      );
    }
  }

  async list(
    userId: string,
    filters: { pluginId?: string; model?: string } = {}
  ): Promise<VoiceProfileMetadata[]> {
    if (filters.pluginId) {
      this.validatePluginId(filters.pluginId);
    }
    if (filters.model) {
      validatePluginModel(filters.model);
    }
    const rows = await this.repository().list(
      userId,
      filters,
      MAX_PROFILES_PER_USER
    );
    return rows.map(row => this.metadataFromRow(row));
  }

  async get(
    id: string,
    userId: string,
    config?: TTSConfig
  ): Promise<VoiceProfileSecret | null> {
    const row = await this.repository().find(id, userId);
    if (!row) {
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
      routingFingerprint: row.routing_fingerprint,
      referenceAudio,
      ...(referenceText ? { referenceText } : {}),
    };
  }

  async getMetadata(
    id: string,
    userId: string
  ): Promise<VoiceProfileMetadata | null> {
    const row = await this.repository().find(id, userId);
    return row ? this.metadataFromRow(row) : null;
  }

  async create(
    userId: string,
    input: CreateVoiceProfileInput
  ): Promise<VoiceProfileMetadata> {
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

    const id = randomUUID();
    const now = Date.now();
    const profile: StoredVoiceProfile = {
      id,
      user_id: userId,
      name: encryptionService.encryptBuffer(
        Buffer.from(name, 'utf8'),
        this.additionalData(id, userId, 'name')
      ),
      name_lookup: createVoiceProfileNameLookup(encryptionService, name),
      plugin_id: input.pluginId,
      model: input.model,
      reference_audio: encryptionService.encryptBuffer(
        referenceAudio.buffer,
        this.additionalData(id, userId, 'audio')
      ),
      reference_text: referenceText
        ? encryptionService.encryptBuffer(
            Buffer.from(referenceText, 'utf8'),
            this.additionalData(id, userId, 'transcript')
          )
        : null,
      routing_fingerprint: input.routingFingerprint,
      audio_mime_type: referenceAudio.mimetype,
      audio_format: referenceAudio.format,
      audio_size: referenceAudio.size,
      consent_confirmed_at: now,
      created_at: now,
      updated_at: now,
    };
    try {
      await this.repository().insertWithLimits(profile, {
        maximumProfiles: MAX_PROFILES_PER_USER,
        maximumTotalAudioBytes: MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER,
        additionalAudioBytes: referenceAudio.size,
      });
    } catch (error) {
      if (error instanceof VoiceProfileLimitError) {
        if (error.kind === 'count') {
          throw new Error(
            `A maximum of ${MAX_PROFILES_PER_USER} saved voice profiles is allowed`
          );
        }
        if (error.kind === 'bytes') {
          throw new Error(
            `Saved voice reference audio is limited to ${MAX_TOTAL_REFERENCE_AUDIO_BYTES_PER_USER} bytes per account`
          );
        }
        throw new Error(
          'A saved voice with this name already exists for the selected model'
        );
      }
      throw error;
    }
    return {
      id,
      name,
      pluginId: input.pluginId,
      model: input.model,
      mimeType: referenceAudio.mimetype,
      createdAt: now,
      updatedAt: now,
    };
  }

  delete(id: string, userId: string): Promise<boolean> {
    return this.repository().delete(id, userId);
  }

  private metadataFromRow(row: StoredVoiceProfile): VoiceProfileMetadata {
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

  private repository() {
    return getPersistence(encryptionService).repositories.extensions
      .voiceProfiles;
  }
}

export default new VoiceProfileService();
