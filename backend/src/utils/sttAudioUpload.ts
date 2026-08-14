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
export const STT_GLOBAL_MAX_DURATION_SECONDS = 5 * 60;

type STTAudioFormat = 'wav' | 'webm';

const MIME_FORMATS: Readonly<Record<string, STTAudioFormat>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/webm': 'webm',
  'video/webm': 'webm',
};

const CANONICAL_MIME: Readonly<Record<STTAudioFormat, string>> = {
  wav: 'audio/wav',
  webm: 'audio/webm',
};

const FORMAT_EXTENSIONS: Readonly<Record<STTAudioFormat, readonly string[]>> = {
  wav: ['wav', 'wave'],
  webm: ['webm'],
};

const MAX_DECODED_AUDIO_BYTES = 256 * 1024 * 1024;
const MAX_DECOMPRESSION_RATIO = 1000;

export class STTAudioUploadError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'missing_file'
      | 'empty_file'
      | 'file_too_large'
      | 'unsupported_mime_type'
      | 'signature_mismatch'
      | 'extension_mismatch'
      | 'invalid_audio_structure'
      | 'duration_exceeded'
      | 'unsafe_audio'
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
  codec: 'pcm' | 'opus';
  durationSeconds: number;
  sampleRate: number;
  channels: number;
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
      .filter((value): value is STTAudioFormat =>
        ['wav', 'webm'].includes(value)
      )
  );
}

interface AudioMetadata {
  codec: 'pcm' | 'opus';
  durationSeconds: number;
  sampleRate: number;
  channels: number;
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

function invalidAudio(message: string): never {
  throw new STTAudioUploadError(message, 'invalid_audio_structure');
}

function parseWavMetadata(buffer: Buffer): AudioMetadata {
  if (buffer.length < 44) invalidAudio('WAV audio is truncated');
  const riffLength = buffer.readUInt32LE(4) + 8;
  if (riffLength !== buffer.length || riffLength < 44) {
    invalidAudio('WAV container length is invalid');
  }

  let offset = 12;
  let formatTag: number | undefined;
  let channels: number | undefined;
  let sampleRate: number | undefined;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let bitsPerSample: number | undefined;
  let dataBytes: number | undefined;
  let formatChunks = 0;
  let dataChunks = 0;
  let chunks = 0;

  while (offset + 8 <= riffLength) {
    chunks += 1;
    if (chunks > 10_000) invalidAudio('WAV contains too many chunks');
    const id = buffer.subarray(offset, offset + 4).toString('ascii');
    const size = buffer.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    if (dataEnd > riffLength) invalidAudio('WAV chunk exceeds its container');

    if (id === 'fmt ') {
      formatChunks += 1;
      if (formatChunks > 1)
        invalidAudio('WAV contains duplicate format chunks');
      if (size < 16) invalidAudio('WAV format chunk is incomplete');
      formatTag = buffer.readUInt16LE(dataStart);
      channels = buffer.readUInt16LE(dataStart + 2);
      sampleRate = buffer.readUInt32LE(dataStart + 4);
      byteRate = buffer.readUInt32LE(dataStart + 8);
      blockAlign = buffer.readUInt16LE(dataStart + 12);
      bitsPerSample = buffer.readUInt16LE(dataStart + 14);
    } else if (id === 'data') {
      dataChunks += 1;
      if (dataChunks > 1) invalidAudio('WAV contains duplicate audio chunks');
      dataBytes = size;
    }
    const nextOffset = dataEnd + (size % 2);
    if (nextOffset > riffLength) invalidAudio('WAV chunk padding is missing');
    offset = nextOffset;
  }

  if (
    formatTag === undefined ||
    channels === undefined ||
    sampleRate === undefined ||
    byteRate === undefined ||
    blockAlign === undefined ||
    bitsPerSample === undefined ||
    dataBytes === undefined
  ) {
    invalidAudio('WAV requires format and audio data chunks');
  }
  if (formatTag !== 1 || ![8, 16, 24, 32].includes(bitsPerSample)) {
    invalidAudio('WAV must contain uncompressed PCM audio');
  }
  if (channels < 1 || channels > 2) {
    invalidAudio('Audio must contain one or two channels');
  }
  if (sampleRate < 8_000 || sampleRate > 96_000) {
    invalidAudio('Audio sample rate must be between 8 kHz and 96 kHz');
  }
  const expectedBlockAlign = channels * Math.ceil(bitsPerSample / 8);
  if (
    blockAlign !== expectedBlockAlign ||
    byteRate !== sampleRate * blockAlign ||
    dataBytes === 0 ||
    dataBytes % blockAlign !== 0
  ) {
    invalidAudio('WAV PCM layout is inconsistent');
  }
  return {
    codec: 'pcm',
    durationSeconds: dataBytes / byteRate,
    sampleRate,
    channels,
  };
}

interface EbmlVint {
  length: number;
  value: number;
  unknown: boolean;
}

interface EbmlElement {
  id: number;
  dataStart: number;
  dataEnd: number;
  next: number;
}

function readEbmlVint(
  buffer: Buffer,
  offset: number,
  stripMarker: boolean
): EbmlVint {
  if (offset >= buffer.length) invalidAudio('WebM element is truncated');
  const first = buffer[offset];
  let length = 1;
  let marker = 0x80;
  while (length <= 8 && (first & marker) === 0) {
    length += 1;
    marker >>= 1;
  }
  if (length > 8 || offset + length > buffer.length) {
    invalidAudio('WebM variable-length integer is invalid');
  }
  if (!stripMarker && length > 4) invalidAudio('WebM element ID is invalid');

  let value = BigInt(stripMarker ? first & (marker - 1) : first);
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(buffer[offset + index]);
  }
  const unknownValue = stripMarker ? (1n << BigInt(length * 7)) - 1n : -1n;
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidAudio('WebM element size is unsafe');
  }
  return {
    length,
    value: Number(value),
    unknown: stripMarker && value === unknownValue,
  };
}

