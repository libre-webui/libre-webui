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

interface LogoProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Render the "WebUI" suffix after "Libre". Defaults to true. */
  wordmark?: boolean;
}

// Single source of truth for the "Libre WebUI" wordmark so it reads identically
// everywhere it appears. "Libre" maps to the DESIGN.md heading scale (md = h1),
// with "WebUI" one tier smaller and lighter for a consistent lockup.
const LIBRE_SIZE: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'text-xl',
  md: 'text-3xl',
  lg: 'text-5xl',
};

const WEBUI_SIZE: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'text-sm',
  md: 'text-xl',
  lg: 'text-3xl',
};

export const Logo: React.FC<LogoProps> = ({
  className,
  size = 'md',
  wordmark = true,
}) => {
  return (
    <span
      className={cn('libre-brand', LIBRE_SIZE[size], className)}
      style={{ fontWeight: 400, letterSpacing: '0.01em' }}
    >
      Libre
      {wordmark && (
        <span
          className={cn('ml-1.5', WEBUI_SIZE[size])}
          style={{ fontWeight: 300 }}
        >
          WebUI
        </span>
      )}
    </span>
  );
};
