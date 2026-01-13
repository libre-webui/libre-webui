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

import React, { useState, useEffect } from 'react';
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
  const { login } = useAuthStore();

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

    if (password.length < 6) {
      toast.error(t('auth.signup.passwordTooShort'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await authApi.signup({
        username,
        password,
        email: '',
      });

      if (response.success && response.data) {
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
      console.error('Admin creation error:', error);
      toast.error(t('setup.admin.failed'));
    } finally {
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
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex justify-center'>
            <Logo />
          </div>
          <h2
            className='libre-brand mt-6 text-center text-2xl sm:text-3xl font-normal text-gray-900 dark:text-gray-100'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            {t('setup.welcome.title')}
          </h2>
        </div>

        <div className='mt-8 sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='w-full max-w-md mx-auto bg-white dark:bg-dark-25 rounded-xl shadow-card hover:shadow-card-hover transition-shadow duration-200 p-6 border border-gray-200 dark:border-dark-200'>
            <div className='text-center mb-6'>
              <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-950 mb-2'>
                {t('setup.welcome.subtitle')}
              </h1>
              <p className='text-gray-600 dark:text-dark-500'>
                {t('setup.welcome.description')}
              </p>
            </div>

            {/* Features */}
            <div className='space-y-4 mb-6'>
              <div className='flex items-start space-x-3'>
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

              <div className='flex items-start space-x-3'>
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

              <div className='flex items-start space-x-3'>
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
              className='w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 transition-colors duration-200'
            >
              <div className='flex items-center'>
                <span>{t('setup.welcome.createAdmin')}</span>
                <ArrowRight size={16} className='ml-2' />
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'encryption-key') {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex justify-center'>
            <Logo />
          </div>
          <h2
            className='libre-brand mt-6 text-center text-2xl sm:text-3xl font-normal text-gray-900 dark:text-gray-100'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            {t('setup.encryptionKey.title')}
          </h2>
        </div>

        <div className='mt-8 sm:mx-auto sm:w-full sm:max-w-lg'>
          <div className='w-full max-w-lg mx-auto bg-white dark:bg-dark-25 rounded-xl shadow-card hover:shadow-card-hover transition-shadow duration-200 p-6 border border-gray-200 dark:border-dark-200'>
            <div className='text-center mb-6'>
              <div className='flex justify-center mb-4'>
                <div className='p-3 bg-amber-100 dark:bg-amber-900/30 rounded-full'>
                  <Key className='h-8 w-8 text-amber-600 dark:text-amber-400' />
                </div>
              </div>
              <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-950 mb-2'>
                {t('setup.encryptionKey.subtitle')}
              </h1>
              <p className='text-gray-600 dark:text-dark-500'>
                {t('setup.encryptionKey.description')}
              </p>
            </div>

            {/* Warning Box */}
            <div className='mb-6 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg'>
              <div className='flex items-start space-x-3'>
                <AlertTriangle className='h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5' />
                <div className='text-sm text-amber-800 dark:text-amber-200'>
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
                <div className='w-full px-3 py-3 pr-12 border border-gray-300 dark:border-dark-300 rounded-lg bg-gray-50 dark:bg-dark-100 font-mono text-sm text-gray-900 dark:text-dark-800 break-all'>
                  {encryptionKey || t('setup.encryptionKey.loading')}
                </div>
                <button
                  type='button'
                  onClick={handleCopyKey}
                  disabled={!encryptionKey}
                  className='absolute right-2 top-1/2 -translate-y-1/2 p-2 text-gray-500 hover:text-gray-700 dark:text-dark-500 dark:hover:text-dark-700 disabled:opacity-50'
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
              <label className='flex items-start space-x-3 cursor-pointer'>
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
              className='w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
            >
              <div className='flex items-center'>
                <span>{t('setup.encryptionKey.continue')}</span>
                <ArrowRight size={16} className='ml-2' />
              </div>
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8'>
      <div className='sm:mx-auto sm:w-full sm:max-w-md'>
        <div className='flex justify-center'>
          <Logo />
        </div>
        <h2
          className='libre-brand mt-6 text-center text-2xl sm:text-3xl font-normal text-gray-900 dark:text-gray-100'
          style={{ fontWeight: 300, letterSpacing: '0.01em' }}
        >
          {t('setup.admin.title')}
        </h2>
      </div>

      <div className='mt-8 sm:mx-auto sm:w-full sm:max-w-md'>
        <div className='w-full max-w-md mx-auto bg-white dark:bg-dark-25 rounded-xl shadow-card hover:shadow-card-hover transition-shadow duration-200 p-6 border border-gray-200 dark:border-dark-200'>
          <div className='text-center mb-6'>
            <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-950 mb-2'>
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
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 transition-colors duration-200'
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
                  className='w-full px-3 py-2 pr-10 border border-gray-300 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 transition-colors duration-200'
                  placeholder={t('setup.admin.passwordPlaceholder')}
                  required
                  disabled={isLoading}
                />
                <button
                  type='button'
                  onClick={() => setShowPassword(!showPassword)}
                  className='absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700'
                  disabled={isLoading}
                >
                  {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                </button>
              </div>
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
                  className='w-full px-3 py-2 pr-10 border border-gray-300 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500 bg-white dark:bg-dark-100 text-gray-900 dark:text-dark-800 transition-colors duration-200'
                  placeholder={t('setup.admin.confirmPlaceholder')}
                  required
                  disabled={isLoading}
                />
                <button
                  type='button'
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className='absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700'
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

            <div className='flex space-x-3'>
              <button
                type='button'
                onClick={() => setStep('welcome')}
                disabled={isLoading}
                className='flex-1 px-4 py-2 border border-gray-300 dark:border-dark-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 dark:text-dark-700 bg-white dark:bg-dark-100 hover:bg-gray-50 dark:hover:bg-dark-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
              >
                {t('common.back')}
              </button>
              <button
                type='submit'
                disabled={isLoading}
                className='flex-1 flex items-center justify-center px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
              >
                {isLoading ? (
                  <div className='flex items-center'>
                    <div className='animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2'></div>
                    {t('setup.admin.creating')}
                  </div>
                ) : (
                  <div className='flex items-center'>
                    <UserPlus size={16} className='mr-2' />
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
