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
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:hugging-face-auth-button');

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
          logger.debug('Hugging Face OAuth configured:', data.configured);
        } else {
          logger.debug('Hugging Face OAuth status check failed');
          setIsConfigured(false);
        }
      } catch (error) {
        // Hugging Face OAuth not configured, hide the button
        logger.debug('Hugging Face OAuth not configured:', error);
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
      className='flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface-raised px-4 text-sm font-medium text-ink shadow-subtle transition-colors hover:border-line-strong hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
    >
      {isLoading ? (
        <div className='flex items-center'>
          <Loader2 size={16} className='me-2 animate-spin' />
          {t('auth.oauth.connectingTo', {
            provider: t('auth.oauth.huggingFace'),
          })}
        </div>
      ) : (
        <div className='flex items-center'>
          <span className='me-2 text-base'>🤗</span>
          {t('auth.oauth.continueWith', {
            provider: t('auth.oauth.huggingFace'),
          })}
        </div>
      )}
    </button>
  );
};

export default HuggingFaceAuthButton;
