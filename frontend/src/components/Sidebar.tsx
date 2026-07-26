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

import React, { useState, useRef, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import { useAuthStore } from '@/store/authStore';
import { useAppStore } from '@/store/appStore';
import type { ChatSession } from '@/types';
import type { WorkTaskSummary } from '@/types/work';
import { cn } from '@/utils';
import { authApi, usersApi } from '@/utils/api';
import { clearWorkTaskDrafts } from '@/utils/workDrafts';
import { toast } from 'react-hot-toast';
import { createLogger } from '@/utils/logger';
import { advanceWelcomePrompt } from '@/utils/welcomePrompts';
import { AvatarModal } from '@/components/sidebar/AvatarModal';
import { SidebarHeader } from '@/components/sidebar/SidebarHeader';
import { SidebarNavigation } from '@/components/sidebar/SidebarNavigation';
import { SidebarSessions } from '@/components/sidebar/SidebarSessions';
import { SidebarUserSection } from '@/components/sidebar/SidebarUserSection';
import { SidebarWorkTasks } from '@/components/sidebar/SidebarWorkTasks';

const logger = createLogger('components:sidebar');
const SettingsModal = React.lazy(() =>
  import('@/components/SettingsModal').then(module => ({
    default: module.SettingsModal,
  }))
);

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  isOpen,
  onClose: _onClose,
  className,
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const {
    sessions,
    deleteSession,
    updateSessionTitle,
    selectedModel,
    models,
    currentSession,
    generatingTitleForSession,
    personas,
  } = useChatStore();
  const workTasks = useWorkStore(state => state.tasks);
  const loadingWorkTasks = useWorkStore(state => state.loadingTasks);
  const workActionLoading = useWorkStore(state => state.actionLoading);
  const deleteWorkTask = useWorkStore(state => state.deleteTask);
  const { user, isAdmin, systemInfo, setUser } = useAuthStore();
  const { backgroundImage, sidebarCompact, toggleSidebarCompact } =
    useAppStore();

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showAvatarModal, setShowAvatarModal] = useState(false);
  const [avatarValue, setAvatarValue] = useState('');
  const [isSavingAvatar, setIsSavingAvatar] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);

  const currentSessionIdFromUrl =
    location.pathname.match(/^\/c\/([^/]+)$/)?.[1] || null;
  const currentSessionId = currentSession?.id || currentSessionIdFromUrl;

  const compactOnMobile = () => {
    if (window.innerWidth < 768 && !sidebarCompact) {
      toggleSidebarCompact();
    }
  };

  const forceWelcomeScreen = () => {
    const { setCurrentSession } = useChatStore.getState();
    advanceWelcomePrompt();
    setCurrentSession(null);
    sessionStorage.setItem('forceWelcomeScreen', 'true');
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        userMenuRef.current &&
        !userMenuRef.current.contains(event.target as Node)
      ) {
        setUserMenuOpen(false);
      }
    };

    if (userMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [userMenuOpen]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        sidebarRef.current &&
        !sidebarRef.current.contains(event.target as Node) &&
        window.innerWidth < 768 &&
        isOpen &&
        !sidebarCompact
      ) {
        toggleSidebarCompact();
      }
    };

    if (isOpen && !sidebarCompact && window.innerWidth < 768) {
      document.addEventListener('mousedown', handleClickOutside);
      return () =>
        document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen, sidebarCompact, toggleSidebarCompact]);

  const handleSaveAvatar = async () => {
    setIsSavingAvatar(true);
    try {
      const response = await usersApi.updateMyAvatar(avatarValue || null);
      if (response.success && response.data) {
        setUser(response.data);
        toast.success(t('user.avatar.updated'));
        setShowAvatarModal(false);
      } else {
        toast.error(response.message || t('user.avatar.updateFailed'));
      }
    } catch (error) {
      logger.error('Failed to update avatar:', error);
      toast.error(t('user.avatar.updateFailed'));
    } finally {
      setIsSavingAvatar(false);
    }
  };

  const handleCreateSession = () => {
    forceWelcomeScreen();
    navigate('/chat', { replace: true });
    compactOnMobile();
  };

  const handleStartWork = () => {
    useWorkStore.getState().clearError();
    navigate('/work');
    compactOnMobile();
  };

  const handleChatNavigation = () => {
    forceWelcomeScreen();
    navigate('/chat', { replace: true });
    compactOnMobile();
  };

  const handleSelectSession = (session: ChatSession) => {
    navigate(`/c/${session.id}`, { replace: true });
    compactOnMobile();
  };

  const handleSelectWorkTask = (workTaskId: string) => {
    navigate(`/work/${workTaskId}`, { replace: true });
    compactOnMobile();
  };

  const handleDeleteWorkTask = async (task: WorkTaskSummary) => {
    if (
      !window.confirm(
        t('work.tasks.deleteConfirm', {
          defaultValue: 'Delete “{{title}}” and its workspace permanently?',
          title:
            task.title ||
            t('work.tasks.untitled', {
              defaultValue: 'Untitled task',
            }),
        })
      )
    ) {
      return;
    }

    try {
      await deleteWorkTask(task.id);
      clearWorkTaskDrafts(task.id);
    } catch (error) {
      logger.error('Failed to delete Work task:', error);
      toast.error(
        t('work.toasts.deleteFailed', {
          defaultValue: 'Could not delete this Work task.',
        })
      );
    }
  };

  const handleDeleteSession = async (
    sessionId: string,
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    logger.debug('Delete session clicked:', sessionId);

    if (window.confirm(t('chat.session.deleteConfirm'))) {
      try {
        logger.debug('Attempting to delete session:', sessionId);
        const isCurrentSession = currentSessionId === sessionId;

        await deleteSession(sessionId);
        logger.debug('Session deleted successfully');

        if (isCurrentSession) {
          const remainingSessions = sessions.filter(s => s.id !== sessionId);
          if (remainingSessions.length > 0) {
            navigate(`/c/${remainingSessions[0].id}`, { replace: true });
          } else {
            navigate('/', { replace: true });
          }
        }
      } catch (_error) {
        logger.error('Error deleting session:', _error);
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

  const handleLogout = async () => {
    try {
      await authApi.logout();
      const { logout } = useAuthStore.getState();
      logout();
      navigate('/login');
      toast.success(t('auth.logout.success'));
    } catch (error) {
      logger.error('Logout error:', error);
      const { logout } = useAuthStore.getState();
      logout();
      navigate('/login');
    }
  };

  const handleOpenSettings = () => {
    setSettingsOpen(true);
    compactOnMobile();
  };

  const handleOpenAvatar = (avatar: string) => {
    setAvatarValue(avatar);
    setShowAvatarModal(true);
  };

  const isElectron = window.location.protocol === 'file:';
  const isWorkRoute =
    location.pathname === '/work' || location.pathname.startsWith('/work/');
  const currentWorkTaskId =
    location.pathname.match(/^\/work\/([^/]+)$/)?.[1] || null;
  const isChatRoute =
    location.pathname === '/' ||
    location.pathname === '/chat' ||
    location.pathname.startsWith('/c/');
  const showWork = systemInfo?.requiresAuth === false || isAdmin();

  return (
    <>
      <div
        ref={sidebarRef}
        data-testid='sidebar'
        className={cn(
          'fixed inset-y-0 start-0 z-50 border-e border-black/[0.06] dark:border-white/[0.06] transform transition-[width,transform,background-color] duration-200 ease-out shadow-[0_24px_80px_rgba(15,23,42,0.12)]',
          sidebarCompact ? 'w-18' : 'w-72 max-sm:w-64',
          isOpen
            ? 'translate-x-0'
            : 'ltr:-translate-x-full rtl:translate-x-full',
          'lg:shadow-none',
          backgroundImage
            ? 'bg-gray-100/75 dark:bg-dark-50/75 backdrop-blur-xl'
            : 'bg-gray-100 dark:bg-dark-50',
          'overscroll-behavior-contain',
          className
        )}
        style={{
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {isElectron && (
          <div
            className='absolute top-0 start-16 end-0 h-8 z-[60]'
            style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
          />
        )}

        <div className='flex flex-col h-full'>
          <SidebarHeader
            sidebarCompact={sidebarCompact}
            isElectron={isElectron}
            showWork={showWork}
            activeMode={isWorkRoute ? 'work' : isChatRoute ? 'chat' : null}
            selectedModel={selectedModel}
            modelCount={models.length}
            onToggleCompact={toggleSidebarCompact}
            onStartWork={handleStartWork}
            onCreateSession={handleCreateSession}
          />

          <SidebarNavigation
            sidebarCompact={sidebarCompact}
            activePath={location.pathname}
            showWork={showWork}
            onChatClick={handleChatNavigation}
            onMobileNavigate={compactOnMobile}
          />

          {isWorkRoute && showWork ? (
            <SidebarWorkTasks
              tasks={workTasks}
              currentTaskId={currentWorkTaskId}
              loading={loadingWorkTasks}
              actionLoading={workActionLoading}
              sidebarCompact={sidebarCompact}
              onSelectTask={handleSelectWorkTask}
              onDeleteTask={task => void handleDeleteWorkTask(task)}
            />
          ) : (
            <SidebarSessions
              sessions={sessions}
              personas={personas}
              currentSessionId={currentSessionId}
              generatingTitleForSession={generatingTitleForSession}
              sidebarCompact={sidebarCompact}
              editingSessionId={editingSessionId}
              editingTitle={editingTitle}
              onEditingTitleChange={setEditingTitle}
              onSelectSession={handleSelectSession}
              onStartEditing={handleStartEditing}
              onSaveEdit={handleSaveEdit}
              onCancelEdit={handleCancelEdit}
              onDeleteSession={handleDeleteSession}
            />
          )}

          <SidebarUserSection
            requiresAuth={systemInfo?.requiresAuth}
            user={user}
            isAdmin={isAdmin()}
            sidebarCompact={sidebarCompact}
            userMenuOpen={userMenuOpen}
            userMenuRef={userMenuRef}
            onToggleUserMenu={() => setUserMenuOpen(open => !open)}
            onOpenSettings={handleOpenSettings}
            onOpenAvatar={handleOpenAvatar}
            onLogout={handleLogout}
            onMobileNavigate={compactOnMobile}
            onCloseUserMenu={() => setUserMenuOpen(false)}
          />
        </div>
      </div>

      {settingsOpen && (
        <React.Suspense fallback={null}>
          <SettingsModal
            isOpen={settingsOpen}
            onClose={() => setSettingsOpen(false)}
          />
        </React.Suspense>
      )}

      <AvatarModal
        open={showAvatarModal}
        value={avatarValue}
        saving={isSavingAvatar}
        onChange={setAvatarValue}
        onClose={() => setShowAvatarModal(false)}
        onSave={handleSaveAvatar}
      />
    </>
  );
};
