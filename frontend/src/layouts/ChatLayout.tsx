import React, { ReactNode } from 'react';
import { Header } from '@/components/Header';
import { Sidebar } from '@/components/Sidebar';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

interface ChatLayoutProps {
  children: ReactNode;
}

export const ChatLayout: React.FC<ChatLayoutProps> = ({ children }) => {
  const { sidebarOpen, toggleSidebar } = useAppStore();

  return (
    <div className='flex h-screen bg-gray-50 dark:bg-dark-100'>
      {/* Sidebar */}
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-dark-50 border-r border-gray-200 dark:border-dark-200 transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:inset-0',
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        )}
      >
        <Sidebar isOpen={sidebarOpen} onClose={() => toggleSidebar()} />
      </aside>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className='fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden'
          onClick={toggleSidebar}
        />
      )}

      {/* Main content */}
      <div className='flex-1 flex flex-col min-w-0'>
        <Header />
        <main className='flex-1 overflow-hidden'>{children}</main>
      </div>
    </div>
  );
};
