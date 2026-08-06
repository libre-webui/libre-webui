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

import { useEffect, useCallback } from 'react';

export interface KeyboardShortcut {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  action: () => void;
  description: string;
}

export const useKeyboardShortcuts = (
  shortcuts: KeyboardShortcut[],
  enabled: boolean = true
) => {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (!enabled) return;

      // Don't trigger shortcuts when user is typing in an input/textarea/contenteditable
      const target = event.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.contentEditable === 'true' ||
        target.isContentEditable
      ) {
        return;
      }

      // Special handling for ? key (which is Shift+/)
      if (event.key === '?' || (event.key === '/' && event.shiftKey)) {
        const helpShortcut = shortcuts.find(
          s => s.key === '?' || s.key === 'h'
        );
        if (helpShortcut) {
          event.preventDefault();
          event.stopPropagation();
          helpShortcut.action();
          return;
        }
      }

      const matchingShortcut = shortcuts.find(shortcut => {
        const keyMatches =
          shortcut.key.toLowerCase() === event.key.toLowerCase();
        // Accept either metaKey (Cmd) or ctrlKey (Ctrl) for cross-platform support
        const metaOrCtrl = !!shortcut.metaKey;
        const metaOrCtrlPressed = event.metaKey || event.ctrlKey;
        const metaMatches = metaOrCtrl ? metaOrCtrlPressed : true;
        const ctrlMatches = shortcut.ctrlKey ? event.ctrlKey : true;
        const shiftMatches = !!shortcut.shiftKey === event.shiftKey;
        const altMatches = !!shortcut.altKey === event.altKey;

        return (
          keyMatches && metaMatches && ctrlMatches && shiftMatches && altMatches
        );
      });

      if (matchingShortcut) {
        event.preventDefault();
        event.stopPropagation();
        matchingShortcut.action();
      }
    },
    [shortcuts, enabled]
  );

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown, enabled]);
};
