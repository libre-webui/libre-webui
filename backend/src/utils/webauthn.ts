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
 * Minimal WebAuthn (passkey) server-side verification on node:crypto.
 *
 * Scope is deliberate: attestation is accepted as `none` (the statement is
 * not evaluated — standard for consumer passkeys), and the algorithms
 * browsers actually negotiate are supported: ES256 (COSE -7), EdDSA
 * (COSE -8), and RS256 (COSE -257, required for TPM-backed Windows Hello).
 * The bounded CBOR reader below decodes only the subset WebAuthn
 * structures use: unsigned/negative integers, byte/text strings, arrays,
 * and maps.
 */

import {
  createHash,
  createPublicKey,
  verify as cryptoVerify,
} from 'node:crypto';

export class WebAuthnError extends Error {}

/* ------------------------------------------------------------------ CBOR */

type CborValue =
  | number
  | string
  | Buffer
  | CborValue[]
  | Map<number | string, CborValue>
  | boolean
  | null;

interface CborRead {
  value: CborValue;
  bytesRead: number;
}

const MAX_CBOR_ITEMS = 1024;

const readCbor = (buffer: Buffer, offset: number, depth: number): CborRead => {
  if (depth > 8) throw new WebAuthnError('CBOR nesting too deep');
  if (offset >= buffer.length) throw new WebAuthnError('CBOR truncated');
  const initial = buffer[offset];
  const majorType = initial >> 5;
  const additional = initial & 0x1f;

  let length = 0;
  let headerBytes = 1;
  if (additional < 24) {
    length = additional;
  } else if (additional === 24) {
    if (offset + 2 > buffer.length) throw new WebAuthnError('CBOR truncated');
    length = buffer[offset + 1];
    headerBytes = 2;
  } else if (additional === 25) {
    if (offset + 3 > buffer.length) throw new WebAuthnError('CBOR truncated');
    length = buffer.readUInt16BE(offset + 1);
    headerBytes = 3;
  } else if (additional === 26) {
    if (offset + 5 > buffer.length) throw new WebAuthnError('CBOR truncated');
    length = buffer.readUInt32BE(offset + 1);
    headerBytes = 5;
  } else if (additional === 27) {
    if (offset + 9 > buffer.length) throw new WebAuthnError('CBOR truncated');
    const big = buffer.readBigUInt64BE(offset + 1);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WebAuthnError('CBOR value too large');
    }
    length = Number(big);
    headerBytes = 9;
  } else {
    throw new WebAuthnError('Unsupported CBOR additional info');
  }

  switch (majorType) {
    case 0:
      return { value: length, bytesRead: headerBytes };
    case 1:
      return { value: -1 - length, bytesRead: headerBytes };
    case 2: {
      const end = offset + headerBytes + length;
      if (end > buffer.length) throw new WebAuthnError('CBOR truncated');
      return {
        value: buffer.subarray(offset + headerBytes, end),
        bytesRead: headerBytes + length,
      };
    }
    case 3: {
      const end = offset + headerBytes + length;
      if (end > buffer.length) throw new WebAuthnError('CBOR truncated');
      return {
        value: buffer.subarray(offset + headerBytes, end).toString('utf8'),
        bytesRead: headerBytes + length,
      };
    }
    case 4: {
      if (length > MAX_CBOR_ITEMS)
        throw new WebAuthnError('CBOR array too large');
      const items: CborValue[] = [];
      let cursor = offset + headerBytes;
      for (let index = 0; index < length; index++) {
        const item = readCbor(buffer, cursor, depth + 1);
        items.push(item.value);
        cursor += item.bytesRead;
      }
      return { value: items, bytesRead: cursor - offset };
    }
    case 5: {
      if (length > MAX_CBOR_ITEMS)
        throw new WebAuthnError('CBOR map too large');
      const map = new Map<number | string, CborValue>();
      let cursor = offset + headerBytes;
      for (let index = 0; index < length; index++) {
        const key = readCbor(buffer, cursor, depth + 1);
        cursor += key.bytesRead;
        const value = readCbor(buffer, cursor, depth + 1);
        cursor += value.bytesRead;
        if (typeof key.value !== 'number' && typeof key.value !== 'string') {
          throw new WebAuthnError('Unsupported CBOR map key');
        }
        map.set(key.value, value.value);
      }
      return { value: map, bytesRead: cursor - offset };
    }
    case 7: {
      if (additional === 20) return { value: false, bytesRead: 1 };
      if (additional === 21) return { value: true, bytesRead: 1 };
      if (additional === 22) return { value: null, bytesRead: 1 };
      throw new WebAuthnError('Unsupported CBOR simple value');
    }
    default:
      throw new WebAuthnError('Unsupported CBOR major type');
  }
};

