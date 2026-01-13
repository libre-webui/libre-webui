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
import { useTranslation } from 'react-i18next';
import { Loader2 } from 'lucide-react';
import { API_BASE_URL } from '../utils/config';

/**
 * Hugging Face OAuth Button Component
 * Only shows if Hugging Face OAuth is configured (env variables present)
 */
export const HuggingFaceAuthButton: React.FC = () => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  // Check if Hugging Face OAuth is configured by testing the auth endpoint
  useEffect(() => {
    /**
     * Check if Hugging Face OAuth is configured on the backend
     */
    const checkHuggingFaceOAuthConfig = async () => {
      try {
        // Check the OAuth status endpoint instead of the auth endpoint
        const response = await fetch(
          `${API_BASE_URL}/auth/oauth/huggingface/status`,
          {
            method: 'GET',
            credentials: 'include',
          }
        );

        if (response.ok) {
          const data = await response.json();
          setIsConfigured(data.configured || false);
          console.log('Hugging Face OAuth configured:', data.configured);
        } else {
          console.log('Hugging Face OAuth status check failed');
          setIsConfigured(false);
        }
      } catch (error) {
        // Hugging Face OAuth not configured, hide the button
        console.log('Hugging Face OAuth not configured:', error);
        setIsConfigured(false);
      }
    };

    checkHuggingFaceOAuthConfig();
    // OAuth callback handling is now done in useInitializeApp hook
  }, []);

  /**
   * Initiate Hugging Face OAuth login
   */
  const handleHuggingFaceLogin = () => {
    if (!isConfigured || isLoading) {
      return;
    }

    setIsLoading(true);

    // Redirect to Hugging Face OAuth
    const hfAuthUrl = `${API_BASE_URL}/auth/oauth/huggingface`;
    window.location.href = hfAuthUrl;
  };

  // Don't render if Hugging Face OAuth is not configured
  if (!isConfigured) {
    return null;
  }

  return (
    <button
      type='button'
      onClick={handleHuggingFaceLogin}
      disabled={isLoading}
      className='w-full flex items-center justify-center px-4 py-2 border border-orange-300 dark:border-orange-600 rounded-lg shadow-sm bg-orange-50 dark:bg-orange-900/20 text-orange-700 dark:text-orange-300 hover:bg-orange-100 dark:hover:bg-orange-900/30 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
    >
      {isLoading ? (
        <div className='flex items-center'>
          <Loader2 size={16} className='animate-spin mr-2' />
          {t('auth.oauth.connectingTo', {
            provider: t('auth.oauth.huggingFace'),
          })}
        </div>
      ) : (
        <div className='flex items-center'>
          <span className='mr-2 text-base'>🤗</span>
          {t('auth.oauth.continueWith', {
            provider: t('auth.oauth.huggingFace'),
          })}
        </div>
      )}
    </button>
  );
};

export default HuggingFaceAuthButton;
