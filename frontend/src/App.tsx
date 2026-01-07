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
} from 'react-router-dom';

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
import { SettingsModal } from '@/components/SettingsModal';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { BackgroundRenderer } from '@/components/BackgroundRenderer';
import { ArtifactSlideOutPanel } from '@/components/ArtifactSlideOutPanel';
import { Logo } from '@/components/Logo';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useInitializeApp } from '@/hooks/useInitializeApp';
import {
  useKeyboardShortcuts,
  KeyboardShortcut,
} from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/utils';
import websocketService from '@/utils/websocket';
import toast from 'react-hot-toast';

// Lazy load pages for code splitting
const ChatPage = React.lazy(() => import('@/pages/ChatPage'));
const ModelsPage = React.lazy(() => import('@/pages/ModelsPage'));
const PersonasPage = React.lazy(() => import('@/pages/PersonasPage'));
const UserManagementPage = React.lazy(
  () => import('@/pages/UserManagementPage')
);
const ArtifactDemoPage = React.lazy(() => import('@/pages/ArtifactDemoPage'));

// Import LoginPage directly (not lazy) to avoid suspense issues during auth redirects
import { LoginPage } from '@/pages/LoginPage';
import { FirstTimeSetup } from '@/components/FirstTimeSetup';

// Loading component
const PageLoader = () => (
  <div className='flex items-center justify-center h-full min-h-screen'>
    <div className='flex flex-col items-center gap-3'>
      <div className='w-8 h-8 border-4 border-gray-200 border-t-blue-500 rounded-full animate-spin'></div>
      <div className='text-gray-600 dark:text-dark-600'>Loading...</div>
    </div>
  </div>
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [setupComplete, setSetupComplete] = useState(false);
  const [inFirstTimeSetup, setInFirstTimeSetup] = useState(false);
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
        console.log('OAuth already processing, skipping...');
        return;
      }

      console.log('Starting OAuth callback processing...');
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
                  singleUserMode: false,
                  hasUsers: true,
                  version: '0.1.6',
                }
              );
              console.log('OAuth login successful, showing toast');
              toast.success('GitHub login successful!');
            } else {
              toast.error('Failed to verify GitHub authentication');
            }
          } else {
            toast.error('GitHub authentication verification failed');
          }
        } catch (error) {
          console.error('OAuth processing error:', error);
          toast.error('GitHub authentication failed');
        }

        // Clean up URL regardless of success/failure
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname
        );
      }

      console.log('OAuth processing completed');
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
      description: 'Toggle sidebar',
    },
    {
      key: ',',
      metaKey: true,
      action: () => setSettingsOpen(true),
      description: 'Open settings',
    },
    {
      key: 'd',
      metaKey: true,
      action: toggleTheme,
      description: 'Toggle dark mode',
    },
    {
      key: 'h',
      action: () => setShortcutsOpen(true),
      description: 'Show keyboard shortcuts',
    },
    {
      key: 'Escape',
      action: () => {
        setSettingsOpen(false);
        setShortcutsOpen(false);
      },
      description: 'Close modals',
    },
  ];

  // Enable keyboard shortcuts
  useKeyboardShortcuts(shortcuts);

  // Initialize WebSocket connection
  React.useEffect(() => {
    websocketService.connect().catch(console.error);

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
          const { UserService } = await import('@/services/userService');
          await UserService.initializeAuth();
        } catch {
          // Will retry on next interval
        }
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [systemInfo, authLoading, retryCount]);

  // Enter first-time setup mode when conditions are met
  React.useEffect(() => {
    if (
      systemInfo &&
      systemInfo.requiresAuth &&
      !systemInfo.hasUsers &&
      !setupComplete
    ) {
      setInFirstTimeSetup(true);
    }
  }, [systemInfo, setupComplete]);

  // Show loading spinner while initializing auth
  if (authLoading) {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-dark-50 flex flex-col justify-center py-12 sm:px-6 lg:px-8'>
        <div className='sm:mx-auto sm:w-full sm:max-w-md'>
          <div className='flex justify-center'>
            <Logo />
          </div>
          <h2
            className='libre-brand mt-6 text-center text-2xl sm:text-3xl font-normal text-gray-900 dark:text-gray-100'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            Libre WebUI
          </h2>
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
      <div className='min-h-screen bg-dark-50 flex items-center justify-center p-4'>
        <div className='text-center'>
          <div className='flex justify-center mb-8'>
            <img
              src='./logo-dark.png'
              alt='Libre WebUI'
              className='h-24 w-24 rounded-xl'
            />
          </div>
          <h1
            className='libre-brand text-3xl text-white mb-8'
            style={{ fontWeight: 300, letterSpacing: '0.02em' }}
          >
            Libre WebUI
          </h1>
          <div className='flex justify-center mb-4'>
            <div className='w-8 h-8 border-3 border-gray-700 border-t-primary-500 rounded-full animate-spin'></div>
          </div>
          <p className='text-gray-500 text-sm'>
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
        <FirstTimeSetup
          onComplete={() => {
            setSetupComplete(true);
            setInFirstTimeSetup(false);
          }}
        />
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
              'flex h-screen text-gray-900 dark:text-dark-800 relative',
              hasActiveBackground()
                ? 'bg-white/40 dark:bg-dark-50/40'
                : 'bg-white dark:bg-dark-50'
            )}
          >
            <ElectronTitleBar />
            <BackgroundRenderer />
            <Sidebar
              isOpen={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
            <div
              className={cn(
                'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out relative z-10',
                'w-full',
                // Desktop behavior: use margin-left to resize content area
                sidebarOpen
                  ? sidebarCompact
                    ? 'lg:ml-16'
                    : 'lg:ml-80'
                  : 'lg:ml-0',
                // Mobile behavior:
                // - Compact sidebar: push content right to avoid overlap
                // - Expanded sidebar: overlay (no transform)
                sidebarOpen && sidebarCompact ? 'max-lg:ml-16' : 'max-lg:ml-0',
                hasActiveBackground()
                  ? 'bg-white/30 dark:bg-dark-50/30'
                  : 'bg-white dark:bg-dark-50'
              )}
            >
              {isDemoMode && demoConfig.showBanner && (
                <DemoModeBanner message={demoConfig.message} />
              )}
              <main
                className={cn(
                  'flex-1 overflow-hidden',
                  hasActiveBackground()
                    ? 'bg-white/20 dark:bg-dark-50/20 backdrop-blur-sm'
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
                      'flex h-screen text-gray-900 dark:text-dark-800 relative',
                      hasActiveBackground()
                        ? 'bg-white/40 dark:bg-dark-50/40'
                        : 'bg-white dark:bg-dark-50'
                    )}
                  >
                    <ElectronTitleBar />
                    <BackgroundRenderer />
                    <Sidebar
                      isOpen={sidebarOpen}
                      onClose={() => setSidebarOpen(false)}
                    />
                    <div
                      className={cn(
                        'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out relative z-10',
                        'w-full',
                        // Desktop behavior: use margin-left to resize content area
                        sidebarOpen
                          ? sidebarCompact
                            ? 'lg:ml-16'
                            : 'lg:ml-80'
                          : 'lg:ml-0',
                        // Mobile behavior:
                        // - Compact sidebar: push content right to avoid overlap
                        // - Expanded sidebar: overlay (no transform)
                        sidebarOpen && sidebarCompact
                          ? 'max-lg:ml-16'
                          : 'max-lg:ml-0',
                        hasActiveBackground()
                          ? 'bg-white/30 dark:bg-dark-50/30'
                          : 'bg-white dark:bg-dark-50'
                      )}
                    >
                      {isDemoMode && demoConfig.showBanner && (
                        <DemoModeBanner message={demoConfig.message} />
                      )}
                      <main
                        className={cn(
                          'flex-1 overflow-hidden',
                          hasActiveBackground()
                            ? 'bg-white/20 dark:bg-dark-50/20 backdrop-blur-sm'
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
        <SettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />

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
        <ArtifactSlideOutPanel />

        <Toaster
          position='top-right'
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
                primary: '#16a34a',
                secondary: '#ffffff',
              },
            },
            error: {
              iconTheme: {
                primary: '#ef4444',
                secondary: '#ffffff',
              },
            },
          }}
          containerStyle={{
            top: 80, // Position below header (header height + some margin)
            right: 20,
          }}
        />
      </Router>
    </ErrorBoundary>
  );
};

export default App;
