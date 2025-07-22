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

import React, { useEffect, useState } from 'react';
import { Github, Loader2 } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

/**
 * GitHub OAuth Button Component
 * Only shows if GitHub OAuth is configured (env variables present)
 */
export const GitHubAuthButton: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  // Check if GitHub OAuth is configured by testing the auth endpoint
  useEffect(() => {
    checkGitHubOAuthConfig();
    // OAuth callback handling is now done in useInitializeApp hook
  }, []);

  /**
   * Check if GitHub OAuth is configured on the backend
   */
  const checkGitHubOAuthConfig = async () => {
    try {
      // Check the OAuth status endpoint instead of the auth endpoint
      const response = await fetch(
        `${BACKEND_URL}/api/auth/oauth/github/status`,
        {
          method: 'GET',
          credentials: 'include',
        }
      );

      if (response.ok) {
        const data = await response.json();
        setIsConfigured(data.configured || false);
        console.log('GitHub OAuth configured:', data.configured);
      } else {
        console.log('GitHub OAuth status check failed');
        setIsConfigured(false);
      }
    } catch (error) {
      // GitHub OAuth not configured, hide the button
      console.log('GitHub OAuth not configured:', error);
      setIsConfigured(false);
    }
  };

  /**
   * Initiate GitHub OAuth login
   */
  const handleGitHubLogin = () => {
    if (!isConfigured || isLoading) {
      return;
    }

    setIsLoading(true);

    // Redirect to GitHub OAuth
    const githubAuthUrl = `${BACKEND_URL}/api/auth/oauth/github`;
    window.location.href = githubAuthUrl;
  };

  // Don't render if GitHub OAuth is not configured
  if (!isConfigured) {
    return null;
  }

  return (
    <>
      {/* Divider */}
      <div className='relative my-4'>
        <div className='absolute inset-0 flex items-center'>
          <div className='w-full border-t border-gray-300 dark:border-dark-300' />
        </div>
        <div className='relative flex justify-center text-sm'>
          <span className='px-2 bg-white dark:bg-dark-25 text-gray-500 dark:text-dark-500'>
            or
          </span>
        </div>
      </div>

      {/* GitHub OAuth Button */}
      <button
        type='button'
        onClick={handleGitHubLogin}
        disabled={isLoading}
        className='w-full flex items-center justify-center px-4 py-2 border border-gray-300 dark:border-dark-300 rounded-lg shadow-sm bg-white dark:bg-dark-100 text-gray-700 dark:text-dark-700 hover:bg-gray-50 dark:hover:bg-dark-150 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
      >
        {isLoading ? (
          <div className='flex items-center'>
            <Loader2 size={16} className='animate-spin mr-2' />
            Connecting to GitHub...
          </div>
        ) : (
          <div className='flex items-center'>
            <Github size={16} className='mr-2' />
            Continue with GitHub
          </div>
        )}
      </button>
    </>
  );
};
