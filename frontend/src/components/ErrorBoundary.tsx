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

import React, { Component, ErrorInfo, ReactNode, useEffect } from 'react';
import { isRouteErrorResponse, useRouteError } from 'react-router';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Home, RefreshCw } from 'lucide-react';
import { createLogger } from '@/utils/logger';
import { Button } from '@/components/ui/Button';

const logger = createLogger('components:error-boundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /**
   * Changing this value clears a caught error, so navigating away from a
   * crashed page recovers without a full reload.
   */
  resetKey?: unknown;
}

interface State {
  hasError: boolean;
  error?: Error;
}

// The app-level fallback should feel like Libre WebUI, not the browser's default
// crash card. Keep this local so ErrorBoundary remains self-contained.
const DefaultErrorFallback: React.FC<{ error?: Error }> = ({ error }) => {
  const { t } = useTranslation();

  return (
    // h-full keeps the card centered inside the shell's content area; the
    // transparent fill leaves wallpaper and theme surfaces intact.
    <div className='flex h-full min-h-[60vh] items-center justify-center p-4 text-ink'>
      <div
        role='alert'
        className='w-full max-w-md rounded-xl border border-line bg-surface-raised shadow-card'
      >
        <div className='p-6 text-center'>
          <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-error-500/10 text-error-600 dark:text-error-400'>
            <AlertTriangle className='h-6 w-6' aria-hidden='true' />
          </div>
          <h1 className='mb-2 text-xl font-semibold text-ink'>
            {t('errorBoundary.title')}
          </h1>
          <p className='mb-5 text-sm leading-6 text-ink-muted'>
            {t('errorBoundary.description')}
          </p>
          <div className='flex flex-col gap-2 sm:flex-row sm:justify-center'>
            <Button type='button' onClick={() => window.location.reload()}>
              <RefreshCw className='h-4 w-4' aria-hidden='true' />
              {t('errorBoundary.tryAgain')}
            </Button>
            <Button
              type='button'
              variant='secondary'
              onClick={() => {
                // Electron serves file:// with a hash router; '/' would leave
                // the bundled app entirely.
                if (window.location.protocol === 'file:') {
                  window.location.hash = '#/';
                  window.location.reload();
                } else {
                  window.location.assign('/');
                }
              }}
            >
              <Home className='h-4 w-4' aria-hidden='true' />
              {t('errorBoundary.goHome')}
            </Button>
          </div>
          {process.env.NODE_ENV === 'development' && error && (
            <details className='mt-5 text-start'>
              <summary className='cursor-pointer text-sm text-ink-muted transition-colors hover:text-ink'>
                {t('errorBoundary.errorDetails')}
              </summary>
              <pre
                dir='ltr'
                className='mt-2 max-h-60 overflow-auto rounded-xl border border-line bg-surface-subtle p-3 text-start text-xs text-ink-muted'
              >
                {error.stack}
              </pre>
            </details>
          )}
        </div>
      </div>
    </div>
  );
};

// Route-level errors are intercepted by the data router before they reach
// the app-level ErrorBoundary, so without this the router renders its bare
// developer stack-trace page. Same branded card, sourced via useRouteError.
export const RouteErrorScreen: React.FC = () => {
  const routeError = useRouteError();

  useEffect(() => {
    logger.error('Route error screen caught an error:', routeError);
  }, [routeError]);

  const error =
    routeError instanceof Error
      ? routeError
      : isRouteErrorResponse(routeError)
        ? new Error(`${routeError.status} ${routeError.statusText}`)
        : new Error(String(routeError));

  return <DefaultErrorFallback error={error} />;
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidUpdate(previous: Props) {
    if (this.state.hasError && previous.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false, error: undefined });
    }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('ErrorBoundary caught an error:', error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return <DefaultErrorFallback error={this.state.error} />;
    }

    return this.props.children;
  }
}
