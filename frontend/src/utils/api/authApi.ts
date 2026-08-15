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
  PendingApprovalSummary,
  SignupResponse,
  SystemInfo,
  User,
  UserCreateRequest,
  UserUpdateRequest,
} from '@/types';
import { API_BASE_URL } from '@/utils/config';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse, logger } from './client';

const appVersion = import.meta.env.VITE_APP_VERSION || '0.0.0';

/** One signed-in session (browser login or OAuth) as reported by the backend. */
export interface AuthSession {
  id: string;
  kind: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** True for the session making the request. */
  current: boolean;
}

/** A scoped API token. The plaintext token is only returned at creation. */
export interface ApiTokenRecord {
  id: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenCreateResponse {
  /** Shown once; never retrievable again. */
  token: string;
  record: ApiTokenRecord;
}

/** Scopes an API token can carry. 'admin' is mintable by administrators only. */
export const API_TOKEN_SCOPES = [
  'chat',
  'models',
  'documents',
  'notes',
  'personas',
  'media',
  'work',
  'admin',
] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

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
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          signupEnabled: true,
          version: appVersion,
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
  }): Promise<ApiResponse<SignupResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<LoginResponse>({
        user: {
          id: 'demo-user-new',
          username: credentials.username,
          email: credentials.email || '',
          role: 'user',
          status: 'active',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        token: 'demo-token-new',
        systemInfo: {
          requiresAuth: true,
          hasUsers: true,
          userCount: 1,
          signupEnabled: true,
          version: appVersion,
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
        signupEnabled: true,
        version: appVersion,
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
        status: 'active',
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

  getSessions: (): Promise<ApiResponse<AuthSession[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<AuthSession[]>([
        {
          id: 'demo-session',
          kind: 'password',
          userAgent: navigator.userAgent,
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          expiresAt: null,
          revokedAt: null,
          current: true,
        },
      ]);
    }

    return api.get('/auth/sessions').then(res => res.data);
  },

  revokeSession: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/auth/sessions/${id}`).then(res => res.data);
  },

  revokeOtherSessions: (): Promise<ApiResponse<{ revokedCount: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ revokedCount: 0 });
    }

    return api.post('/auth/sessions/revoke-others').then(res => res.data);
  },

  listApiTokens: (): Promise<ApiResponse<ApiTokenRecord[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<ApiTokenRecord[]>([]);
    }

    return api.get('/auth/tokens').then(res => res.data);
  },

  createApiToken: (payload: {
    name: string;
    scopes: string[];
    expiresInDays?: number;
  }): Promise<ApiResponse<ApiTokenCreateResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<ApiTokenCreateResponse>({
        token: 'lwui_demo_not_a_real_token',
        record: {
          id: 'demo-token-' + Date.now(),
          name: payload.name,
          tokenPrefix: 'lwui_demo',
          scopes: payload.scopes,
          createdAt: new Date().toISOString(),
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        },
      });
    }

    return api.post('/auth/tokens', payload).then(res => res.data);
  },

  revokeApiToken: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/auth/tokens/${id}`).then(res => res.data);
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
          status: 'active',
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
        status: 'active',
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
        status: 'active',
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

  getPendingApprovals: (): Promise<ApiResponse<PendingApprovalSummary>> => {
    if (isDemoMode()) {
      return createDemoResponse({ count: 0, latestCreatedAt: null });
    }

    return api.get('/users/pending-approvals').then(res => res.data);
  },

  approveUser: (id: string): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id,
        username: 'demo-user',
        email: 'demo@example.com',
        role: 'user',
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch(`/users/${id}/approve`).then(res => res.data);
  },

  updateMyAvatar: (avatar: string | null): Promise<ApiResponse<User>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        id: 'demo-user',
        username: 'demo',
        email: 'demo@example.com',
        role: 'admin' as const,
        status: 'active' as const,
        avatar,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    return api.patch('/users/me/avatar', { avatar }).then(res => res.data);
  },
};
