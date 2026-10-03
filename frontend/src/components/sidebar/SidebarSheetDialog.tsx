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

import { useRef, type HTMLAttributes } from 'react';
import { useDialogFocus } from '@/hooks/useDialogFocus';

interface SidebarSheetDialogProps extends HTMLAttributes<HTMLDivElement> {
  onClose: () => void;
}

/**
 * Modal panel for the mobile action sheets. It is its own component so the
 * focus trap captures the opener when the sheet mounts, not when the parent
 * list does.
 */
export function SidebarSheetDialog({
  onClose,
  children,
  ...props
}: SidebarSheetDialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, { onClose });
  return (
    <div ref={ref} tabIndex={-1} role='dialog' aria-modal='true' {...props}>
      {children}
    </div>
  );
}
