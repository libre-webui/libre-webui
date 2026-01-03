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

import React, { ReactNode } from 'react';
import { Sidebar } from '@/components/Sidebar';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

interface ChatLayoutProps {
  children: ReactNode;
}

export const ChatLayout: React.FC<ChatLayoutProps> = ({ children }) => {
  const { sidebarOpen, sidebarCompact, toggleSidebar } = useAppStore();

  return (
    <div className='flex h-screen bg-gray-50 dark:bg-dark-100'>
      {/* Sidebar - Let the Sidebar component handle its own positioning */}
      <Sidebar isOpen={sidebarOpen} onClose={() => toggleSidebar()} />

      {/* Main content - Adjust margin based on sidebar state */}
      <div
        className={cn(
          'flex-1 flex flex-col min-w-0 transition-all duration-300 ease-in-out',
          // Add left margin when sidebar is open (on all screen sizes for side-by-side layout)
          sidebarOpen
            ? sidebarCompact
              ? 'ml-20'
              : 'ml-80 max-sm:ml-64'
            : 'ml-0'
        )}
      >
        <main className='flex-1 overflow-hidden'>{children}</main>
      </div>
    </div>
  );
};
