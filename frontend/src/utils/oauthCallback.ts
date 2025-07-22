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
  // OAuth processing is now handled by App.tsx
  // This function is kept for backward compatibility but does nothing
  return false;
};

/**
 * Handle login with received JWT token
 */
const _handleTokenLogin = async (token: string): Promise<boolean> => {
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
        // Don't show success toast here since App.tsx handles it
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
