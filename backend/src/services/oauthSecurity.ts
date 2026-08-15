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

import { randomBytes, timingSafeEqual } from 'crypto';
import type { CookieOptions, Request, Response } from 'express';

export type OAuthProvider = 'github' | 'huggingface' | 'oidc';

const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_TRANSFER_TTL_MS = 60 * 1000;
const SESSION_COOKIE_NAME = 'libre_oauth_session';
const SESSION_COOKIE_PATH = '/api/auth/oauth';

const stateCookieName = (provider: OAuthProvider): string =>
  `libre_oauth_state_${provider}`;

const stateCookiePath = (provider: OAuthProvider): string =>
  `/api/auth/oauth/${provider}`;

const isSecureRequest = (req: Request): boolean =>
  req.secure || req.protocol === 'https';

const cookieOptions = (
  req: Request,
  path: string,
  maxAge: number
): CookieOptions => ({
  httpOnly: true,
  secure: isSecureRequest(req),
  sameSite: 'lax',
  path,
  maxAge,
});

const clearCookieOptions = (req: Request, path: string): CookieOptions => ({
  httpOnly: true,
  secure: isSecureRequest(req),
  sameSite: 'lax',
  path,
});

const readCookie = (req: Request, name: string): string | undefined => {
  const header = req.headers.cookie;
  if (!header) return undefined;

  for (const item of header.split(';')) {
    const separator = item.indexOf('=');
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() !== name) continue;

    const rawValue = item.slice(separator + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return undefined;
    }
  }

  return undefined;
};

const secureEqual = (left: string, right: string): boolean => {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
};

/** Start a browser-bound OAuth flow and return the state sent to the provider. */
export const beginOAuthFlow = (
  req: Request,
  res: Response,
  provider: OAuthProvider
): string => {
  const state = randomBytes(32).toString('base64url');
  res.cookie(
    stateCookieName(provider),
    state,
    cookieOptions(req, stateCookiePath(provider), STATE_TTL_MS)
  );
  return state;
};

/**
 * Start a browser-bound OAuth flow that also needs per-flow secrets (PKCE
 * verifier, OIDC nonce). The payload rides in the same HttpOnly state
 * cookie, encoded alongside the CSRF state.
 */
export const beginOAuthFlowWithPayload = (
  req: Request,
  res: Response,
  provider: OAuthProvider,
  payload: Record<string, string>
): string => {
  const state = randomBytes(32).toString('base64url');
  const envelope = Buffer.from(
    JSON.stringify({ state, ...payload }),
    'utf8'
  ).toString('base64url');
  res.cookie(
    stateCookieName(provider),
    envelope,
    cookieOptions(req, stateCookiePath(provider), STATE_TTL_MS)
  );
  return state;
};

/**
 * Validate state and return the per-flow payload stored at flow start.
 * The cookie is always cleared, so a callback cannot be replayed.
 */
export const consumeOAuthStatePayload = (
  req: Request,
  res: Response,
  provider: OAuthProvider,
  receivedState: string
): Record<string, string> | null => {
  const path = stateCookiePath(provider);
  const raw = readCookie(req, stateCookieName(provider));
  res.clearCookie(stateCookieName(provider), clearCookieOptions(req, path));
  if (!raw || !receivedState) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8')
    );
    if (!parsed || typeof parsed !== 'object') return null;
    const envelope = parsed as Record<string, unknown>;
    if (
      typeof envelope.state !== 'string' ||
      !secureEqual(envelope.state, receivedState)
    ) {
      return null;
    }
    const payload: Record<string, string> = {};
    for (const [key, value] of Object.entries(envelope)) {
      if (key !== 'state' && typeof value === 'string') payload[key] = value;
    }
    return payload;
  } catch {
    return null;
  }
};

/** Validate and clear OAuth state so a callback cannot be replayed in-browser. */
export const consumeOAuthState = (
  req: Request,
  res: Response,
  provider: OAuthProvider,
  receivedState: string
): boolean => {
  const path = stateCookiePath(provider);
  const expectedState = readCookie(req, stateCookieName(provider));
  res.clearCookie(stateCookieName(provider), clearCookieOptions(req, path));

  return Boolean(
    expectedState && receivedState && secureEqual(expectedState, receivedState)
  );
};

/**
 * Transfer a completed OAuth session without exposing its bearer token in the
 * callback URL, browser history, reverse-proxy logs, or referrer headers.
 */
export const setOAuthSessionCookie = (
  _req: Request,
  res: Response,
  token: string
): void => {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: SESSION_COOKIE_PATH,
    maxAge: SESSION_TRANSFER_TTL_MS,
  });
};

/** Read and immediately clear the short-lived OAuth session-transfer cookie. */
export const consumeOAuthSessionCookie = (
  req: Request,
  res: Response
): string | undefined => {
  const token = readCookie(req, SESSION_COOKIE_NAME);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: SESSION_COOKIE_PATH,
  });
  return token;
};
