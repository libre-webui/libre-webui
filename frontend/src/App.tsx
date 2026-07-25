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

import React, { useState, Suspense } from 'react';
import {
  BrowserRouter,
  HashRouter,
  Routes,
  Route,
  useLocation,
} from 'react-router';

// Initialize i18n
import '@/i18n';
import { isRTL } from '@/i18n';
import { useTranslation } from 'react-i18next';

// Use HashRouter for Electron (file:// protocol) since BrowserRouter doesn't work with file://
const Router =
  window.location.protocol === 'file:' ? HashRouter : BrowserRouter;
const isElectron = window.location.protocol === 'file:';

// Draggable title bar area for Electron macOS
const ElectronTitleBar: React.FC = () => {
  if (!isElectron) return null;
  return (
    <div
      className='absolute top-0 left-0 right-0 h-8 z-50'
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    />
  );
};
import { Toaster } from 'react-hot-toast';
import { Sidebar } from '@/components/Sidebar';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { API_BASE_URL } from '@/utils/config';
import {
  KeyboardShortcutsModal,
  KeyboardShortcutsIndicator,
} from '@/components/KeyboardShortcuts';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { BackgroundRenderer } from '@/components/BackgroundRenderer';
import { Logo } from '@/components/Logo';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useInitializeApp } from '@/hooks/useInitializeApp';
import { UserService } from '@/services/userService';
import {
  useKeyboardShortcuts,
  KeyboardShortcut,
} from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import websocketService from '@/utils/websocket';
import toast from 'react-hot-toast';

const logger = createLogger('app');

// Lazy load pages for code splitting
const ChatPage = React.lazy(() => import('@/pages/ChatPage'));
const ModelsPage = React.lazy(() => import('@/pages/ModelsPage'));
const PersonasPage = React.lazy(() => import('@/pages/PersonasPage'));
const GalleryPage = React.lazy(() => import('@/pages/GalleryPage'));
const LibreClawPage = React.lazy(() => import('@/pages/LibreClawPage'));
const UserManagementPage = React.lazy(
  () => import('@/pages/UserManagementPage')
);
const ArtifactDemoPage = React.lazy(() => import('@/pages/ArtifactDemoPage'));
const SettingsModal = React.lazy(() =>
  import('@/components/SettingsModal').then(module => ({
    default: module.SettingsModal,
  }))
);
const ArtifactSlideOutPanel = React.lazy(() =>
  import('@/components/ArtifactSlideOutPanel').then(module => ({
    default: module.ArtifactSlideOutPanel,
  }))
);
const FirstTimeSetup = React.lazy(() =>
  import('@/components/FirstTimeSetup').then(module => ({
    default: module.FirstTimeSetup,
  }))
);

// Import LoginPage directly (not lazy) to avoid suspense issues during auth redirects
import { LoginPage } from '@/pages/LoginPage';

// Loading component
const PageLoader = () => {
  const { t } = useTranslation();
  return (
    <div className='flex h-full min-h-screen items-center justify-center bg-gray-50 dark:bg-dark-100'>
      <div className='flex flex-col items-center gap-3'>
        <div className='h-8 w-8 rounded-full border-4 border-gray-200 border-t-primary-500 animate-spin dark:border-dark-300 dark:border-t-primary-400'></div>
        <div className='text-gray-600 dark:text-dark-600'>
          {t('common.loading')}
        </div>
      </div>
    </div>
  );
};

const SidebarLayoutSpacer: React.FC<{ isOpen: boolean; compact: boolean }> = ({
  isOpen,
  compact,
}) => (
  <div
    aria-hidden='true'
    className={cn(
      'hidden lg:block flex-shrink-0 transition-[width] duration-200 ease-out',
      isOpen ? (compact ? 'w-18' : 'w-72') : 'w-0'
    )}
  />
);

// Conditional keyboard shortcuts indicator - only shows on chat pages and desktop
const ConditionalKeyboardShortcutsIndicator: React.FC<{
  onClick: () => void;
}> = ({ onClick }) => {
  const location = useLocation();

  // Check if we're on a chat page (root, /chat, or /c/sessionId)
  const isChatPage =
    location.pathname === '/' ||
    location.pathname === '/chat' ||
    location.pathname.startsWith('/c/');

  if (!isChatPage) return null;

  return (
    <div className='hidden lg:block'>
      <KeyboardShortcutsIndicator onClick={onClick} />
    </div>
  );
};

