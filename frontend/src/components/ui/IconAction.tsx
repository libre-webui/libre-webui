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

import React from 'react';
import { cn } from '@/utils';

interface IconActionProps {
  icon: React.ComponentType<{ className?: string }>;
  /** Doubles as the tooltip and the accessible name. */
  label: string;
  destructive?: boolean;
  disabled?: boolean;
  testId?: string;
  onClick: () => void;
}

/** Compact icon-only row action used by the workspace list pages. */
export const IconAction: React.FC<IconActionProps> = ({
  icon: Icon,
  label,
  destructive,
  disabled,
  testId,
  onClick,
}) => (
  <button
    type='button'
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    data-testid={testId}
    className={cn(
      'rounded-lg p-1.5 text-gray-400 transition-colors disabled:cursor-not-allowed disabled:opacity-50',
      destructive
        ? 'hover:bg-red-500/10 hover:text-red-500'
        : 'hover:bg-black/[0.04] hover:text-gray-700 dark:hover:bg-white/[0.06] dark:hover:text-dark-800'
    )}
  >
    <Icon className='h-3.5 w-3.5' />
  </button>
);
