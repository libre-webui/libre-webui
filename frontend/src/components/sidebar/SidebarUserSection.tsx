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

import type { RefObject } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  ChartNoAxesCombined,
  ChevronRight,
  LogOut,
  Server,
  Settings,
  Shield,
  User as UserIcon,
} from 'lucide-react';
import type { User } from '@/types';
import { cn } from '@/utils';

interface SidebarUserSectionProps {
  requiresAuth?: boolean;
  user: User | null;
  isAdmin: boolean;
  pendingApprovalCount: number;
  sidebarCompact: boolean;
  userMenuOpen: boolean;
  userMenuRef: RefObject<HTMLDivElement | null>;
  onToggleUserMenu: () => void;
  onOpenSettings: () => void;
  onOpenAvatar: (avatar: string) => void;
  onLogout: () => void;
  onMobileNavigate: () => void;
  onCloseUserMenu: () => void;
}

function UserAvatar({ user, size }: { user: User; size: 'sm' | 'md' }) {
  const dimension = size === 'sm' ? 'w-7 h-7' : 'w-8 h-8';
  const textSize = size === 'sm' ? 'text-xs' : 'text-sm';

  return user.avatar ? (
    <img
      src={user.avatar}
      alt={user.username}
      className={`${dimension} rounded-full object-cover ring-1 ring-black/10 dark:ring-white/10`}
      title={`${user.username} (${user.role})`}
    />
  ) : (
    <div
      className={`${dimension} bg-gray-950 dark:bg-white rounded-full flex items-center justify-center`}
      title={`${user.username} (${user.role})`}
    >
      <span className={`text-white dark:text-gray-950 ${textSize} font-medium`}>
        {user.username.charAt(0).toUpperCase()}
      </span>
    </div>
  );
}

