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
 * Just enough X.509 to run a private certificate authority for the Work
 * egress proxy: a self-signed ECDSA P-256 root and short-lived server
 * certificates it signs. Node can parse certificates but not build them, so
 * the DER is assembled here. The output is deliberately conventional (v3,
 * SHA-256, SAN-only host names, critical basic constraints and key usage)
 * because the strictest clients in the sandbox, rustls/webpki in the Rust
 * agent CLIs, reject anything unusual.
 */

import crypto, { type KeyObject } from 'node:crypto';

const ECDSA_WITH_SHA256 = '1.2.840.10045.4.3.2';
const OID_COMMON_NAME = '2.5.4.3';
const OID_ORGANIZATION = '2.5.4.10';
const OID_BASIC_CONSTRAINTS = '2.5.29.19';
const OID_KEY_USAGE = '2.5.29.15';
const OID_EXTENDED_KEY_USAGE = '2.5.29.37';
const OID_SUBJECT_ALT_NAME = '2.5.29.17';
const OID_SUBJECT_KEY_ID = '2.5.29.14';
const OID_AUTHORITY_KEY_ID = '2.5.29.35';
const OID_SERVER_AUTH = '1.3.6.1.5.5.7.3.1';
const ORGANIZATION = 'Libre WebUI Work egress';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** Backdating absorbs clock skew between the backend and a sandbox. */
const BACKDATE_MS = HOUR_MS;
const CA_LIFETIME_MS = 397 * DAY_MS;
const SERVER_LIFETIME_MS = 7 * DAY_MS;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

const sequence = (...items: Buffer[]): Buffer =>
  tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
const octetString = (value: Buffer): Buffer => tlv(0x04, value);
const booleanTrue = (): Buffer => tlv(0x01, Buffer.from([0xff]));
const utf8String = (value: string): Buffer =>
  tlv(0x0c, Buffer.from(value, 'utf8'));
const contextExplicit = (tagNumber: number, value: Buffer): Buffer =>
  tlv(0xa0 + tagNumber, value);

function bitString(value: Buffer, unusedBits = 0): Buffer {
  return tlv(0x03, Buffer.concat([Buffer.from([unusedBits]), value]));
}

/** DER INTEGER from unsigned big-endian bytes: minimal and non-negative. */
function integer(bytes: Buffer): Buffer {
  let value = bytes;
  while (value.length > 1 && value[0] === 0 && (value[1] & 0x80) === 0) {
    value = value.subarray(1);
  }
  if (value[0] & 0x80) value = Buffer.concat([Buffer.from([0]), value]);
  return tlv(0x02, value);
}

function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes = [40 * parts[0] + parts[1]];
  for (const part of parts.slice(2)) {
    const encoded = [part & 0x7f];
    let rest = Math.floor(part / 128);
    while (rest > 0) {
      encoded.unshift((rest & 0x7f) | 0x80);
      rest = Math.floor(rest / 128);
    }
    bytes.push(...encoded);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** UTCTime through 2049, GeneralizedTime after, as RFC 5280 requires. */
function time(date: Date): Buffer {
  const digits = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050
    ? tlv(0x17, Buffer.from(`${digits.slice(2)}Z`, 'ascii'))
    : tlv(0x18, Buffer.from(`${digits}Z`, 'ascii'));
}

function distinguishedName(commonName: string): Buffer {
  return sequence(
    set(sequence(objectIdentifier(OID_COMMON_NAME), utf8String(commonName))),
    set(sequence(objectIdentifier(OID_ORGANIZATION), utf8String(ORGANIZATION)))
  );
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return sequence(
    objectIdentifier(id),
    ...(critical ? [booleanTrue()] : []),
    octetString(value)
  );
}

/** RFC 5280 method 1: SHA-1 of the subjectPublicKey bit string contents. */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const jwk = publicKey.export({ format: 'jwk' });
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') {
    throw new Error('Only EC public keys can be certified.');
  }
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, 'base64url'),
    Buffer.from(jwk.y, 'base64url'),
  ]);
  return crypto.createHash('sha1').update(point).digest();
}

function serialNumber(): Buffer {
  const serial = crypto.randomBytes(16);
  // Positive and never zero.
  serial[0] = (serial[0] & 0x7f) | 0x01;
  return serial;
}