function readEbmlElement(
  buffer: Buffer,
  offset: number,
  containerEnd: number
): EbmlElement {
  const id = readEbmlVint(buffer, offset, false);
  const size = readEbmlVint(buffer, offset + id.length, true);
  const dataStart = offset + id.length + size.length;
  const dataEnd = size.unknown ? containerEnd : dataStart + size.value;
  if (
    dataStart > containerEnd ||
    dataEnd > containerEnd ||
    dataEnd < dataStart
  ) {
    invalidAudio('WebM element exceeds its container');
  }
  return { id: id.value, dataStart, dataEnd, next: dataEnd };
}

function walkEbmlElements(
  buffer: Buffer,
  start: number,
  end: number,
  visit: (element: EbmlElement) => void
): void {
  let offset = start;
  let count = 0;
  while (offset < end) {
    count += 1;
    if (count > 100_000) invalidAudio('WebM contains too many elements');
    const element = readEbmlElement(buffer, offset, end);
    visit(element);
    if (element.next <= offset) invalidAudio('WebM element made no progress');
    offset = element.next;
  }
}

function readEbmlUnsigned(buffer: Buffer, element: EbmlElement): number {
  const length = element.dataEnd - element.dataStart;
  if (length < 1 || length > 8) invalidAudio('WebM integer is invalid');
  let value = 0n;
  for (let offset = element.dataStart; offset < element.dataEnd; offset += 1) {
    value = (value << 8n) | BigInt(buffer[offset]);
  }
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    invalidAudio('WebM integer is unsafe');
  }
  return Number(value);
}

function readEbmlFloat(buffer: Buffer, element: EbmlElement): number {
  const length = element.dataEnd - element.dataStart;
  if (length === 4) return buffer.readFloatBE(element.dataStart);
  if (length === 8) return buffer.readDoubleBE(element.dataStart);
  invalidAudio('WebM floating-point value is invalid');
}

