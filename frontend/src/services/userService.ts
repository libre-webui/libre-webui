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
import { authApi } from '@/utils/api';

export class UserService {
  /**
   * Initialize authentication state
   */
  static async initializeAuth(): Promise<void> {
    const { setLoading, setSystemInfo, login } = useAuthStore.getState();

    try {
      setLoading(true);
      console.log('🔐 Starting auth initialization...');

      // First, get system info
      console.log('📡 Fetching system info...');
      const systemInfoResponse = await authApi.getSystemInfo();
      console.log('📡 System info response:', systemInfoResponse);

      if (systemInfoResponse.success && systemInfoResponse.data) {
        console.log('✅ Setting system info:', systemInfoResponse.data);
        setSystemInfo(systemInfoResponse.data);
      } else {
        console.error('❌ System info response failed:', systemInfoResponse);
      }

      // Check if there's a stored token
      const token = localStorage.getItem('auth-token');
      if (token) {
        try {
          // Set up axios header for the verification request
          const axios = (await import('axios')).default;
          const originalHeaders = axios.defaults.headers.common;
          axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

          // Verify the token
          const userResponse = await authApi.verifyToken();
          if (userResponse.success && userResponse.data) {
            const systemInfo = useAuthStore.getState().systemInfo;
            if (systemInfo) {
              login(userResponse.data, token, systemInfo);
            }
          }

          // Restore original headers
          axios.defaults.headers.common = originalHeaders;
        } catch (error) {
          console.error('Token verification failed:', error);
          // Clear invalid token
          localStorage.removeItem('auth-token');
        }
      }
    } catch (error) {
      console.error('Auth initialization error:', error);
    } finally {
      setLoading(false);
    }
  }
}

// Set up axios interceptor to include auth token
import axios from 'axios';

const setupAxiosInterceptors = () => {
  axios.interceptors.request.use(
    config => {
      const token = localStorage.getItem('auth-token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
      return config;
    },
    error => {
      return Promise.reject(error);
    }
  );

  axios.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 401) {
        // Token expired or invalid
        localStorage.removeItem('auth-token');
        const { logout } = useAuthStore.getState();
        logout();
        window.location.href = '/login';
      }
      return Promise.reject(error);
    }
  );
};

setupAxiosInterceptors();
