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
    const focusable = () => {
      const elements = Array.from(
        dialog.querySelectorAll<HTMLElement>(focusableSelector)
      ).filter(
        element =>
          element.tabIndex >= 0 &&
          !element.matches(':disabled') &&
          isVisible(element)
      );
      return elements.filter(element => {
        if (
          !(element instanceof HTMLInputElement) ||
          element.type !== 'radio' ||
          !element.name
        ) {
          return true;
        }
        const group = elements.filter(
          (other): other is HTMLInputElement =>
            other instanceof HTMLInputElement &&
            other.type === 'radio' &&
            other.name === element.name &&
            other.form === element.form
        );
        return element === (group.find(radio => radio.checked) ?? group[0]);
      });
    };
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
        event.preventDefault();
        if (!first) {
          dialog.focus();
        } else {
          // Native Tab order can skip buttons on macOS Safari. Move through
          // the same list used for containment so those skipped edges cannot
          // send focus behind the modal.
          const index = elements.indexOf(document.activeElement as HTMLElement);
          const next = event.shiftKey
            ? index <= 0
              ? elements.length - 1
              : index - 1
            : (index + 1) % elements.length;
          elements[next]?.focus();
        }
      }
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || !isForemost()) return;
      const button =
        event.target instanceof Element ? event.target.closest('button') : null;
      // Safari does not focus clicked buttons. Capture an actual nested
      // dialog opener before its click handler mounts the next dialog.
      if (button && focusable().includes(button)) {
        event.preventDefault();
        button.focus({ preventScroll: true });
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleMouseDown);
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [dialogRef, enabled, initialOpener, initialFocusRef]);
}
