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

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export type SmtpSecurity = 'tls' | 'starttls' | 'none';
export type EmailSettingSource = 'stored' | 'env' | 'default';

export interface EmailSettingsResponse {
  /** Enabled and configured: users may opt into email notifications. */
  available: boolean;
  enabled: boolean;
  /** The current account's address, or null when none is on file. */
  recipient: string | null;
  /** The remaining fields are only present for administrators. */
  host?: string;
  port?: number;
  security?: SmtpSecurity;
  username?: string;
  passwordConfigured?: boolean;
  from?: string;
  rejectUnauthorized?: boolean;
  appUrl?: string;
  configured?: boolean;
  sources?: Record<
    'host' | 'port' | 'security' | 'username' | 'password' | 'from' | 'appUrl',
    EmailSettingSource
  >;
}

export interface EmailSettingsUpdate {
  enabled?: boolean;
  host?: string;
  port?: number | string;
  security?: SmtpSecurity;
  username?: string;
  /** Omit to keep the stored password; send an empty string to clear it. */
  password?: string;
  from?: string;
  rejectUnauthorized?: boolean;
  appUrl?: string;
}

export interface EmailTestResponse {
  ok: boolean;
  authenticated: boolean;
  /** The address the test message went to, or null for a connection-only probe. */
  sentTo: string | null;
}

const demoSettings: EmailSettingsResponse = {
  available: false,
  enabled: false,
  recipient: null,
};

export const emailApi = {
  getSettings: (): Promise<ApiResponse<EmailSettingsResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse(demoSettings);
    }
    return api.get('/email/settings').then(res => res.data);
  },

  updateSettings: (
    update: EmailSettingsUpdate
  ): Promise<ApiResponse<EmailSettingsResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse(demoSettings);
    }
    return api.put('/email/settings', update).then(res => res.data);
  },

  test: (to?: string): Promise<ApiResponse<EmailTestResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        ok: true,
        authenticated: false,
        sentTo: to ?? null,
      });
    }
    return api.post('/email/test', to ? { to } : {}).then(res => res.data);
  },
};