/** Decode one CBOR item and report how many bytes it consumed. */
export const decodeCbor = (
  buffer: Buffer
): { value: CborValue; bytesRead: number } => readCbor(buffer, 0, 0);

/* -------------------------------------------------- authenticator data */

export interface ParsedAuthenticatorData {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId: Buffer | null;
  /** COSE public key map, present only with attested credential data. */
  publicKey: Map<number | string, CborValue> | null;
}

export const parseAuthenticatorData = (
  authData: Buffer
): ParsedAuthenticatorData => {
  if (authData.length < 37) {
    throw new WebAuthnError('Authenticator data too short');
  }
  const rpIdHash = authData.subarray(0, 32);
  const flags = authData[32];
  const signCount = authData.readUInt32BE(33);
  const attestedCredentialIncluded = (flags & 0x40) !== 0;

  let credentialId: Buffer | null = null;
  let publicKey: Map<number | string, CborValue> | null = null;
  if (attestedCredentialIncluded) {
    if (authData.length < 55) {
      throw new WebAuthnError('Attested credential data too short');
    }
    const credentialIdLength = authData.readUInt16BE(53);
    if (credentialIdLength === 0 || credentialIdLength > 1023) {
      throw new WebAuthnError('Invalid credential id length');
    }
    const credentialIdEnd = 55 + credentialIdLength;
    if (authData.length < credentialIdEnd) {
      throw new WebAuthnError('Attested credential data truncated');
    }
    credentialId = authData.subarray(55, credentialIdEnd);
    const key = readCbor(authData, credentialIdEnd, 0);
    if (!(key.value instanceof Map)) {
      throw new WebAuthnError('COSE public key is not a map');
    }
    publicKey = key.value;
  }

  return {
    rpIdHash,
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount,
    credentialId,
    publicKey,
  };
};

/* -------------------------------------------------------- COSE keys */

export interface StoredPublicKey {
  /** COSE algorithm: -7 = ES256, -8 = EdDSA (Ed25519), -257 = RS256. */
  alg: number;
  /**
   * base64url key parameters. For EC2 keys `x`/`y` are the curve
   * coordinates; for Ed25519 `x` is the key; for RSA `x` holds the
   * modulus n and `y` the public exponent e.
   */
  x: string;
  y?: string;
}

const asBuffer = (value: CborValue | undefined, name: string): Buffer => {
  if (!Buffer.isBuffer(value)) {
    throw new WebAuthnError(`COSE key is missing ${name}`);
  }
  return value;
};

