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

export interface TurnstilePublicConfig {
  enabled: boolean;
  siteKey?: string;
}

interface TurnstileVerifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export class TurnstileService {
  private get siteKey(): string | undefined {
    return process.env.TURNSTILE_SITE_KEY?.trim() || undefined;
  }

  private get secretKey(): string | undefined {
    return process.env.TURNSTILE_SECRET_KEY?.trim() || undefined;
  }

  isConfigured(): boolean {
    return Boolean(this.siteKey && this.secretKey);
  }

  getPublicConfig(): TurnstilePublicConfig {
    if (!this.isConfigured()) {
      return { enabled: false };
    }

    return {
      enabled: true,
      siteKey: this.siteKey,
    };
  }

  async verify(token: unknown, remoteIp?: string): Promise<boolean> {
    if (!this.isConfigured()) {
      return true;
    }

    if (typeof token !== 'string' || !token.trim()) {
      return false;
    }

    const body = new URLSearchParams({
      secret: this.secretKey!,
      response: token.trim(),
    });

    if (remoteIp) {
      body.set('remoteip', remoteIp);
    }

    try {
      const response = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });

      if (!response.ok) {
        console.error(
          'Turnstile verification request failed:',
          response.status
        );
        return false;
      }

      const data = (await response.json()) as TurnstileVerifyResponse;

      if (!data.success) {
        console.warn(
          'Turnstile verification failed:',
          data['error-codes']?.join(', ') || 'unknown error'
        );
      }

      return data.success;
    } catch (error) {
      console.error('Turnstile verification error:', error);
      return false;
    }
  }
}

export const turnstileService = new TurnstileService();
