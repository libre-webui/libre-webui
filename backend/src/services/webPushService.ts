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
 * Browser Web Push, implemented directly on node:crypto:
 *
 * - RFC 8291 payload encryption (ECDH P-256 + HKDF + aes128gcm, one record).
 * - RFC 8292 VAPID authorization (ES256 JWT bound to the endpoint origin).
 * - Per-device subscriptions encrypted at rest, bound to the auth session
 *   that created them, and removed when that session is revoked.
 *
 * VAPID keys come from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (base64url,
 * uncompressed point + raw scalar) or are generated once and persisted in
 * system settings, encrypted. Deliveries go through the shared egress guard,
 * so a subscription endpoint can never reach private address space.
 */

import {
  createCipheriv,
  createECDH,
  createPrivateKey,
  hkdfSync,
  randomBytes,
  randomUUID,
  sign as cryptoSign,
} from 'node:crypto';
import { isIP } from 'node:net';
import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';
import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';
import {
  isAllowlistedPrivateHost,
  secureToolRequest,
  validateToolServerUrl,
} from '../utils/toolEgress.js';
import { isPublicIpAddress } from '../utils/webpageFetcher.js';
import {
  registerSessionRevocationListener,
  type SessionRevocationEvent,
} from './authSessionService.js';
import { createLogger } from '../utils/logger.js';
import type { StoredPushSubscriptionRecord } from '../persistence/resourceTypes.js';

const logger = createLogger('services:web-push');

const repositories = () =>
  getPersistence(encryptionService).repositories.resources;

const MAX_SUBSCRIPTIONS_PER_USER = 10;
const MAX_PAYLOAD_BYTES = 3800;
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;

export class WebPushError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 400
  ) {
    super(message);
  }
}

/** The endpoint acknowledged but the subscription no longer exists. */
export class PushSubscriptionGoneError extends Error {}

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/* --------------------------------------------------------- VAPID keys */

interface VapidKeys {
  /** base64url uncompressed P-256 point (65 bytes). */
  publicKey: string;
  /** base64url raw private scalar (32 bytes). */
  privateKey: string;
}

let cachedKeys: VapidKeys | null = null;

const generateVapidKeys = (): VapidKeys => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
  };
};

const validKeyShape = (keys: VapidKeys): boolean => {
  try {
    const publicKey = Buffer.from(keys.publicKey, 'base64url');
    const privateKey = Buffer.from(keys.privateKey, 'base64url');
    return (
      publicKey.length === 65 &&
      publicKey[0] === 0x04 &&
      privateKey.length === 32
    );
  } catch {
    return false;
  }
};

export const getVapidKeys = async (): Promise<VapidKeys> => {
  if (cachedKeys) return cachedKeys;
  const fromEnv: VapidKeys = {
    publicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? '',
    privateKey: process.env.VAPID_PRIVATE_KEY?.trim() ?? '',
  };
  if (fromEnv.publicKey && fromEnv.privateKey) {
    if (!validKeyShape(fromEnv)) {
      throw new WebPushError(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not valid base64url P-256 keys',
        500
      );
    }
    cachedKeys = fromEnv;
    return cachedKeys;
  }
  const stored = await getSystemSetting('web_push_vapid_keys');
  if (stored) {
    try {
      const decoded = JSON.parse(
        encryptionService.decryptAuthenticated(stored)
      ) as VapidKeys;
      if (validKeyShape(decoded)) {
        cachedKeys = decoded;
        return cachedKeys;
      }
    } catch {
      logger.warn('Stored VAPID keys were unreadable; regenerating');
    }
  }
  const generated = generateVapidKeys();
  await setSystemSetting(
    'web_push_vapid_keys',
    encryptionService.encrypt(JSON.stringify(generated))
  );
  cachedKeys = generated;
  return cachedKeys;
};

export const getVapidPublicKey = async (): Promise<string> =>
  (await getVapidKeys()).publicKey;

/** Raw P-256 scalar + point → a PEM/KeyObject for ES256 signing. */
const vapidPrivateKeyObject = (keys: VapidKeys) => {
  const publicKey = Buffer.from(keys.publicKey, 'base64url');
  return createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: publicKey.subarray(1, 33).toString('base64url'),
      y: publicKey.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
};

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** RFC 8292 VAPID JWT for one push-service origin. */
export const buildVapidAuthorization = async (
  endpointOrigin: string
): Promise<string> => {
  const keys = await getVapidKeys();
  const header = base64UrlJson({ typ: 'JWT', alg: 'ES256' });
  const payload = base64UrlJson({
    aud: endpointOrigin,
    exp: Math.floor(Date.now() / 1000) + VAPID_JWT_LIFETIME_SECONDS,
    sub: process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@localhost',
  });
  const signature = cryptoSign(
    'sha256',
    Buffer.from(`${header}.${payload}`, 'utf8'),
    { key: vapidPrivateKeyObject(keys), dsaEncoding: 'ieee-p1363' }
  ).toString('base64url');
  return `vapid t=${header}.${payload}.${signature}, k=${keys.publicKey}`;
};

