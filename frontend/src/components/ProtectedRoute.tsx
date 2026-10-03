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

import React from 'react';
import { Navigate, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useAuthStore } from '@/store/authStore';
import { endedByExplicitLogout } from '@/utils/postLoginPath';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAuth?: boolean;
  requireAdmin?: boolean;
  requireWork?: boolean;
  requireStrands?: boolean;
}

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requireAuth = true,
  requireAdmin = false,
  requireWork = false,
  requireStrands = false,
}) => {
  const {
    isAuthenticated,
    user,
    systemInfo,
    isLoading,
    canUseWork,
    canUseStrands,
  } = useAuthStore();
  const location = useLocation();
  const { t } = useTranslation();

  // Show loading spinner while checking auth
  if (isLoading) {
    return (
      <div
        role='status'
        className='min-h-screen flex items-center justify-center bg-gray-50 dark:bg-dark-50'
      >
        <div className='w-8 h-8 border-4 border-gray-200 dark:border-dark-300 border-t-primary-500 dark:border-t-primary-400 rounded-full animate-spin motion-reduce:animate-none'></div>
        <span className='sr-only'>{t('common.loading')}</span>
      </div>
    );
  }

  // The Strands engine starts disabled; its access mode gates every
  // deployment mode, including no-auth single-user installs.
  if (requireStrands && !canUseStrands()) {
    return <Navigate to='/' replace />;
  }

  // If system doesn't require auth, allow access
  if (systemInfo && !systemInfo.requiresAuth) {
    return <>{children}</>;
  }

  // If auth is required but user is not authenticated
  if (requireAuth && !isAuthenticated) {
    // Remember the destination so signing in can return to it — except after
    // a deliberate sign-out, where the next account must start fresh.
    return (
      <Navigate
        to='/login'
        replace
        state={endedByExplicitLogout() ? undefined : { from: location }}
      />
    );
  }

  // If admin is required but user is not admin
  if (requireAdmin && (!user || user.role !== 'admin')) {
    return <Navigate to='/' replace />;
  }

  // If Work access is required, follow the persisted access mode: admins
  // always pass, other users pass when Work is open to all users.
  if (requireWork && !canUseWork()) {
    return <Navigate to='/' replace />;
  }

  return <>{children}</>;
};
