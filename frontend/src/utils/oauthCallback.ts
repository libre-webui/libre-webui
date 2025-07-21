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
import toast from 'react-hot-toast';
import axios from 'axios';

// Use the same API base URL logic as the main api.ts
const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ||
  import.meta.env.VITE_BACKEND_URL + '/api' ||
  'http://localhost:3001/api';

/**
 * Handle OAuth callback and extract token from URL
 */
export const handleOAuthCallback = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');
  const authStatus = urlParams.get('auth');
  const error = urlParams.get('error');

  console.log('🔍 OAuth callback check - URL:', window.location.href);
  console.log(
    '🔍 OAuth callback check - Search params:',
    window.location.search
  );
  console.log(
    '🔍 OAuth callback check - All params:',
    Object.fromEntries(urlParams.entries())
  );
  console.log('🔍 OAuth callback check:', {
    token: token ? 'present' : 'none',
    authStatus,
    error,
  });

  if (error === 'oauth_failed') {
    toast.error('GitHub authentication failed. Please try again.');
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
    return false;
  }

  if (error === 'oauth_not_configured') {
    toast.error('GitHub OAuth is not configured on the server.');
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
    return false;
  }

  if (token && authStatus === 'success') {
    console.log('🔑 Processing OAuth token...');
    const success = await handleTokenLogin(token);
    // Clean up URL
    window.history.replaceState({}, document.title, window.location.pathname);
    return success;
  }

  return false;
};

/**
 * Handle login with received JWT token
 */
const handleTokenLogin = async (token: string): Promise<boolean> => {
  console.log('🔐 Starting token verification...');
  console.log('🔗 API_BASE_URL:', API_BASE_URL);
  console.log('🔗 Full URL will be:', `${API_BASE_URL}/auth/me`);
  try {
    // Verify token and get user info
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
    });

    console.log(
      '📡 Token verification response:',
      response.status,
      response.ok
    );

    if (response.ok) {
      const data = await response.json();
      console.log('👤 User data received:', data);
      if (data.success && data.data) {
        // Login using the auth store
        const { login } = useAuthStore.getState();
        login(data.data, token, {
          requiresAuth: true,
          singleUserMode: false,
          hasUsers: true,
        });
        toast.success('GitHub login successful!');
        console.log(
          '✅ GitHub OAuth login successful for user:',
          data.data.username
        );
        return true;
      } else {
        toast.error('Failed to verify GitHub authentication');
        console.error('❌ Failed to verify GitHub authentication:', data);
      }
    } else {
      toast.error('GitHub authentication verification failed');
      console.error(
        '❌ GitHub authentication verification failed:',
        response.status
      );
    }
  } catch (error) {
    console.error('❌ GitHub token login error:', error);
    toast.error('GitHub authentication failed');
  }

  return false;
};
