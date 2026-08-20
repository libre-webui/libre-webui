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

/**
 * Image-edit upload validation (IMAGE-01). Every reference image and mask
 * is checked against declared MIME, sniffed magic bytes, and byte ceilings
 * before anything reaches a provider. PNG is the interoperable default —
 * masks must carry an alpha channel, which only PNG guarantees here.
 */

export const IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_EDIT_GLOBAL_MAX_REFERENCE_IMAGES = 4;

export type ImageEditFormat = 'png' | 'jpeg' | 'webp';

const FORMAT_MIME: Record<ImageEditFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export class ImageEditUploadError extends Error {
  constructor(
    readonly code:
      | 'missing_file'
      | 'unsupported_mime_type'
      | 'signature_mismatch'
      | 'file_too_large'
      | 'too_many_images',
    message: string
  ) {
    super(message);
    this.name = 'ImageEditUploadError';
  }
}

export const detectImageEditFormat = (
  buffer: Buffer
): ImageEditFormat | null => {
  if (buffer.length >= 8 && buffer.subarray(0, 4).equals(PNG_MAGIC)) {
    return 'png';
  }
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) {
    return 'jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
};

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

export interface ValidatedImageEditInput {
  buffer: Buffer;
  mimeType: string;
  filename: string;
}

export const validateImageEditUpload = (
  file: { buffer: Buffer; mimetype?: string; size: number },
  options: {
    allowedMimeTypes?: string[];
    maxBytes?: number;
    filename: string;
  }
): ValidatedImageEditInput => {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new ImageEditUploadError('missing_file', 'An image file is required');
  }
  const maxBytes = Math.min(
    options.maxBytes ?? IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES,
    IMAGE_EDIT_GLOBAL_MAX_IMAGE_BYTES
  );
  if (file.buffer.length > maxBytes) {
    throw new ImageEditUploadError(
      'file_too_large',
      `Image inputs are limited to ${maxBytes} bytes`
    );
  }
  const format = detectImageEditFormat(file.buffer);
  if (!format) {
    throw new ImageEditUploadError(
      'signature_mismatch',
      'Image content is not a recognized PNG, JPEG, or WebP file'
    );
  }
  const sniffedMime = FORMAT_MIME[format];
  const declared = file.mimetype?.toLowerCase().split(';')[0]?.trim();
  if (declared && declared !== sniffedMime) {
    throw new ImageEditUploadError(
      'signature_mismatch',
      'Image content does not match its declared MIME type'
    );
  }
  const allowed = (
    options.allowedMimeTypes?.length ? options.allowedMimeTypes : ['image/png']
  ).map(value => value.toLowerCase());
  if (!allowed.includes(sniffedMime)) {
    throw new ImageEditUploadError(
      'unsupported_mime_type',
      `This model accepts only: ${allowed.join(', ')}`
    );
  }
  return {
    buffer: file.buffer,
    mimeType: sniffedMime,
    filename: options.filename,
  };
};
