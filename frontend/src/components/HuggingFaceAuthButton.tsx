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
import { Heart, Loader2 } from 'lucide-react';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

/**
 * Hugging Face OAuth Button Component
 * Only shows if Hugging Face OAuth is configured (env variables present)
 */
export const HuggingFaceAuthButton: React.FC = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  // Check if Hugging Face OAuth is configured by testing the auth endpoint
  useEffect(() => {
    checkHuggingFaceOAuthConfig();
    // OAuth callback handling is now done in useInitializeApp hook
  }, []);

  /**
   * Check if Hugging Face OAuth is configured on the backend
   */
  const checkHuggingFaceOAuthConfig = async () => {
    try {
      // Check the OAuth status endpoint instead of the auth endpoint
      const response = await fetch(
        `${BACKEND_URL}/api/auth/oauth/huggingface/status`,
        {
          method: 'GET',
          credentials: 'include',
        }
      );

      if (response.ok) {
        const data = await response.json();
        setIsConfigured(data.configured);
      } else {
        setIsConfigured(false);
      }
    } catch (error) {
      console.error('Error checking Hugging Face OAuth config:', error);
      setIsConfigured(false);
    }
  };

  /**
   * Handle Hugging Face OAuth login
   */
  const handleHuggingFaceLogin = () => {
    setIsLoading(true);
    // Redirect to the Hugging Face OAuth endpoint
    window.location.href = `${BACKEND_URL}/api/auth/oauth/huggingface`;
  };

  // Don't render if Hugging Face OAuth is not configured
  if (!isConfigured) {
    return null;
  }

  return (
    <div className='mb-4'>
      <div className='relative'>
        <div className='absolute inset-0 flex items-center'>
          <span className='w-full border-t border-gray-300' />
        </div>
        <div className='relative flex justify-center text-sm'>
          <span className='px-2 bg-white text-gray-500'>or</span>
        </div>
      </div>

      <div className='mt-4'>
        <button
          type='button'
          onClick={handleHuggingFaceLogin}
          disabled={isLoading}
          className='w-full inline-flex justify-center items-center py-2 px-4 border border-transparent rounded-md shadow-sm bg-orange-600 text-sm font-medium text-white hover:bg-orange-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-orange-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
        >
          {isLoading ? (
            <>
              <Loader2 className='w-4 h-4 mr-2 animate-spin' />
              Connecting...
            </>
          ) : (
            <>
              <Heart className='w-4 h-4 mr-2' />
              Continue with Hugging Face
            </>
          )}
        </button>
      </div>
    </div>
  );
};

export default HuggingFaceAuthButton;
