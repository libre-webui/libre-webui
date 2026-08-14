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

import type { Request, Response } from 'express';
import multer from 'multer';
import {
  acquireSharedCapacity,
  SharedCapacityExceededError,
  type SharedCapacityReservation,
} from '../platform/coordination/sharedAdmission.js';
import type { TTSConfig } from '../types/index.js';

export const TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES = 10 * 1024 * 1024;
export const TTS_VOICE_CLONE_MAX_ACTIVE_PER_USER = 6;
export const TTS_VOICE_CLONE_MAX_ACTIVE_GLOBAL = 16;

export class TTSVoiceCloneConcurrencyError extends Error {
  constructor() {
    super('Too many concurrent voice-cloning requests');
    this.name = 'TTSVoiceCloneConcurrencyError';
  }
}

export async function reserveTTSVoiceCloneUpload(
  userId: string
): Promise<SharedCapacityReservation> {
  try {
    return await acquireSharedCapacity({
      limits: [
        {
          scope: 'voice-clone-upload.global',
          capacity: TTS_VOICE_CLONE_MAX_ACTIVE_GLOBAL,
        },
        {
          scope: 'voice-clone-upload.user',
          subject: userId,
          capacity: TTS_VOICE_CLONE_MAX_ACTIVE_PER_USER,
        },
      ],
    });
  } catch (error) {
    if (error instanceof SharedCapacityExceededError) {
      throw new TTSVoiceCloneConcurrencyError();
    }
    throw error;
  }
}

export const TTS_VOICE_CLONE_DEFAULT_AUDIO_MIME_TYPES = [
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/vnd.wave',
  'audio/mpeg',
  'audio/mp3',
  'audio/flac',
  'audio/x-flac',
  'audio/ogg',
  'application/ogg',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
] as const;

export interface TTSVoiceCloneAudioFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size?: number;
}

export interface ValidatedTTSVoiceCloneAudio {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a';
  size: number;
}

export type TTSVoiceCloneUploadErrorCode =
  | 'missing_file'
  | 'file_too_large'
  | 'unsupported_mime_type'
  | 'signature_mismatch';

export class TTSVoiceCloneUploadError extends Error {
  constructor(
    message: string,
    readonly code: TTSVoiceCloneUploadErrorCode
  ) {
    super(message);
    this.name = 'TTSVoiceCloneUploadError';
  }
}

const normalizeMimeType = (mimeType: string): string =>
  mimeType.split(';', 1)[0].trim().toLowerCase();

const canonicalFormatForMimeType = (
  mimeType: string
): ValidatedTTSVoiceCloneAudio['format'] | null => {
  switch (normalizeMimeType(mimeType)) {
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
    case 'audio/vnd.wave':
      return 'wav';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/flac':
    case 'audio/x-flac':
      return 'flac';
    case 'audio/ogg':
    case 'application/ogg':
      return 'ogg';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    default:
      return null;
  }
};

const canonicalMimeTypeForFormat = (
  format: ValidatedTTSVoiceCloneAudio['format']
): string =>
  ({
    wav: 'audio/wav',
    mp3: 'audio/mpeg',
    flac: 'audio/flac',
    ogg: 'audio/ogg',
    m4a: 'audio/mp4',
  })[format];

const detectAudioFormat = (
  buffer: Buffer
): ValidatedTTSVoiceCloneAudio['format'] | null => {
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return 'wav';
  }
  if (
    buffer.length >= 3 &&
    (buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  ) {
    return 'mp3';
  }
  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === 'fLaC'
  ) {
    return 'flac';
  }
  if (
    buffer.length >= 4 &&
    buffer.subarray(0, 4).toString('ascii') === 'OggS'
  ) {
    return 'ogg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(4, 8).toString('ascii') === 'ftyp'
  ) {
    return 'm4a';
  }
  return null;
};

export function getTTSVoiceCloneMaxAudioBytes(config?: TTSConfig): number {
  const configuredLimit = config?.clone_max_audio_bytes;
  if (
    typeof configuredLimit !== 'number' ||
    !Number.isFinite(configuredLimit) ||
    configuredLimit <= 0
  ) {
    return TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES;
  }
  return Math.min(
    Math.floor(configuredLimit),
    TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES
  );
}

export function validateTTSVoiceCloneAudio(
  file: TTSVoiceCloneAudioFile | undefined,
  config?: TTSConfig
): ValidatedTTSVoiceCloneAudio {
  if (!file) {
    throw new TTSVoiceCloneUploadError(
      'Reference audio is required',
      'missing_file'
    );
  }

  const size = file.buffer.length;
  const maxBytes = getTTSVoiceCloneMaxAudioBytes(config);
  if (size === 0) {
    throw new TTSVoiceCloneUploadError(
      'Reference audio cannot be empty',
      'signature_mismatch'
    );
  }
  if (size > maxBytes) {
    throw new TTSVoiceCloneUploadError(
      `Reference audio exceeds the maximum size of ${maxBytes} bytes`,
      'file_too_large'
    );
  }

  const mimeType = normalizeMimeType(file.mimetype);
  const configuredMimeTypes = config?.clone_audio_mime_types?.length
    ? config.clone_audio_mime_types.map(normalizeMimeType)
    : [...TTS_VOICE_CLONE_DEFAULT_AUDIO_MIME_TYPES];
  const declaredFormat = canonicalFormatForMimeType(mimeType);
  const configuredFormats = new Set(
    configuredMimeTypes
      .map(canonicalFormatForMimeType)
      .filter(
        (format): format is ValidatedTTSVoiceCloneAudio['format'] =>
          format !== null
      )
  );
  if (!declaredFormat || !configuredFormats.has(declaredFormat)) {
    throw new TTSVoiceCloneUploadError(
      `Unsupported reference audio MIME type: ${mimeType || 'unknown'}`,
      'unsupported_mime_type'
    );
  }

  const detectedFormat = detectAudioFormat(file.buffer);
  if (!detectedFormat || detectedFormat !== declaredFormat) {
    throw new TTSVoiceCloneUploadError(
      'Reference audio content does not match its declared MIME type',
      'signature_mismatch'
    );
  }

  return {
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: canonicalMimeTypeForFormat(detectedFormat),
    format: detectedFormat,
    size,
  };
}

const voiceCloneUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: TTS_VOICE_CLONE_GLOBAL_MAX_AUDIO_BYTES,
    files: 1,
    fields: 8,
    parts: 9,
    fieldNameSize: 100,
    fieldSize: 128 * 1024,
  },
});

/** Parse one in-memory `reference_audio` file without persisting it. */
export function parseTTSVoiceCloneUpload(
  req: Request,
  res: Response,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let settled = false;
    const finish = (error?: unknown): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abortUpload);
      if (error) reject(error);
      else resolve();
    };
    const abortUpload = (): void => {
      const reason =
        signal?.reason instanceof Error
          ? signal.reason
          : new Error('Voice-clone upload admission was lost');
      // Reject before waiting for a slow sender to finish. Multer receives the
      // request error in the same turn and destroys its partial Busboy upload;
      // the settled guard ignores Multer's later callback.
      finish(reason);
      if (!req.destroyed) req.emit('error', reason);
    };
    voiceCloneUpload.single('reference_audio')(req, res, error => {
      finish(error);
    });
    if (!settled) {
      signal?.addEventListener('abort', abortUpload, { once: true });
      if (signal?.aborted) abortUpload();
    }
  });
}
