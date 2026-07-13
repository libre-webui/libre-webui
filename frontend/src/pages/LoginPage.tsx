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

import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { LoginForm } from '@/components/LoginForm';
import { SignupForm } from '@/components/SignupForm';
import { Logo } from '@/components/Logo';
import { ThemeToggle } from '@/components/ThemeToggle';
import { useTranslation } from 'react-i18next';

export const LoginPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { isAuthenticated, requiresAuth } = useAuthStore();
  const [isSignupMode, setIsSignupMode] = useState(false);
  const authRequired = requiresAuth();

  useEffect(() => {
    // If already authenticated or auth is disabled, redirect to home.
    if (isAuthenticated || !authRequired) {
      navigate('/');
    }
  }, [authRequired, isAuthenticated, navigate]);

  if (isAuthenticated || !authRequired) {
    return null;
  }

  return (
    <div className='relative min-h-screen overflow-y-auto bg-gray-50 text-gray-950 dark:bg-dark-50 dark:text-dark-950'>
      <header className='absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-between border-b border-gray-200/70 px-5 dark:border-white/[0.08] sm:px-8'>
        <Logo
          size='sm'
          className='text-gray-950 dark:text-dark-950 lg:invisible'
        />
        <ThemeToggle />
      </header>

      <main className='grid min-h-screen pt-16 lg:grid-cols-[minmax(20rem,0.9fr)_minmax(32rem,1.1fr)]'>
        <section className='relative hidden overflow-hidden border-e border-gray-200/70 p-10 dark:border-white/[0.08] lg:flex lg:flex-col lg:justify-between xl:p-16'>
          <Logo
            size='lg'
            className='relative z-10 text-gray-950 dark:text-dark-950'
          />
          <div className='relative z-10 max-w-xl border-s border-gray-300 ps-6 dark:border-white/15'>
            <p className='text-4xl font-light leading-[1.08] tracking-[-0.04em] text-gray-900 dark:text-dark-900 xl:text-5xl'>
              {t('setup.welcome.features.secure.description')}
            </p>
          </div>
        </section>

        <section className='flex items-center justify-center px-4 py-12 sm:px-8 lg:py-16'>
          <div className='w-full max-w-md [&>div]:!max-w-none [&>div]:!rounded-none [&>div]:!border-0 [&>div]:!bg-transparent [&>div]:!p-0 [&>div]:!shadow-none'>
            {isSignupMode ? (
              <SignupForm
                onBackToLogin={() => setIsSignupMode(false)}
                onSignup={() => setIsSignupMode(false)}
              />
            ) : (
              <LoginForm onShowSignup={() => setIsSignupMode(true)} />
            )}
          </div>
        </section>
      </main>
    </div>
  );
};
