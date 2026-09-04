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

import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import { authApi } from '@/utils/api';
import { createLogger } from '@/utils/logger';

const logger = createLogger('user-service');

export class UserService {
  /**
   * Initialize authentication state
   */
  static async initializeAuth(): Promise<void> {
    const { setLoading, setSystemInfo, login } = useAuthStore.getState();

    try {
      setLoading(true);
      logger.debug('Starting auth initialization...');

      // First, get system info
      logger.debug('Fetching system info...');
      const systemInfoResponse = await authApi.getSystemInfo();
      logger.debug('System info response:', systemInfoResponse);

      if (systemInfoResponse.success && systemInfoResponse.data) {
        logger.debug('Setting system info:', systemInfoResponse.data);
        setSystemInfo(systemInfoResponse.data);
        // Paint the administrator's default theme wherever this browser has
        // not chosen one (the sign-in page most of all).
        useAppStore
          .getState()
          .applyInstanceTheme(systemInfoResponse.data.defaultTheme);
      } else {
        logger.error('System info response failed:', systemInfoResponse);
      }

      // Check if there's a stored token
      const token = localStorage.getItem('auth-token');
      if (token) {
        try {
          // The API client reads the stored token for every request.
          const userResponse = await authApi.verifyToken();
          if (userResponse.success && userResponse.data) {
            const systemInfo = useAuthStore.getState().systemInfo;
            if (systemInfo) {
              login(userResponse.data, token, systemInfo);
            }
          }
        } catch (error) {
          logger.error('Token verification failed:', error);
          // Clear invalid token
          localStorage.removeItem('auth-token');
        }
      }
    } catch (error) {
      logger.error('Auth initialization error:', error);
    } finally {
      setLoading(false);
    }
  }
}
