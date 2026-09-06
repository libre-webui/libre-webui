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

import { useEffect, useRef, useState, type RefObject } from 'react';

const focusableSelector =
  'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]';

/** Keep keyboard navigation in the foremost modal and return to its opener. */
export function useDialogFocus(
  dialogRef: RefObject<HTMLElement | null>,
  {
    onClose,
    enabled = true,
    initialFocusRef,
  }: {
    onClose?: () => void;
    enabled?: boolean;
    initialFocusRef?: RefObject<HTMLElement | null>;
  }
) {
  // Capture before React applies a child's autoFocus during the commit.
  const [initialOpener] = useState(() => document.activeElement);
  const preservedFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!enabled || !dialog) return;
    const active = document.activeElement;
    const opener = dialog.contains(active) ? initialOpener : active;
    const isVisible = (element: HTMLElement) =>
      element.getClientRects().length > 0 &&
      getComputedStyle(element).visibility !== 'hidden' &&
      !element.closest('[inert], [aria-hidden="true"]');
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter(
        element =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          isVisible(element)
      );
    const isForemost = () => {
      const dialogs = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[role="dialog"][aria-modal="true"]'
        )
      ).filter(isVisible);
      return dialogs[dialogs.length - 1] === dialog;
    };

    const requestedFocus = initialFocusRef?.current;
    if (
      requestedFocus &&
      dialog.contains(requestedFocus) &&
      isVisible(requestedFocus) &&
      !requestedFocus.matches(':disabled')
    ) {
      preservedFocusRef.current = requestedFocus;
      requestedFocus.focus({ preventScroll: true });
    } else if (active instanceof HTMLElement && dialog.contains(active)) {
      preservedFocusRef.current = active;
    } else {
      // StrictMode replays effects after restoring the opener. Keep a child's
      // autofocus target when that same dialog is still mounted.
      const initialFocus = preservedFocusRef.current;
      const target =
        initialFocus &&
        dialog.contains(initialFocus) &&
        isVisible(initialFocus) &&
        !initialFocus.matches(':disabled')
          ? initialFocus
          : (focusable()[0] ?? dialog);
      target.focus({ preventScroll: true });
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isForemost() || event.isComposing) return;
      if (event.key === 'Escape' && onCloseRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      } else if (event.key === 'Tab') {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) {
          event.preventDefault();
          dialog.focus();
        } else if (
          !dialog.contains(document.activeElement) ||
          (event.shiftKey &&
            (document.activeElement === first ||
              document.activeElement === dialog)) ||
          (!event.shiftKey && document.activeElement === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [dialogRef, enabled, initialOpener, initialFocusRef]);
}
