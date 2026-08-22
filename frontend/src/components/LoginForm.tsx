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
import { authApi, isMfaChallenge } from '@/utils/api';
import type { MfaChallengeResponse } from '@/utils/api';
import type { LoginResponse } from '@/types';
import {
  Clock3,
  Eye,
  EyeOff,
  KeyRound,
  LogIn,
  ShieldCheck,
} from 'lucide-react';
import { getPasskeyAssertion, passkeysSupported } from '@/utils/webauthnClient';
import { GitHubAuthButton } from '@/components/GitHubAuthButton';
import { HuggingFaceAuthButton } from '@/components/HuggingFaceAuthButton';
import { OidcAuthButton } from '@/components/OidcAuthButton';
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
  const [mfaChallenge, setMfaChallenge] = useState<MfaChallengeResponse | null>(
    null
  );
  const [mfaCode, setMfaCode] = useState('');
  const [enrollment, setEnrollment] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [pendingLogin, setPendingLogin] = useState<LoginResponse | null>(null);
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
    const loginPassword = isDemo ? DEMO_CREDENTIALS.password : password;

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
        if (isMfaChallenge(response.data)) {
          setMfaChallenge(response.data);
          setMfaCode('');
          if (response.data.requirement === 'enroll') {
            const enrollResponse = await authApi.mfaEnrollChallenge({
              challengeToken: response.data.challengeToken,
            });
            if (enrollResponse.success && enrollResponse.data) {
              setEnrollment(enrollResponse.data);
            } else {
              toast.error(enrollResponse.message || t('auth.mfa.enrollFailed'));
              setMfaChallenge(null);
            }
          }
          return;
        }
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

  const completeLogin = (data: LoginResponse) => {
    login(data.user, data.token, data.systemInfo);
    toast.success(t('auth.login.loginSuccess'));
    onLogin?.();
    navigate('/');
  };

  const handleMfaSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!mfaChallenge || !mfaCode.trim()) return;
    setIsLoading(true);
    try {
      if (mfaChallenge.requirement === 'enroll') {
        const response = await authApi.mfaActivateChallenge({
          challengeToken: mfaChallenge.challengeToken,
          code: mfaCode.trim(),
        });
        if (response.success && response.data) {
          const { recoveryCodes: codes, ...loginData } = response.data;
          setPendingLogin(loginData);
          setRecoveryCodes(codes);
        } else {
          toast.error(response.message || t('auth.mfa.invalidCode'));
        }
        return;
      }
      const response = await authApi.mfaVerify({
        challengeToken: mfaChallenge.challengeToken,
        code: mfaCode.trim(),
      });
      if (response.success && response.data) {
        completeLogin(response.data);
      } else {
        toast.error(response.message || t('auth.mfa.invalidCode'));
      }
    } catch (error: unknown) {
      const apiError = error as { response?: { data?: { message?: string } } };
      const message = apiError.response?.data?.message;
      if (message && /challenge/i.test(message)) {
        // The 5-minute challenge expired: back to the password step.
        toast.error(t('auth.mfa.challengeExpired'));
        setMfaChallenge(null);
        setEnrollment(null);
      } else {
        toast.error(message || t('auth.mfa.invalidCode'));
      }
    } finally {
      setMfaCode('');
      setIsLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    setIsLoading(true);
    try {
      const optionsResponse = await authApi.passkeyLoginOptions();
      if (!optionsResponse.success || !optionsResponse.data) {
        toast.error(optionsResponse.message || t('auth.passkeys.signInFailed'));
        return;
      }
      const credential = await getPasskeyAssertion(
        optionsResponse.data.publicKey
      );
      const response = await authApi.passkeyLogin({
        challengeToken: optionsResponse.data.challengeToken,
        credential,
      });
      if (response.success && response.data) {
        localStorage.removeItem('auth-token');
        completeLogin(response.data);
      } else {
        toast.error(response.message || t('auth.passkeys.signInFailed'));
      }
    } catch (error: unknown) {
      const domError = error as { name?: string };
      if (
        domError.name === 'NotAllowedError' ||
        domError.name === 'AbortError'
      ) {
        return; // The user dismissed the browser prompt.
      }
      const apiError = error as { response?: { data?: { message?: string } } };
      logger.error('Passkey login error:', error);
      toast.error(
        apiError.response?.data?.message || t('auth.passkeys.signInFailed')
      );
    } finally {
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

  const cardClass = cn(
    'mx-auto w-full max-w-md',
    !bare &&
      'rounded-3xl border border-line bg-surface-raised p-6 shadow-card sm:p-8'
  );

  const inputClass =
    'h-11 w-full rounded-xl border border-line bg-surface px-3 text-sm text-ink shadow-subtle outline-none transition-[border-color,box-shadow,background-color] placeholder:text-ink-muted focus:border-line-strong focus:ring-2 focus:ring-primary-500/35 disabled:cursor-not-allowed disabled:bg-surface-subtle disabled:text-ink-muted motion-reduce:transition-none';

  if (recoveryCodes && pendingLogin) {
    return (
      <div className={cardClass} data-testid='login-recovery-codes'>
        <div className={cn('mb-6', bare ? 'text-start' : 'text-center')}>
          <h1 className='mb-2 text-2xl font-light tracking-[-0.04em] text-ink'>
            {t('auth.mfa.recoveryCodesTitle')}
          </h1>
          <p className='text-sm leading-6 text-ink-muted'>
            {t('auth.mfa.recoveryCodesHint')}
          </p>
        </div>
        <div className='mb-6 grid grid-cols-2 gap-2 rounded-xl border border-line bg-surface p-4 font-mono text-sm text-ink'>
          {recoveryCodes.map(code => (
            <span key={code} dir='ltr'>
              {code}
            </span>
          ))}
        </div>
        <button
          type='button'
          onClick={() => completeLogin(pendingLogin)}
          className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          {t('auth.mfa.recoveryCodesSaved')}
        </button>
      </div>
    );
  }

  if (mfaChallenge) {
    const enrolling = mfaChallenge.requirement === 'enroll';
    return (
      <div className={cardClass} data-testid='login-mfa-step'>
        <div className={cn('mb-6', bare ? 'text-start' : 'text-center')}>
          <div
            className={cn(
              'mb-3 flex',
              bare ? 'justify-start' : 'justify-center'
            )}
          >
            <ShieldCheck aria-hidden='true' className='h-8 w-8 text-ink' />
          </div>
          <h1 className='mb-2 text-2xl font-light tracking-[-0.04em] text-ink'>
            {enrolling ? t('auth.mfa.setupTitle') : t('auth.mfa.verifyTitle')}
          </h1>
          <p className='text-sm leading-6 text-ink-muted'>
            {enrolling ? t('auth.mfa.setupSubtitle') : t('auth.mfa.verifyHint')}
          </p>
        </div>
        {enrolling && enrollment && (
          <div className='mb-5 space-y-3 rounded-xl border border-line bg-surface p-4 text-start'>
            <p className='text-xs leading-5 text-ink-muted'>
              {t('auth.mfa.secretHint')}
            </p>
            <code
              dir='ltr'
              data-testid='mfa-enroll-secret'
              className='block break-all font-mono text-sm text-ink'
            >
              {enrollment.secret}
            </code>
            <a
              href={enrollment.otpauthUrl}
              dir='ltr'
              className='inline-block text-xs font-medium text-primary-600 hover:text-primary-700 dark:text-primary-400'
            >
              {t('auth.mfa.openAuthenticator')}
            </a>
          </div>
        )}
        <form onSubmit={handleMfaSubmit} className='space-y-5'>
          <div>
            <label
              htmlFor='mfa-code'
              className='mb-2 block text-sm font-medium text-ink'
            >
              {enrolling
                ? t('auth.mfa.codeLabel')
                : t('auth.mfa.codeOrRecoveryLabel')}
            </label>
            <input
              id='mfa-code'
              data-testid='mfa-code-input'
              type='text'
              inputMode='numeric'
              autoComplete='one-time-code'
              autoFocus
              dir='ltr'
              value={mfaCode}
              onChange={e => setMfaCode(e.target.value)}
              className={inputClass}
              placeholder={t('auth.mfa.codePlaceholder')}
              required
              disabled={isLoading}
            />
          </div>
          <button
            type='submit'
            disabled={isLoading || !mfaCode.trim()}
            className='flex h-11 w-full items-center justify-center rounded-xl border border-transparent bg-ink px-4 text-sm font-medium text-ink-inverse shadow-subtle transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
          >
            {isLoading ? (
              <div className='flex items-center'>
                <div className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-current'></div>
                {t('auth.login.signingIn')}
              </div>
            ) : (
              t('auth.mfa.verifyButton')
            )}
          </button>
          <button
            type='button'
            onClick={() => {
              setMfaChallenge(null);
              setEnrollment(null);
              setMfaCode('');
            }}
            className='w-full text-center text-sm font-medium text-ink-muted transition-colors hover:text-ink'
          >
            {t('auth.mfa.backToSignIn')}
          </button>
        </form>
      </div>
    );
  }

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

      {!isDemo && passkeysSupported() && systemInfo?.passkeysInUse && (
        <button
          type='button'
          data-testid='passkey-signin-button'
          onClick={handlePasskeyLogin}
          disabled={isLoading}
          className='mt-3 flex h-11 w-full items-center justify-center rounded-xl border border-line bg-surface px-4 text-sm font-medium text-ink shadow-subtle transition-colors hover:bg-surface-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-40 motion-reduce:transition-none'
        >
          <KeyRound size={16} className='me-2' />
          {t('auth.passkeys.signInButton')}
        </button>
      )}

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
                {oauth.oidc && (
                  <OidcAuthButton displayName={oauth.oidcDisplayName} />
                )}
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
