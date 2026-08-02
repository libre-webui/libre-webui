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

import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import { Clock3, Eye, EyeOff, LogIn } from 'lucide-react';
import { GitHubAuthButton } from '@/components/GitHubAuthButton';
import { HuggingFaceAuthButton } from '@/components/HuggingFaceAuthButton';
import { isDemoMode } from '@/utils/demoMode';
import { useOAuthProviders } from '@/hooks/useOAuthProviders';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { TurnstileWidget } from '@/components/TurnstileWidget';

const logger = createLogger('components:login-form');

interface LoginFormProps {
  onLogin?: () => void;
  onShowSignup?: () => void;
  initialApprovalPending?: boolean;
  /** Drops the card chrome so a page can supply its own framing. */
  bare?: boolean;
}

const DEMO_CREDENTIALS = {
  username: 'demo',
  password: 'demo',
};

export const LoginForm: React.FC<LoginFormProps> = ({
  onLogin,
  onShowSignup,
  initialApprovalPending = false,
  bare = false,
}) => {
  const { t } = useTranslation();
  const isDemo = isDemoMode();
  const oauth = useOAuthProviders();
  const [username, setUsername] = useState(
    isDemo ? DEMO_CREDENTIALS.username : ''
  );
  const [password, setPassword] = useState(
    isDemo ? DEMO_CREDENTIALS.password : ''
  );
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [approvalPending, setApprovalPending] = useState(
    initialApprovalPending
  );
  const [turnstileToken, setTurnstileToken] = useState('');
  const navigate = useNavigate();
  const { login, systemInfo } = useAuthStore();
  const turnstileSiteKey = systemInfo?.turnstile?.siteKey;
  const isTurnstileEnabled = Boolean(
    systemInfo?.turnstile?.enabled && turnstileSiteKey && !isDemo
  );
  const handleTurnstileTokenChange = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);
  const submitDisabled = useMemo(
    () => isLoading || (isTurnstileEnabled && !turnstileToken),
    [isLoading, isTurnstileEnabled, turnstileToken]
  );

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    const loginUsername = isDemo ? DEMO_CREDENTIALS.username : username.trim();
    const loginPassword = isDemo ? DEMO_CREDENTIALS.password : password.trim();

    if (!loginUsername || !loginPassword) {
      toast.error(t('auth.login.enterBoth'));
      return;
    }

    if (isTurnstileEnabled && !turnstileToken) {
      toast.error(
        t(
          'auth.login.verificationFailed',
          'Security verification failed. Please refresh and try again.'
        )
      );
      return;
    }

    setIsLoading(true);
    setApprovalPending(false);

    try {
      // Clear any existing auth data before login
      localStorage.removeItem('auth-token');

      const response = await authApi.login({
        username: loginUsername,
        password: loginPassword,
        turnstileToken,
      });

      if (response.success && response.data) {
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        toast.success(t('auth.login.loginSuccess'));
        onLogin?.();
        navigate('/');
      } else {
        toast.error(response.message || t('auth.login.loginFailed'));
      }
    } catch (error: unknown) {
      logger.error('Login error:', error);
      const apiError = error as {
        response?: { data?: { code?: string; message?: string } };
      };
      if (apiError.response?.data?.code === 'ACCOUNT_PENDING') {
        setApprovalPending(true);
        toast.error(
          apiError.response.data.message ||
            t(
              'auth.login.approvalPending',
              'Your account is waiting for administrator approval.'
            )
        );
      } else {
        toast.error(t('auth.login.checkCredentials'));
      }
    } finally {
      setTurnstileToken('');
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      // Find the form and trigger submit
      const form = e.currentTarget.form;
      if (form) {
        form.requestSubmit();
      }
    }
  };

  return (
    <div
      className={cn(
        'mx-auto w-full max-w-md',
        !bare &&
          'rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'
      )}
    >
      <div className={cn('mb-8', bare ? 'text-start' : 'text-center')}>
        <h1 className='mb-2 text-3xl font-light tracking-[-0.04em] text-ink'>
          {t('auth.login.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {t('auth.login.subtitle')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-5'>
        {approvalPending && (
          <div
            data-testid='login-approval-pending'
            role='status'
            className='flex gap-3 rounded-xl border border-warning-500/30 bg-warning-500/10 p-3 text-start'
          >
            <Clock3
              aria-hidden='true'
              className='mt-0.5 h-4 w-4 shrink-0 text-warning-700 dark:text-warning-400'
            />
            <p className='text-xs leading-5 text-ink-muted'>
              {t(
                'auth.login.approvalPending',
                'Your account is waiting for administrator approval.'
              )}
            </p>
          </div>
        )}
        <div>
          <label
            htmlFor='username'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.login.username')}
          </label>
          <input
            id='username'
            type='text'
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none'
            placeholder={t('auth.login.usernamePlaceholder')}
            required
            disabled={isLoading || isDemo}
          />
        </div>

        <div>
          <label
            htmlFor='password'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.login.password')}
          </label>
          <div className='relative'>
            <input
              id='password'
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 pe-11 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none'
              placeholder={t('auth.login.passwordPlaceholder')}
              required
              disabled={isLoading || isDemo}
            />
            <button
              type='button'
              onClick={() => setShowPassword(!showPassword)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={isLoading || isDemo}
              aria-label={
                showPassword ? 'Hide characters' : 'Reveal characters'
              }
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        {isTurnstileEnabled && turnstileSiteKey && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            action='login'
            disabled={isLoading}
            errorMessage={t(
              'auth.login.verificationFailed',
              'Security verification failed. Please refresh and try again.'
            )}
            onTokenChange={handleTurnstileTokenChange}
          />
        )}

        <button
          type='submit'
          disabled={submitDisabled}
          className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          {isLoading ? (
            <div className='flex items-center'>
              <div className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-current'></div>
              {t('auth.login.signingIn')}
            </div>
          ) : (
            <div className='flex items-center'>
              <LogIn size={16} className='me-2' />
              {t('auth.login.signIn')}
            </div>
          )}
        </button>
      </form>

      {!isDemo && (
        <>
          {/* Social sign-in, only when the backend has a provider configured */}
          {oauth.hasAny && (
            <div className='mt-6'>
              <div className='relative'>
                <div className='absolute inset-0 flex items-center'>
                  <div className='w-full border-t border-line' />
                </div>
                <div className='relative flex justify-center text-sm'>
                  <span
                    className={cn(
                      'px-2 text-ink-muted',
                      bare ? 'bg-canvas' : 'bg-surface-raised'
                    )}
                  >
                    {t('common.or')}
                  </span>
                </div>
              </div>

              <div className='mt-6 space-y-3'>
                {oauth.github && <GitHubAuthButton />}
                {oauth.huggingface && <HuggingFaceAuthButton />}
              </div>
            </div>
          )}

          {onShowSignup && (
            <div className='mt-6 text-center'>
              <p className='text-sm text-ink-muted'>
                {t('auth.login.noAccount')}{' '}
                <button
                  onClick={onShowSignup}
                  className='font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'
                >
                  {t('auth.login.signUpHere')}
                </button>
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
};