/* ------------------------------------------------ RFC 8291 encryption */

export interface EncryptParams {
  /** Test hook: fixed ephemeral private key (32-byte scalar). */
  ephemeralPrivateKey?: Buffer;
  /** Test hook: fixed 16-byte salt. */
  salt?: Buffer;
}

/**
 * Encrypt one push message with aes128gcm content encoding. Returns the
 * complete request body (header block + single record).
 */
export const encryptPushPayload = (
  userAgentPublicKey: Buffer,
  authSecret: Buffer,
  plaintext: Buffer,
  params: EncryptParams = {}
): Buffer => {
  if (userAgentPublicKey.length !== 65 || userAgentPublicKey[0] !== 0x04) {
    throw new WebPushError('Subscription p256dh key is not a P-256 point');
  }
  if (authSecret.length !== 16) {
    throw new WebPushError('Subscription auth secret must be 16 bytes');
  }
  if (plaintext.length > MAX_PAYLOAD_BYTES) {
    throw new WebPushError('Push payload is too large');
  }
  const ecdh = createECDH('prime256v1');
  if (params.ephemeralPrivateKey) {
    ecdh.setPrivateKey(params.ephemeralPrivateKey);
  } else {
    ecdh.generateKeys();
  }
  const applicationServerPublicKey = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(userAgentPublicKey);

  // RFC 8291 §3.3-3.4: combine the ECDH secret with the auth secret and both
  // public keys, then derive the content key and nonce from a random salt.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    userAgentPublicKey,
    applicationServerPublicKey,
  ]);
  const inputKeyingMaterial = Buffer.from(
    hkdfSync('sha256', sharedSecret, authSecret, keyInfo, 32)
  );
  const salt = params.salt ?? randomBytes(16);
  const contentEncryptionKey = Buffer.from(
    hkdfSync(
      'sha256',
      inputKeyingMaterial,
      salt,
      Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'),
      16
    )
  );
  const nonce = Buffer.from(
    hkdfSync(
      'sha256',
      inputKeyingMaterial,
      salt,
      Buffer.from('Content-Encoding: nonce\0', 'utf8'),
      12
    )
  );

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096);
  const header = Buffer.concat([
    salt,
    recordSize,
    Buffer.from([applicationServerPublicKey.length]),
    applicationServerPublicKey,
  ]);

  const cipher = createCipheriv('aes-128-gcm', contentEncryptionKey, nonce);
  const padded = Buffer.concat([plaintext, Buffer.from([0x02])]);
  const ciphertext = Buffer.concat([
    cipher.update(padded),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([header, ciphertext]);
};

/* ------------------------------------------------------ subscriptions */

const endpointLookup = (endpoint: string): string =>
  encryptionService.purposeLookupToken('push-endpoint', endpoint);

const assertAcceptableEndpoint = (endpoint: string): URL => {
  let url: URL;
  try {
    url = validateToolServerUrl(endpoint);
  } catch {
    throw new WebPushError('The push endpoint URL is not valid');
  }
  if (url.protocol !== 'https:') {
    throw new WebPushError('Push endpoints must use HTTPS');
  }
  const literalHost = url.hostname.replace(/^\[|\]$/g, '');
  if (
    isIP(literalHost) !== 0 &&
    !isAllowlistedPrivateHost(url.hostname) &&
    !isPublicIpAddress(literalHost)
  ) {
    throw new WebPushError(
      'Push endpoints cannot target private or local addresses'
    );
  }
  return url;
};

const decodeSubscriptionKey = (
  value: unknown,
  name: string,
  expectedLength: number
): Buffer => {
  if (typeof value !== 'string' || !value) {
    throw new WebPushError(`Subscription ${name} key is required`);
  }
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.length !== expectedLength) {
    throw new WebPushError(`Subscription ${name} key has the wrong length`);
  }
  return decoded;
};

export interface PublicPushSubscription {
  id: string;
  createdAt: number;
  lastUsedAt: number | null;
  current: boolean;
}

