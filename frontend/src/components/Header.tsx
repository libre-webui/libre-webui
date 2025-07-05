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
import { Button, Select } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserMenu } from '@/components/UserMenu';
import { Logo } from '@/components/Logo';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { usePluginStore } from '@/store/pluginStore';
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
  const { currentSession, models, updateCurrentSessionModel } = useChatStore();
  const {
    hasSeenSettingsNotification,
    markSettingsNotificationAsSeen,
    sidebarOpen,
    toggleSidebar,
  } = useAppStore();
  const { plugins } = usePluginStore();
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

  const isOnChatPage = () => {
    return (
      location.pathname === '/chat' ||
      location.pathname === '/' ||
      location.pathname.startsWith('/c/')
    );
  };

  const handleModelChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const newModel = event.target.value;
    if (currentSession && newModel !== currentSession.model) {
      try {
        await updateCurrentSessionModel(newModel);
      } catch (_error) {
        console.error('Failed to update session model:', _error);
      }
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
          className
        )}
      >
        {/* Left side */}
        <div className='flex items-center gap-3'>
          {/* Mobile menu button - only show on mobile when sidebar is closed */}
          {!sidebarOpen && (
            <Button
              variant='ghost'
              size='sm'
              onClick={toggleSidebar}
              className='lg:hidden h-10 w-10 p-0'
            >
              <Menu className='h-5 w-5' />
            </Button>
          )}

          {/* Page title and session info */}
          <div className='flex items-center gap-3'>
            <Logo size='sm' />
            <div className='flex flex-col min-w-0'>
              <h1 className='text-base sm:text-lg font-semibold text-gray-900 dark:text-dark-800 leading-tight truncate'>
                {getPageTitle()}
              </h1>
              {isOnChatPage() && currentSession && models.length > 0 && (
                <div className='flex items-center gap-2 mt-0.5'>
                  <span className='text-xs text-gray-500 dark:text-dark-500 hidden sm:inline'>
                    Model:
                  </span>
                  <Select
                    value={currentSession.model}
                    onChange={handleModelChange}
                    options={models.map(model => ({
                      value: model.name,
                      label: model.isPlugin
                        ? `${model.name} (${model.pluginName})`
                        : model.name,
                    }))}
                    className='text-xs min-w-0 py-1 px-2 h-6 border-0 bg-gray-50 dark:bg-dark-200 rounded-lg max-w-32 sm:max-w-none'
                  />
                  {/* Plugin indicator - only show when current model is from a plugin */}
                  {currentSession &&
                    (() => {
                      const currentModel = models.find(
                        m => m.name === currentSession.model
                      );
                      const activePlugin = currentModel?.isPlugin
                        ? plugins.find(
                            p =>
                              p.active &&
                              p.model_map?.includes(currentSession.model)
                          )
                        : null;

                      return (
                        activePlugin &&
                        currentModel?.isPlugin && (
                          <div className='flex items-center gap-1'>
                            <span className='text-xs text-gray-500 dark:text-dark-500 hidden sm:inline'>
                              via
                            </span>
                            <span className='text-xs font-medium text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 px-2 py-1 rounded'>
                              {currentModel.pluginName || activePlugin.name}
                            </span>
                          </div>
                        )
                      );
                    })()}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Right side */}
        <div className='flex items-center gap-1 sm:gap-2'>
          <UserMenu />

          <ThemeToggle />
          <div className='relative'>
            <Button
              variant='ghost'
              size='sm'
              className='h-8 w-8 sm:h-9 sm:w-9 p-0 hover:bg-gray-100 dark:hover:bg-dark-200'
              title='Settings (⌘,)'
              onClick={handleSettingsClick}
            >
              <Settings className='h-4 w-4' />
            </Button>
            {/* Simple green notification dot - only show if user hasn't seen settings */}
            {!hasSeenSettingsNotification && (
              <div className='absolute -top-1 -right-1 h-3 w-3 bg-green-500 rounded-full border-2 border-white dark:border-dark-50'></div>
            )}
          </div>

          {/* Logout button - only show if user is authenticated */}
          {systemInfo?.requiresAuth && user && (
            <Button
              variant='ghost'
              size='sm'
              className='h-8 w-8 sm:h-9 sm:w-9 p-0 hover:bg-red-50 dark:hover:bg-red-900/20 text-red-600 dark:text-red-400'
              title='Sign Out'
              onClick={handleLogout}
            >
              <LogOut className='h-4 w-4' />
            </Button>
          )}
        </div>
      </header>
    </>
  );
};
