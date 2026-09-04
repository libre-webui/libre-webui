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

import { providerRequest } from '../utils/providerFetch.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('codex-oauth');

/**
 * Reuses the Codex CLI's ChatGPT sign-in for the bundled "codex-oauth"
 * provider plugin. Tokens live in the CLI's own auth file; this service only
 * reads them, refreshes them through the same public OAuth client the CLI
 * uses, and writes refreshed tokens back so the CLI keeps working too.
 * Token values are never logged.
 */

const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/** Overridable for tests only; production always talks to auth.openai.com. */
const oauthTokenUrl = (): string =>
  process.env.CODEX_OAUTH_TOKEN_URL || 'https://auth.openai.com/oauth/token';
/** Refresh slightly early so an in-flight request never carries a dead token. */
const EXPIRY_MARGIN_MS = 60_000;

export const CODEX_OAUTH_PLUGIN_ID = 'codex-oauth';

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface JwtClaims {
  exp?: number;
  chatgpt_account_id?: string;
  'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
}

const codexEnabled = (): boolean =>
  process.env.CODEX_OAUTH_MODELS_ENABLED !== 'false';

function authFilePath(): string {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'auth.json');
}

function decodeJwtClaims(token: string): JwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8')
    ) as JwtClaims;
  } catch {
    return null;
  }
}

function accountIdFromClaims(claims: JwtClaims | null): string | undefined {
  return (
    claims?.chatgpt_account_id ||
    claims?.['https://api.openai.com/auth']?.chatgpt_account_id
  );
}

export class CodexOAuthService {
  private cachedAccessToken: string | null = null;
  private cachedAccountId: string | undefined;
  private cachedExpiryMs = 0;
  private refreshFlight: {
    controller: AbortController;
    promise: Promise<void>;
    settled: boolean;
    waiters: number;
  } | null = null;

  /** Whether the Codex CLI sign-in exists on this server. */
  isAvailable(): boolean {
    if (!codexEnabled()) return false;
    try {
      const parsed = JSON.parse(
        fs.readFileSync(authFilePath(), 'utf8')
      ) as CodexAuthFile;
      return Boolean(parsed.tokens?.refresh_token);
    } catch {
      return false;
    }
  }

  /**
   * Last known access token, for synchronous header building. Call
   * ensureFreshToken() on the async request path first.
   */
  getCachedAccessToken(): string | null {
    if (!this.cachedAccessToken) this.loadFromDisk();
    return this.cachedAccessToken;
  }

  getCachedAccountId(): string | undefined {
    if (!this.cachedAccessToken) this.loadFromDisk();
    return this.cachedAccountId;
  }

  /** Refresh the access token when missing or near expiry (single flight). */
  async ensureFreshToken(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!codexEnabled()) return;
    if (!this.cachedAccessToken) this.loadFromDisk();
    if (
      this.cachedAccessToken &&
      Date.now() < this.cachedExpiryMs - EXPIRY_MARGIN_MS
    ) {
      return;
    }
    if (!this.refreshFlight) {
      const controller = new AbortController();
      const flight = {
        controller,
        promise: Promise.resolve(),
        settled: false,
        waiters: 0,
      };
      flight.promise = this.refresh(controller.signal).finally(() => {
        flight.settled = true;
        if (this.refreshFlight === flight) this.refreshFlight = null;
      });
      this.refreshFlight = flight;
    }
    const flight = this.refreshFlight;
    flight.waiters += 1;
    try {
      await waitForSharedRefresh(flight.promise, signal);
    } finally {
      flight.waiters = Math.max(0, flight.waiters - 1);
      if (
        flight.waiters === 0 &&
        !flight.settled &&
        this.refreshFlight === flight
      ) {
        // Every interested generation has gone away. Keep the aborted flight
        // registered until Axios settles so an immediate retry cannot overlap
        // a refresh-token exchange that is still tearing down.
        flight.controller.abort(new Error('Codex token refresh was cancelled'));
      }
    }
  }

  private loadFromDisk(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(authFilePath(), 'utf8')
      ) as CodexAuthFile;
      const accessToken = parsed.tokens?.access_token;
      if (!accessToken) return;
      const claims = decodeJwtClaims(accessToken);
      this.cachedAccessToken = accessToken;
      this.cachedAccountId =
        parsed.tokens?.account_id || accountIdFromClaims(claims);
      this.cachedExpiryMs = claims?.exp ? claims.exp * 1000 : 0;
    } catch {
      // Unavailable or unreadable; isAvailable() reports this state.
    }
  }

  private async refresh(signal?: AbortSignal): Promise<void> {
    const file = authFilePath();
    let parsed: CodexAuthFile;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as CodexAuthFile;
    } catch {
      throw new Error(
        'Codex sign-in not found on this server. Run "codex login" as the server user.'
      );
    }
    const refreshToken = parsed.tokens?.refresh_token;
    if (!refreshToken) {
      throw new Error(
        'Codex auth file has no refresh token. Run "codex login" as the server user.'
      );
    }

    const response = await providerRequest({
      url: oauthTokenUrl(),
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }).toString(),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeoutMs: 30_000,
      signal,
      redirect: 'follow',
    });
    const tokens = response.data as {
      id_token?: string;
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!tokens.access_token) {
      throw new Error('Codex token refresh returned no access token.');
    }

    const claims = decodeJwtClaims(tokens.access_token);
    this.cachedAccessToken = tokens.access_token;
    this.cachedAccountId =
      accountIdFromClaims(claims) || parsed.tokens?.account_id;
    this.cachedExpiryMs = claims?.exp
      ? claims.exp * 1000
      : Date.now() + (tokens.expires_in ?? 3600) * 1000;

    const updated: CodexAuthFile = {
      ...parsed,
      tokens: {
        ...parsed.tokens,
        id_token: tokens.id_token ?? parsed.tokens?.id_token,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? refreshToken,
        ...(this.cachedAccountId ? { account_id: this.cachedAccountId } : {}),
      },
      last_refresh: new Date().toISOString(),
    };
    try {
      fs.writeFileSync(file, JSON.stringify(updated, null, 2), { mode: 0o600 });
    } catch (error) {
      // The in-memory token still works for this process.
      logger.warn('Could not persist refreshed Codex tokens:', error);
    }
    logger.info('Refreshed Codex OAuth access token.');
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error('Codex token refresh was cancelled');
}

function waitForSharedRefresh(
  promise: Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error('Codex token refresh was cancelled')
      );
    };
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      () => {
        cleanup();
        resolve();
      },
      error => {
        cleanup();
        reject(error);
      }
    );
  });
}

const codexOAuthService = new CodexOAuthService();
export default codexOAuthService;
