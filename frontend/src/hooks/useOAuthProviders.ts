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

import { useEffect, useState } from 'react';
import { API_BASE_URL } from '@/utils/config';
import { createLogger } from '@/utils/logger';

const logger = createLogger('hooks:oauth-providers');

export type OAuthProvider = 'github' | 'huggingface' | 'oidc';

interface ProviderStatus {
  configured: boolean;
  /** Instance-chosen label for generic OIDC (e.g. "Acme SSO"). */
  displayName?: string;
}

const probe = async (provider: OAuthProvider): Promise<ProviderStatus> => {
  try {
    const response = await fetch(
      `${API_BASE_URL}/auth/oauth/${provider}/status`,
      { method: 'GET', credentials: 'include' }
    );
    if (!response.ok) return { configured: false };
    const data = await response.json();
    return {
      configured: Boolean(data.configured),
      displayName:
        typeof data.displayName === 'string' ? data.displayName : undefined,
    };
  } catch (error) {
    logger.debug(`${provider} OAuth not configured:`, error);
    return { configured: false };
  }
};

/**
 * Which social sign-in providers the backend has configured. Lets the sign-in
 * form drop its "or" divider entirely when none are available.
 */
export const useOAuthProviders = () => {
  const [providers, setProviders] = useState<Record<OAuthProvider, boolean>>({
    github: false,
    huggingface: false,
    oidc: false,
  });
  const [oidcDisplayName, setOidcDisplayName] = useState<string | undefined>(
    undefined
  );

  useEffect(() => {
    let active = true;
    Promise.all([probe('github'), probe('huggingface'), probe('oidc')]).then(
      ([github, huggingface, oidc]) => {
        if (!active) return;
        setProviders({
          github: github.configured,
          huggingface: huggingface.configured,
          oidc: oidc.configured,
        });
        setOidcDisplayName(oidc.displayName);
      }
    );
    return () => {
      active = false;
    };
  }, []);

  return {
    ...providers,
    oidcDisplayName,
    hasAny: providers.github || providers.huggingface || providers.oidc,
  };
};
