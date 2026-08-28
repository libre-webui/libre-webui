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
  createBrowserRouter,
  createHashRouter,
  RouterProvider,
  Routes,
  Route,
  useNavigate,
} from 'react-router';

// Initialize i18n
import '@/i18n';
import { isRTL } from '@/i18n';
import { useTranslation } from 'react-i18next';

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
import { ErrorBoundary, RouteErrorScreen } from '@/components/ErrorBoundary';
import { API_BASE_URL } from '@/utils/config';
import { WhatsNewModal } from '@/components/WhatsNewModal';
import { useWhatsNew } from '@/hooks/useWhatsNew';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { BackgroundRenderer } from '@/components/BackgroundRenderer';
import { AppTabBar } from '@/components/AppTabBar';
import { startNewChat, startNewWork } from '@/utils/appNavigation';
import { CommandPalette } from '@/components/CommandPalette';
import { LogoMark } from '@/components/LogoMark';
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
import { armTTSAudioPlaybackUnlock } from '@/utils/ttsBatching';
import toast from 'react-hot-toast';

const logger = createLogger('app');

// Lazy load pages for code splitting
const HomePage = React.lazy(() => import('@/pages/HomePage'));
const ChatPage = React.lazy(() => import('@/pages/ChatPage'));
const PersonasPage = React.lazy(() => import('@/pages/PersonasPage'));
const GalleryPage = React.lazy(() => import('@/pages/GalleryPage'));
const NotesPage = React.lazy(() => import('@/pages/NotesPage'));
const CalendarPage = React.lazy(() => import('@/pages/CalendarPage'));
const AutomationsPage = React.lazy(() => import('@/pages/AutomationsPage'));
const LibreClawPage = React.lazy(() => import('@/pages/LibreClawPage'));
const ChannelsPage = React.lazy(() => import('@/pages/ChannelsPage'));
const WorkPage = React.lazy(() => import('@/pages/WorkPage'));
const UserManagementPage = React.lazy(
  () => import('@/pages/UserManagementPage')
);
const PluginUsagePage = React.lazy(() => import('@/pages/PluginUsagePage'));
const EvaluationsPage = React.lazy(() => import('@/pages/EvaluationsPage'));
const SystemPage = React.lazy(() => import('@/pages/SystemPage'));
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
      isOpen ? (compact ? 'w-16' : 'w-72') : 'w-0'
    )}
  />
);

// Reserves room for the artifact panel so the chat splits beside it on
// desktop instead of being covered. The panel itself is fixed-positioned and
// fills exactly this space.
const ArtifactLayoutSpacer: React.FC = () => {
  const { artifactPanelOpen, artifactPanelWidth, artifactPanelResizing } =
    useAppStore();
  return (
    <div
      aria-hidden='true'
      className={cn(
        'hidden md:block flex-shrink-0',
        !artifactPanelResizing && 'transition-[width] duration-300 ease-out'
      )}
      style={{ width: artifactPanelOpen ? artifactPanelWidth : 0 }}
    />
  );
};

interface ShellLayoutProps {
  hasBackground: boolean;
  sidebarOpen: boolean;
  sidebarCompact: boolean;
  onCloseSidebar: () => void;
  showDemoBanner: boolean;
  demoMessage?: string;
  children: React.ReactNode;
}

// The single app frame: sidebar + tab strip + routed content card.
const ShellLayout: React.FC<ShellLayoutProps> = ({
  hasBackground,
  sidebarOpen,
  sidebarCompact,
  onCloseSidebar,
  showDemoBanner,
  demoMessage,
  children,
}) => (
  <div
    className={cn(
      'flex h-dvh min-h-0 text-ink relative overflow-hidden',
      hasBackground ? 'bg-sidebar/60' : 'bg-sidebar'
    )}
  >
    <ElectronTitleBar />
    <BackgroundRenderer />
    <Sidebar isOpen={sidebarOpen} onClose={onCloseSidebar} />
    <SidebarLayoutSpacer isOpen={sidebarOpen} compact={sidebarCompact} />
    <div
      data-testid='app-shell-content'
      className={cn(
        'flex-1 basis-0 flex min-h-0 flex-col min-w-0 transition-[margin,background-color] duration-200 ease-out relative z-10 lg:pb-2 lg:pe-2',
        isElectron ? 'pt-8' : 'lg:pt-1.5',
        // Mobile behavior:
        // - Compact sidebar: push content away to avoid overlap
        // - Expanded sidebar: overlay (no transform)
        sidebarOpen && sidebarCompact ? 'max-lg:ms-16' : 'max-lg:ms-0',
        hasBackground ? 'bg-white/10 dark:bg-dark-50/10' : 'bg-transparent'
      )}
    >
      {showDemoBanner && <DemoModeBanner message={demoMessage} />}
      <AppTabBar />
      <main
        className={cn(
          'min-h-0 flex-1 overflow-hidden lg:rounded-[1.5rem] lg:border lg:border-black/[0.06] dark:lg:border-white/[0.07] lg:shadow-[0_1px_2px_rgba(0,0,0,0.03),0_18px_60px_rgba(15,23,42,0.04)]',
          hasBackground
            ? 'bg-white/30 dark:bg-dark-50/35 backdrop-blur-sm'
            : 'bg-canvas'
        )}
      >
        <ErrorBoundary>
          <Suspense fallback={<PageLoader />}>{children}</Suspense>
        </ErrorBoundary>
      </main>
    </div>
    <ArtifactLayoutSpacer />
  </div>
);

