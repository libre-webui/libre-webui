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

interface LogoMarkProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Accessible name. Pass null where the mark sits beside text that already
   * names the product, so it is not announced twice.
   */
  label?: string | null;
}

const MARK_SIZE: Record<NonNullable<LogoMarkProps['size']>, string> = {
  sm: 'h-6 w-6',
  md: 'h-8 w-8',
  lg: 'h-12 w-12',
};

/**
 * The Libre WebUI mark, drawn rather than typeset.
 *
 * Inlined instead of loaded from /logo.svg so the strokes take `currentColor`:
 * one file serves both themes, it repaints with the surrounding text in the
 * same frame as a theme change, and there is no second request or flash of the
 * wrong variant. Colour comes from the caller's text colour, which keeps the
 * mark monochrome by construction.
 */
export const LogoMark: React.FC<LogoMarkProps> = ({
  className,
  size = 'md',
  label = 'Libre WebUI',
}) => {
  return (
    <svg
      viewBox='0 0 64 64'
      className={cn('shrink-0', MARK_SIZE[size], className)}
      role={label ? 'img' : 'presentation'}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      focusable='false'
    >
      <path
        d='M 11.5 18.0 L 11.5 32 A 20.5 20.5 0 0 0 50.58 40.66'
        fill='none'
        stroke='currentColor'
        strokeWidth='11'
        strokeLinecap='round'
      />
      <path
        d='M 50.58 18.0 L 50.58 25.66'
        fill='none'
        stroke='currentColor'
        strokeWidth='11'
        strokeLinecap='round'
      />
    </svg>
  );
};
