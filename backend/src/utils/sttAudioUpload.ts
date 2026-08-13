/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { Request, Response } from 'express';
import multer from 'multer';
import type { STTConfig } from '../types/index.js';

export const STT_GLOBAL_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

type STTAudioFormat = 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a' | 'webm';

const MIME_FORMATS: Readonly<Record<string, STTAudioFormat>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mpga': 'mp3',
  'audio/flac': 'flac',
  'audio/x-flac': 'flac',
  'audio/ogg': 'ogg',
  'application/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'video/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/webm': 'webm',
  'video/webm': 'webm',
};

const CANONICAL_MIME: Readonly<Record<STTAudioFormat, string>> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  webm: 'audio/webm',
};

export class STTAudioUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'missing_file'
      | 'empty_file'
      | 'file_too_large'
      | 'unsupported_mime_type'
      | 'signature_mismatch'
  ) {
    super(message);
    this.name = 'STTAudioUploadError';
  }
}

export interface ValidatedSTTAudio {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
  format: STTAudioFormat;
}

const normalizeMime = (value: string): string =>
  value.split(';', 1)[0].trim().toLowerCase();

function configuredFormats(config?: STTConfig): Set<STTAudioFormat> {
  if (!config?.formats?.length) {
    return new Set(Object.values(MIME_FORMATS));
  }
  return new Set(
    config.formats
      .map(value => value.trim().toLowerCase())
      .map(value => (value === 'mp4' ? 'm4a' : value))
      .filter((value): value is STTAudioFormat =>
        ['wav', 'mp3', 'flac', 'ogg', 'm4a', 'webm'].includes(value)
      )
  );
}

function detectFormat(buffer: Buffer): STTAudioFormat | null {
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
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x1a &&
    buffer[1] === 0x45 &&
    buffer[2] === 0xdf &&
    buffer[3] === 0xa3
  ) {
    return 'webm';
  }
  return null;
}

export function validateSTTAudio(
  file: Express.Multer.File | undefined,
  config?: STTConfig
): ValidatedSTTAudio {
  if (!file) {
    throw new STTAudioUploadError(
      'Audio recording is required',
      'missing_file'
    );
  }
  const size = file.buffer.length;
  if (size === 0) {
    throw new STTAudioUploadError(
      'Audio recording cannot be empty',
      'empty_file'
    );
  }
  const configuredMax = config?.max_audio_bytes;
  const maxBytes =
    typeof configuredMax === 'number' &&
    Number.isFinite(configuredMax) &&
    configuredMax > 0
      ? Math.min(Math.floor(configuredMax), STT_GLOBAL_MAX_AUDIO_BYTES)
      : STT_GLOBAL_MAX_AUDIO_BYTES;
  if (size > maxBytes) {
    throw new STTAudioUploadError(
      `Audio recording exceeds the maximum size of ${maxBytes} bytes`,
      'file_too_large'
    );
  }

  const declaredFormat = MIME_FORMATS[normalizeMime(file.mimetype)];
  if (!declaredFormat || !configuredFormats(config).has(declaredFormat)) {
    throw new STTAudioUploadError(
      `Unsupported audio MIME type: ${normalizeMime(file.mimetype) || 'unknown'}`,
      'unsupported_mime_type'
    );
  }
  const detectedFormat = detectFormat(file.buffer);
  if (!detectedFormat || detectedFormat !== declaredFormat) {
    throw new STTAudioUploadError(
      'Audio content does not match its declared MIME type',
      'signature_mismatch'
    );
  }
  return {
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: CANONICAL_MIME[detectedFormat],
    size,
    format: detectedFormat,
  };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: STT_GLOBAL_MAX_AUDIO_BYTES,
    files: 1,
    fields: 4,
    // One audio file plus model, plugin, language, and prompt. Busboy raises
    // LIMIT_PART_COUNT when the configured count is reached, so reserve one
    // boundary above the five accepted parts.
    parts: 6,
    fieldNameSize: 100,
    fieldSize: 8 * 1024,
  },
});

export function parseSTTAudioUpload(
  req: Request,
  res: Response
): Promise<void> {
  return new Promise((resolve, reject) => {
    upload.single('audio')(req, res, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}
