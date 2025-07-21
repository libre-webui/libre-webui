/*
 * Libre WebUI - GitHub OAuth2 Login Component (JWT Integration)
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Github, Loader2, User, LogOut } from 'lucide-react';
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

const BACKEND_URL = 'http://localhost:3001';

/**
 * GitHub OAuth2 Login Component (JWT Integration)
 * Handles GitHub authentication flow with JWT token management
 * Integrates seamlessly with existing Libre WebUI authentication
 */
export const GitHubAuth: React.FC = () => {
  const [user, setUser] = useState<UserData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Get JWT token from localStorage
   */
  const getToken = (): string | null => {
    return localStorage.getItem('libre_webui_token');
  };

  /**
   * Store JWT token in localStorage
   */
  const setToken = (token: string) => {
    localStorage.setItem('libre_webui_token', token);
  };

  /**
   * Remove JWT token from localStorage
   */
  const removeToken = () => {
    localStorage.removeItem('libre_webui_token');
  };

  /**
   * Check authentication status on component mount
   */
  useEffect(() => {
    checkAuthStatus();
    handleOAuthCallback();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Handle OAuth callback and extract token from URL
   */
  const handleOAuthCallback = useCallback(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const authStatus = urlParams.get('auth');
    const error = urlParams.get('error');

    if (token && authStatus === 'success') {
      // Store the JWT token
      setToken(token);
      // Remove URL parameters
      window.history.replaceState({}, document.title, window.location.pathname);
      // Check auth status with the new token
      checkAuthStatus();
    }

    if (error === 'oauth_failed') {
      setError('GitHub authentication failed. Please try again.');
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Check if user is currently authenticated using JWT
   */
  const checkAuthStatus = useCallback(async () => {
    try {
      setLoading(true);
      const token = getToken();

      if (!token) {
        setUser(null);
        setLoading(false);
        return;
      }

      const response = await axios.get<AuthResponse>(
        `${BACKEND_URL}/api/auth/me`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (response.data.success && response.data.data) {
        setUser(response.data.data);
        setError(null);
      } else {
        setUser(null);
        removeToken(); // Remove invalid token
      }
    } catch (error: unknown) {
      console.log(
        'Not authenticated:',
        error instanceof Error ? error.message : 'Unknown error'
      );
      setUser(null);
      removeToken(); // Remove invalid token
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Initiate GitHub OAuth login
   */
  const handleGitHubLogin = () => {
    setError(null);
    // Redirect to backend GitHub OAuth route
    window.location.href = `${BACKEND_URL}/api/auth/oauth/github`;
  };

  /**
   * Handle user logout
   */
  const handleLogout = () => {
    removeToken();
    setUser(null);
    setError(null);
  };

  /**
   * Loading state
   */
  if (loading) {
    return (
      <div className='flex items-center justify-center min-h-screen bg-gray-50'>
        <div className='text-center'>
          <Loader2 className='mx-auto h-8 w-8 animate-spin text-blue-600' />
          <p className='mt-2 text-gray-600'>Checking authentication...</p>
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
              Welcome to Libre WebUI
            </h1>

            <div className='flex items-center justify-center mb-4'>
              <User className='w-16 h-16 text-gray-400' />
            </div>

            <h2 className='text-xl font-semibold text-gray-800 mb-2'>
              {user.username}
            </h2>

            <p className='text-gray-600 mb-2'>
              {user.email || 'No email provided'}
            </p>

            <p className='text-sm text-gray-500 mb-6'>
              Role: {user.role} | ID: {user.id}
            </p>

            <div className='space-y-3'>
              <button
                onClick={handleLogout}
                className='inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-md transition-colors duration-200'
              >
                <LogOut className='w-4 h-4 mr-2' />
                Logout
              </button>

              <div className='text-xs text-green-600 bg-green-50 p-2 rounded'>
                ✅ JWT Authentication Active
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
          <h1 className='text-3xl font-bold text-gray-900 mb-2'>Libre WebUI</h1>
          <p className='text-gray-600 mb-8'>
            Sign in with your GitHub account to continue
          </p>

          <button
            onClick={handleGitHubLogin}
            className='w-full inline-flex items-center justify-center px-6 py-3 bg-gray-900 hover:bg-gray-800 text-white font-medium rounded-md transition-colors duration-200'
          >
            <Github className='w-5 h-5 mr-3' />
            Sign in with GitHub
          </button>

          <div className='mt-4 text-xs text-blue-600 bg-blue-50 p-2 rounded'>
            🔑 JWT-based authentication with GitHub OAuth
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