function parseWebmMetadata(buffer: Buffer): AudioMetadata {
  if (buffer.length < 64) invalidAudio('WebM audio is truncated');
  const header = readEbmlElement(buffer, 0, buffer.length);
  if (header.id !== 0x1a45dfa3) invalidAudio('WebM EBML header is missing');
  let documentType = '';
  walkEbmlElements(buffer, header.dataStart, header.dataEnd, element => {
    if (element.id === 0x4282) {
      documentType = buffer
        .subarray(element.dataStart, element.dataEnd)
        .toString('ascii');
    }
  });
  if (documentType !== 'webm') invalidAudio('EBML document is not WebM');

  let segment: EbmlElement | undefined;
  walkEbmlElements(buffer, header.next, buffer.length, element => {
    if (!segment && element.id === 0x18538067) segment = element;
  });
  if (!segment) invalidAudio('WebM segment is missing');

  let timecodeScale = 1_000_000;
  let declaredDurationTicks = 0;
  let sampleRate = 0;
  let channels = 0;
  const opusTrackNumbers = new Set<number>();
  let trackEntries = 0;
  let maxBlockTicks = 0;
  let blocks = 0;
  const pendingBlocks: Array<{
    element: EbmlElement;
    clusterTicks: number;
  }> = [];

  const parseInfo = (container: EbmlElement) => {
    walkEbmlElements(
      buffer,
      container.dataStart,
      container.dataEnd,
      element => {
        if (element.id === 0x2ad7b1)
          timecodeScale = readEbmlUnsigned(buffer, element);
        if (element.id === 0x4489) {
          declaredDurationTicks = readEbmlFloat(buffer, element);
        }
      }
    );
  };
  const parseTrack = (container: EbmlElement) => {
    trackEntries += 1;
    let trackNumber = 0;
    let trackType = 0;
    let codecId = '';
    let codecPrivate: Buffer | undefined;
    let trackSampleRate = 0;
    let trackChannels = 0;
    walkEbmlElements(
      buffer,
      container.dataStart,
      container.dataEnd,
      element => {
        if (element.id === 0xd7)
          trackNumber = readEbmlUnsigned(buffer, element);
        if (element.id === 0x83) trackType = readEbmlUnsigned(buffer, element);
        if (element.id === 0x86) {
          codecId = buffer
            .subarray(element.dataStart, element.dataEnd)
            .toString('ascii');
        }
        if (element.id === 0x63a2) {
          codecPrivate = buffer.subarray(element.dataStart, element.dataEnd);
        }
        if (element.id === 0xe1) {
          walkEbmlElements(
            buffer,
            element.dataStart,
            element.dataEnd,
            audio => {
              if (audio.id === 0xb5) {
                trackSampleRate = readEbmlFloat(buffer, audio);
              }
              if (audio.id === 0x9f) {
                trackChannels = readEbmlUnsigned(buffer, audio);
              }
            }
          );
        }
      }
    );
    if (
      Number.isSafeInteger(trackNumber) &&
      trackNumber > 0 &&
      trackType === 2 &&
      codecId === 'A_OPUS' &&
      codecPrivate !== undefined &&
      codecPrivate.length >= 19 &&
      codecPrivate.subarray(0, 8).toString('ascii') === 'OpusHead' &&
      codecPrivate[8] <= 15 &&
      codecPrivate[9] === trackChannels &&
      codecPrivate[18] === 0
    ) {
      opusTrackNumbers.add(trackNumber);
      sampleRate = trackSampleRate;
      channels = trackChannels;
    }
  };
  const parseBlock = (element: EbmlElement, clusterTicks: number) => {
    const track = readEbmlVint(buffer, element.dataStart, true);
    if (!opusTrackNumbers.has(track.value)) return;
    const timecodeOffset = element.dataStart + track.length;
    if (timecodeOffset + 3 > element.dataEnd) {
      invalidAudio('WebM audio block is truncated');
    }
    const relativeTicks = buffer.readInt16BE(timecodeOffset);
    const flags = buffer[timecodeOffset + 2];
    const lacing = (flags >> 1) & 0x03;
    if (lacing !== 0) {
      invalidAudio('WebM audio blocks must not use lacing');
    }
    if (element.dataEnd <= timecodeOffset + 3) {
      invalidAudio('WebM audio block contains no Opus packet');
    }
    maxBlockTicks = Math.max(maxBlockTicks, clusterTicks + relativeTicks);
    blocks += 1;
  };
  const parseCluster = (container: EbmlElement) => {
    let clusterTicks = 0;
    const clusterBlocks: EbmlElement[] = [];
    walkEbmlElements(
      buffer,
      container.dataStart,
      container.dataEnd,
      element => {
        if (element.id === 0xe7)
          clusterTicks = readEbmlUnsigned(buffer, element);
        if (element.id === 0xa3) clusterBlocks.push(element);
        if (element.id === 0xa0) {
          walkEbmlElements(
            buffer,
            element.dataStart,
            element.dataEnd,
            child => {
              if (child.id === 0xa1) clusterBlocks.push(child);
            }
          );
        }
      }
    );
    for (const element of clusterBlocks) {
      pendingBlocks.push({ element, clusterTicks });
    }
  };

  walkEbmlElements(buffer, segment.dataStart, segment.dataEnd, element => {
    if (element.id === 0x1549a966) parseInfo(element);
    if (element.id === 0x1654ae6b) {
      walkEbmlElements(buffer, element.dataStart, element.dataEnd, track => {
        if (track.id === 0xae) parseTrack(track);
      });
    }
    if (element.id === 0x1f43b675) parseCluster(element);
  });

  if (trackEntries !== 1 || opusTrackNumbers.size !== 1) {
    invalidAudio('WebM must contain exactly one Opus audio track');
  }
  for (const block of pendingBlocks) {
    parseBlock(block.element, block.clusterTicks);
  }
  if (
    !Number.isFinite(sampleRate) ||
    sampleRate < 8_000 ||
    sampleRate > 96_000
  ) {
    invalidAudio('Audio sample rate must be between 8 kHz and 96 kHz');
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    invalidAudio('Audio must contain one or two channels');
  }
  if (blocks === 0 || timecodeScale < 1 || timecodeScale > 1_000_000_000) {
    invalidAudio('WebM contains no usable audio frames');
  }
  const declaredSeconds = (declaredDurationTicks * timecodeScale) / 1e9;
  // MediaRecorder often omits Segment Duration. The final Opus packet is at
  // most 120 ms, so include that packet in the conservative duration estimate.
  const blockSeconds = (maxBlockTicks * timecodeScale) / 1e9 + 0.12;
  const durationSeconds = Math.max(declaredSeconds, blockSeconds);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    invalidAudio('WebM duration is invalid');
  }
  return { codec: 'opus', durationSeconds, sampleRate, channels };
}

