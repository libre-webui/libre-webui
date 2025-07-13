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
  BrowserRouter as Router,
  Routes,
  Route,
  useLocation,
} from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { SidebarToggle } from '@/components/SidebarToggle';
import { ProtectedRoute } from '@/components/ProtectedRoute';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import {
  KeyboardShortcutsModal,
  KeyboardShortcutsIndicator,
} from '@/components/KeyboardShortcuts';
import { SettingsModal } from '@/components/SettingsModal';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { BackgroundRenderer } from '@/components/BackgroundRenderer';
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

// Conditional keyboard shortcuts indicator - only shows on chat pages
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

  return <KeyboardShortcutsIndicator onClick={onClick} />;
};

const App: React.FC = () => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const {
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    toggleTheme,
    backgroundImage,
    preferences,
  } = useAppStore();
  const {
    systemInfo,
    isLoading: authLoading,
    user,
    isAuthenticated,
  } = useAuthStore();
  const { isDemoMode, demoConfig } = useAppStore();

  // Initialize the app
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

  // Debug logging - this will help us understand what's happening
  React.useEffect(() => {
    console.log('🔍 Auth Debug State:', {
      systemInfo,
      authLoading,
      user,
      isAuthenticated,
      requiresAuth: systemInfo?.requiresAuth,
      singleUserMode: systemInfo?.singleUserMode,
    });
  }, [systemInfo, authLoading, user, isAuthenticated]);

  // Define keyboard shortcuts
  const shortcuts: KeyboardShortcut[] = [
    {
      key: 'b',
      metaKey: true,
      action: toggleSidebar,
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

  // Debug: Show system info if no systemInfo is loaded
  if (!systemInfo) {
    return (
      <div className='min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center'>
        <div className='text-center'>
          <h2 className='text-xl font-bold text-gray-900 dark:text-white mb-2'>
            System Info Not Loaded
          </h2>
          <p className='text-gray-600 dark:text-gray-400 mb-4'>
            Unable to load system configuration. Check the console for errors.
          </p>
          <button
            onClick={() => window.location.reload()}
            className='bg-blue-500 hover:bg-blue-600 text-white font-medium py-2 px-4 rounded-lg'
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Show FirstTimeSetup if system requires auth but has no users
  if (systemInfo && systemInfo.requiresAuth && !systemInfo.hasUsers) {
    return (
      <ErrorBoundary>
        <FirstTimeSetup />
      </ErrorBoundary>
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
            <BackgroundRenderer />
            <Sidebar
              isOpen={sidebarOpen}
              onClose={() => setSidebarOpen(false)}
            />
            <SidebarToggle />
            <div
              className={cn(
                'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out relative z-10',
                'w-full',
                sidebarOpen ? 'lg:ml-80' : 'lg:ml-0',
                hasActiveBackground()
                  ? 'bg-white/30 dark:bg-dark-50/30'
                  : 'bg-white dark:bg-dark-50'
              )}
            >
              <Header onSettingsClick={() => setSettingsOpen(true)} />
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
                    <BackgroundRenderer />
                    <Sidebar
                      isOpen={sidebarOpen}
                      onClose={() => setSidebarOpen(false)}
                    />
                    <SidebarToggle />
                    <div
                      className={cn(
                        'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out relative z-10',
                        'w-full',
                        sidebarOpen ? 'lg:ml-80' : 'lg:ml-0',
                        hasActiveBackground()
                          ? 'bg-white/30 dark:bg-dark-50/30'
                          : 'bg-white dark:bg-dark-50'
                      )}
                    >
                      <Header onSettingsClick={() => setSettingsOpen(true)} />
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
