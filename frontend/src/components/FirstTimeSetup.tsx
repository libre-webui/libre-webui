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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import {
  Eye,
  EyeOff,
  UserPlus,
  ArrowRight,
  Shield,
  Zap,
  Globe,
  Key,
  Copy,
  Check,
  AlertTriangle,
} from 'lucide-react';
import { Logo } from '@/components/Logo';
import { TurnstileWidget } from '@/components/TurnstileWidget';
import { createLogger } from '@/utils/logger';
import {
  getPasswordPolicyError,
  PASSWORD_REQUIREMENTS,
} from '@/utils/passwordPolicy';

const logger = createLogger('components:first-time-setup');

interface FirstTimeSetupProps {
  onComplete?: () => void;
}

export const FirstTimeSetup: React.FC<FirstTimeSetupProps> = ({
  onComplete,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<
    'welcome' | 'create-admin' | 'encryption-key'
  >('welcome');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [keyCopied, setKeyCopied] = useState(false);
  const [keyAcknowledged, setKeyAcknowledged] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState('');
  const { login, systemInfo } = useAuthStore();
  const turnstileSiteKey = systemInfo?.turnstile?.siteKey;
  const isTurnstileEnabled = Boolean(
    systemInfo?.turnstile?.enabled && turnstileSiteKey
  );
  const handleTurnstileTokenChange = useCallback((token: string) => {
    setTurnstileToken(token);
  }, []);
  const createAdminDisabled = useMemo(
    () => isLoading || (isTurnstileEnabled && !turnstileToken),
    [isLoading, isTurnstileEnabled, turnstileToken]
  );

  // Fetch encryption key when entering that step
  useEffect(() => {
    if (step === 'encryption-key' && !encryptionKey) {
      authApi.getEncryptionKey().then(response => {
        if (response.success && response.data) {
          setEncryptionKey(response.data.encryptionKey);
        }
      });
    }
  }, [step, encryptionKey]);

  const handleCreateAdmin = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (!username.trim() || !password.trim() || !confirmPassword.trim()) {
      toast.error(t('setup.admin.fillAllFields'));
      return;
    }

    if (password !== confirmPassword) {
      toast.error(t('auth.signup.passwordMismatch'));
      return;
    }

    const passwordError = getPasswordPolicyError(password);
    if (passwordError) {
      toast.error(passwordError);
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
        email: '',
        turnstileToken,
      });

      if (response.success && response.data) {
        if (!('token' in response.data)) {
          toast.error(
            t(
              'setup.admin.approvalUnexpected',
              'The initial administrator could not be activated. Please try again.'
            )
          );
          return;
        }
        login(
          response.data.user,
          response.data.token,
          response.data.systemInfo
        );
        toast.success(t('setup.admin.success'));
        // Show encryption key step before completing
        setStep('encryption-key');
      } else {
        toast.error(response.message || t('setup.admin.failed'));
      }
    } catch (error) {
      logger.error('Admin creation error:', error);
      toast.error(t('setup.admin.failed'));
    } finally {
      setTurnstileToken('');
      setIsLoading(false);
    }
  };

  const handleCopyKey = async () => {
    if (encryptionKey) {
      try {
        await navigator.clipboard.writeText(encryptionKey);
        setKeyCopied(true);
        toast.success(t('setup.encryptionKey.copied'));
        setTimeout(() => setKeyCopied(false), 3000);
      } catch {
        toast.error(t('setup.encryptionKey.copyFailed'));
      }
    }
  };

  const handleComplete = () => {
    if (!keyAcknowledged) {
      toast.error(t('setup.encryptionKey.confirmRequired'));
      return;
    }
    onComplete?.();
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

  if (step === 'welcome') {
    return (
      <div className='min-h-screen bg-gray-50 px-4 py-16 dark:bg-dark-50 sm:px-6 lg:flex lg:flex-col lg:justify-center lg:py-20'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex flex-col items-center'>
            <Logo className='text-gray-900 dark:text-gray-100' />
          </div>
        </div>

        <div className='mt-10 sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='mx-auto w-full max-w-md rounded-2xl border border-gray-200/80 bg-white/80 p-6 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] sm:p-8'>
            <div className='mb-7 text-start'>
              <h1 className='mb-2 text-2xl font-normal tracking-[-0.03em] text-gray-950 dark:text-dark-950'>
                {t('setup.welcome.subtitle')}
              </h1>
              <p className='text-gray-600 dark:text-dark-500'>
                {t('setup.welcome.description')}
              </p>
            </div>

            {/* Features */}
            <div className='mb-7 divide-y divide-gray-200/70 border-y border-gray-200/70 dark:divide-white/[0.08] dark:border-white/[0.08]'>
              <div className='flex items-start gap-3 py-4'>
                <div className='flex-shrink-0 mt-1'>
                  <Shield className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                </div>
                <div>
                  <h3 className='text-sm font-medium text-gray-900 dark:text-dark-950'>
                    {t('setup.welcome.features.secure.title')}
                  </h3>
                  <p className='text-sm text-gray-600 dark:text-dark-500'>
                    {t('setup.welcome.features.secure.description')}
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3 py-4'>
                <div className='flex-shrink-0 mt-1'>
                  <Zap className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                </div>
                <div>
                  <h3 className='text-sm font-medium text-gray-900 dark:text-dark-950'>
                    {t('setup.welcome.features.fast.title')}
                  </h3>
                  <p className='text-sm text-gray-600 dark:text-dark-500'>
                    {t('setup.welcome.features.fast.description')}
                  </p>
                </div>
              </div>

              <div className='flex items-start gap-3 py-4'>
                <div className='flex-shrink-0 mt-1'>
                  <Globe className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                </div>
                <div>
                  <h3 className='text-sm font-medium text-gray-900 dark:text-dark-950'>
                    {t('setup.welcome.features.openSource.title')}
                  </h3>
                  <p className='text-sm text-gray-600 dark:text-dark-500'>
                    {t('setup.welcome.features.openSource.description')}
                  </p>
                </div>
              </div>
            </div>

            <button
              onClick={() => setStep('create-admin')}
              className='flex min-h-11 w-full items-center justify-center rounded-xl border border-transparent bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2'
            >
              <div className='flex items-center'>
                <span>{t('setup.welcome.createAdmin')}</span>
                <ArrowRight size={16} className='ms-2 rtl:rotate-180' />
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'encryption-key') {
    return (
      <div className='min-h-screen bg-gray-50 px-4 py-16 dark:bg-dark-50 sm:px-6 lg:flex lg:flex-col lg:justify-center lg:py-20'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex flex-col items-center'>
            <Logo className='text-gray-900 dark:text-gray-100' />
          </div>
          <h2 className='mt-8 text-center text-3xl font-light tracking-[-0.035em] text-gray-950 dark:text-dark-950'>
            {t('setup.encryptionKey.title')}
          </h2>
        </div>

        <div className='mt-10 sm:mx-auto sm:w-full sm:max-w-lg'>
          <div className='mx-auto w-full max-w-lg rounded-2xl border border-gray-200/80 bg-white/80 p-6 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] sm:p-8'>
            <div className='mb-7 text-start'>
              <div className='flex justify-center mb-4'>
                <div className='rounded-xl border border-amber-200 bg-amber-500/10 p-3 dark:border-amber-800/60 dark:bg-amber-900/20'>
                  <Key className='h-8 w-8 text-amber-600 dark:text-amber-400' />
                </div>
              </div>
              <h1 className='mb-2 text-2xl font-normal tracking-[-0.03em] text-gray-950 dark:text-dark-950'>
                {t('setup.encryptionKey.subtitle')}
              </h1>
              <p className='text-gray-600 dark:text-dark-500'>
                {t('setup.encryptionKey.description')}
              </p>
            </div>

            {/* Warning Box */}
            <div className='mb-6 rounded-xl border border-amber-200 bg-amber-500/10 p-4 dark:border-amber-800/60 dark:bg-amber-900/20'>
              <div className='flex items-start gap-3'>
                <AlertTriangle className='h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5' />
                <div className='text-sm text-ink'>
                  <p className='font-medium mb-1'>
                    {t('setup.encryptionKey.warning')}
                  </p>
                  <p>{t('setup.encryptionKey.warningText')}</p>
                </div>
              </div>
            </div>

            {/* Encryption Key Display */}
            <div className='mb-6'>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                {t('setup.encryptionKey.label')}
              </label>
              <div className='relative'>
                <div className='w-full break-all rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 pe-12 font-mono text-sm text-gray-900 dark:border-white/10 dark:bg-white/[0.035] dark:text-dark-800'>
                  {encryptionKey || t('setup.encryptionKey.loading')}
                </div>
                <button
                  type='button'
                  onClick={handleCopyKey}
                  disabled={!encryptionKey}
                  className='absolute end-2 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700 disabled:opacity-50 dark:text-dark-500 dark:hover:text-dark-700'
                  title={t('setup.encryptionKey.copyToClipboard')}
                >
                  {keyCopied ? (
                    <Check className='h-5 w-5 text-green-500' />
                  ) : (
                    <Copy className='h-5 w-5' />
                  )}
                </button>
              </div>
              <p className='mt-2 text-xs text-gray-500 dark:text-dark-500'>
                {t('setup.encryptionKey.envNote')}
              </p>
            </div>

            {/* Acknowledgment Checkbox */}
            <div className='mb-6'>
              <label className='flex cursor-pointer items-start gap-3'>
                <input
                  type='checkbox'
                  checked={keyAcknowledged}
                  onChange={e => setKeyAcknowledged(e.target.checked)}
                  className='mt-1 h-4 w-4 text-primary-600 focus:ring-primary-500 border-gray-300 dark:border-dark-300 rounded'
                />
                <span className='text-sm text-gray-700 dark:text-dark-700'>
                  {t('setup.encryptionKey.acknowledgment')}
                </span>
              </label>
            </div>

            <button
              onClick={handleComplete}
              disabled={!keyAcknowledged}
              className='flex min-h-11 w-full items-center justify-center rounded-xl border border-transparent bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
            >
              <div className='flex items-center'>
                <span>{t('setup.encryptionKey.continue')}</span>
                <ArrowRight size={16} className='ms-2 rtl:rotate-180' />
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-gray-50 px-4 py-16 dark:bg-dark-50 sm:px-6 lg:flex lg:flex-col lg:justify-center lg:py-20'>
      <div className='sm:mx-auto sm:w-full sm:max-w-md'>
        <div className='flex flex-col items-center'>
          <Logo className='text-gray-900 dark:text-gray-100' />
        </div>
        <h2 className='mt-8 text-center text-3xl font-light tracking-[-0.035em] text-gray-950 dark:text-dark-950'>
          {t('setup.admin.title')}
        </h2>
      </div>

      <div className='mt-10 sm:mx-auto sm:w-full sm:max-w-md'>
        <div className='mx-auto w-full max-w-md rounded-2xl border border-gray-200/80 bg-white/80 p-6 shadow-sm backdrop-blur-xl dark:border-white/10 dark:bg-white/[0.04] sm:p-8'>
          <div className='mb-7 text-start'>
            <h1 className='mb-2 text-2xl font-normal tracking-[-0.03em] text-gray-950 dark:text-dark-950'>
              {t('setup.admin.subtitle')}
            </h1>
            <p className='text-gray-600 dark:text-dark-500'>
              {t('setup.admin.description')}
            </p>
          </div>

          <form onSubmit={handleCreateAdmin} className='space-y-4'>
            <div>
              <label
                htmlFor='username'
                className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
              >
                {t('auth.login.username')}
              </label>
              <input
                id='username'
                type='text'
                value={username}
                onChange={e => setUsername(e.target.value)}
                onKeyDown={handleKeyDown}
                className='w-full rounded-xl border border-gray-200 bg-white/80 px-3 py-2.5 text-gray-900 transition-colors duration-200 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-dark-800'
                placeholder={t('setup.admin.usernamePlaceholder')}
                required
                disabled={isLoading}
              />
            </div>

            <div>
              <label
                htmlFor='password'
                className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
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
                  className='w-full rounded-xl border border-gray-200 bg-white/80 px-3 py-2.5 pe-10 text-gray-900 transition-colors duration-200 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-dark-800'
                  placeholder={t('setup.admin.passwordPlaceholder')}
                  required
                  disabled={isLoading}
                />
                <button
                  type='button'
                  onClick={() => setShowPassword(!showPassword)}
                  className='absolute inset-y-0 end-0 flex items-center pe-3 text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700'
                  disabled={isLoading}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
              <p className='mt-1.5 text-xs text-gray-500 dark:text-dark-500'>
                {PASSWORD_REQUIREMENTS}
              </p>
            </div>

            <div>
              <label
                htmlFor='confirmPassword'
                className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
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
                  className='w-full rounded-xl border border-gray-200 bg-white/80 px-3 py-2.5 pe-10 text-gray-900 transition-colors duration-200 focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-500/20 dark:border-white/10 dark:bg-white/[0.04] dark:text-dark-800'
                  placeholder={t('setup.admin.confirmPlaceholder')}
                  required
                  disabled={isLoading}
                />
                <button
                  type='button'
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className='absolute inset-y-0 end-0 flex items-center pe-3 text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700'
                  disabled={isLoading}
                >
                  {showConfirmPassword ? (
                    <EyeOff size={20} />
                  ) : (
                    <Eye size={20} />
                  )}
                </button>
              </div>
            </div>

            {isTurnstileEnabled && turnstileSiteKey && (
              <TurnstileWidget
                siteKey={turnstileSiteKey}
                action='signup'
                disabled={isLoading}
                errorMessage={t('auth.signup.tryAgain')}
                onTokenChange={handleTurnstileTokenChange}
              />
            )}

            <div className='flex gap-3'>
              <button
                type='button'
                onClick={() => setStep('welcome')}
                disabled={isLoading}
                className='min-h-11 flex-1 rounded-xl border border-gray-200 bg-transparent px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors duration-200 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:text-dark-700 dark:hover:bg-white/[0.06]'
              >
                {t('common.back')}
              </button>
              <button
                type='submit'
                disabled={createAdminDisabled}
                className='flex min-h-11 flex-1 items-center justify-center rounded-xl border border-transparent bg-primary-600 px-4 py-2.5 text-sm font-medium text-white transition-colors duration-200 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50'
              >
                {isLoading ? (
                  <div className='flex items-center'>
                    <div className='me-2 h-4 w-4 animate-spin rounded-full border-b-2 border-white'></div>
                    {t('setup.admin.creating')}
                  </div>
                ) : (
                  <div className='flex items-center'>
                    <UserPlus size={16} className='me-2' />
                    {t('setup.admin.createAdmin')}
                  </div>
                )}
              </button>
            </div>
          </form>

          <div className='mt-6 text-center'>
            <p className='text-xs text-gray-500 dark:text-dark-500'>
              {t('setup.admin.note')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