function validateAudioBounds(
  metadata: AudioMetadata,
  compressedBytes: number,
  config?: STTConfig
): void {
  const configuredDuration = config?.max_duration_seconds;
  const maxDuration =
    typeof configuredDuration === 'number' &&
    Number.isFinite(configuredDuration) &&
    configuredDuration > 0
      ? Math.min(configuredDuration, STT_GLOBAL_MAX_DURATION_SECONDS)
      : STT_GLOBAL_MAX_DURATION_SECONDS;
  if (metadata.durationSeconds > maxDuration) {
    throw new STTAudioUploadError(
      `Audio recording exceeds the maximum duration of ${maxDuration} seconds`,
      'duration_exceeded'
    );
  }
  const decodedBytes =
    metadata.durationSeconds * metadata.sampleRate * metadata.channels * 2;
  if (
    decodedBytes > MAX_DECODED_AUDIO_BYTES ||
    decodedBytes / compressedBytes > MAX_DECOMPRESSION_RATIO
  ) {
    throw new STTAudioUploadError(
      'Audio recording expands beyond safe processing limits',
      'unsafe_audio'
    );
  }
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
  const filename = file.originalname.trim().toLowerCase();
  const extension = filename.includes('.') ? filename.split('.').pop() : '';
  if (!extension || !FORMAT_EXTENSIONS[detectedFormat].includes(extension)) {
    throw new STTAudioUploadError(
      'Audio filename extension does not match its content',
      'extension_mismatch'
    );
  }

  const metadata =
    detectedFormat === 'wav'
      ? parseWavMetadata(file.buffer)
      : parseWebmMetadata(file.buffer);
  validateAudioBounds(metadata, size, config);
  return {
    buffer: file.buffer,
    originalname: file.originalname,
    mimetype: CANONICAL_MIME[detectedFormat],
    size,
    format: detectedFormat,
    ...metadata,
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
          : new Error('Speech-to-text upload admission was lost');
      // Reject immediately so the route can fail closed without waiting for a
      // slow sender to finish. Multer still receives the request error in the
      // same turn, which unpipes and destroys Busboy and discards its partial
      // in-memory file. Its later callback is ignored by the settled guard.
      finish(reason);
      if (!req.destroyed) req.emit('error', reason);
    };
    upload.single('audio')(req, res, error => {
      finish(error);
    });
    if (!settled) {
      signal?.addEventListener('abort', abortUpload, { once: true });
      if (signal?.aborted) abortUpload();
    }
  });
}
