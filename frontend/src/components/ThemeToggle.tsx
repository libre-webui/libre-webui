import React from 'react';
import { Sun, Moon } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { Button } from '@/components/ui';

export const ThemeToggle: React.FC = () => {
  const { theme, toggleTheme } = useAppStore();

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={toggleTheme}
      className='h-9 w-9 p-0 rounded-xl hover:bg-gray-100 dark:hover:bg-dark-200 transition-all duration-200 hover:scale-105 active:scale-95'
      title={`Switch to ${theme.mode === 'light' ? 'dark' : 'light'} mode (⌘D)`}
    >
      {theme.mode === 'light' ? (
        <Moon className='h-4 w-4 text-gray-600 dark:text-dark-500' />
      ) : (
        <Sun className='h-4 w-4 text-yellow-500 dark:text-yellow-400' />
      )}
    </Button>
  );
};
