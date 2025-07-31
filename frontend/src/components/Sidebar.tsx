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
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Plus,
  MessageSquare,
  Trash2,
  Edit3,
  Check,
  X,
  Settings,
  Database,
  Users,
  User,
} from 'lucide-react';
import { Button, Input } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { SettingsModal } from '@/components/SettingsModal';
import { useChatStore } from '@/store/chatStore';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import { ChatSession } from '@/types';
import { formatTimestamp, truncateText, cn } from '@/utils';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose,
  className,
}) => {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    sessions,
    createSession,
    deleteSession,
    updateSessionTitle,
    selectedModel,
    models,
    currentSession,
  } = useChatStore();
  const { user, isAdmin, systemInfo } = useAuthStore();
  const { backgroundImage } = useAppStore();

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Extract current session ID from URL using useParams
  const { sessionId } = useParams<{ sessionId: string }>();
  const currentSessionIdFromUrl = sessionId || null;

  // Get current session ID from store as fallback
  const currentSessionId = currentSession?.id || currentSessionIdFromUrl;

  const handleCreateSession = async () => {
    if (!selectedModel) return;
    const newSession = await createSession(selectedModel);
    if (newSession) {
      navigate(`/c/${newSession.id}`, { replace: true });
    }
    // On mobile, close sidebar after creating session
    if (window.innerWidth < 768) {
      onClose();
    }
  };

  const handleSelectSession = (session: ChatSession) => {
    navigate(`/c/${session.id}`, { replace: true });
    // On mobile, close sidebar after selecting session
    if (window.innerWidth < 768) {
      onClose();
    }
  };
  const handleDeleteSession = async (
    sessionId: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    if (process.env.NODE_ENV === 'development') {
      console.log('Delete session clicked:', sessionId);
    }

    if (window.confirm('Are you sure you want to delete this chat?')) {
      try {
        if (process.env.NODE_ENV === 'development') {
          console.log('Attempting to delete session:', sessionId);
        }

        // Check if we're deleting the current session
        const isCurrentSession = currentSessionId === sessionId;

        await deleteSession(sessionId);
        if (process.env.NODE_ENV === 'development') {
          console.log('Session deleted successfully');
        }

        // If we deleted the current session, navigate to another session or root
        if (isCurrentSession) {
          const remainingSessions = sessions.filter(s => s.id !== sessionId);
          if (remainingSessions.length > 0) {
            navigate(`/c/${remainingSessions[0].id}`, { replace: true });
          } else {
            navigate('/', { replace: true });
          }
        }
      } catch (_error) {
        console.error('Error deleting session:', _error);
      }
    }
  };

  const handleStartEditing = (session: ChatSession, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingSessionId(session.id);
    setEditingTitle(session.title);
  };

  const handleSaveEdit = async (sessionId: string) => {
    if (editingTitle.trim()) {
      await updateSessionTitle(sessionId, editingTitle.trim());
    }
    setEditingSessionId(null);
    setEditingTitle('');
  };

  const handleCancelEdit = () => {
    setEditingSessionId(null);
    setEditingTitle('');
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          className='fixed inset-0 bg-black/50 z-40 lg:hidden transition-opacity duration-300'
          onClick={onClose}
          onTouchStart={onClose} // Better touch handling
        />
      )}

      {/* Sidebar */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-80 border-r border-gray-200 dark:border-dark-200 transform transition-all duration-300 ease-in-out shadow-xl',
          // On mobile: slide in/out from left
          // On desktop: slide in/out from left but maintain layout flow
          isOpen ? 'translate-x-0' : '-translate-x-80', // Hide completely to the left (full width)
          // Remove shadow on desktop when integrated into layout
          'lg:shadow-none',
          // Conditional background based on whether background image is set
          backgroundImage
            ? 'bg-gray-50/70 dark:bg-dark-25/70 backdrop-blur-sm'
            : 'bg-gray-50 dark:bg-dark-25',
          // Better touch scrolling on mobile
          'overscroll-behavior-contain',
          className
        )}
        style={{
          // Ensure proper touch scrolling on mobile
          WebkitOverflowScrolling: 'touch',
        }}
      >
        <div className='flex flex-col h-full'>
          {/* Header - Compact */}
          <div className='p-3 border-b border-gray-200/60 dark:border-dark-200/60'>
            <div className='flex items-center justify-between mb-3'>
              <div className='flex items-center gap-2'>
                <Logo size='sm' />
                <span
                  className='libre-brand text-base font-semibold text-gray-900 dark:text-dark-800'
                  style={{ lineHeight: 1 }}
                >
                  Libre WebUI
                </span>
              </div>
              <Button
                variant='ghost'
                size='sm'
                onClick={onClose}
                className='lg:hidden h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-dark-200 active:bg-gray-200 dark:active:bg-dark-100 touch-manipulation'
              >
                <X className='h-4 w-4' />
              </Button>
            </div>

            <Button
              onClick={handleCreateSession}
              disabled={!selectedModel || models.length === 0}
              className='w-full bg-primary-600 hover:bg-primary-700 active:bg-primary-800 text-white shadow-sm hover:shadow-md active:shadow-lg transition-all duration-200 border-0 touch-manipulation'
              size='sm'
              title={
                !selectedModel || models.length === 0
                  ? 'No models available. Please ensure Ollama is running and models are installed.'
                  : ''
              }
            >
              <Plus className='h-4 w-4 mr-2' />
              New Chat
            </Button>
          </div>

          {/* Navigation Menu - Grouped */}
          <div className='px-3 py-2'>
            <nav className='space-y-1'>
              <button
                onClick={() => {
                  // Clear current session and set a flag to force welcome screen
                  const { setCurrentSession } = useChatStore.getState();
                  setCurrentSession(null);
                  // Set a flag in sessionStorage to force welcome screen
                  sessionStorage.setItem('forceWelcomeScreen', 'true');
                  navigate('/chat', { replace: true });
                  if (window.innerWidth < 768) {
                    onClose();
                  }
                }}
                className={cn(
                  'w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 text-left touch-manipulation',
                  location.pathname === '/chat' || location.pathname === '/'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-200 shadow-sm'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200'
                )}
              >
                <MessageSquare className='h-4 w-4 shrink-0' />
                Chat
              </button>

              <Link
                to='/models'
                onClick={() => window.innerWidth < 768 && onClose()}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 touch-manipulation',
                  location.pathname === '/models'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-200 shadow-sm'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200'
                )}
              >
                <Database className='h-4 w-4 shrink-0' />
                Models
              </Link>

              <Link
                to='/personas'
                onClick={() => window.innerWidth < 768 && onClose()}
                className={cn(
                  'flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 touch-manipulation',
                  location.pathname === '/personas'
                    ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-200 shadow-sm'
                    : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200'
                )}
              >
                <User className='h-4 w-4 shrink-0' />
                Personas
              </Link>

              {/* User Management - only show for admins when auth is required */}
              {systemInfo?.requiresAuth && user && isAdmin() && (
                <Link
                  to='/users'
                  onClick={() => window.innerWidth < 768 && onClose()}
                  className={cn(
                    'flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 touch-manipulation',
                    location.pathname === '/users'
                      ? 'bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-200 shadow-sm'
                      : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200'
                  )}
                >
                  <Users className='h-4 w-4 shrink-0' />
                  User Management
                </Link>
              )}

              <button
                onClick={() => {
                  setSettingsOpen(true);
                  if (window.innerWidth < 768) {
                    onClose();
                  }
                }}
                className='flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium transition-all duration-200 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-200/50 hover:text-gray-900 dark:hover:text-gray-100 active:bg-gray-100 dark:active:bg-dark-200 w-full text-left touch-manipulation'
              >
                <Settings className='h-4 w-4 shrink-0' />
                Settings
              </button>
            </nav>
          </div>

          {/* Sessions list */}
          <div
            className='flex-1 overflow-y-auto scrollbar-thin border-t border-gray-200/60 dark:border-dark-200/60 overscroll-behavior-contain'
            style={{
              WebkitOverflowScrolling: 'touch',
            }}
          >
            <div className='p-3'>
              <div className='flex items-center justify-between mb-3 px-1'>
                <h3 className='text-sm font-semibold text-gray-800 dark:text-gray-200'>
                  Recent Chats
                </h3>
                {sessions.length > 0 && (
                  <span className='inline-flex items-center justify-center px-2 py-0.5 text-xs font-medium bg-gray-100 dark:bg-dark-300 text-gray-600 dark:text-gray-400 rounded-full min-w-[1.5rem] h-5'>
                    {sessions.length}
                  </span>
                )}
              </div>
              {sessions.length === 0 ? (
                <div className='text-center py-8 px-2'>
                  <div className='w-12 h-12 mx-auto mb-3 bg-gray-100 dark:bg-dark-300 rounded-xl flex items-center justify-center'>
                    <MessageSquare className='h-5 w-5 text-gray-400 dark:text-gray-500' />
                  </div>
                  <p className='text-sm font-medium text-gray-600 dark:text-gray-400'>
                    No chats yet
                  </p>
                  <p className='text-xs mt-1 text-gray-500 dark:text-gray-500'>
                    Create your first chat above
                  </p>
                </div>
              ) : (
                <div className='space-y-1.5'>
                  {sessions.map(session => {
                    const isActive = currentSessionId === session.id;

                    return (
                      <div
                        key={session.id}
                        className={cn(
                          'group relative rounded-lg p-3 cursor-pointer transition-all duration-200 touch-manipulation',
                          isActive
                            ? 'bg-primary-50 dark:bg-primary-900/25 border border-primary-200/60 dark:border-primary-700/60 shadow-sm'
                            : 'hover:bg-white dark:hover:bg-dark-200/70 hover:shadow-sm border border-transparent hover:border-gray-200/60 dark:hover:border-dark-300/60 active:bg-gray-50 dark:active:bg-dark-200'
                        )}
                        onClick={() => handleSelectSession(session)}
                      >
                        {editingSessionId === session.id ? (
                          <div
                            className='flex items-center gap-2'
                            onClick={e => e.stopPropagation()}
                          >
                            <Input
                              value={editingTitle}
                              onChange={e => setEditingTitle(e.target.value)}
                              onKeyDown={e => {
                                if (e.key === 'Enter') {
                                  handleSaveEdit(session.id);
                                } else if (e.key === 'Escape') {
                                  handleCancelEdit();
                                }
                              }}
                              className='text-sm h-8'
                              autoFocus
                            />
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={() => handleSaveEdit(session.id)}
                              className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300 active:bg-gray-200 dark:active:bg-dark-400 touch-manipulation'
                            >
                              <Check className='h-3 w-3' />
                            </Button>
                            <Button
                              variant='ghost'
                              size='sm'
                              onClick={handleCancelEdit}
                              className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300 active:bg-gray-200 dark:active:bg-dark-400 touch-manipulation'
                            >
                              <X className='h-3 w-3' />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className='flex items-start justify-between'>
                              <div className='flex-1 min-w-0'>
                                <h3
                                  className={cn(
                                    'text-sm font-medium truncate mb-1 leading-tight',
                                    isActive
                                      ? 'text-primary-900 dark:text-primary-100 font-semibold'
                                      : 'text-gray-900 dark:text-gray-100'
                                  )}
                                >
                                  {truncateText(session.title, 28)}
                                </h3>
                                <p
                                  className={cn(
                                    'text-xs leading-tight',
                                    isActive
                                      ? 'text-primary-700 dark:text-primary-300'
                                      : 'text-gray-500 dark:text-gray-400'
                                  )}
                                >
                                  {formatTimestamp(session.updatedAt)} •{' '}
                                  <span className='font-medium'>
                                    {session.model}
                                  </span>
                                </p>
                              </div>

                              <div className='flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all duration-200 ml-2 shrink-0'>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={e => handleStartEditing(session, e)}
                                  className='h-7 w-7 sm:h-6 sm:w-6 p-0 hover:bg-gray-100 dark:hover:bg-dark-400 active:bg-gray-200 dark:active:bg-dark-300 rounded-md touch-manipulation'
                                  title='Rename chat'
                                >
                                  <Edit3 className='h-3 w-3' />
                                </Button>
                                <Button
                                  variant='ghost'
                                  size='sm'
                                  onClick={e =>
                                    handleDeleteSession(session.id, e)
                                  }
                                  className='h-7 w-7 sm:h-6 sm:w-6 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 active:bg-red-100 dark:active:bg-red-900/30 rounded-md touch-manipulation'
                                  title='Delete chat'
                                >
                                  <Trash2 className='h-3 w-3' />
                                </Button>
                              </div>
                            </div>

                            {session.messages.length > 0 && (
                              <p
                                className={cn(
                                  'text-xs mt-1.5 line-clamp-2 leading-relaxed',
                                  isActive
                                    ? 'text-primary-600 dark:text-primary-400'
                                    : 'text-gray-400 dark:text-gray-500'
                                )}
                              >
                                {truncateText(
                                  session.messages[session.messages.length - 1]
                                    ?.content || '',
                                  55
                                )}
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <SettingsModal
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </>
  );
};
