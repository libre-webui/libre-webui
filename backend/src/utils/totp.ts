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
 * RFC 6238 TOTP over RFC 4226 HOTP, implemented directly on node:crypto.
 * Authenticator apps expect HMAC-SHA1, 30-second steps, and 6 digits; those
 * are protocol constants here, not options.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Accept the previous/next step to absorb clock skew. */
export const TOTP_SKEW_STEPS = 1;

export const encodeBase32 = (bytes: Buffer): string => {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
};

export const decodeBase32 = (encoded: string): Buffer => {
  const normalized = encoded.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new Error('Invalid base32 character');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
};

/** Generate a new 160-bit shared secret, base32-encoded for authenticator apps. */
export const generateTotpSecret = (): string => encodeBase32(randomBytes(20));

/** The otpauth:// provisioning URI understood by authenticator apps. */
export const buildOtpauthUrl = (
  secret: string,
  accountName: string,
  issuer: string
): string => {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
  const query = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
};

export const totpCodeForStep = (secret: string, step: number): string => {
  const key = decodeBase32(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac('sha1', key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
};

export const currentTotpStep = (nowMs = Date.now()): number =>
  Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

const codesEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

/**
 * Verify a submitted code within the skew window. Returns the matched
 * timestep so the caller can persist it and refuse replays; null when the
 * code does not match any step in the window.
 */
export const verifyTotpCode = (
  secret: string,
  submitted: string,
  nowMs = Date.now()
): number | null => {
  const normalized = submitted.replace(/\s/g, '');
  if (!/^\d{6}$/.test(normalized)) return null;
  const current = currentTotpStep(nowMs);
  for (let offset = -TOTP_SKEW_STEPS; offset <= TOTP_SKEW_STEPS; offset++) {
    const step = current + offset;
    if (step < 0) continue;
    if (codesEqual(totpCodeForStep(secret, step), normalized)) {
      return step;
    }
  }
  return null;
};
