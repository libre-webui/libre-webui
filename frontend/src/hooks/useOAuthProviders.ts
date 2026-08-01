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

export type OAuthProvider = 'github' | 'huggingface';

const probe = async (provider: OAuthProvider): Promise<boolean> => {
  try {
    const response = await fetch(
      `${API_BASE_URL}/auth/oauth/${provider}/status`,
      { method: 'GET', credentials: 'include' }
    );
    if (!response.ok) return false;
    const data = await response.json();
    return Boolean(data.configured);
  } catch (error) {
    logger.debug(`${provider} OAuth not configured:`, error);
    return false;
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
  });

  useEffect(() => {
    let active = true;
    Promise.all([probe('github'), probe('huggingface')]).then(
      ([github, huggingface]) => {
        if (active) setProviders({ github, huggingface });
      }
    );
    return () => {
      active = false;
    };
  }, []);

  return {
    ...providers,
    hasAny: providers.github || providers.huggingface,
  };
};
