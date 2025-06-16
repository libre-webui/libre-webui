import React, { useState, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { SidebarToggle } from '@/components/SidebarToggle';
import {
  KeyboardShortcutsModal,
  KeyboardShortcutsIndicator,
} from '@/components/KeyboardShortcuts';
import { SettingsModal } from '@/components/SettingsModal';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { useAppStore } from '@/store/appStore';
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

// Loading component
const PageLoader = () => (
  <div className='flex items-center justify-center h-full'>
    <div className='text-gray-600 dark:text-dark-600'>Loading...</div>
  </div>
);

const App: React.FC = () => {
  const {
    sidebarOpen,
    setSidebarOpen,
    toggleSidebar,
    toggleTheme,
    isDemoMode,
    demoConfig,
  } = useAppStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Initialize the app
  useInitializeApp();

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

  return (
    <Router>
      <div className='flex h-screen bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'>
        <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

        <SidebarToggle />

        <div
          className={cn(
            'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out bg-white dark:bg-dark-50',
            // Add left margin on desktop when sidebar is open to prevent content jumping
            // On mobile, always use full width regardless of sidebar state
            'w-full',
            sidebarOpen ? 'lg:ml-80' : 'lg:ml-0'
          )}
        >
          <Header onSettingsClick={() => setSettingsOpen(true)} />

          {/* Demo Mode Banner */}
          {isDemoMode && demoConfig.showBanner && (
            <DemoModeBanner message={demoConfig.message} />
          )}

          <main className='flex-1 overflow-hidden bg-white dark:bg-dark-50'>
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path='/' element={<ChatPage />} />
                <Route path='/chat' element={<ChatPage />} />
                <Route path='/chat/:sessionId' element={<ChatPage />} />
                <Route path='/models' element={<ModelsPage />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>

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

      {/* Keyboard shortcuts indicator */}
      <KeyboardShortcutsIndicator onClick={() => setShortcutsOpen(true)} />

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
  );
};

export default App;
