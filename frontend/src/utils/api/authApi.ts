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

import type {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  SystemInfo,
  User,
  UserCreateRequest,
  UserUpdateRequest,
} from '@/types';
import { API_BASE_URL } from '@/utils/config';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse, logger } from './client';

// Authentication API
export const authApi = {
  login: (credentials: LoginRequest): Promise<ApiResponse<LoginResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          allowUserModelPull: true,
          version: '0.1.0',
        },
      });
    }

    return api.post('/auth/login', credentials).then(res => res.data);
  },

  signup: (credentials: {
    username: string;
    password: string;
    email?: string;
    turnstileToken?: string;
  }): Promise<ApiResponse<LoginResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user-new',
          username: credentials.username,
          email: credentials.email || '',
          role: 'user',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token-new',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          allowUserModelPull: true,
          version: '0.1.0',
          turnstile: { enabled: false },
        },
      });
    }

    return api.post('/auth/signup', credentials).then(res => res.data);
  },

  logout: (): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.post('/auth/logout').then(res => res.data);
  },

  getSystemInfo: (): Promise<ApiResponse<SystemInfo>> => {
    logger.debug('getSystemInfo called, demo mode:', isDemoMode());

    if (isDemoMode()) {
      return createDemoResponse<SystemInfo>({
        requiresAuth: true,
        hasUsers: true,
        userCount: 1,
        allowUserModelPull: true,
        version: '0.1.0',
        turnstile: { enabled: false },
      });
    }

    logger.debug('Making API call to:', API_BASE_URL + '/auth/system-info');
    logger.debug(
      'Full URL from:',
      window.location.origin,
      '-> API:',
      API_BASE_URL + '/auth/system-info'
    );
    return api
      .get('/auth/system-info')
      .then(res => {
        logger.debug('getSystemInfo response:', res.data);
        return res.data;
      })
      .catch(error => {
        logger.debug('getSystemInfo error:', error);
        if (error.response) {
          logger.debug('Error response data:', error.response.data);
          logger.debug('Error status:', error.response.status);
          logger.debug('Error headers:', error.response.headers);
        }
        if (error.request) {
          logger.debug('Network error - no response received:', error.request);
        }
        logger.debug('Error config:', error.config);
        throw error;
      });
  },

  verifyToken: (): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.get('/auth/verify').then(res => res.data);
  },

  getEncryptionKey: (): Promise<ApiResponse<{ encryptionKey: string }>> => {
    if (isDemoMode()) {
      return createDemoResponse<{ encryptionKey: string }>({
        encryptionKey: 'demo-encryption-key-not-real',
      });
    }

    return api.get('/auth/encryption-key').then(res => res.data);
  },

  updateModelPullSetting: (
    allowUserModelPull: boolean
  ): Promise<ApiResponse<SystemInfo>> => {
    if (isDemoMode()) {
      return createDemoResponse<SystemInfo>({
        requiresAuth: true,
        hasUsers: true,
        userCount: 1,
        allowUserModelPull,
        version: '0.1.0',
        turnstile: { enabled: false },
      });
    }

    return api
      .patch('/auth/system-settings/model-pull', { allowUserModelPull })
      .then(res => res.data);
  },
};

// Users API
export const usersApi = {
  getUsers: (): Promise<ApiResponse<User[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<User[]>([
        {
          id: 'demo-user',
          username: 'demo',
          email: 'demo@example.com',
          role: 'admin',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]);
    }

    return api.get('/users').then(res => res.data);
  },

  createUser: (userData: UserCreateRequest): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id: 'new-user-' + Date.now(),
        username: userData.username,
        email: userData.email,
        role: userData.role,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.post('/users', userData).then(res => res.data);
  },

  updateUser: (
    id: string,
    userData: UserUpdateRequest
  ): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse<User>({
        id,
        username: userData.username || 'demo',
        email: userData.email || 'demo@example.com',
        role: userData.role || 'user',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch(`/users/${id}`, userData).then(res => res.data);
  },

  deleteUser: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/users/${id}`).then(res => res.data);
  },

  updateMyAvatar: (avatar: string | null): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin' as const,
        avatar,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch('/users/me/avatar', { avatar }).then(res => res.data);
  },
};
