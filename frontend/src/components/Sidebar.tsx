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
  } = useChatStore();
  const { user, isAdmin, systemInfo } = useAuthStore();
  const { backgroundImage } = useAppStore();

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Define the prefix for session URLs
  const SESSION_URL_PREFIX = '/c/';

  // Extract current session ID from URL using useParams
  const { sessionId } = useParams<{ sessionId: string }>();
  const currentSessionIdFromUrl = location.pathname.startsWith(
    SESSION_URL_PREFIX
  )
    ? sessionId
    : null;

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
        const isCurrentSession = currentSessionIdFromUrl === sessionId;

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
          className='fixed inset-0 bg-black/50 z-40 lg:hidden'
          onClick={onClose}
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
          className
        )}
      >
        <div className='flex flex-col h-full'>
          {/* Header */}
          <div className='p-4 sm:p-6 border-b border-gray-200 dark:border-dark-200'>
            <div className='flex items-center justify-between mb-4 sm:mb-6'>
              <div className='flex items-center gap-3'>
                <Logo size='sm' />
                <span
                  className='libre-brand text-lg sm:text-xl font-semibold text-gray-900 dark:text-dark-800'
                  style={{ lineHeight: 1 }}
                >
                  Libre WebUI
                </span>
              </div>
              <Button
                variant='ghost'
                size='sm'
                onClick={onClose}
                className='lg:hidden h-8 w-8 p-0 hover:bg-gray-200 dark:hover:bg-dark-200'
              >
                <X className='h-4 w-4' />
              </Button>
            </div>

            <Button
              onClick={handleCreateSession}
              disabled={!selectedModel || models.length === 0}
              className='w-full shadow-sm hover:shadow-md transition-all duration-200'
              size='md'
              title={
                !selectedModel || models.length === 0
                  ? 'No models available. Please ensure Ollama is running and models are installed.'
                  : ''
              }
            >
              <Plus className='h-4 w-4 mr-2' />
              New Chat
            </Button>

            {/* Model status indicator */}
            {models.length === 0 && (
              <div className='mt-3 p-3 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-xl'>
                <p className='text-xs text-gray-700 dark:text-dark-700'>
                  No models available. Please ensure Ollama is running and
                  models are installed.
                </p>
              </div>
            )}

            {selectedModel && (
              <div className='mt-3 p-3 bg-gray-50 dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-xl'>
                <p className='text-xs text-gray-700 dark:text-dark-700'>
                  Using model:{' '}
                  <span className='font-medium'>{selectedModel}</span>
                </p>
              </div>
            )}
          </div>

          {/* Navigation Menu */}
          <div className='px-4 py-2 border-b border-gray-200 dark:border-dark-200'>
            <nav className='space-y-1'>
              <Link
                to='/chat'
                onClick={() => window.innerWidth < 768 && onClose()}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  location.pathname === '/chat' || location.pathname === '/'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-dark-200 hover:text-gray-900 dark:hover:text-gray-200'
                )}
              >
                <MessageSquare className='h-4 w-4' />
                Chat
              </Link>

              <Link
                to='/models'
                onClick={() => window.innerWidth < 768 && onClose()}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  location.pathname === '/models'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-dark-200 hover:text-gray-900 dark:hover:text-gray-200'
                )}
              >
                <Database className='h-4 w-4' />
                Models
              </Link>

              <Link
                to='/personas'
                onClick={() => window.innerWidth < 768 && onClose()}
                className={cn(
                  'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                  location.pathname === '/personas'
                    ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-dark-200 hover:text-gray-900 dark:hover:text-gray-200'
                )}
              >
                <User className='h-4 w-4' />
                Personas
              </Link>

              {/* User Management - only show for admins when auth is required */}
              {systemInfo?.requiresAuth && user && isAdmin() && (
                <Link
                  to='/users'
                  onClick={() => window.innerWidth < 768 && onClose()}
                  className={cn(
                    'flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors',
                    location.pathname === '/users'
                      ? 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
                      : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-dark-200 hover:text-gray-900 dark:hover:text-gray-200'
                  )}
                >
                  <Users className='h-4 w-4' />
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
                className='flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-dark-200 hover:text-gray-900 dark:hover:text-gray-200 w-full text-left'
              >
                <Settings className='h-4 w-4' />
                Settings
              </button>
            </nav>
          </div>

          {/* Sessions list */}
          <div className='flex-1 overflow-y-auto scrollbar-thin'>
            <div className='p-3 sm:p-4'>
              <div className='flex items-center justify-between mb-3'>
                <h3 className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                  Chat Sessions
                </h3>
                {sessions.length > 0 && (
                  <span className='text-xs text-gray-500 dark:text-gray-400'>
                    {sessions.length}
                  </span>
                )}
              </div>
              {sessions.length === 0 ? (
                <div className='text-center py-12 text-gray-500 dark:text-dark-600'>
                  <MessageSquare className='h-8 w-8 mx-auto mb-3 opacity-50' />
                  <p className='text-sm font-medium'>No chats yet</p>
                  <p className='text-xs mt-1'>Start a conversation to begin</p>
                </div>
              ) : (
                <div className='space-y-2'>
                  {sessions.map(session => (
                    <div
                      key={session.id}
                      className={cn(
                        'group relative rounded-xl p-4 cursor-pointer transition-all duration-200',
                        'hover:bg-white dark:hover:bg-dark-200 hover:shadow-sm',
                        currentSessionIdFromUrl === session.id &&
                          'bg-white dark:bg-dark-200 shadow-sm border border-primary-200 dark:border-primary-800 ring-1 ring-primary-100 dark:ring-primary-900'
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
                            className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300'
                          >
                            <Check className='h-3 w-3' />
                          </Button>
                          <Button
                            variant='ghost'
                            size='sm'
                            onClick={handleCancelEdit}
                            className='h-8 w-8 p-0 shrink-0 hover:bg-gray-100 dark:hover:bg-dark-300'
                          >
                            <X className='h-3 w-3' />
                          </Button>
                        </div>
                      ) : (
                        <>
                          <div className='flex items-start justify-between'>
                            <div className='flex-1 min-w-0'>
                              <h3 className='text-sm font-medium text-gray-900 dark:text-dark-800 truncate mb-1'>
                                {truncateText(session.title, 30)}
                              </h3>
                              <p className='text-xs text-gray-500 dark:text-dark-600'>
                                {formatTimestamp(session.updatedAt)} •{' '}
                                {session.model}
                              </p>
                            </div>

                            <div className='flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0'>
                              <Button
                                variant='ghost'
                                size='sm'
                                onClick={e => handleStartEditing(session, e)}
                                className='h-7 w-7 p-0 hover:bg-gray-100 dark:hover:bg-dark-300'
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
                                className='h-7 w-7 p-0 text-error-600 hover:text-error-700 hover:bg-error-50 dark:hover:bg-error-900/20'
                                title='Delete chat'
                              >
                                <Trash2 className='h-3 w-3' />
                              </Button>
                            </div>
                          </div>

                          {session.messages.length > 0 && (
                            <p className='text-xs text-gray-400 dark:text-dark-500 mt-2 line-clamp-2'>
                              {truncateText(
                                session.messages[session.messages.length - 1]
                                  ?.content || '',
                                60
                              )}
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className='p-4 border-t border-gray-200 dark:border-dark-200 bg-gray-25 dark:bg-dark-100'>
            <div className='text-xs text-gray-500 dark:text-dark-600 text-center space-y-2'>
              {models.length > 0 && (
                <p>
                  Using{' '}
                  <span className='font-medium text-gray-700 dark:text-dark-700'>
                    {selectedModel || 'No model selected'}
                  </span>
                </p>
              )}
              <p>
                {sessions.length} chat{sessions.length !== 1 ? 's' : ''}{' '}
                available
              </p>

              {/* Keyboard shortcuts hint */}
              <div className='pt-2 border-t border-gray-200 dark:border-dark-300'>
                <p className='text-xs text-gray-400 dark:text-dark-500'>
                  Press{' '}
                  <kbd className='px-1 py-0.5 text-xs font-mono bg-gray-200 dark:bg-dark-300 text-gray-600 dark:text-dark-600 rounded'>
                    ⌘B
                  </kbd>{' '}
                  to toggle sidebar
                </p>
                <p className='text-xs text-gray-400 dark:text-dark-500 mt-1'>
                  Press{' '}
                  <kbd className='px-1 py-0.5 text-xs font-mono bg-gray-200 dark:bg-dark-300 text-gray-600 dark:text-dark-600 rounded'>
                    ?
                  </kbd>{' '}
                  or{' '}
                  <kbd className='px-1 py-0.5 text-xs font-mono bg-gray-200 dark:bg-dark-300 text-gray-600 dark:text-dark-600 rounded'>
                    H
                  </kbd>{' '}
                  for shortcuts
                </p>
              </div>
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
