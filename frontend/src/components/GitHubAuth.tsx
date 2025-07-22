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
 * User data structure (matching backend UserPublic interface)
 */
interface AppUser {
  id: string;
  username: string;
  email: string | null;
  role: 'admin' | 'user';
  createdAt?: string;
  updatedAt?: string;
}

/**
 * OAuth Profile data structure
 */
interface OAuthProfile {
  provider: string;
  githubId: string;
  username: string;
  avatarUrl: string;
}

/**
 * API Response structure
 */
interface AuthResponse {
  success: boolean;
  user?: AppUser;
  profile?: OAuthProfile;
  error?: string;
}

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

/**
 * GitHub OAuth2 Login Component with JWT Integration
 * Handles GitHub authentication flow with JWT token management
 */
export const GitHubAuth: React.FC = () => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [oauthProfile, setOAuthProfile] = useState<OAuthProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  /**
   * Get JWT token from localStorage
   */
  const getToken = (): string | null => {
    return localStorage.getItem('jwt_token');
  };

  /**
   * Set JWT token in localStorage
   */
  const setToken = (token: string): void => {
    localStorage.setItem('jwt_token', token);
  };

  /**
   * Remove JWT token from localStorage
   */
  const removeToken = (): void => {
    localStorage.removeItem('jwt_token');
  };

  /**
   * Create axios instance with auth header
   */
  const createAuthAxios = () => {
    const token = getToken();
    return axios.create({
      baseURL: BACKEND_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  };

  /**
   * Handle OAuth callback and extract JWT token from URL
   */
  const handleAuthCallback = useCallback(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    if (token) {
      // Store JWT token and clear URL params
      setToken(token);
      window.history.replaceState({}, document.title, window.location.pathname);
      // Auth status check will be handled by the useEffect after this
      return true; // Indicate token was processed
    }

    if (urlParams.get('auth') === 'success') {
      // Remove URL parameters after successful auth
      window.history.replaceState({}, document.title, window.location.pathname);
      return false; // No token processed, auth check can proceed
    }

    if (urlParams.get('error')) {
      const errorType = urlParams.get('error');
      const errorMessages: { [key: string]: string } = {
        oauth_failed: 'GitHub authentication failed. Please try again.',
        oauth_callback_failed: 'OAuth callback failed. Please try again.',
      };
      setError(
        errorMessages[errorType!] || 'Authentication failed. Please try again.'
      );
      window.history.replaceState({}, document.title, window.location.pathname);
      return false; // Error processed, no auth check needed
    }

    return false; // No callback parameters found
  }, []);

  /**
   * Check if user is currently authenticated using JWT
   */
  const checkAuthStatus = useCallback(async () => {
    try {
      setLoading(true);
      const token = getToken();

      if (!token) {
        setUser(null);
        setOAuthProfile(null);
        return;
      }

      const authAxios = createAuthAxios();

      // Check auth status
      const authResponse = await authAxios.get<{
        authenticated: boolean;
        user: { id: string; username: string; role: string } | null;
      }>('/api/auth/status');

      if (authResponse.data.authenticated && authResponse.data.user) {
        // Get full user details
        const userResponse = await authAxios.get<AuthResponse>('/api/user');
        if (userResponse.data.success && userResponse.data.user) {
          setUser(userResponse.data.user);

          // Get OAuth profile if available
          try {
            const profileResponse =
              await authAxios.get<AuthResponse>('/api/oauth/profile');
            if (profileResponse.data.success && profileResponse.data.profile) {
              setOAuthProfile(profileResponse.data.profile);
            }
          } catch (_profileError) {
            // OAuth profile is optional
          }

          setError(null);
        } else {
          // Invalid token
          removeToken();
          setUser(null);
          setOAuthProfile(null);
        }
      } else {
        // Token invalid or expired
        removeToken();
        setUser(null);
        setOAuthProfile(null);
      }
    } catch (_error: unknown) {
      // Remove invalid token
      removeToken();
      setUser(null);
      setOAuthProfile(null);
    } finally {
      setLoading(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Initiate GitHub OAuth login
   */
  const handleGitHubLogin = () => {
    setError(null);
    // Redirect to backend GitHub auth route
    window.location.href = `${BACKEND_URL}/api/auth/oauth/github`;
  };

  /**
   * Handle user logout
   */
  const handleLogout = async () => {
    try {
      setLoading(true);
      const authAxios = createAuthAxios();

      // Call logout endpoint (mainly for server-side cleanup)
      await authAxios.post('/logout');

      // Remove token and clear state
      removeToken();
      setUser(null);
      setOAuthProfile(null);
      setError(null);
    } catch (error: unknown) {
      console.error('Logout error:', error);
      // Even if server logout fails, clear local state
      removeToken();
      setUser(null);
      setOAuthProfile(null);
      setError('Logout completed (with warnings)');
    } finally {
      setLoading(false);
    }
  };

  /**
   * Initialize authentication on component mount
   */
  useEffect(() => {
    if (initialized) return; // Prevent double execution

    let isMounted = true;

    const initializeAuth = async () => {
      if (!isMounted) return;

      setInitialized(true);

      // First handle any OAuth callback
      const tokenProcessed = handleAuthCallback();

      // Only check auth status if no token was just processed
      if (!tokenProcessed) {
        // Small delay to avoid race conditions
        setTimeout(() => {
          if (isMounted) {
            checkAuthStatus();
          }
        }, 50);
      } else {
        // Token was processed, check auth with the new token
        setTimeout(() => {
          if (isMounted) {
            checkAuthStatus();
          }
        }, 100);
      }
    };

    initializeAuth();

    return () => {
      isMounted = false;
    };
  }, [initialized]); // eslint-disable-line react-hooks/exhaustive-deps

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
              {oauthProfile?.avatarUrl ? (
                <img
                  src={oauthProfile.avatarUrl}
                  alt={user.username}
                  className='w-16 h-16 rounded-full border-2 border-gray-200'
                />
              ) : (
                <User className='w-16 h-16 text-gray-400' />
              )}
            </div>

            <h2 className='text-xl font-semibold text-gray-800 mb-2'>
              {oauthProfile?.username || user.username}
            </h2>

            <div className='text-gray-600 mb-6 space-y-1'>
              <p>User ID: {user.id}</p>
              <p>Role: {user.role}</p>
              {oauthProfile && (
                <>
                  <p>GitHub: {oauthProfile.githubId}</p>
                  <p>Provider: {oauthProfile.provider}</p>
                </>
              )}
            </div>

            <button
              onClick={handleLogout}
              className='inline-flex items-center px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-medium rounded-md transition-colors duration-200'
            >
              <LogOut className='w-4 h-4 mr-2' />
              Logout
            </button>

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