function toPem(der: Buffer): string {
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`;
}

interface CertificateFields {
  subject: string;
  issuer: string;
  publicKey: KeyObject;
  signingKey: KeyObject;
  notBefore: Date;
  notAfter: Date;
  extensions: Buffer[];
}

function signCertificate(fields: CertificateFields): Buffer {
  const algorithm = sequence(objectIdentifier(ECDSA_WITH_SHA256));
  const tbs = sequence(
    contextExplicit(0, integer(Buffer.from([2]))),
    integer(serialNumber()),
    algorithm,
    distinguishedName(fields.issuer),
    sequence(time(fields.notBefore), time(fields.notAfter)),
    distinguishedName(fields.subject),
    fields.publicKey.export({ type: 'spki', format: 'der' }),
    contextExplicit(3, sequence(...fields.extensions))
  );
  const signature = crypto.sign('sha256', tbs, {
    key: fields.signingKey,
    dsaEncoding: 'der',
  });
  return sequence(tbs, algorithm, bitString(signature));
}

export interface CertificateAuthority {
  readonly commonName: string;
  readonly certificatePem: string;
  readonly notAfter: Date;
  readonly privateKey: KeyObject;
  readonly keyId: Buffer;
}

export interface ServerCertificate {
  readonly host: string;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
  readonly notAfter: Date;
}

/** A fresh root. Its private key lives only in this process's memory. */
export function createCertificateAuthority(
  commonName = 'Libre WebUI Work egress CA',
  now = Date.now()
): CertificateAuthority {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const keyId = keyIdentifier(publicKey);
  const notAfter = new Date(now + CA_LIFETIME_MS);
  const der = signCertificate({
    subject: commonName,
    issuer: commonName,
    publicKey,
    signingKey: privateKey,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter,
    extensions: [
      // CA with path length 0: it may only sign end-entity certificates.
      extension(
        OID_BASIC_CONSTRAINTS,
        true,
        sequence(booleanTrue(), integer(Buffer.from([0])))
      ),
      // keyCertSign and cRLSign.
      extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x06]), 1)),
      extension(OID_SUBJECT_KEY_ID, false, octetString(keyId)),
    ],
  });
  return {
    commonName,
    certificatePem: toPem(der),
    notAfter,
    privateKey,
    keyId,
  };
}

const HOST_PATTERN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** A server certificate for one DNS host name, signed by the authority. */
export function issueServerCertificate(
  authority: CertificateAuthority,
  host: string,
  now = Date.now()
): ServerCertificate {
  const name = host.trim().toLowerCase();
  if (!HOST_PATTERN.test(name)) {
    throw new Error(`Cannot certify "${host}": not a DNS host name.`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  const requestedEnd = now + SERVER_LIFETIME_MS;
  const notAfter = new Date(
    requestedEnd < authority.notAfter.getTime()
      ? requestedEnd
      : authority.notAfter.getTime()
  );
  const der = signCertificate({
    subject: name,
    issuer: authority.commonName,
    publicKey,
    signingKey: authority.privateKey,
    notBefore: new Date(now - BACKDATE_MS),
    notAfter,
    extensions: [
      extension(OID_BASIC_CONSTRAINTS, true, sequence()),
      // digitalSignature only: ECDHE key exchange signs, it never encrypts.
      extension(OID_KEY_USAGE, true, bitString(Buffer.from([0x80]), 7)),
      extension(
        OID_EXTENDED_KEY_USAGE,
        false,
        sequence(objectIdentifier(OID_SERVER_AUTH))
      ),
      extension(
        OID_SUBJECT_ALT_NAME,
        false,
        sequence(tlv(0x82, Buffer.from(name, 'ascii')))
      ),
      extension(
        OID_SUBJECT_KEY_ID,
        false,
        octetString(keyIdentifier(publicKey))
      ),
      extension(
        OID_AUTHORITY_KEY_ID,
        false,
        sequence(tlv(0x80, authority.keyId))
      ),
    ],
  });
  return {
    host: name,
    certificatePem: toPem(der),
    privateKeyPem: privateKey
      .export({ type: 'pkcs8', format: 'pem' })
      .toString(),
    notAfter,
  };
}