const AppContent: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which settings tab to open on; the shortcuts key jumps straight to its own.
  const [settingsTab, setSettingsTab] = useState<string | undefined>(undefined);
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
    closeArtifactPanel,
  } = useAppStore();
  const {
    systemInfo,
    isLoading: authLoading,
    user: _user,
    isAuthenticated,
  } = useAuthStore();
  const { isDemoMode, demoConfig } = useAppStore();
  const hasWorkspaceAccess =
    systemInfo?.requiresAuth === false || isAuthenticated;
  const whatsNew = useWhatsNew();

  // Browser autoplay permission is transient. Arm the shared TTS output on
  // the next real gesture so a response can start speaking after its network
  // request completes, even when auto-play was saved in an earlier session.
  React.useEffect(() => {
    if (
      !preferences.ttsSettings?.enabled ||
      !preferences.ttsSettings.autoPlay
    ) {
      return;
    }
    return armTTSAudioPlaybackUnlock();
  }, [preferences.ttsSettings?.autoPlay, preferences.ttsSettings?.enabled]);

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
      const authStatus = urlParams.get('auth');

      if (authStatus === 'success') {
        try {
          const response = await fetch(`${API_BASE_URL}/auth/oauth/exchange`, {
            method: 'POST',
            credentials: 'include',
          });

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
              const { login } = useAuthStore.getState();
              login(data.data.user, data.data.token, data.data.systemInfo);
              logger.debug('OAuth login successful');
              toast.success(t('auth.oauth.loginSuccess'));
            } else {
              toast.error(t('auth.oauth.completionFailed'));
            }
          } else {
            toast.error(t('auth.oauth.verificationFailed'));
          }
        } catch (error) {
          logger.error('OAuth processing error:', error);
          toast.error(t('auth.oauth.authenticationFailed'));
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
  }, [t]);

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
      action: () => {
        setSettingsTab(undefined);
        setSettingsOpen(true);
      },
      description: t('keyboard.openSettings'),
    },
    {
      key: 'o',
      metaKey: true,
      shiftKey: true,
      action: () => startNewChat(navigate),
      description: t('keyboard.newChat'),
    },
    {
      key: 'u',
      metaKey: true,
      shiftKey: true,
      action: () => {
        if (useAuthStore.getState().canUseWork()) {
          startNewWork(navigate);
        }
      },
      description: t('keyboard.newWork'),
    },
    {
      key: 'd',
      metaKey: true,
      action: toggleTheme,
      description: t('keyboard.toggleDarkMode'),
    },
    {
      key: '?',
      action: () => {
        setSettingsTab('shortcuts');
        setSettingsOpen(true);
      },
      description: t('keyboard.showShortcuts'),
    },
    {
      key: 'Escape',
      action: () => setSettingsOpen(false),
      description: t('keyboard.closeModals'),
    },
  ];

  // Enable keyboard shortcuts
  useKeyboardShortcuts(shortcuts, hasWorkspaceAccess);

  // Global overlays live outside ProtectedRoute, so they must be closed and
  // hidden explicitly whenever the authenticated workspace becomes
  // unavailable (logout, expiry, or an unauthenticated /login visit).
  React.useEffect(() => {
    if (hasWorkspaceAccess) return;

    const frame = window.requestAnimationFrame(() => {
      setSettingsOpen(false);
      closeArtifactPanel();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [closeArtifactPanel, hasWorkspaceAccess]);

  // Initialize WebSocket connection
  React.useEffect(() => {
    if (!hasWorkspaceAccess) {
      websocketService.disconnect();
      return;
    }

    websocketService.connect().catch(logger.error);

    return () => {
      websocketService.disconnect();
    };
  }, [hasWorkspaceAccess]);

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
            <LogoMark size='lg' className='text-gray-900 dark:text-gray-100' />
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
            <LogoMark
              size='lg'
              className='mx-auto text-gray-900 dark:text-white'
            />
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
    <>
      {/* Show full layout only if system doesn't require auth or user is authenticated */}
      {systemInfo && !systemInfo.requiresAuth ? (
        // No auth required - show full layout
        <ShellLayout
          hasBackground={!!hasActiveBackground()}
          sidebarOpen={sidebarOpen}
          sidebarCompact={sidebarCompact}
          onCloseSidebar={() => setSidebarOpen(false)}
          showDemoBanner={isDemoMode && demoConfig.showBanner}
          demoMessage={demoConfig.message}
        >
          <Routes>
            <Route path='/' element={<HomePage />} />
            <Route path='/chat' element={<ChatPage />} />
            <Route path='/c/:sessionId' element={<ChatPage />} />
            <Route path='/personas' element={<PersonasPage />} />
            <Route path='/gallery' element={<GalleryPage />} />
            <Route path='/notes' element={<NotesPage />} />
            <Route path='/calendar' element={<CalendarPage />} />
            <Route path='/automations' element={<AutomationsPage />} />
            <Route path='/channels' element={<ChannelsPage />} />
            <Route
              path='/work'
              element={
                <ProtectedRoute requireWork={true}>
                  <WorkPage />
                </ProtectedRoute>
              }
            />
            <Route
              path='/work/:taskId'
              element={
                <ProtectedRoute requireWork={true}>
                  <WorkPage />
                </ProtectedRoute>
              }
            />
            <Route
              path='/agents'
              element={
                <ProtectedRoute requireAdmin={true} requireAgents={true}>
                  <LibreClawPage />
                </ProtectedRoute>
              }
            />
            <Route
              path='/usage'
              element={
                <ProtectedRoute requireAdmin={true}>
                  <PluginUsagePage />
                </ProtectedRoute>
              }
            />
            <Route path='/evaluations' element={<EvaluationsPage />} />
            <Route
              path='/system'
              element={
                <ProtectedRoute requireAdmin={true}>
                  <SystemPage />
                </ProtectedRoute>
              }
            />
            <Route path='/login' element={<LoginPage />} />
          </Routes>
        </ShellLayout>
      ) : (
        // Auth required - show routes without main layout constraining login
        <Routes>
          <Route path='/login' element={<LoginPage />} />
          <Route
            path='/*'
            element={
              <ProtectedRoute>
                <ShellLayout
                  hasBackground={!!hasActiveBackground()}
                  sidebarOpen={sidebarOpen}
                  sidebarCompact={sidebarCompact}
                  onCloseSidebar={() => setSidebarOpen(false)}
                  showDemoBanner={isDemoMode && demoConfig.showBanner}
                  demoMessage={demoConfig.message}
                >
                  <Routes>
                    <Route path='/' element={<HomePage />} />
                    <Route path='/chat' element={<ChatPage />} />
                    <Route path='/c/:sessionId' element={<ChatPage />} />
                    <Route path='/personas' element={<PersonasPage />} />
                    <Route path='/gallery' element={<GalleryPage />} />
                    <Route path='/notes' element={<NotesPage />} />
                    <Route path='/calendar' element={<CalendarPage />} />
                    <Route path='/automations' element={<AutomationsPage />} />
                    <Route path='/channels' element={<ChannelsPage />} />
                    <Route
                      path='/work'
                      element={
                        <ProtectedRoute requireWork={true}>
                          <WorkPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path='/work/:taskId'
                      element={
                        <ProtectedRoute requireWork={true}>
                          <WorkPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route
                      path='/agents'
                      element={
                        <ProtectedRoute
                          requireAdmin={true}
                          requireAgents={true}
                        >
                          <LibreClawPage />
                        </ProtectedRoute>
                      }
                    />
                    <Route path='/artifacts' element={<ArtifactDemoPage />} />
                    <Route
                      path='/usage'
                      element={
                        <ProtectedRoute requireAdmin={true}>
                          <PluginUsagePage />
                        </ProtectedRoute>
                      }
                    />
                    <Route path='/evaluations' element={<EvaluationsPage />} />
                    <Route
                      path='/system'
                      element={
                        <ProtectedRoute requireAdmin={true}>
                          <SystemPage />
                        </ProtectedRoute>
                      }
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
                </ShellLayout>
              </ProtectedRoute>
            }
          />
        </Routes>
      )}

      {/* Modals */}
      {hasWorkspaceAccess && settingsOpen && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={settingsOpen}
            initialTab={settingsTab}
            onClose={() => setSettingsOpen(false)}
          />
        </Suspense>
      )}

      {hasWorkspaceAccess && whatsNew.open && whatsNew.notes && (
        <WhatsNewModal notes={whatsNew.notes} onDismiss={whatsNew.dismiss} />
      )}

      {/* Artifact slide-out panel */}
      {hasWorkspaceAccess && artifactPanelOpen && (
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

      {hasWorkspaceAccess && (
        <CommandPalette
          onOpenSettings={() => {
            setSettingsTab(undefined);
            setSettingsOpen(true);
          }}
          onOpenSettingsTab={tab => {
            setSettingsTab(tab);
            setSettingsOpen(true);
          }}
        />
      )}
    </>
  );
};

// Data routers support navigation blockers used by the Work file editor.
// Electron still uses hash-based URLs because file:// cannot serve history
// fallbacks.
const appRoutes = [
  {
    path: '*',
    element: <AppContent />,
    errorElement: <RouteErrorScreen />,
  },
];
const appRouter = isElectron
  ? createHashRouter(appRoutes)
  : createBrowserRouter(appRoutes);

const App: React.FC = () => (
  <ErrorBoundary>
    <RouterProvider router={appRouter} />
  </ErrorBoundary>
);

export default App;
