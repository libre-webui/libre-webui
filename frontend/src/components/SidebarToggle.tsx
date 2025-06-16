import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';
import { cn } from '@/utils';

interface SidebarToggleProps {
  className?: string;
}

export const SidebarToggle: React.FC<SidebarToggleProps> = ({ className }) => {
  const { sidebarOpen, toggleSidebar } = useAppStore();

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleSidebar}
      className={cn(
        'fixed top-1/2 -translate-y-1/2 z-40 h-10 w-6 sm:h-12 sm:w-6 p-0 rounded-r-lg rounded-l-none bg-white dark:bg-dark-50 border border-gray-200 dark:border-dark-200 border-l-0 shadow-lg hover:bg-gray-50 dark:hover:bg-dark-100 transition-all duration-300 ease-in-out hover:w-7 group touch-manipulation',
        // Position the toggle at the edge of the sidebar with smooth transitions
        // When sidebar is open: at the right edge of the sidebar (320px from left)
        // When sidebar is closed: at the left edge (0px from left)
        // Hide on mobile when sidebar is closed to avoid interference
        sidebarOpen
          ? 'left-80 opacity-100 pointer-events-auto' // 320px - sidebar width
          : 'left-0 opacity-100 pointer-events-auto max-sm:opacity-0 max-sm:pointer-events-none', // Hide on mobile when closed
        className
      )}
      title={sidebarOpen ? 'Close sidebar (⌘B)' : 'Open sidebar (⌘B)'}
    >
      {sidebarOpen ? (
        <ChevronLeft className='h-4 w-4 text-gray-600 dark:text-dark-600 group-hover:text-gray-900 dark:group-hover:text-dark-800 transition-colors duration-200' />
      ) : (
        <ChevronRight className='h-4 w-4 text-gray-600 dark:text-dark-600 group-hover:text-gray-900 dark:group-hover:text-dark-800 transition-colors duration-200' />
      )}
    </Button>
  );
};
