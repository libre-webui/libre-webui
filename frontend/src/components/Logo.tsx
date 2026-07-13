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
// everywhere it appears. "WebUI" keeps the same type size as "Libre"; the
// lighter weight is the only distinction.
const LIBRE_SIZE: Record<NonNullable<LogoProps['size']>, string> = {
  sm: 'text-[1.0625rem] leading-none',
  md: 'text-[1.625rem] leading-none',
  lg: 'text-[2.5rem] leading-none',
};

export const Logo: React.FC<LogoProps> = ({
  className,
  size = 'md',
  wordmark = true,
}) => {
  return (
    <span
      dir='ltr'
      className={cn(
        'libre-brand inline-flex items-baseline whitespace-nowrap',
        LIBRE_SIZE[size],
        className
      )}
    >
      Libre
      {wordmark && (
        <span className='ms-1 font-normal tracking-[-0.035em]'>WebUI</span>
      )}
    </span>
  );
};
