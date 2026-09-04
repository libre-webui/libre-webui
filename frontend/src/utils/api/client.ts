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
import { API_BASE_URL, logConfigInfo } from '@/utils/config';
import { createLogger } from '@/utils/logger';
import { createHttpClient, type HttpError } from './httpClient';

export { HttpError, isHttpError } from './httpClient';
export type { HttpClient, HttpRequestConfig, HttpResponse } from './httpClient';

export const logger = createLogger('api');

logConfigInfo();
logger.debug('User agent:', navigator.userAgent);
logger.debug('Demo mode detected:', isDemoMode());

export const createDemoResponse = <T>(
  data: T,
  success = true
): Promise<ApiResponse<T>> => {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve({
        success,
        data,
        error: success ? undefined : 'Demo mode: Backend not available',
      });
    }, 500);
  });
};

const API_TIMEOUT = import.meta.env.VITE_API_TIMEOUT
  ? parseInt(import.meta.env.VITE_API_TIMEOUT)
  : 300000;

const handleApiError = (error: HttpError): never => {
  if (error.response?.status === 401) {
    logger.warn('Session expired or unauthorized, logging out...');
    localStorage.removeItem('auth-token');

    import('@/store/authStore').then(({ useAuthStore }) => {
      const authStore = useAuthStore.getState();
      authStore.logout();
    });

    const isElectron = window.location.protocol === 'file:';
    const currentPath = isElectron
      ? window.location.hash
      : window.location.pathname;
    if (!currentPath.includes('/login')) {
      window.location.href = isElectron ? '#/login' : '/login';
    }

    throw new Error('Session expired');
  }

  // A 403 from a Work endpoint usually means an administrator changed the
  // access mode mid-session. Re-sync the stored access so the interface
  // stops (or starts) offering Work without requiring a re-login. The
  // access probe itself sits outside the Work gate, so this cannot loop.
  if (
    error.response?.status === 403 &&
    (error.config?.url ?? '').startsWith('/work') &&
    error.config?.url !== '/work/access'
  ) {
    import('@/store/authStore').then(({ useAuthStore }) => {
      void useAuthStore.getState().refreshWorkAccess();
    });
  }

  logger.error('API Error:', error);
  throw error;
};

export const api = createHttpClient({
  baseURL: API_BASE_URL,
  timeout: API_TIMEOUT,
  onRequest: config => {
    const token = localStorage.getItem('auth-token');
    if (token) {
      config.headers = {
        ...(config.headers || {}),
        Authorization: `Bearer ${token}`,
      };
    }
    return config;
  },
  onError: handleApiError,
});

export default api;