const App: React.FC = () => {
  const { t, i18n } = useTranslation();

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [setupComplete, setSetupComplete] = useState(false);
  const {
    sidebarOpen,
    sidebarCompact,
    setSidebarOpen,
    setSidebarCompact,
    toggleSidebar,
    toggleSidebarCompact,
    toggleTheme,
    backgroundImage,
    preferences,
    artifactPanelOpen,
  } = useAppStore();
  const {
    systemInfo,
    isLoading: authLoading,
    user: _user,
    isAuthenticated: _isAuthenticated,
  } = useAuthStore();
  const { isDemoMode, demoConfig } = useAppStore();

  // Handle OAuth callback FIRST - before any routing or initialization
  const [oauthProcessed, setOauthProcessed] = React.useState(false);
  const processingRef = React.useRef(false);

  React.useEffect(() => {
    const processOAuthCallback = async () => {
      // Prevent multiple simultaneous executions
      if (processingRef.current) {
        logger.debug('OAuth already processing, skipping...');
        return;
      }

      logger.debug('Starting OAuth callback processing...');
      processingRef.current = true;

      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      const authStatus = urlParams.get('auth');

      if (token && authStatus === 'success') {
        try {
          // Verify token and get user info from the backend
          const response = await fetch(`${API_BASE_URL}/auth/me`, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
            credentials: 'include',
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
              // Use auth store login function to properly authenticate
              const { login, systemInfo } = useAuthStore.getState();
              login(
                data.data,
                token,
                systemInfo || {
                  requiresAuth: true,
                  hasUsers: true,
                  userCount: 1,
                  version: '0.1.6',
                }
              );
              logger.debug('OAuth login successful, showing toast');
              toast.success('GitHub login successful!');
            } else {
              toast.error('Failed to verify GitHub authentication');
            }
          } else {
            toast.error('GitHub authentication verification failed');
          }
        } catch (error) {
          logger.error('OAuth processing error:', error);
          toast.error('GitHub authentication failed');
        }

        // Clean up URL regardless of success/failure
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname
        );
      }

      logger.debug('OAuth processing completed');
      setOauthProcessed(true);
      processingRef.current = false;
    };

    processOAuthCallback();
  }, []);

  // Initialize the app only after OAuth is processed
  useInitializeApp();

  // Check if any background is active (persona background or general background settings)
  const hasActiveBackground = () => {
    // Persona background takes priority
    if (backgroundImage) {
      return true;
    }

    // Check general background settings
    const backgroundSettings = preferences.backgroundSettings;
    return backgroundSettings?.enabled && backgroundSettings?.imageUrl;
  };

  // Define keyboard shortcuts
  const shortcuts: KeyboardShortcut[] = [
    {
      key: 'b',
      metaKey: true,
      action: () => {
        // On desktop (lg screens), always keep sidebar open and toggle compact mode
        // On mobile, allow closing/opening the sidebar
        if (window.innerWidth >= 1024) {
          // lg breakpoint
          // Desktop behavior: If closed, open in expanded mode, otherwise toggle compact
          if (!sidebarOpen) {
            setSidebarCompact(false);
            toggleSidebar();
          } else {
            toggleSidebarCompact();
          }
        } else {
          // Mobile behavior: Toggle open/closed, always open in expanded mode
          if (!sidebarOpen && sidebarCompact) {
            setSidebarCompact(false);
          }
          toggleSidebar();
        }
      },
      description: t('keyboard.toggleSidebar'),
    },
    {
      key: ',',
      metaKey: true,
      action: () => setSettingsOpen(true),
      description: t('keyboard.openSettings'),
    },
    {
      key: 'd',
      metaKey: true,
      action: toggleTheme,
      description: t('keyboard.toggleDarkMode'),
    },
    {
      key: 'h',
      action: () => setShortcutsOpen(true),
      description: t('keyboard.showShortcuts'),
    },
    {
      key: 'Escape',
      action: () => {
        setSettingsOpen(false);
        setShortcutsOpen(false);
      },
      description: t('keyboard.closeModals'),
    },
  ];

  // Enable keyboard shortcuts
  useKeyboardShortcuts(shortcuts);

  // Initialize WebSocket connection
  React.useEffect(() => {
    websocketService.connect().catch(logger.error);

    return () => {
      websocketService.disconnect();
    };
  }, []);

  // Auto-retry connection to backend when it's not available
  React.useEffect(() => {
    if (!systemInfo && !authLoading && retryCount < 15) {
      const timer = setTimeout(async () => {
        setRetryCount(c => c + 1);
        try {
          // Re-run auth initialization to check if backend is now available
          await UserService.initializeAuth();
        } catch {
          // Will retry on next interval
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [systemInfo, authLoading, retryCount]);

  // Enter first-time setup mode when conditions are met (derived from auth/system state)
  const inFirstTimeSetup =
    !setupComplete &&
    systemInfo?.requiresAuth === true &&
    systemInfo?.hasUsers === false;

  // Show loading spinner while initializing auth
  if (authLoading) {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex flex-col items-center'>
            <Logo className='text-gray-900 dark:text-gray-100' />
          </div>
        </div>

        <div className='mt-8 flex flex-col items-center gap-4'>
          <div className='w-8 h-8 border-4 border-gray-300 dark:border-gray-600 border-t-primary-500 dark:border-t-primary-400 rounded-full animate-spin'></div>
        </div>
      </div>
    );
  }

  // Show loading screen while waiting for backend
  if (!systemInfo) {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex items-center justify-center p-4'>
        <div className='text-center'>
          <div className='mb-8'>
            <Logo className='text-gray-900 dark:text-white' />
          </div>
          <div className='flex justify-center mb-4'>
            <div className='w-8 h-8 border-4 border-gray-300 dark:border-dark-300 border-t-primary-500 dark:border-t-primary-400 rounded-full animate-spin'></div>
          </div>
          <p className='text-gray-600 dark:text-dark-600 text-sm'>
            {retryCount > 0
              ? `Connecting to backend... (${retryCount}/15)`
              : 'Starting up...'}
          </p>
        </div>
      </div>
    );
  }

  // Show FirstTimeSetup if we're in setup mode and haven't completed it
  if (inFirstTimeSetup && !setupComplete) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<PageLoader />}>
          <FirstTimeSetup
            onComplete={() => {
              setSetupComplete(true);
            }}
          />
        </Suspense>
      </ErrorBoundary>
    );
  }

  // Show loading state while processing OAuth
  if (!oauthProcessed) {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex items-center justify-center'>
        <div className='w-8 h-8 border-4 border-gray-300 dark:border-gray-600 border-t-primary-500 dark:border-t-primary-400 rounded-full animate-spin'></div>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <Router>
        {/* Show full layout only if system doesn't require auth or user is authenticated */}
        {systemInfo && !systemInfo.requiresAuth ? (
          // No auth required - show full layout
          <div
            className={cn(
              'flex h-dvh min-h-0 text-gray-950 dark:text-dark-900 relative overflow-hidden',
              hasActiveBackground()
                ? 'bg-gray-100/60 dark:bg-dark-50/60'
                : 'bg-gray-100 dark:bg-dark-50'
            )}
          >
            <ElectronTitleBar />
            <BackgroundRenderer />
            <Sidebar
              isOpen={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
            <SidebarLayoutSpacer
              isOpen={sidebarOpen}
              compact={sidebarCompact}
            />
            <div
              data-testid='app-shell-content'
              className={cn(
                'flex-1 basis-0 flex min-h-0 flex-col min-w-0 transition-[margin,background-color] duration-200 ease-out relative z-10 lg:py-2 lg:pe-2',
                // Mobile behavior:
                // - Compact sidebar: push content away to avoid overlap
                // - Expanded sidebar: overlay (no transform)
                sidebarOpen && sidebarCompact ? 'max-lg:ms-18' : 'max-lg:ms-0',
                hasActiveBackground()
                  ? 'bg-white/10 dark:bg-dark-50/10'
                  : 'bg-transparent'
              )}
            >
              {isDemoMode && demoConfig.showBanner && (
                <DemoModeBanner message={demoConfig.message} />
              )}
              <main
                className={cn(
                  'min-h-0 flex-1 overflow-hidden lg:rounded-[1.5rem] lg:border lg:border-black/[0.06] dark:lg:border-white/[0.07] lg:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_60px_rgba(15,23,42,0.04)]',
                  hasActiveBackground()
                    ? 'bg-white/30 dark:bg-dark-100/35 backdrop-blur-sm'
                    : 'bg-gray-50 dark:bg-dark-100'
                )}
              >
                <ErrorBoundary>
                  <Suspense fallback={<PageLoader />}>
                    <Routes>
                      <Route path='/' element={<ChatPage />} />
                      <Route path='/chat' element={<ChatPage />} />
                      <Route path='/c/:sessionId' element={<ChatPage />} />
                      <Route path='/models' element={<ModelsPage />} />
                      <Route path='/personas' element={<PersonasPage />} />
                      <Route path='/login' element={<LoginPage />} />
                    </Routes>
                  </Suspense>
                </ErrorBoundary>
              </main>
            </div>
          </div>
        ) : (
          // Auth required - show routes without main layout constraining login
          <Routes>
            <Route path='/login' element={<LoginPage />} />
            <Route
              path='/*'
              element={
                <ProtectedRoute>
                  <div
                    className={cn(
                      'flex h-dvh min-h-0 text-gray-950 dark:text-dark-900 relative overflow-hidden',
                      hasActiveBackground()
                        ? 'bg-gray-100/60 dark:bg-dark-50/60'
                        : 'bg-gray-100 dark:bg-dark-50'
                    )}
                  >
                    <ElectronTitleBar />
                    <BackgroundRenderer />
                    <Sidebar
                      isOpen={sidebarOpen}
                      onClose={() => setSidebarOpen(false)}
                    />
                    <SidebarLayoutSpacer
                      isOpen={sidebarOpen}
                      compact={sidebarCompact}
                    />
                    <div
                      data-testid='app-shell-content'
                      className={cn(
                        'flex-1 basis-0 flex min-h-0 flex-col min-w-0 transition-[margin,background-color] duration-200 ease-out relative z-10 lg:py-2 lg:pe-2',
                        // Mobile behavior:
                        // - Compact sidebar: push content away to avoid overlap
                        // - Expanded sidebar: overlay (no transform)
                        sidebarOpen && sidebarCompact
                          ? 'max-lg:ms-18'
                          : 'max-lg:ms-0',
                        hasActiveBackground()
                          ? 'bg-white/10 dark:bg-dark-50/10'
                          : 'bg-transparent'
                      )}
                    >
                      {isDemoMode && demoConfig.showBanner && (
                        <DemoModeBanner message={demoConfig.message} />
                      )}
                      <main
                        className={cn(
                          'min-h-0 flex-1 overflow-hidden lg:rounded-[1.5rem] lg:border lg:border-black/[0.06] dark:lg:border-white/[0.07] lg:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_60px_rgba(15,23,42,0.04)]',
                          hasActiveBackground()
                            ? 'bg-white/30 dark:bg-dark-100/35 backdrop-blur-sm'
                            : 'bg-gray-50 dark:bg-dark-100'
                        )}
                      >
                        <ErrorBoundary>
                          <Suspense fallback={<PageLoader />}>
                            <Routes>
                              <Route path='/' element={<ChatPage />} />
                              <Route path='/chat' element={<ChatPage />} />
                              <Route
                                path='/c/:sessionId'
                                element={<ChatPage />}
                              />
                              <Route path='/models' element={<ModelsPage />} />
                              <Route
                                path='/personas'
                                element={<PersonasPage />}
                              />
                              <Route
                                path='/gallery'
                                element={<GalleryPage />}
                              />
                              <Route
                                path='/agents'
                                element={<LibreClawPage />}
                              />
                              <Route
                                path='/artifacts'
                                element={<ArtifactDemoPage />}
                              />
                              <Route
                                path='/users'
                                element={
                                  <ProtectedRoute requireAdmin={true}>
                                    <UserManagementPage />
                                  </ProtectedRoute>
                                }
                              />
                            </Routes>
                          </Suspense>
                        </ErrorBoundary>
                      </main>
                    </div>
                  </div>
                </ProtectedRoute>
              }
            />
          </Routes>
        )}

        {/* Modals */}
        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsModal
              isOpen={settingsOpen}
              onClose={() => setSettingsOpen(false)}
            />
          </Suspense>
        )}

        <KeyboardShortcutsModal
          isOpen={shortcutsOpen}
          onClose={() => setShortcutsOpen(false)}
          shortcuts={shortcuts}
        />

        {/* Keyboard shortcuts indicator - only show on chat pages */}
        <ConditionalKeyboardShortcutsIndicator
          onClick={() => setShortcutsOpen(true)}
        />

        {/* Artifact slide-out panel */}
        {artifactPanelOpen && (
          <Suspense fallback={null}>
            <ArtifactSlideOutPanel />
          </Suspense>
        )}

        <Toaster
          position={isRTL(i18n.language) ? 'top-left' : 'top-right'}
          toastOptions={{
            duration: 4000,
            className: 'animate-slide-up',
            style: {
              background: 'var(--toast-bg)',
              color: 'var(--toast-color)',
              border: '1px solid var(--toast-border)',
              borderRadius: '0.75rem',
              boxShadow:
                '0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)',
              cursor: 'pointer',
            },
            success: {
              iconTheme: {
                primary: 'rgb(var(--color-primary-600))',
                secondary: '#ffffff',
              },
            },
            error: {
              iconTheme: {
                primary: 'rgb(var(--color-primary-600))',
                secondary: '#ffffff',
              },
            },
          }}
          containerStyle={{
            top: 80, // Position below header (header height + some margin)
            insetInlineEnd: 20,
          }}
        />
      </Router>
    </ErrorBoundary>
  );
};

export default App;
