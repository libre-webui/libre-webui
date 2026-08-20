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

import { inflateRawSync } from 'node:zlib';

/**
 * Minimal read-only ZIP archive parser for OOXML document extraction.
 *
 * Deliberately dependency-free: office uploads are size-capped buffers, so a
 * central-directory walk plus zlib raw-inflate covers every legitimate DOCX,
 * PPTX, and XLSX file without pulling an archive library into the supply
 * chain. Encrypted entries, zip64 archives, and unknown compression methods
 * are rejected instead of guessed at, and every inflate call is bounded so a
 * crafted archive cannot expand past the configured budget.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const EOCD_MIN_BYTES = 22;
const MAX_EOCD_SCAN_BYTES = EOCD_MIN_BYTES + 65_535;
const ZIP64_MARKER_16 = 0xffff;
const ZIP64_MARKER_32 = 0xffffffff;
const METHOD_STORED = 0;
const METHOD_DEFLATED = 8;
const FLAG_ENCRYPTED = 0x0001;

export interface ZipArchiveLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
}

export const DEFAULT_ZIP_ARCHIVE_LIMITS: Readonly<ZipArchiveLimits> =
  Object.freeze({
    maxEntries: 4096,
    maxEntryBytes: 64 * 1024 * 1024,
    maxTotalBytes: 256 * 1024 * 1024,
  });

export class ZipArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipArchiveError';
  }
}

interface ZipEntryRecord {
  path: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipArchive {
  private inflatedTotal = 0;

  constructor(
    private readonly buffer: Buffer,
    private readonly entryMap: Map<string, ZipEntryRecord>,
    private readonly limits: Readonly<ZipArchiveLimits>
  ) {}

  entryPaths(): string[] {
    return [...this.entryMap.keys()];
  }

  has(path: string): boolean {
    return this.entryMap.has(path);
  }

  /** Returns the decompressed bytes of one entry, or null when absent. */
  read(path: string): Buffer | null {
    const entry = this.entryMap.get(path);
    if (!entry) return null;
    const dataOffset = this.resolveDataOffset(entry);
    const compressed = this.buffer.subarray(
      dataOffset,
      dataOffset + entry.compressedSize
    );
    if (compressed.length !== entry.compressedSize) {
      throw new ZipArchiveError(`Archive entry ${path} is truncated`);
    }
    const inflated = this.inflate(entry, compressed);
    this.inflatedTotal += inflated.length;
    if (this.inflatedTotal > this.limits.maxTotalBytes) {
      throw new ZipArchiveError(
        'Archive exceeds the total decompressed size budget'
      );
    }
    return inflated;
  }

  private inflate(entry: ZipEntryRecord, compressed: Buffer): Buffer {
    if (entry.method === METHOD_STORED) {
      return compressed;
    }
    try {
      return inflateRawSync(compressed, {
        maxOutputLength: Math.min(
          entry.uncompressedSize,
          this.limits.maxEntryBytes
        ),
      });
    } catch {
      throw new ZipArchiveError(
        `Archive entry ${entry.path} failed to decompress within its declared size`
      );
    }
  }

  private resolveDataOffset(entry: ZipEntryRecord): number {
    const header = entry.localHeaderOffset;
    if (
      header + 30 > this.buffer.length ||
      this.buffer.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE
    ) {
      throw new ZipArchiveError(
        `Archive entry ${entry.path} has an invalid local header`
      );
    }
    const nameLength = this.buffer.readUInt16LE(header + 26);
    const extraLength = this.buffer.readUInt16LE(header + 28);
    return header + 30 + nameLength + extraLength;
  }
}

const findEndOfCentralDirectory = (buffer: Buffer): number => {
  const scanStart = Math.max(0, buffer.length - MAX_EOCD_SCAN_BYTES);
  for (
    let offset = buffer.length - EOCD_MIN_BYTES;
    offset >= scanStart;
    offset -= 1
  ) {
    if (buffer.readUInt32LE(offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  throw new ZipArchiveError('Not a ZIP archive');
};

export const readZipArchive = (
  buffer: Buffer,
  limits: Readonly<ZipArchiveLimits> = DEFAULT_ZIP_ARCHIVE_LIMITS
): ZipArchive => {
  if (buffer.length < EOCD_MIN_BYTES) {
    throw new ZipArchiveError('Not a ZIP archive');
  }
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocd + 16);
  if (
    entryCount === ZIP64_MARKER_16 ||
    centralDirectoryOffset === ZIP64_MARKER_32
  ) {
    throw new ZipArchiveError('zip64 archives are not supported');
  }
  if (entryCount > limits.maxEntries) {
    throw new ZipArchiveError(
      `Archive declares ${entryCount} entries; at most ${limits.maxEntries} are allowed`
    );
  }
  const entries = new Map<string, ZipEntryRecord>();
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > buffer.length ||
      buffer.readUInt32LE(cursor) !== CENTRAL_DIRECTORY_SIGNATURE
    ) {
      throw new ZipArchiveError('Central directory is corrupt');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const path = buffer
      .subarray(cursor + 46, cursor + 46 + nameLength)
      .toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
    if ((flags & FLAG_ENCRYPTED) !== 0) {
      throw new ZipArchiveError('Encrypted archive entries are not supported');
    }
    if (method !== METHOD_STORED && method !== METHOD_DEFLATED) {
      throw new ZipArchiveError(
        `Archive entry ${path} uses an unsupported compression method`
      );
    }
    if (
      compressedSize === ZIP64_MARKER_32 ||
      uncompressedSize === ZIP64_MARKER_32 ||
      localHeaderOffset === ZIP64_MARKER_32
    ) {
      throw new ZipArchiveError('zip64 archive entries are not supported');
    }
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ZipArchiveError(
        `Archive entry ${path} exceeds the per-entry decompressed size budget`
      );
    }
    if (path.endsWith('/')) continue; // directory marker
    entries.set(path, {
      path,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
  }
  return new ZipArchive(buffer, entries, limits);
};