export const subscribe = async (
  userId: string,
  sessionId: string | null,
  input: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } },
  userAgent: string | null
): Promise<{ id: string }> => {
  const endpoint = typeof input.endpoint === 'string' ? input.endpoint : '';
  if (!endpoint || endpoint.length > 2048) {
    throw new WebPushError('The push endpoint URL is not valid');
  }
  assertAcceptableEndpoint(endpoint);
  decodeSubscriptionKey(input.keys?.p256dh, 'p256dh', 65);
  decodeSubscriptionKey(input.keys?.auth, 'auth', 16);

  const existing = await repositories().pushSubscriptions.listByUser(userId);
  const lookup = endpointLookup(endpoint);
  const alreadyMine = existing.some(row => row.endpoint_lookup === lookup);
  if (!alreadyMine && existing.length >= MAX_SUBSCRIPTIONS_PER_USER) {
    throw new WebPushError(
      `At most ${MAX_SUBSCRIPTIONS_PER_USER} push subscriptions are supported per account`,
      409
    );
  }

  const record: StoredPushSubscriptionRecord = {
    id: randomUUID(),
    user_id: userId,
    session_id: sessionId,
    endpoint_lookup: lookup,
    subscription: encryptionService.encrypt(
      JSON.stringify({
        endpoint,
        keys: { p256dh: input.keys?.p256dh, auth: input.keys?.auth },
      })
    ),
    user_agent: userAgent?.slice(0, 512) ?? null,
    created_at: Date.now(),
    last_used_at: null,
  };
  await repositories().pushSubscriptions.upsertByEndpoint(record);
  const stored = await repositories().pushSubscriptions.findByLookup(lookup);
  return { id: stored?.id ?? record.id };
};

export const unsubscribe = async (
  userId: string,
  endpoint: string
): Promise<boolean> =>
  repositories().pushSubscriptions.deleteByLookup(
    userId,
    endpointLookup(endpoint)
  );

export const listSubscriptionsForUser = async (
  userId: string
): Promise<StoredPushSubscriptionRecord[]> =>
  repositories().pushSubscriptions.listByUser(userId);

/* ------------------------------------------------------------ delivery */

const decryptSubscription = (
  record: StoredPushSubscriptionRecord
): PushSubscriptionKeys | null => {
  try {
    const decoded = JSON.parse(
      encryptionService.decryptAuthenticated(record.subscription)
    ) as PushSubscriptionKeys;
    if (
      typeof decoded.endpoint === 'string' &&
      typeof decoded.keys?.p256dh === 'string' &&
      typeof decoded.keys?.auth === 'string'
    ) {
      return decoded;
    }
  } catch {
    // Fall through: an unreadable envelope means the subscription is dead.
  }
  return null;
};

export interface PushMessage {
  title: string;
  body?: string;
  href?: string;
  type?: string;
}

/**
 * Deliver one message to one stored subscription. Returns false (and
 * removes the row) when the push service reports the subscription gone.
 */
export const deliverToSubscription = async (
  subscriptionId: string,
  message: PushMessage,
  signal?: AbortSignal
): Promise<{ delivered: boolean; status?: number }> => {
  const record =
    await repositories().pushSubscriptions.findById(subscriptionId);
  if (!record) return { delivered: false };
  const subscription = decryptSubscription(record);
  if (!subscription) {
    await repositories().pushSubscriptions.delete(record.id);
    return { delivered: false };
  }

  const endpointUrl = assertAcceptableEndpoint(subscription.endpoint);
  const body = encryptPushPayload(
    Buffer.from(subscription.keys.p256dh, 'base64url'),
    Buffer.from(subscription.keys.auth, 'base64url'),
    Buffer.from(JSON.stringify(message), 'utf8')
  );
  const authorization = await buildVapidAuthorization(endpointUrl.origin);

  const response = await secureToolRequest({
    url: subscription.endpoint,
    method: 'POST',
    headers: {
      Authorization: authorization,
      TTL: String(PUSH_TTL_SECONDS),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Urgency: 'normal',
    },
    body,
    timeoutMs: 10_000,
    maxResponseBytes: 16 * 1024,
    ...(signal ? { signal } : {}),
  });

  if (response.status === 404 || response.status === 410) {
    await repositories().pushSubscriptions.delete(record.id);
    throw new PushSubscriptionGoneError(
      `Push subscription is gone (${response.status})`
    );
  }
  if (response.status >= 200 && response.status < 300) {
    await repositories().pushSubscriptions.touch(record.id, Date.now());
    return { delivered: true, status: response.status };
  }
  return { delivered: false, status: response.status };
};

/* ---------------------------------------------------------- lifecycle */

let revocationCleanupRegistered = false;

/** Remove device subscriptions when their auth session is revoked. */
export const registerPushSessionCleanup = (): void => {
  if (revocationCleanupRegistered) return;
  revocationCleanupRegistered = true;
  registerSessionRevocationListener((event: SessionRevocationEvent) => {
    void (async () => {
      try {
        for (const sessionId of event.sessionIds) {
          await repositories().pushSubscriptions.deleteForSession(sessionId);
        }
      } catch (error) {
        logger.warn('Push subscription cleanup after revocation failed', {
          error,
        });
      }
    })();
  });
};
