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

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import { authApi } from '@/utils/api';
import { Eye, EyeOff, UserPlus } from 'lucide-react';
import { GitHubAuthButton } from '@/components/GitHubAuthButton';

interface SignupFormProps {
  onSignup?: () => void;
  onBackToLogin?: () => void;
}

export const SignupForm: React.FC<SignupFormProps> = ({
  onSignup,
  onBackToLogin,
}) => {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuthStore();

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

    setIsLoading(true);

    try {
      const response = await authApi.signup({ username, password, email });

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
      console.error('Signup error:', error);
      toast.error(t('auth.signup.tryAgain'));
    } finally {
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
    <div className='w-full max-w-md mx-auto bg-white dark:bg-dark-25 rounded-xl shadow-card hover:shadow-card-hover transition-shadow duration-200 p-6 border border-gray-200 dark:border-dark-200'>
      <div className='text-center mb-6'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-950 mb-2'>
          {t('auth.signup.title')}
        </h1>
        <p className='text-gray-600 dark:text-dark-500'>
          {t('auth.signup.subtitle')}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-4'>
        <div>
          <label
            htmlFor='username'
            className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
          >
            {t('auth.signup.username')}
          </label>
          <input
            id='username'
            type='text'
            value={username}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={handleKeyDown}
            className='w-full px-3 py-2 border border-gray-200 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 bg-white dark:bg-dark-200 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 transition-colors duration-200'
            placeholder={t('auth.signup.usernamePlaceholder')}
            required
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='email'
            className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
          >
            {t('auth.signup.email')}{' '}
            <span className='text-gray-400'>({t('common.optional')})</span>
          </label>
          <input
            id='email'
            type='email'
            value={email}
            onChange={e => setEmail(e.target.value)}
            onKeyDown={handleKeyDown}
            className='w-full px-3 py-2 border border-gray-200 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 bg-white dark:bg-dark-200 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 transition-colors duration-200'
            placeholder={t('auth.signup.emailPlaceholder')}
            disabled={isLoading}
          />
        </div>

        <div>
          <label
            htmlFor='password'
            className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'
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
              className='w-full px-3 py-2 pr-10 border border-gray-200 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 bg-white dark:bg-dark-200 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 transition-colors duration-200'
              placeholder={t('auth.signup.passwordPlaceholder')}
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
              className='w-full px-3 py-2 pr-10 border border-gray-200 dark:border-dark-300 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-accent-500 focus:border-accent-500 bg-white dark:bg-dark-200 text-gray-900 dark:text-dark-800 placeholder:text-gray-400 dark:placeholder:text-dark-500 transition-colors duration-200'
              placeholder={t('auth.signup.confirmPasswordPlaceholder')}
              required
              disabled={isLoading}
            />
            <button
              type='button'
              onClick={() => setShowConfirmPassword(!showConfirmPassword)}
              className='absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:text-dark-500 dark:hover:text-dark-700'
              disabled={isLoading}
            >
              {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        <button
          type='submit'
          disabled={isLoading}
          className='w-full flex items-center justify-center px-4 py-2 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200'
        >
          {isLoading ? (
            <div className='flex items-center'>
              <div className='animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2'></div>
              {t('auth.signup.creatingAccount')}
            </div>
          ) : (
            <div className='flex items-center'>
              <UserPlus size={16} className='mr-2' />
              {t('auth.signup.createAccount')}
            </div>
          )}
        </button>
      </form>

      {/* GitHub OAuth Button */}
      <GitHubAuthButton />

      <div className='mt-6 text-center'>
        <p className='text-sm text-gray-600 dark:text-dark-500'>
          {t('auth.signup.hasAccount')}{' '}
          <button
            onClick={onBackToLogin}
            className='text-primary-500 hover:text-primary-600 dark:text-primary-400 dark:hover:text-primary-300 font-medium transition-colors duration-200'
          >
            {t('auth.signup.signInHere')}
          </button>
        </p>
      </div>

      <div className='mt-4 text-center'>
        <p className='text-xs text-gray-500 dark:text-dark-500'>
          {t('common.mode')}: {t('common.multiUser')}
        </p>
      </div>
    </div>
  );
};
