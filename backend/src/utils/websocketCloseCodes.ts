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

import { Transform, type TransformCallback } from 'node:stream';

/**
 * Rewrites reserved WebSocket close codes in a server-to-client frame stream.
 *
 * websockify closes a viewer with a code that RFC 6455 reserves for local
 * use (1005, 1006, 1015) when its VNC target disappears. A browser rejects
 * such a frame as "a broken close frame containing a reserved status code"
 * and reports a failed connection instead of a close. The screen relay pipes
 * websockify's bytes through untouched, so this Transform walks the frame
 * boundaries and replaces a reserved code with 1011 (internal error), the
 * closest code a server is allowed to send. Everything else passes through
 * byte for byte. Server frames are never masked, so the code can be edited
 * in place.
 */

export const REPLACEMENT_CLOSE_CODE = 1011;

export const isReservedCloseCode = (code: number): boolean =>
  code < 1000 ||
  code === 1004 ||
  code === 1005 ||
  code === 1006 ||
  code === 1015 ||
  (code >= 1016 && code <= 2999);

const CLOSE_OPCODE = 0x8;

interface FrameHeader {
  headerLength: number;
  payloadLength: number;
  opcode: number;
}

const parseHeader = (buffer: Buffer): FrameHeader | null => {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let headerLength = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    headerLength = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    headerLength = 10;
  }
  if (masked) headerLength += 4;
  if (buffer.length < headerLength) return null;
  return { headerLength, payloadLength, opcode };
};

export class WebSocketCloseCodeSanitizer extends Transform {
  /** Header bytes of the frame being parsed, until its length is known. */
  private pendingHeader = Buffer.alloc(0);
  /** Payload bytes still to pass through for the current frame. */
  private remainingPayload = 0;
  /** True while the current close frame's two code bytes are outstanding. */
  private closeCodePending = false;
  private closeCodeBytes = Buffer.alloc(0);

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    let data: Buffer = chunk;
    let offset = 0;
    while (offset < data.length) {
      if (this.remainingPayload > 0) {
        offset = this.forwardPayload(data, offset);
        continue;
      }
      this.pendingHeader = Buffer.concat([
        this.pendingHeader,
        data.subarray(offset),
      ]);
      const header = parseHeader(this.pendingHeader);
      if (!header) break; // Wait for more header bytes.
      this.push(this.pendingHeader.subarray(0, header.headerLength));
      data = this.pendingHeader.subarray(header.headerLength);
      offset = 0;
      this.pendingHeader = Buffer.alloc(0);
      this.remainingPayload = header.payloadLength;
      this.closeCodePending =
        header.opcode === CLOSE_OPCODE && header.payloadLength >= 2;
      this.closeCodeBytes = Buffer.alloc(0);
    }
    callback();
  }

  _flush(callback: TransformCallback): void {
    if (this.pendingHeader.length > 0) this.push(this.pendingHeader);
    if (this.closeCodeBytes.length > 0) this.push(this.closeCodeBytes);
    callback();
  }

  /** Pass payload bytes through, editing a close code once it is complete. */
  private forwardPayload(chunk: Buffer, offset: number): number {
    const take = Math.min(this.remainingPayload, chunk.length - offset);
    let slice = chunk.subarray(offset, offset + take);
    if (this.closeCodePending) {
      const needed = 2 - this.closeCodeBytes.length;
      const codePart = slice.subarray(0, needed);
      this.closeCodeBytes = Buffer.concat([this.closeCodeBytes, codePart]);
      slice = slice.subarray(codePart.length);
      if (this.closeCodeBytes.length === 2) {
        const bytes = Buffer.from(this.closeCodeBytes);
        if (isReservedCloseCode(bytes.readUInt16BE(0))) {
          bytes.writeUInt16BE(REPLACEMENT_CLOSE_CODE, 0);
        }
        this.push(bytes);
        this.closeCodePending = false;
        this.closeCodeBytes = Buffer.alloc(0);
      }
    }
    if (slice.length > 0) this.push(slice);
    this.remainingPayload -= take;
    return offset + take;
  }
}

export const createCloseCodeSanitizer = (): WebSocketCloseCodeSanitizer =>
  new WebSocketCloseCodeSanitizer();
