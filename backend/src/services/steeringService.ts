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
 * Model steering. A llama.cpp server built with per-request control vectors
 * lists its vectors at GET /steering, and a chat request that names some of
 * them under "steering", as {name: strength}, has those directions added to
 * the model's residual stream for every token it reads and writes. A chat
 * keeps its mix in its generation options, so the whole conversation runs
 * steered.
 *
 * The list is looked for beside the provider's API root, and through
 * llama-swap's /upstream/<model>/ passthrough when the root is a llama-swap
 * proxy. A request carries only the names that server listed; the rest are
 * dropped before it leaves, so a chat that switches to another model never
 * sends a field that provider would reject.
 *
 * Who may steer is an administrator decision, admins-only by default: a
 * steering vector can carry a model past its own instructions. The
 * STEERING_ACCESS_MODE environment variable pins the value and locks the
 * toggle.
 */

import { getSystemSetting, setSystemSetting } from './systemSettingsService.js';
import { providerRequest } from '../utils/providerFetch.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('services:steering');

export type SteeringAccessMode = 'admins' | 'all-users';

export const STEERING_ACCESS_MODES: readonly SteeringAccessMode[] = [
  'admins',
  'all-users',
];

export const STEERING_ACCESS_MODE_KEY = 'steering_access_mode';

export function isSteeringAccessMode(
  value: unknown
): value is SteeringAccessMode {
  return (
    typeof value === 'string' &&
    (STEERING_ACCESS_MODES as readonly string[]).includes(value)
  );
}

/** Whether the environment pins the setting, locking the admin toggle. */
export function steeringAccessModeLockedByEnv(): boolean {
  return isSteeringAccessMode(process.env.STEERING_ACCESS_MODE);
}

export async function getSteeringAccessMode(): Promise<SteeringAccessMode> {
  const env = process.env.STEERING_ACCESS_MODE;
  if (isSteeringAccessMode(env)) return env;
  try {
    const value = await getSystemSetting(STEERING_ACCESS_MODE_KEY);
    return isSteeringAccessMode(value) ? value : 'admins';
  } catch {
    // No database means no persisted opt-in; stay admins-only.
    return 'admins';
  }
}

export async function setSteeringAccessMode(
  mode: SteeringAccessMode
): Promise<void> {
  if (!isSteeringAccessMode(mode)) {
    throw new Error(`Invalid steering access mode "${String(mode)}".`);
  }
  await setSystemSetting(STEERING_ACCESS_MODE_KEY, mode);
}

/** Whether this user may steer right now; unknown users never may. */
export async function userCanSteer(
  userId: string | undefined
): Promise<boolean> {
  if (!userId) return false;
  try {
    const [{ authorize }, { userModel }] = await Promise.all([
      import('./authorizationService.js'),
      import('../models/userModel.js'),
    ]);
    const user = await userModel.getUserById(userId);
    if (!user) return false;
    const decision = await authorize(
      { userId: user.id, role: user.role, status: user.status },
      'use',
      { type: 'feature', id: 'steering' }
    );
    return decision.allowed;
  } catch (error) {
    logger.warn('Steering access check failed; not steering:', error);
    return false;
  }
}

/** One vector a server offers, as its GET /steering lists it. */
export interface SteeringVector {
  name: string;
  label?: string;
  description?: string;
  group?: string;
  source?: string;
  /** The strength the server suggests. */
  default?: number;
}

/** Strengths past this break most models; the server takes any float. */
export const STEERING_STRENGTH_LIMIT = 2;
const MAX_VECTORS_IN_MIX = 64;
const MAX_LISTED_VECTORS = 1000;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const clampStrength = (value: number): number =>
  Math.max(-STEERING_STRENGTH_LIMIT, Math.min(STEERING_STRENGTH_LIMIT, value));

/**
 * A chat's mix as {name: strength}, from either the object form or the
 * server's own [{name, strength}] form. Zero strengths are left out, since
 * they steer nothing; an empty mix is no mix.
 */
export function normalizeSteeringMix(
  raw: unknown
): Record<string, number> | undefined {
  const entries: Array<[unknown, unknown]> = Array.isArray(raw)
    ? raw.map(item =>
        item && typeof item === 'object'
          ? [
              (item as { name?: unknown }).name,
              (item as { strength?: unknown }).strength,
            ]
          : [undefined, undefined]
      )
    : raw && typeof raw === 'object'
      ? Object.entries(raw as Record<string, unknown>)
      : [];
  const mix: Record<string, number> = {};
  for (const [name, strength] of entries) {
    if (Object.keys(mix).length >= MAX_VECTORS_IN_MIX) break;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) continue;
    if (typeof strength !== 'number' || !Number.isFinite(strength)) continue;
    const value = Math.round(clampStrength(strength) * 1000) / 1000;
    if (value !== 0) mix[name] = value;
  }
  return Object.keys(mix).length > 0 ? mix : undefined;
}

