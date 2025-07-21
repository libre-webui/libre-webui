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
  try {
    // Verify token and get user info
    const response = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
    });

    if (response.ok) {
      const data = await response.json();
      if (data.success && data.data) {
        // Login using the auth store
        const { login } = useAuthStore.getState();
        login(data.data, token, {
          requiresAuth: true,
          singleUserMode: false,
          hasUsers: true,
        });
        toast.success('GitHub login successful!');
        return true;
      } else {
        toast.error('Failed to verify GitHub authentication');
      }
    } else {
      toast.error('GitHub authentication verification failed');
    }
  } catch (_error) {
    toast.error('GitHub authentication failed');
  }

  return false;
};
