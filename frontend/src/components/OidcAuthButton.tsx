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

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { KeyRound, Loader2 } from 'lucide-react';
import { API_BASE_URL } from '../utils/config';

interface OidcAuthButtonProps {
  /** Instance-chosen provider label from the OIDC status endpoint. */
  displayName?: string;
}

/**
 * Generic OIDC sign-in button. Rendering is gated by the caller (via
 * useOAuthProviders), so this component only starts the login flow.
 */
export const OidcAuthButton: React.FC<OidcAuthButtonProps> = ({
  displayName,
}) => {
  const { t } = useTranslation();
  const [isLoading, setIsLoading] = useState(false);
  const provider =
    displayName || t('auth.oidc.defaultProviderName', 'Single sign-on');

  const handleOidcLogin = () => {
    if (isLoading) {
      return;
    }

    setIsLoading(true);
    window.location.href = `${API_BASE_URL}/auth/oauth/oidc`;
  };

  return (
    <button
      type='button'
      onClick={handleOidcLogin}
      disabled={isLoading}
      className='flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface-raised px-4 text-sm font-medium text-ink shadow-subtle transition-colors hover:border-line-strong hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
    >
      {isLoading ? (
        <div className='flex items-center'>
          <Loader2 size={16} className='me-2 animate-spin' />
          {t('auth.oauth.connectingTo', { provider })}
        </div>
      ) : (
        <div className='flex items-center'>
          <KeyRound size={16} className='me-2' />
          {t('auth.oauth.continueWith', { provider })}
        </div>
      )}
    </button>
  );
};
