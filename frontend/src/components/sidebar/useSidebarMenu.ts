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

import { useEffect, useRef, type KeyboardEvent } from 'react';

export function useSidebarMenu(
  menuId: string | undefined,
  onClose: () => void
) {
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!menuId) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    menu
      ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
      ?.focus();

    return () => {
      // A menu action can open an autofocus input or dialog. Preserve that
      // destination and restore the trigger only when focus has been orphaned.
      if (
        document.activeElement === document.body ||
        menu?.contains(document.activeElement)
      ) {
        trigger?.focus();
      }
    };
  }, [menuId]);

  const closeMenu = () => {
    // Focus the trigger while its row controls are still visible. Once the
    // menu closes, focus-within keeps the otherwise hover-only button shown.
    if (menuId) triggerRef.current?.focus();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
      closeMenu();
      return;
    }

    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not(:disabled)'
      ) ?? []
    );
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    items[next].focus();
  };

  const setTrigger = (element: HTMLElement) => {
    triggerRef.current = element;
  };

  return { menuRef, setTrigger, onKeyDown, closeMenu };
}
