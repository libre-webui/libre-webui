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

import type { ComponentType, ReactNode, RefObject } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Camera,
  ChartNoAxesCombined,
  ChevronRight,
  LogOut,
  Pin,
  Server,
  Settings,
  Shield,
  User as UserIcon,
} from 'lucide-react';
import type { User } from '@/types';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';
import { preferencesApi } from '@/utils/api';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:sidebar-user-section');

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

interface MenuNavRowProps {
  to: string;
  sectionId: string;
  icon: ComponentType<{ className?: string }>;
  label: string;
  badge?: ReactNode;
  pinned: boolean;
  onNavigate: () => void;
  onTogglePin: (sectionId: string) => void;
}

/**
 * A navigation entry in the user menu: the link itself plus a small toggle
 * that pins or unpins the section in the sidebar.
 */
function MenuNavRow({
  to,
  sectionId,
  icon: Icon,
  label,
  badge,
  pinned,
  onNavigate,
  onTogglePin,
}: MenuNavRowProps) {
  const { t } = useTranslation();
  const pinTitle = pinned
    ? t('sidebar.pinned.unpin', 'Unpin from sidebar')
    : t('sidebar.pinned.pin', 'Pin to sidebar');

  return (
    <div className='flex w-full items-center'>
      <Link
        to={to}
        onClick={onNavigate}
        className='flex min-w-0 flex-1 items-center gap-3 py-2.5 ps-3 pe-1 text-[13px] text-ink transition-colors duration-150 hover:bg-interactive-hover'
      >
        <Icon className='h-4 w-4 shrink-0' />
        <span className='min-w-0 flex-1 text-start'>{label}</span>
        {badge}
      </Link>
      <button
        type='button'
        onClick={() => onTogglePin(sectionId)}
        aria-pressed={pinned}
        aria-label={pinTitle}
        title={pinTitle}
        data-testid={`pin-nav-toggle-${sectionId}`}
        className='me-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-subtle transition-colors duration-150 hover:bg-interactive-hover hover:text-ink'
      >
        <Pin
          className={cn(
            'h-3.5 w-3.5',
            pinned && 'fill-current text-primary-500'
          )}
        />
      </button>
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
  const pinnedNavItems = useAppStore(state => state.preferences.pinnedNavItems);
  const setPreferences = useAppStore(state => state.setPreferences);
  const pinned = pinnedNavItems ?? [];

  const handleTogglePinned = (sectionId: string) => {
    const next = pinned.includes(sectionId)
      ? pinned.filter(item => item !== sectionId)
      : [...pinned, sectionId];
    setPreferences({ pinnedNavItems: next });
    preferencesApi.updatePreferences({ pinnedNavItems: next }).catch(error => {
      logger.error('Failed to save pinned navigation preference:', error);
    });
  };

  if (!requiresAuth || !user) return null;

  return (
    <div
      className={cn(
        'border-t border-black/[0.04] dark:border-white/[0.06]',
        sidebarCompact ? 'p-2' : 'p-2'
      )}
    >
      {sidebarCompact ? (
        <div
          className='relative flex flex-col items-center gap-1'
          ref={userMenuRef}
        >
          <button
            type='button'
            onClick={onOpenSettings}
            className='flex h-9 w-9 items-center justify-center rounded-full text-ink outline-none transition-colors hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-primary-500/30'
            title={t('user.menu.settings')}
            aria-label={t('user.menu.settings')}
            data-testid='sidebar-rail-settings-button'
          >
            <Settings className='h-[18px] w-[18px]' />
          </button>
          <button
            type='button'
            onClick={onToggleUserMenu}
            className='relative flex h-9 w-9 items-center justify-center rounded-full outline-none transition-colors hover:bg-interactive-hover focus-visible:ring-2 focus-visible:ring-primary-500/30'
            aria-label={user.username}
            aria-expanded={userMenuOpen}
            title={user.username}
            data-testid='sidebar-rail-user-menu-button'
          >
            <UserAvatar user={user} size='sm' />
            {pendingApprovalCount > 0 && (
              <span
                data-testid='pending-user-notification-badge'
                className='absolute -end-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-md bg-error-500 px-1 text-[9px] font-semibold text-white shadow-sm'
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
            <div
              data-testid='sidebar-user-menu'
              className='scroll-region absolute bottom-0 start-full z-[70] ms-3 w-64 max-h-[calc(100dvh-1rem)] overflow-y-auto rounded-xl border border-black/[0.04] bg-surface-overlay py-1 shadow-lv3 animate-scale-in scrollbar-thin dark:border-white/[0.06]'
            >
              <button
                type='button'
                onClick={() => {
                  onOpenAvatar(user.avatar || '');
                  onCloseUserMenu();
                }}
                className='flex w-full items-center gap-2.5 border-b border-gray-100 px-3 py-2.5 text-start transition-colors hover:bg-gray-100/70 dark:border-dark-200/50 dark:hover:bg-dark-200/70'
              >
                <UserAvatar user={user} size='md' />
                <span className='min-w-0 flex-1'>
                  <span className='block truncate text-sm font-medium text-gray-900 dark:text-gray-100'>
                    {user.username}
                  </span>
                  <span className='block truncate text-xs text-gray-500 dark:text-gray-400'>
                    {t('user.menu.changePicture')}
                  </span>
                </span>
                <Camera className='h-4 w-4 shrink-0 text-gray-400' />
              </button>

              <div className='py-1'>
                {isAdmin && (
                  <MenuNavRow
                    to='/users'
                    sectionId='users'
                    icon={UserIcon}
                    label={t('user.menu.userManagement')}
                    badge={
                      pendingApprovalCount > 0 ? (
                        <span className='rounded-md bg-error-500 px-1.5 py-0.5 text-[10px] font-semibold text-white'>
                          {pendingApprovalCount > 99
                            ? '99+'
                            : pendingApprovalCount}
                        </span>
                      ) : undefined
                    }
                    pinned={pinned.includes('users')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}
                {isAdmin && (
                  <MenuNavRow
                    to='/system'
                    sectionId='system'
                    icon={Server}
                    label={t('user.menu.system')}
                    pinned={pinned.includes('system')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}
                {isAdmin && (
                  <MenuNavRow
                    to='/usage'
                    sectionId='usage'
                    icon={ChartNoAxesCombined}
                    label={t('user.menu.usageAnalytics')}
                    pinned={pinned.includes('usage')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}
                <div className='my-1 border-t border-gray-100 dark:border-dark-200/50' />
                <button
                  type='button'
                  onClick={() => {
                    onOpenSettings();
                    onCloseUserMenu();
                  }}
                  className='flex w-full items-center gap-3 px-3 py-2.5 text-start text-[13px] text-ink transition-colors hover:bg-interactive-hover'
                >
                  <Settings className='h-4 w-4 shrink-0' />
                  {t('user.menu.settings')}
                </button>
                <button
                  type='button'
                  onClick={() => {
                    onLogout();
                    onCloseUserMenu();
                  }}
                  className='flex w-full items-center gap-3 px-3 py-2.5 text-start text-[13px] text-red-600 transition-colors hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                >
                  <LogOut className='h-4 w-4 shrink-0' />
                  {t('user.menu.logout')}
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className='relative' ref={userMenuRef}>
          <button
            type='button'
            onClick={onOpenSettings}
            className='flex h-[34px] w-full items-center gap-2 rounded-xl px-2.5 text-start text-sm text-ink transition-colors duration-150 hover:bg-interactive-hover touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30'
            data-testid='sidebar-settings-button'
          >
            <Settings className='h-4 w-4 shrink-0 text-ink-muted' />
            {t('user.menu.settings')}
          </button>
          <button
            onClick={onToggleUserMenu}
            className='relative h-[38px] w-full rounded-xl px-2.5 hover:bg-interactive-hover transition-colors duration-150 text-start touch-manipulation outline-none focus-visible:ring-2 focus-visible:ring-primary-500/30'
          >
            <div className='flex items-center gap-2'>
              <UserAvatar user={user} size='sm' />
              <div className='flex min-w-0 flex-1 items-center gap-1.5'>
                <p className='truncate text-sm text-ink'>{user.username}</p>
                {user.role === 'admin' && (
                  <Shield size={11} className='shrink-0 text-ink-subtle' />
                )}
              </div>
              <ChevronRight
                className={cn(
                  'h-4 w-4 text-ink-subtle transition-transform duration-150 rtl:rotate-180',
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
            <div
              data-testid='sidebar-user-menu'
              className='scroll-region absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[calc(100dvh-1rem)] rounded-xl border border-black/[0.04] bg-surface-overlay py-1 shadow-lv3 animate-scale-in scrollbar-thin dark:border-white/[0.06]'
            >
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
                  className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-ink hover:bg-interactive-hover transition-colors duration-150 text-start'
                >
                  <Camera className='h-4 w-4 shrink-0' />
                  {t('user.menu.changePicture')}
                </button>

                {isAdmin && (
                  <MenuNavRow
                    to='/users'
                    sectionId='users'
                    icon={UserIcon}
                    label={t('user.menu.userManagement')}
                    badge={
                      pendingApprovalCount > 0 ? (
                        <span className='ms-2 rounded-full bg-error-500 px-1.5 py-0.5 text-[10px] font-semibold text-white'>
                          {pendingApprovalCount > 99
                            ? '99+'
                            : pendingApprovalCount}
                        </span>
                      ) : undefined
                    }
                    pinned={pinned.includes('users')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}

                {isAdmin && (
                  <MenuNavRow
                    to='/system'
                    sectionId='system'
                    icon={Server}
                    label={t('user.menu.system')}
                    pinned={pinned.includes('system')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}

                {isAdmin && (
                  <MenuNavRow
                    to='/usage'
                    sectionId='usage'
                    icon={ChartNoAxesCombined}
                    label={t('user.menu.usageAnalytics')}
                    pinned={pinned.includes('usage')}
                    onNavigate={() => {
                      onCloseUserMenu();
                      onMobileNavigate();
                    }}
                    onTogglePin={handleTogglePinned}
                  />
                )}

                <div className='border-t border-gray-100 dark:border-dark-200/50 my-1'></div>

                <button
                  onClick={() => {
                    onOpenSettings();
                    onCloseUserMenu();
                  }}
                  className='w-full flex items-center gap-3 px-3 py-2.5 text-[13px] text-ink hover:bg-interactive-hover transition-colors duration-150 text-start'
                >
                  <Settings className='h-4 w-4 shrink-0' />
                  {t('user.menu.settings')}
                </button>

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
