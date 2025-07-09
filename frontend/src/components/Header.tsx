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
import { useLocation, useNavigate } from 'react-router-dom';
import { Settings, Menu, LogOut, User } from 'lucide-react';
import { Button, Select } from '@/components/ui';
import { ThemeToggle } from '@/components/ThemeToggle';
import { UserMenu } from '@/components/UserMenu';
import { Logo } from '@/components/Logo';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { usePluginStore } from '@/store/pluginStore';
import { authApi, personaApi, chatApi } from '@/utils/api';
import { toast } from 'react-hot-toast';
import { cn } from '@/utils';
import { Persona } from '@/types';

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
  const {
    currentSession,
    models,
    updateCurrentSessionModel: _updateCurrentSessionModel,
    setCurrentSession: _setCurrentSession,
  } = useChatStore();
  const {
    hasSeenSettingsNotification,
    markSettingsNotificationAsSeen,
    sidebarOpen,
    toggleSidebar,
    setBackgroundImage,
  } = useAppStore();
  const { plugins } = usePluginStore();
  const { user, logout, systemInfo } = useAuthStore();

  // Persona state
  const [_personas, setPersonas] = useState<Persona[]>([]);
  const [currentPersona, setCurrentPersona] = useState<Persona | null>(null);

  // Load personas on component mount
  useEffect(() => {
    const loadPersonas = async () => {
      try {
        const response = await personaApi.getPersonas();
        if (response.success && response.data) {
          setPersonas(response.data);
        }
      } catch (error) {
        console.error('Failed to load personas:', error);
      }
    };

    loadPersonas();
  }, []);

  // Load current persona when session changes
  useEffect(() => {
    const loadCurrentPersona = async () => {
      if (currentSession?.personaId) {
        try {
          const response = await personaApi.getPersona(
            currentSession.personaId
          );
          if (response.success && response.data) {
            setCurrentPersona(response.data);
          } else {
            // Persona not found, clear the reference
            console.warn(
              `Persona ${currentSession.personaId} not found, clearing reference`
            );
            setCurrentPersona(null);
            // Clear the personaId from the session to prevent repeated requests
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        } catch (error) {
          console.error('Failed to load current persona:', error);
          setCurrentPersona(null);
          // Clear the personaId from the session to prevent repeated requests
          if (currentSession) {
            const { setCurrentSession } = useChatStore.getState();
            setCurrentSession({
              ...currentSession,
              personaId: undefined,
            });
          }
        }
      } else {
        setCurrentPersona(null);
      }
    };

    loadCurrentPersona();
  }, [currentSession?.personaId, currentSession]);

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

  const handleModelOrPersonaChange = async (
    event: React.ChangeEvent<HTMLSelectElement>
  ) => {
    const value = event.target.value;
    if (!currentSession) return;

    try {
      // Check if the selected value is a persona
      if (value.startsWith('persona:')) {
        const personaId = value.replace('persona:', '');

        // Get persona details to use its model
        const personaResponse = await personaApi.getPersona(personaId);
        if (!personaResponse.success || !personaResponse.data) {
          toast.error('Failed to load persona details');
          return;
        }

        const persona = personaResponse.data;

        // Update session with persona and its model
        const response = await chatApi.updateSession(currentSession.id, {
          personaId: personaId,
          model: value, // Keep the persona model string (persona:xxx)
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          // Apply persona background if it has one
          if (persona.background) {
            setBackgroundImage(persona.background);
          }

          toast.success('Persona applied');
        }
      } else {
        // It's a regular model - update the model and clear persona
        const response = await chatApi.updateSession(currentSession.id, {
          model: value,
          personaId: undefined,
        });

        if (response.success && response.data) {
          // Update both currentSession and the sessions array
          const { sessions } = useChatStore.getState();
          const updatedSessions = sessions.map(s =>
            s.id === currentSession.id ? response.data! : s
          );
          useChatStore.setState({
            sessions: updatedSessions,
            currentSession: response.data,
          });

          setBackgroundImage(null);
          toast.success('Model updated');
        }
      }
    } catch (error) {
      console.error('Failed to update session:', error);
      toast.error('Failed to update session');
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
            <button
              onClick={handleLogoClick}
              className='flex items-center gap-3 p-1 rounded-md hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
              title='Go to latest chat'
            >
              <Logo size='sm' />
              <div className='flex flex-col min-w-0'>
                <h1 className='text-base sm:text-lg font-semibold text-gray-900 dark:text-dark-800 leading-tight truncate'>
                  {getPageTitle()}
                </h1>
              </div>
            </button>
            {isOnChatPage() && currentSession && models.length > 0 && (
              <div className='flex items-center gap-2 mt-0.5'>
                <span className='text-xs text-gray-500 dark:text-dark-500 hidden sm:inline'>
                  Model:
                </span>
                <Select
                  value={
                    currentSession.personaId
                      ? `persona:${currentSession.personaId}`
                      : currentSession.model
                  }
                  onChange={handleModelOrPersonaChange}
                  options={models.map(model => ({
                    value: model.name,
                    label: model.isPersona
                      ? `👤 ${model.personaName} (via ${model.model})`
                      : model.isPlugin
                        ? `${model.name} (${model.pluginName})`
                        : model.name,
                  }))}
                  className='text-xs min-w-0 py-1 px-2 h-6 border-0 bg-gray-50 dark:bg-dark-200 rounded-lg max-w-32 sm:max-w-none'
                />

                {/* Persona indicator - show when using a persona */}
                {currentSession?.personaId && currentPersona && (
                  <div className='flex items-center gap-1'>
                    <span className='text-xs text-gray-500 dark:text-dark-500 hidden sm:inline'>
                      via
                    </span>
                    <div className='flex items-center gap-1'>
                      {currentPersona.avatar ? (
                        <img
                          src={currentPersona.avatar}
                          alt={currentPersona.name}
                          className='w-4 h-4 rounded-full object-cover'
                        />
                      ) : (
                        <User className='h-3 w-3' />
                      )}
                      <span className='text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/20 px-2 py-1 rounded'>
                        {currentPersona.name}
                      </span>
                    </div>
                  </div>
                )}

                {/* Plugin indicator - only show when current model is from a plugin and no persona */}
                {!currentSession?.personaId &&
                  currentSession &&
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

        {/* Right side */}
        <div className='flex items-center gap-1 sm:gap-2'>
          <UserMenu onSettingsClick={onSettingsClick} />

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
