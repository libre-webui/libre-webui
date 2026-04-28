/*
 * Libre WebUI - GitHub OAuth2 Login Component (JWT Integration)
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch, Loader2, User, LogOut } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import axios from 'axios';

/**
 * User data structure (compatible with Libre WebUI's JWT system)
 */
interface UserData {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  createdAt: string;
  updatedAt: string;
}

/**
 * API Response structure
 */
interface AuthResponse {
  success: boolean;
  data?: UserData;
  message?: string;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

/**
 * GitHub OAuth2 Login Component (JWT Integration)
 * Handles GitHub authentication flow with JWT token management
 * Integrates seamlessly with existing Libre WebUI authentication
 */
export const GitHubAuth: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const getToken = (): string | null => localStorage.getItem('jwt_token');
  const _setToken = (token: string) => localStorage.setItem('jwt_token', token);
  const removeToken = () => localStorage.removeItem('jwt_token');

  const { data: user = null, isLoading: loading } = useQuery({
    queryKey: ['github-auth-me'],
    queryFn: async (): Promise<UserData | null> => {
      const token = getToken();
      if (!token) return null;
      try {
        const response = await axios.get<AuthResponse>(
          `${BACKEND_URL}/api/auth/me`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (response.data.success && response.data.data) {
          return response.data.data;
        }
        removeToken();
        return null;
      } catch (e: unknown) {
        console.log(
          'Not authenticated:',
          e instanceof Error ? e.message : 'Unknown error'
        );
        removeToken();
        return null;
      }
    },
    staleTime: 60_000,
  });

  const handleGitHubLogin = () => {
    setError(null);
    window.location.href = `${BACKEND_URL}/api/auth/oauth/github`;
  };

  const handleLogout = () => {
    removeToken();
    setError(null);
    queryClient.setQueryData(['github-auth-me'], null);
  };

  /**
   * Loading state
   */
  if (loading) {
    return (
      <div className='flex items-center justify-center min-h-screen bg-gray-50'>
        <div className='text-center'>
          <Loader2 className='mx-auto h-8 w-8 animate-spin text-blue-600' />
          <p className='mt-2 text-gray-600'>{t('auth.checkingAuth')}</p>
        </div>
      </div>
    );
  }

  /**
   * Authenticated user view
   */
  if (user) {
    return (
      <div className='min-h-screen bg-gray-50 p-8'>
        <div className='max-w-md mx-auto bg-white rounded-lg shadow-md p-6'>
          <div className='text-center'>
            <h1 className='text-2xl font-bold text-gray-900 mb-6'>
              {t('auth.welcome')}
            </h1>

            <div className='flex items-center justify-center mb-4'>
              <User className='w-16 h-16 text-gray-400' />
            </div>

            <h2 className='text-xl font-semibold text-gray-800 mb-2'>
              {user.username}
            </h2>

            <p className='text-gray-600 mb-2'>
              {user.email || t('auth.noEmail')}
            </p>

            <p className='text-sm text-gray-500 mb-6'>
              {t('auth.role')}: {user.role} | {t('auth.id')}: {user.id}
            </p>

            <div className='space-y-3'>
              <button
                onClick={handleLogout}
                className='inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-md transition-colors duration-200'
              >
                <LogOut className='w-4 h-4 mr-2' />
                {t('auth.logout')}
              </button>

              <div className='text-xs text-green-600 bg-green-50 p-2 rounded'>
                ✅ {t('auth.jwtActive')}
              </div>
            </div>

            {error && (
              <div className='mt-4 p-3 bg-red-50 border border-red-200 rounded-md'>
                <p className='text-red-800 text-sm'>{error}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /**
   * Login view for unauthenticated users
   */
  return (
    <div className='flex items-center justify-center min-h-screen bg-gray-50'>
      <div className='max-w-md w-full mx-auto bg-white rounded-lg shadow-md p-8'>
        <div className='text-center'>
          <h1 className='text-3xl font-bold text-gray-900 mb-2'>
            Libre <span className='text-xl'>WebUI</span>
          </h1>
          <p className='text-gray-600 mb-8'>{t('auth.signInDescription')}</p>

          <button
            onClick={handleGitHubLogin}
            className='w-full inline-flex items-center justify-center px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white font-medium rounded-md transition-colors duration-200'
          >
            <GitBranch className='w-5 h-5 mr-3' />
            {t('auth.signInWithGitHub')}
          </button>

          <div className='mt-4 text-xs text-blue-600 bg-blue-50 p-2 rounded'>
            🔑 {t('auth.jwtDescription')}
          </div>

          {error && (
            <div className='mt-4 p-3 bg-red-50 border border-red-200 rounded-md'>
              <p className='text-red-800 text-sm'>{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
