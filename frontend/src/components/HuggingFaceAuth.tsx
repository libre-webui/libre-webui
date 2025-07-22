/*
 * Libre WebUI - Hugging Face OAuth2 Login Component (JWT Integration)
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useState, useCallback } from 'react';
import { Heart, Loader2, User, LogOut } from 'lucide-react';
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
  huggingfaceId: string;
  username: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
}

/**
 * API Response structure
 */
interface AuthResponse {
  success: boolean;
  user?: AppUser;
  profile?: OAuthProfile;
  message?: string;
}

/**
 * Configuration from environment
 */
const BACKEND_URL =
  import.meta.env.VITE_API_BASE_URL || 'http://localhost:3001/api';

interface HuggingFaceAuthProps {
  onAuthSuccess?: (user: AppUser) => void;
  _onAuthError?: (error: string) => void;
}

export const HuggingFaceAuth: React.FC<HuggingFaceAuthProps> = ({
  onAuthSuccess,
  _onAuthError,
}) => {
  const [user, setUser] = useState<AppUser | null>(null);
  const [oauthProfile, setOAuthProfile] = useState<OAuthProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [configured, setConfigured] = useState(false);
  const [initialized, setInitialized] = useState(false);

  /**
   * Get JWT token from localStorage
   */
  const getToken = useCallback((): string | null => {
    return localStorage.getItem('jwt_token');
  }, []);

  /**
   * Set JWT token in localStorage
   */
  const setToken = useCallback((token: string): void => {
    localStorage.setItem('jwt_token', token);
  }, []);

  /**
   * Remove JWT token from localStorage
   */
  const removeToken = useCallback((): void => {
    localStorage.removeItem('jwt_token');
  }, []);

  /**
   * Create axios instance with auth header
   */
  const createAuthAxios = useCallback(() => {
    const token = getToken();
    return axios.create({
      baseURL: BACKEND_URL,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
  }, [getToken]);

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
        oauth_failed: 'Hugging Face authentication failed. Please try again.',
        oauth_callback_failed: 'OAuth callback failed. Please try again.',
        oauth_not_configured:
          'Hugging Face OAuth is not configured on this server.',
      };
      setError(
        errorMessages[errorType!] || 'Authentication failed. Please try again.'
      );
      window.history.replaceState({}, document.title, window.location.pathname);
      return false; // Error processed, no auth check needed
    }

    return false; // No callback parameters found
  }, [setToken]);

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
      }>('/auth/status');

      if (authResponse.data.authenticated && authResponse.data.user) {
        // Get full user details
        const userResponse = await authAxios.get<AuthResponse>('/user');
        if (userResponse.data.success && userResponse.data.user) {
          setUser(userResponse.data.user);

          // Get OAuth profile if available
          try {
            const profileResponse =
              await authAxios.get<AuthResponse>('/oauth/profile');
            if (profileResponse.data.success && profileResponse.data.profile) {
              setOAuthProfile(profileResponse.data.profile);
            }
          } catch (_profileError) {
            // OAuth profile is optional
          }

          setError(null);
          onAuthSuccess?.(userResponse.data.user);
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
  }, [getToken, createAuthAxios, removeToken, onAuthSuccess]);

  /**
   * Initiate Hugging Face OAuth login
   */
  const handleLogin = () => {
    setLoading(true);
    setError(null);
    // Redirect to Hugging Face OAuth endpoint
    window.location.href = `${BACKEND_URL}/auth/oauth/huggingface`;
  };

  /**
   * Logout user and clear tokens
   */
  const handleLogout = async () => {
    try {
      setLoading(true);
      setError(null);

      const authAxios = createAuthAxios();

      // Call logout endpoint
      await authAxios.post('/auth/logout');

      // Clear local state
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
   * Check if Hugging Face OAuth is configured on the server
   */
  const checkOAuthConfiguration = useCallback(async () => {
    try {
      const response = await axios.get(
        `${BACKEND_URL}/auth/oauth/huggingface/status`
      );
      setConfigured(response.data.configured);
    } catch (error) {
      console.error('Failed to check Hugging Face OAuth configuration:', error);
      setConfigured(false);
    }
  }, []);

  /**
   * Initialize authentication on component mount
   */
  useEffect(() => {
    if (initialized) return; // Prevent double execution

    let isMounted = true;

    const initializeAuth = async () => {
      if (!isMounted) return;

      setInitialized(true);

      // First check if OAuth is configured
      await checkOAuthConfiguration();

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
  }, [
    initialized,
    handleAuthCallback,
    checkAuthStatus,
    checkOAuthConfiguration,
  ]);

  // Don't render if not configured
  if (!configured) {
    return null;
  }

  if (loading) {
    return (
      <button
        disabled
        className='w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 text-white rounded-lg font-medium opacity-75 cursor-not-allowed'
      >
        <Loader2 className='h-4 w-4 animate-spin' />
        Loading...
      </button>
    );
  }

  if (user) {
    return (
      <div className='w-full space-y-3'>
        {/* User Info */}
        <div className='flex items-center gap-3 p-3 bg-orange-50 border border-orange-200 rounded-lg'>
          <div className='flex-shrink-0'>
            <User className='h-5 w-5 text-orange-600' />
          </div>
          <div className='flex-1 min-w-0'>
            <p className='text-sm font-medium text-orange-900'>
              {user.username}
            </p>
            {user.email && (
              <p className='text-xs text-orange-700 truncate'>{user.email}</p>
            )}
            {oauthProfile && (
              <p className='text-xs text-orange-600'>
                🤗 {oauthProfile.provider} • {oauthProfile.username}
              </p>
            )}
          </div>
        </div>

        {/* Logout Button */}
        <button
          onClick={handleLogout}
          className='w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-medium transition-colors duration-200'
        >
          <LogOut className='h-4 w-4' />
          Sign Out
        </button>
      </div>
    );
  }

  return (
    <div className='w-full space-y-3'>
      {/* Login Button */}
      <button
        onClick={handleLogin}
        className='w-full flex items-center justify-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-700 text-white rounded-lg font-medium transition-colors duration-200'
      >
        <Heart className='h-4 w-4' />
        Continue with Hugging Face
      </button>

      {/* Error Display */}
      {error && (
        <div className='p-3 bg-red-50 border border-red-200 rounded-lg'>
          <p className='text-sm text-red-700'>{error}</p>
        </div>
      )}
    </div>
  );
};

export default HuggingFaceAuth;
