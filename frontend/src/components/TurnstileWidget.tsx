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

import React, { useEffect, useRef, useState } from 'react';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:turnstile-widget');

const TURNSTILE_SCRIPT_URL =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

type TurnstileWidgetId = string;

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      theme: 'auto';
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
    }
  ) => TurnstileWidgetId;
  reset: (widgetId?: TurnstileWidgetId) => void;
  remove?: (widgetId: TurnstileWidgetId) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

interface TurnstileWidgetProps {
  siteKey: string;
  disabled?: boolean;
  errorMessage: string;
  onTokenChange: (token: string) => void;
}

let turnstileScriptPromise: Promise<void> | null = null;

const loadTurnstileScript = (): Promise<void> => {
  if (window.turnstile) {
    return Promise.resolve();
  }

  if (turnstileScriptPromise) {
    return turnstileScriptPromise;
  }

  turnstileScriptPromise = new Promise((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_URL}"]`
    );

    if (existingScript) {
      existingScript.addEventListener('load', () => resolve(), { once: true });
      existingScript.addEventListener('error', reject, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = reject;
    document.head.appendChild(script);
  });

  return turnstileScriptPromise;
};

export const TurnstileWidget: React.FC<TurnstileWidgetProps> = ({
  siteKey,
  disabled = false,
  errorMessage,
  onTokenChange,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<TurnstileWidgetId | null>(null);
  const [scriptFailed, setScriptFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    onTokenChange('');

    loadTurnstileScript()
      .then(() => {
        if (cancelled || !container || !window.turnstile) {
          return;
        }

        container.innerHTML = '';
        widgetIdRef.current = window.turnstile.render(container, {
          sitekey: siteKey,
          theme: 'auto',
          callback: token => onTokenChange(token),
          'expired-callback': () => onTokenChange(''),
          'error-callback': () => onTokenChange(''),
        });
      })
      .catch(error => {
        logger.error('Turnstile script failed to load:', error);
        if (!cancelled) {
          setScriptFailed(true);
        }
      });

    return () => {
      cancelled = true;
      onTokenChange('');

      if (widgetIdRef.current && window.turnstile?.remove) {
        window.turnstile.remove(widgetIdRef.current);
      } else if (container) {
        container.innerHTML = '';
      }

      widgetIdRef.current = null;
    };
  }, [onTokenChange, siteKey]);

  useEffect(() => {
    if (disabled && widgetIdRef.current) {
      window.turnstile?.reset(widgetIdRef.current);
      onTokenChange('');
    }
  }, [disabled, onTokenChange]);

  if (scriptFailed) {
    return (
      <div className='rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300'>
        {errorMessage}
      </div>
    );
  }

  return (
    <div
      className={`rounded-lg border border-accent-200 bg-accent-50/40 p-3 transition-opacity dark:border-accent-800/70 dark:bg-accent-950/20 ${
        disabled ? 'pointer-events-none opacity-60' : ''
      }`}
      aria-label='Security verification'
    >
      <div ref={containerRef} className='min-h-[65px]' />
    </div>
  );
};