/** Extract the supported key material from a COSE public-key map. */
export const extractPublicKey = (
  cose: Map<number | string, CborValue>
): StoredPublicKey => {
  const kty = cose.get(1);
  const alg = cose.get(3);
  if (alg === -7) {
    if (kty !== 2 || cose.get(-1) !== 1) {
      throw new WebAuthnError('ES256 requires an EC2 P-256 key');
    }
    const x = asBuffer(cose.get(-2), 'x');
    const y = asBuffer(cose.get(-3), 'y');
    if (x.length !== 32 || y.length !== 32) {
      throw new WebAuthnError('Invalid P-256 coordinate length');
    }
    return {
      alg: -7,
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    };
  }
  if (alg === -8) {
    if (kty !== 1 || cose.get(-1) !== 6) {
      throw new WebAuthnError('EdDSA requires an Ed25519 key');
    }
    const x = asBuffer(cose.get(-2), 'x');
    if (x.length !== 32) {
      throw new WebAuthnError('Invalid Ed25519 key length');
    }
    return { alg: -8, x: x.toString('base64url') };
  }
  if (alg === -257) {
    if (kty !== 3) {
      throw new WebAuthnError('RS256 requires an RSA key');
    }
    const n = asBuffer(cose.get(-1), 'n');
    const e = asBuffer(cose.get(-2), 'e');
    if (n.length < 256 || n.length > 512) {
      throw new WebAuthnError('RSA modulus must be 2048-4096 bits');
    }
    if (e.length < 1 || e.length > 8) {
      throw new WebAuthnError('Invalid RSA exponent length');
    }
    return {
      alg: -257,
      x: n.toString('base64url'),
      y: e.toString('base64url'),
    };
  }
  throw new WebAuthnError('Unsupported credential algorithm');
};

const publicKeyObject = (stored: StoredPublicKey) => {
  if (stored.alg === -7) {
    return createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: stored.x, y: stored.y },
      format: 'jwk',
    });
  }
  if (stored.alg === -8) {
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: stored.x },
      format: 'jwk',
    });
  }
  if (stored.alg === -257) {
    return createPublicKey({
      key: { kty: 'RSA', n: stored.x, e: stored.y },
      format: 'jwk',
    });
  }
  throw new WebAuthnError('Unsupported credential algorithm');
};

/** Verify a WebAuthn assertion signature over authData || sha256(clientData). */
export const verifyAssertionSignature = (
  stored: StoredPublicKey,
  authData: Buffer,
  clientDataJson: Buffer,
  signature: Buffer
): boolean => {
  const signedData = Buffer.concat([
    authData,
    createHash('sha256').update(clientDataJson).digest(),
  ]);
  const key = publicKeyObject(stored);
  try {
    if (stored.alg === -7) {
      return cryptoVerify(
        'sha256',
        signedData,
        { key, dsaEncoding: 'der' },
        signature
      );
    }
    if (stored.alg === -257) {
      // RSASSA-PKCS1-v1_5 with SHA-256 (node's default RSA padding).
      return cryptoVerify('sha256', signedData, key, signature);
    }
    return cryptoVerify(null, signedData, key, signature);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------- client data */

export interface ParsedClientData {
  type: string;
  challenge: string;
  origin: string;
}

export const parseClientDataJson = (
  clientDataJson: Buffer
): ParsedClientData => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(clientDataJson.toString('utf8'));
  } catch {
    throw new WebAuthnError('clientDataJSON is not valid JSON');
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.type !== 'string' ||
    typeof record.challenge !== 'string' ||
    typeof record.origin !== 'string'
  ) {
    throw new WebAuthnError('clientDataJSON is missing required fields');
  }
  return {
    type: record.type,
    challenge: record.challenge,
    origin: record.origin,
  };
};

/** The registrable-domain rule: the origin's hostname must equal the RP id
 * or be a subdomain of it. */
export const originMatchesRpId = (origin: string, rpId: string): boolean => {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return hostname === rpId || hostname.endsWith(`.${rpId}`);
};

/** Parse an attestation object far enough to reach authData ('none' policy). */
export const parseAttestationObject = (attestationObject: Buffer): Buffer => {
  const decoded = decodeCbor(attestationObject);
  if (!(decoded.value instanceof Map)) {
    throw new WebAuthnError('Attestation object is not a CBOR map');
  }
  const authData = decoded.value.get('authData');
  if (!Buffer.isBuffer(authData)) {
    throw new WebAuthnError('Attestation object is missing authData');
  }
  return authData;
};

export const sha256 = (input: string | Buffer): Buffer =>
  createHash('sha256').update(input).digest();
