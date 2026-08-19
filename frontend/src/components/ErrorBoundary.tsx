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

const logger = createLogger('components:error-boundary');

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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
    <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex items-center justify-center p-4 text-gray-900 dark:text-dark-800'>
      <div className='w-full max-w-md rounded-2xl border border-gray-200 dark:border-dark-300 bg-white/95 dark:bg-dark-100/95 shadow-card backdrop-blur-sm'>
        <div className='p-6 text-center'>
          <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-100 text-primary-700 dark:bg-primary-900/35 dark:text-primary-300 ring-1 ring-primary-200 dark:ring-primary-800/60'>
            <AlertTriangle className='h-6 w-6' />
          </div>
          <h1 className='mb-2 text-xl font-semibold text-gray-950 dark:text-dark-950'>
            {t('errorBoundary.title')}
          </h1>
          <p className='mb-5 text-sm leading-6 text-gray-600 dark:text-dark-600'>
            {t('errorBoundary.description')}
          </p>
          <div className='flex flex-col gap-2 sm:flex-row sm:justify-center'>
            <button
              onClick={() => window.location.reload()}
              className='inline-flex items-center justify-center gap-2 rounded-xl bg-primary-600 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-all hover:bg-primary-700 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:focus:ring-offset-dark-100'
            >
              <RefreshCw className='h-4 w-4' />
              {t('errorBoundary.tryAgain')}
            </button>
            <button
              onClick={() => {
                window.location.assign('/');
              }}
              className='inline-flex items-center justify-center gap-2 rounded-xl border border-gray-200 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 shadow-sm transition-all hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 dark:border-dark-300 dark:bg-dark-50 dark:text-dark-700 dark:hover:bg-dark-200 dark:focus:ring-offset-dark-100'
            >
              <Home className='h-4 w-4' />
              {t('common.home', 'Home')}
            </button>
          </div>
          {process.env.NODE_ENV === 'development' && error && (
            <details className='mt-5 text-left'>
              <summary className='cursor-pointer text-sm text-gray-500 transition-colors hover:text-primary-600 dark:text-dark-500 dark:hover:text-primary-300'>
                {t('errorBoundary.errorDetails')}
              </summary>
              <pre className='mt-2 max-h-60 overflow-auto rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700 dark:border-dark-300 dark:bg-dark-200 dark:text-dark-700'>
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
