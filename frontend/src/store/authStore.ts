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

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, SystemInfo } from '@/types';

interface AuthState {
  user: User | null;
  token: string | null;
  systemInfo: SystemInfo | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (user: User, token: string, systemInfo: SystemInfo) => void;
  logout: () => void;
  setUser: (user: User) => void;
  setSystemInfo: (systemInfo: SystemInfo) => void;
  setLoading: (loading: boolean) => void;
  isAdmin: () => boolean;
  requiresAuth: () => boolean;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      systemInfo: null,
      isAuthenticated: false,
      isLoading: false,

      login: (user: User, token: string, systemInfo: SystemInfo) => {
        // Save token to localStorage
        localStorage.setItem('auth-token', token);

        set({
          user,
          token,
          systemInfo,
          isAuthenticated: true,
          isLoading: false,
        });
      },

      logout: () => {
        // Remove token from localStorage
        localStorage.removeItem('auth-token');

        set({
          user: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },

      setUser: (user: User) => {
        set({ user });
      },

      setSystemInfo: (systemInfo: SystemInfo) => {
        set({ systemInfo });
      },

      setLoading: (loading: boolean) => {
        set({ isLoading: loading });
      },

      isAdmin: () => {
        const { user } = get();
        return user?.role === 'admin';
      },

      requiresAuth: () => {
        const { systemInfo } = get();
        return systemInfo?.requiresAuth ?? false;
      },
    }),
    {
      name: 'auth-store',
      partialize: state => ({
        user: state.user,
        token: state.token,
        systemInfo: state.systemInfo,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