export function SidebarUserSection({
  requiresAuth,
  user,
  isAdmin,
  pendingApprovalCount,
  sidebarCompact,
  userMenuOpen,
  userMenuRef,
  onToggleUserMenu,
  onOpenSettings,
  onOpenAvatar,
  onLogout,
  onMobileNavigate,
  onCloseUserMenu,
}: SidebarUserSectionProps) {
  const { t } = useTranslation();

  if (!requiresAuth || !user) return null;

  return (
    <div
      className={cn(
        'border-t border-black/[0.05] dark:border-white/[0.05]',
        sidebarCompact ? 'p-2' : 'p-3'
      )}
    >
      {sidebarCompact ? (
        <div className='flex flex-col items-center space-y-2'>
          <UserAvatar user={user} size='sm' />

          <button
            onClick={onOpenSettings}
            className='w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-dark-600 hover:bg-white/70 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation transition-colors duration-150'
            title={t('sidebar.navigation.settings')}
          >
            <Settings className='h-4 w-4' />
          </button>

          {isAdmin && (
            <Link
              to='/usage'
              onClick={onMobileNavigate}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-dark-600 hover:bg-white/70 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation transition-colors duration-150'
              title={t('sidebar.navigation.usageAnalytics')}
            >
              <ChartNoAxesCombined className='h-4 w-4' />
            </Link>
          )}

          {isAdmin && (
            <Link
              to='/system'
              onClick={onMobileNavigate}
              className='w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-dark-600 hover:bg-white/70 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation transition-colors duration-150'
              title={t('sidebar.navigation.system')}
            >
              <Server className='h-4 w-4' />
            </Link>
          )}

          {isAdmin && (
            <Link
              to='/users'
              onClick={onMobileNavigate}
              className='relative w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-dark-600 hover:bg-white/70 dark:hover:bg-dark-200 hover:text-gray-950 dark:hover:text-dark-950 touch-manipulation transition-colors duration-150'
              title={t('sidebar.navigation.userManagement')}
            >
              <UserIcon className='h-4 w-4' />
              {pendingApprovalCount > 0 && (
                <span
                  data-testid='pending-user-notification-badge'
                  className='absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-error-500 px-1 text-[10px] font-semibold text-white shadow-subtle'
                  aria-label={t('userManager.approval.notificationBadge', {
                    count: pendingApprovalCount,
                    defaultValue: '{{count}} pending user approvals',
                  })}
                >
                  {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
                </span>
              )}
            </Link>
          )}

          <button
            onClick={onLogout}
            className='w-10 h-10 flex items-center justify-center rounded-xl text-gray-500 dark:text-dark-500 hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 touch-manipulation transition-colors duration-150'
            title={t('sidebar.navigation.signOut')}
          >
            <LogOut className='h-4 w-4' />
          </button>
        </div>
      ) : (
        <div className='relative' ref={userMenuRef}>
          <button
            onClick={onToggleUserMenu}
            className='relative w-full p-2.5 rounded-xl hover:bg-white/70 dark:hover:bg-dark-200 transition-colors duration-150 text-start touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30'
          >
            <div className='flex items-center gap-2.5'>
              <UserAvatar user={user} size='sm' />
              <div className='flex-1 min-w-0'>
                <p className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                  {user.username}
                </p>
                <div className='flex items-center mt-0.5'>
                  {user.role === 'admin' && (
                    <Shield size={10} className='text-primary-500 me-1' />
                  )}
                  <span className='text-[11px] text-gray-500 dark:text-dark-500 capitalize'>
                    {user.role}
                  </span>
                </div>
              </div>
              <ChevronRight
                className={cn(
                  'h-4 w-4 text-gray-400 dark:text-dark-500 transition-transform duration-150 rtl:rotate-180',
                  userMenuOpen && 'rotate-90 rtl:rotate-90'
                )}
              />
            </div>
            {isAdmin && pendingApprovalCount > 0 && (
              <span
                data-testid='pending-user-notification-badge'
                className='absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-error-500 px-1 text-[10px] font-semibold text-white shadow-subtle'
                aria-label={t('userManager.approval.notificationBadge', {
                  count: pendingApprovalCount,
                  defaultValue: '{{count}} pending user approvals',
                })}
              >
                {pendingApprovalCount > 99 ? '99+' : pendingApprovalCount}
              </span>
            )}
          </button>

          {userMenuOpen && (
            <div className='scroll-region absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[calc(100dvh-1rem)] rounded-2xl border border-black/[0.07] bg-white/95 py-2 shadow-[0_18px_60px_rgba(15,23,42,0.16)] backdrop-blur-xl animate-scale-in scrollbar-thin dark:border-white/[0.08] dark:bg-dark-25/95'>
              <div className='px-3 py-2 border-b border-gray-100 dark:border-dark-200/50'>
                <div className='flex items-center gap-2.5'>
                  <UserAvatar user={user} size='md' />
                  <div className='flex-1 min-w-0'>
                    <p className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                      {user.username}
                    </p>
                    <p className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                      {user.email || t('user.profile.noEmail')}
                    </p>
                  </div>
                </div>
              </div>

              <div className='py-1'>
                <button
                  onClick={() => {
                    onOpenAvatar(user.avatar || '');
                    onCloseUserMenu();
                  }}
                  className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-gray-700 dark:text-dark-700 hover:bg-gray-100/70 dark:hover:bg-dark-200/70 transition-colors duration-150 text-start'
                >
                  <Camera className='h-4 w-4 shrink-0' />
                  {t('user.menu.changePicture')}
                </button>

                <button
                  onClick={() => {
                    onOpenSettings();
                    onCloseUserMenu();
                  }}
                  className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-gray-700 dark:text-dark-700 hover:bg-gray-100/70 dark:hover:bg-dark-200/70 transition-colors duration-150 text-start'
                >
                  <Settings className='h-4 w-4 shrink-0' />
                  {t('user.menu.settings')}
                </button>

                {isAdmin && (
                  <Link
                    to='/usage'
                    onClick={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-gray-700 dark:text-dark-700 hover:bg-gray-100/70 dark:hover:bg-dark-200/70 transition-colors duration-150'
                  >
                    <ChartNoAxesCombined className='h-4 w-4 shrink-0' />
                    <span className='min-w-0 flex-1 text-start'>
                      {t('user.menu.usageAnalytics')}
                    </span>
                  </Link>
                )}

                {isAdmin && (
                  <Link
                    to='/system'
                    onClick={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-gray-700 dark:text-dark-700 hover:bg-gray-100/70 dark:hover:bg-dark-200/70 transition-colors duration-150'
                  >
                    <Server className='h-4 w-4 shrink-0' />
                    <span className='min-w-0 flex-1 text-start'>
                      {t('user.menu.system')}
                    </span>
                  </Link>
                )}

                {isAdmin && (
                  <Link
                    to='/users'
                    onClick={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-gray-700 dark:text-dark-700 hover:bg-gray-100/70 dark:hover:bg-dark-200/70 transition-colors duration-150'
                  >
                    <UserIcon className='h-4 w-4 shrink-0' />
                    <span className='min-w-0 flex-1 text-start'>
                      {t('user.menu.userManagement')}
                    </span>
                    {pendingApprovalCount > 0 && (
                      <span className='ms-2 rounded-full bg-error-500 px-1.5 py-0.5 text-[10px] font-semibold text-white'>
                        {pendingApprovalCount > 99
                          ? '99+'
                          : pendingApprovalCount}
                      </span>
                    )}
                  </Link>
                )}

                <div className='border-t border-gray-100 dark:border-dark-200/50 my-1'></div>

                <button
                  onClick={() => {
                    onLogout();
                    onCloseUserMenu();
                  }}
                  className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors duration-150 text-start'
                >
                  <LogOut className='h-4 w-4 shrink-0' />
                  {t('user.menu.logout')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
