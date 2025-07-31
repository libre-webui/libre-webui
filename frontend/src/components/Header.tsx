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
import { useLocation, useNavigate } from 'react-router-dom';
import { Settings, Menu, LogOut } from 'lucide-react';
import { Button } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserMenu } from '@/components/UserMenu';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
// Removed unused import: usePluginStore
import { authApi } from '@/utils/api';
import { toast } from 'react-hot-toast';
import { cn } from '@/utils';

interface HeaderProps {
  className?: string;
  onSettingsClick?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  className,
  onSettingsClick,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { currentSession } = useChatStore();
  const {
    hasSeenSettingsNotification,
    markSettingsNotificationAsSeen,
    sidebarOpen,
    toggleSidebar,
  } = useAppStore();
  // Removed unused pluginStore
  const { user, logout, systemInfo } = useAuthStore();

  const getPageTitle = () => {
    if (location.pathname === '/models') {
      return 'Model Management';
    } else if (
      location.pathname.startsWith('/c/') ||
      location.pathname === '/chat' ||
      location.pathname === '/'
    ) {
      return currentSession ? currentSession.title : 'Chat';
    } else {
      return 'Chat';
    }
  };

  const handleLogoClick = () => {
    const { sessions } = useChatStore.getState();

    if (sessions.length > 0) {
      // Sessions are sorted by updated_at DESC, so the first one is the latest
      const latestSession = sessions[0];
      navigate(`/c/${latestSession.id}`);
    } else {
      // No sessions exist, navigate to root to create a new one
      navigate('/');
    }
  };

  const handleSettingsClick = () => {
    // Mark notification as seen when settings is opened
    if (!hasSeenSettingsNotification) {
      markSettingsNotificationAsSeen();
    }

    if (onSettingsClick) {
      onSettingsClick();
    }
  };

  const handleLogout = async () => {
    try {
      await authApi.logout();
      logout();
      navigate('/login');
      toast.success('Logged out successfully');
    } catch (error) {
      console.error('Logout error:', error);
      // Still logout locally even if API call fails
      logout();
      navigate('/login');
    }
  };

  return (
    <>
      <header
        className={cn(
          'flex items-center justify-between p-3 sm:p-4 border-b border-gray-100 dark:border-dark-200 bg-white/80 dark:bg-dark-50/80 backdrop-blur-sm',
          'min-h-[60px] sm:min-h-[64px]', // Ensure consistent header height
          className
        )}
      >
        {/* Left side */}
        <div className='flex items-center gap-2 sm:gap-3 min-w-0 flex-1'>
          {/* Mobile menu button - only show on mobile when sidebar is closed */}
          {!sidebarOpen && (
            <Button
              variant='ghost'
              size='sm'
              onClick={toggleSidebar}
              className={cn(
                'lg:hidden h-9 w-9 sm:h-10 sm:w-10 p-0 flex-shrink-0',
                'active:bg-gray-100 dark:active:bg-dark-200 touch-manipulation'
              )}
            >
              <Menu className='h-5 w-5' />
            </Button>
          )}

          {/* Page title and session info */}
          <div className='flex items-center gap-2 sm:gap-3 min-w-0 flex-1'>
            <button
              onClick={handleLogoClick}
              className={cn(
                'flex items-center gap-2 sm:gap-3 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-dark-200',
                'transition-colors min-w-0 touch-manipulation active:bg-gray-200 dark:active:bg-dark-100'
              )}
              title='Go to latest chat'
            >
              <div className='flex flex-col min-w-0'>
                <h1 className='text-sm sm:text-base md:text-lg font-semibold text-gray-900 dark:text-dark-800 leading-tight truncate'>
                  {getPageTitle()}
                </h1>
              </div>
            </button>
          </div>
        </div>

        {/* Right side */}
        <div className='flex items-center gap-1 sm:gap-2 flex-shrink-0'>
          <UserMenu onSettingsClick={onSettingsClick} />

          <ThemeToggle />

          <div className='relative'>
            <Button
              variant='ghost'
              size='sm'
              className={cn(
                'h-8 w-8 sm:h-9 sm:w-9 p-0 hover:bg-gray-100 dark:hover:bg-dark-200',
                'active:bg-gray-100 dark:active:bg-dark-200 touch-manipulation'
              )}
              title='Settings (⌘,)'
              onClick={handleSettingsClick}
            >
              <Settings className='h-4 w-4' />
            </Button>
            {/* Simple green notification dot - only show if user hasn't seen settings */}
            {!hasSeenSettingsNotification && (
              <div className='absolute -top-0.5 -right-0.5 h-2.5 w-2.5 sm:h-3 sm:w-3 bg-green-500 rounded-full border-2 border-white dark:border-dark-50'></div>
            )}
          </div>

          {/* Logout button - only show if user is authenticated and not included in UserMenu */}
          {systemInfo?.requiresAuth && user && (
            <Button
              variant='ghost'
              size='sm'
              className={cn(
                'h-8 w-8 sm:h-9 sm:w-9 p-0 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400',
                'active:bg-red-100 dark:active:bg-red-900/30 touch-manipulation',
                'sm:hidden' // Hide on desktop since UserMenu has logout
              )}
              title='Sign Out'
              onClick={handleLogout}
            >
              <LogOut className='h-3.5 w-3.5 sm:h-4 sm:w-4' />
            </Button>
          )}
        </div>
      </header>
    </>
  );
};
