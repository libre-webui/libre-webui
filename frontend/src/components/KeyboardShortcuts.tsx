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

import React, { useState } from 'react';
import { Keyboard, X } from 'lucide-react';
import { Button } from '@/components/ui';
import { formatShortcut, KeyboardShortcut } from '@/hooks/useKeyboardShortcuts';
import { cn } from '@/utils';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
  shortcuts: KeyboardShortcut[];
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({
  isOpen,
  onClose,
  shortcuts,
}) => {
  if (!isOpen) return null;

  const shortcutGroups = {
    Navigation: shortcuts.filter(
      s => s.description.includes('sidebar') || s.description.includes('Toggle')
    ),
    Settings: shortcuts.filter(
      s =>
        s.description.includes('settings') ||
        s.description.includes('dark mode')
    ),
    General: shortcuts.filter(
      s =>
        !s.description.includes('sidebar') &&
        !s.description.includes('settings') &&
        !s.description.includes('dark mode') &&
        !s.description.includes('Toggle')
    ),
  };

  return (
    <div className='fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4'>
      <div className='bg-white dark:bg-dark-100 rounded-xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-hidden'>
        {/* Header */}
        <div className='flex items-center justify-between p-6 border-b border-gray-200 dark:border-dark-300'>
          <div className='flex items-center gap-2'>
            <Keyboard className='h-5 w-5 text-gray-700 dark:text-dark-600' />
            <h2 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              Keyboard Shortcuts
            </h2>
          </div>
          <Button
            variant='ghost'
            size='sm'
            onClick={onClose}
            className='h-8 w-8 p-0 hover:bg-gray-100 dark:hover:bg-dark-200'
          >
            <X className='h-4 w-4' />
          </Button>
        </div>

        {/* Content */}
        <div className='p-6 space-y-6 overflow-y-auto max-h-[60vh]'>
          {Object.entries(shortcutGroups).map(([groupName, groupShortcuts]) => {
            if (groupShortcuts.length === 0) return null;

            return (
              <div key={groupName}>
                <h3 className='text-sm font-medium text-gray-700 dark:text-dark-600 mb-3'>
                  {groupName}
                </h3>
                <div className='space-y-2'>
                  {groupShortcuts.map((shortcut, index) => (
                    <div
                      key={index}
                      className='flex items-center justify-between py-2'
                    >
                      <span className='text-sm text-gray-600 dark:text-dark-500'>
                        {shortcut.description}
                      </span>
                      <kbd className='px-2 py-1 text-xs font-mono bg-gray-100 dark:bg-dark-200 text-gray-700 dark:text-dark-600 rounded border border-gray-300 dark:border-dark-400'>
                        {formatShortcut(shortcut)}
                      </kbd>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}

          {/* Additional helpful shortcuts */}
          <div>
            <h3 className='text-sm font-medium text-gray-700 dark:text-dark-600 mb-3'>
              Chat
            </h3>
            <div className='space-y-2'>
              <div className='flex items-center justify-between py-2'>
                <span className='text-sm text-gray-600 dark:text-dark-500'>
                  Send message
                </span>
                <kbd className='px-2 py-1 text-xs font-mono bg-gray-100 dark:bg-dark-200 text-gray-700 dark:text-dark-600 rounded border border-gray-300 dark:border-dark-400'>
                  Enter
                </kbd>
              </div>
              <div className='flex items-center justify-between py-2'>
                <span className='text-sm text-gray-600 dark:text-dark-500'>
                  New line in message
                </span>
                <kbd className='px-2 py-1 text-xs font-mono bg-gray-100 dark:bg-dark-200 text-gray-700 dark:text-dark-600 rounded border border-gray-300 dark:border-dark-400'>
                  ⇧+Enter
                </kbd>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className='px-6 py-4 bg-gray-50 dark:bg-dark-200 border-t border-gray-200 dark:border-dark-300'>
          <p className='text-xs text-gray-500 dark:text-dark-400 text-center'>
            Press{' '}
            <kbd className='px-1 py-0.5 text-xs font-mono bg-gray-200 dark:bg-dark-300 rounded'>
              ?
            </kbd>{' '}
            or{' '}
            <kbd className='px-1 py-0.5 text-xs font-mono bg-gray-200 dark:bg-dark-300 rounded'>
              H
            </kbd>{' '}
            to show this help
          </p>
        </div>
      </div>
    </div>
  );
};

// Small floating keyboard shortcuts indicator
export const KeyboardShortcutsIndicator: React.FC<{
  onClick: () => void;
  className?: string;
}> = ({ onClick, className }) => {
  const [isHovered, setIsHovered] = useState(false);

  return (
    <Button
      variant='ghost'
      size='sm'
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={cn(
        'fixed top-4 right-4 h-10 w-10 p-0 bg-white/80 dark:bg-dark-100/80 backdrop-blur-sm border border-gray-200 dark:border-dark-300 shadow-lg hover:shadow-xl transition-all duration-200 z-50',
        'hover:bg-white dark:hover:bg-dark-100',
        className
      )}
      title='Keyboard shortcuts'
    >
      <Keyboard className='h-4 w-4' />
      {isHovered && (
        <div className='absolute top-full mt-2 right-0 px-2 py-1 text-xs bg-gray-900 text-white rounded whitespace-nowrap'>
          Keyboard shortcuts
        </div>
      )}
    </Button>
  );
};
