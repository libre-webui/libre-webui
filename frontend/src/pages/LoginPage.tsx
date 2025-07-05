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

import React, { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '@/store/authStore';
import { LoginForm } from '@/components/LoginForm';
import { Logo } from '@/components/Logo';

export const LoginPage: React.FC = () => {
  const navigate = useNavigate();
  const { isAuthenticated, requiresAuth } = useAuthStore();

  useEffect(() => {
    // If already authenticated, redirect to home
    if (isAuthenticated) {
      navigate('/');
    }
  }, [isAuthenticated, navigate]);

  // If system doesn't require auth, redirect to home
  if (!requiresAuth()) {
    navigate('/');
    return null;
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
          Libre WebUI
        </h2>
      </div>

      <div className='mt-8 sm:mx-auto sm:w-full sm:max-w-md'>
        <LoginForm />
      </div>
    </div>
  );
};
