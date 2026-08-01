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
import { Eye, EyeOff, UserPlus } from 'lucide-react';
import { GitHubAuthButton } from '@/components/GitHubAuthButton';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:signup-form');

interface SignupFormProps {
  onSignup?: () => void;
  onBackToLogin?: () => void;
  /** Drops the card chrome so a page can supply its own framing. */
  bare?: boolean;
}

export const SignupForm: React.FC<SignupFormProps> = ({
  onSignup,
  onBackToLogin,
  bare = false,
}) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const navigate = useNavigate();
  const { login, systemInfo } = useAuthStore();
  const turnstileSiteKey = systemInfo?.turnstile?.siteKey;
  const isTurnstileEnabled = Boolean(
    systemInfo?.turnstile?.enabled && turnstileSiteKey
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

    if (!username.trim() || !password.trim()) {
      toast.error(t('auth.signup.usernameRequired'));
      return;
    }

    if (password !== confirmPassword) {
      toast.error(t('auth.signup.passwordMismatch'));
      return;
    }

    if (password.length < 6) {
      toast.error(t('auth.signup.passwordTooShort'));
      return;
    }

    if (isTurnstileEnabled && !turnstileToken) {
      toast.error(t('auth.signup.tryAgain'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await authApi.signup({
        username,
        password,
        email,
        turnstileToken,
      });

      if (response.success && response.data) {
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        toast.success(t('auth.signup.signupSuccess'));
        onSignup?.();
        navigate('/');
      } else {
        toast.error(response.message || t('auth.signup.signupFailed'));
      }
    } catch (error) {
      logger.error('Signup error:', error);
      toast.error(t('auth.signup.tryAgain'));
    } finally {
      setTurnstileToken('');
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
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
          {t('auth.signup.title')}
        </h1>
        <p className='text-sm leading-6 text-ink-muted'>
          {t('auth.signup.subtitle')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-4'>
        <div>
          <label
            htmlFor='username'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.username')}
          </label>
          <input
            id='username'
            type='text'
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
            placeholder={t('auth.signup.usernamePlaceholder')}
            required
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='email'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.email')}{' '}
            <span className='text-ink-muted'>({t('common.optional')})</span>
          </label>
          <input
            id='email'
            type='email'
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            className='h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
            placeholder={t('auth.signup.emailPlaceholder')}
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='password'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.password')}
          </label>
          <div className='relative'>
            <input
              id='password'
              type={showPassword ? 'text' : 'password'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 pe-11 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
              placeholder={t('auth.signup.passwordPlaceholder')}
              required
              disabled={isLoading}
            />
            <button
              type='button'
              onClick={() => setShowPassword(!showPassword)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={isLoading}
              aria-label={
                showPassword ? 'Hide characters' : 'Reveal characters'
              }
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        <div>
          <label
            htmlFor='confirmPassword'
            className='mb-2 block text-sm font-medium text-ink'
          >
            {t('auth.signup.confirmPassword')}
          </label>
          <div className='relative'>
            <input
              id='confirmPassword'
              type={showConfirmPassword ? 'text' : 'password'}
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              onKeyDown={handleKeyDown}
              className='h-11 w-full rounded-xl border border-line bg-surface px-3 pe-11 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none'
              placeholder={t('auth.signup.confirmPasswordPlaceholder')}
              required
              disabled={isLoading}
            />
            <button
              type='button'
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className='absolute inset-y-0 end-0 flex items-center pe-3 text-ink-muted transition-colors hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'
              disabled={isLoading}
              aria-label={
                showConfirmPassword
                  ? 'Hide confirmation'
                  : 'Reveal confirmation'
              }
            >
              {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        {isTurnstileEnabled && turnstileSiteKey && (
          <TurnstileWidget
            siteKey={turnstileSiteKey}
            disabled={isLoading}
            errorMessage={t('auth.signup.tryAgain')}
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
              {t('auth.signup.creatingAccount')}
            </div>
          ) : (
            <div className='flex items-center'>
              <UserPlus size={16} className='me-2' />
              {t('auth.signup.createAccount')}
            </div>
          )}
        </button>
      </form>

      {/* GitHub OAuth Button */}
      <GitHubAuthButton />

      <div className='mt-6 text-center'>
        <p className='text-sm text-ink-muted'>
          {t('auth.signup.hasAccount')}{' '}
          <button
            onClick={onBackToLogin}
            className='font-medium text-primary-600 transition-colors hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'
          >
            {t('auth.signup.signInHere')}
          </button>
        </p>
      </div>
    </div>
  );
};