const shortText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : undefined;

/** The vectors a GET /steering body lists, or null when it is not one. */
export function parseSteeringList(data: unknown): SteeringVector[] | null {
  const vectors = (data as { vectors?: unknown } | null)?.vectors;
  if (!Array.isArray(vectors)) return null;
  const parsed: SteeringVector[] = [];
  const seen = new Set<string>();
  for (const item of vectors.slice(0, MAX_LISTED_VECTORS)) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = record.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    const suggested = record.default;
    parsed.push({
      name,
      ...(shortText(record.label, 120)
        ? { label: shortText(record.label, 120) }
        : {}),
      ...(shortText(record.description, 400)
        ? { description: shortText(record.description, 400) }
        : {}),
      ...(shortText(record.group, 60)
        ? { group: shortText(record.group, 60) }
        : {}),
      ...(shortText(record.source, 200)
        ? { source: shortText(record.source, 200) }
        : {}),
      ...(typeof suggested === 'number' && Number.isFinite(suggested)
        ? { default: clampStrength(suggested) }
        : {}),
    });
  }
  return parsed;
}

/**
 * Where a server's vector list can be, for a chat endpoint such as
 * http://host:8080/v1/chat/completions: beside the API root (a llama-server
 * of its own), then through llama-swap's passthrough for this model.
 */
export function steeringListUrls(endpoint: string, model: string): string[] {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return [];
  }
  const root =
    url.origin +
    url.pathname
      .replace(/\/+$/, '')
      .replace(/\/(chat\/completions|completions|responses)$/, '')
      .replace(/\/v1$/, '');
  const modelPath = model
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  return [`${root}/steering`, `${root}/upstream/${modelPath}/steering`];
}

interface CachedList {
  vectors: SteeringVector[] | null;
  expiresAt: number;
}

const LISTED_TTL_MS = 10 * 60_000;
const UNLISTED_TTL_MS = 2 * 60_000;
/** A direct server answers at once; a llama-swap model may have to load first. */
const DIRECT_TIMEOUT_MS = 5_000;
const UPSTREAM_TIMEOUT_MS = 120_000;
const LIST_MAX_BYTES = 2 * 1024 * 1024;

const cache = new Map<string, CachedList>();
const inFlight = new Map<string, Promise<SteeringVector[] | null>>();

export function clearSteeringCache(): void {
  cache.clear();
  inFlight.clear();
}

/** The cached answer for this key, without asking the server. */
export function cachedSteeringList(
  key: string
): SteeringVector[] | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.vectors;
}

async function fetchSteeringList(
  endpoint: string,
  model: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<SteeringVector[] | null> {
  const [direct, upstream] = steeringListUrls(endpoint, model);
  // Only the credential header travels; the list is a plain GET.
  const getHeaders = Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== 'content-type'
    )
  );
  for (const [url, timeoutMs] of [
    [direct, DIRECT_TIMEOUT_MS],
    [upstream, UPSTREAM_TIMEOUT_MS],
  ] as const) {
    if (!url) continue;
    try {
      const response = await providerRequest<unknown>({
        url,
        method: 'GET',
        headers: getHeaders,
        timeoutMs,
        signal,
        maxResponseBytes: LIST_MAX_BYTES,
      });
      const vectors = parseSteeringList(response.data);
      if (vectors) return vectors;
    } catch (error) {
      if (signal?.aborted) throw error;
      logger.debug(`No steering list at ${url}: ${String(error)}`);
    }
  }
  return null;
}

/**
 * The vectors the server behind this endpoint offers for this model, or null
 * when it offers none. Answers are cached per key, a found list for ten
 * minutes and a missing one for two, and concurrent asks share one request.
 */
export async function getSteeringList(
  key: string,
  endpoint: string,
  model: string,
  headers: Record<string, string>,
  signal?: AbortSignal
): Promise<SteeringVector[] | null> {
  const cached = cachedSteeringList(key);
  if (cached !== undefined) return cached;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = fetchSteeringList(endpoint, model, headers, signal)
    .then(vectors => {
      cache.set(key, {
        vectors,
        expiresAt: Date.now() + (vectors ? LISTED_TTL_MS : UNLISTED_TTL_MS),
      });
      return vectors;
    })
    .finally(() => {
      inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** The part of a mix this server can apply: names it listed, nothing else. */
export function restrictSteeringMix(
  mix: Record<string, number> | undefined,
  vectors: readonly SteeringVector[] | null
): Record<string, number> | undefined {
  if (!mix || !vectors) return undefined;
  const offered = new Set(vectors.map(vector => vector.name));
  const kept = Object.fromEntries(
    Object.entries(mix).filter(([name]) => offered.has(name))
  );
  return Object.keys(kept).length > 0 ? kept : undefined;
}
