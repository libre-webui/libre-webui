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
}

export const Logo: React.FC<LogoProps> = ({ className, size = 'md' }) => {
  const sizeClasses = {
    sm: 'h-6 w-6',
    md: 'h-8 w-8',
    lg: 'h-12 w-12',
  };

  return (
    <div
      className={cn(
        'flex-shrink-0 rounded-lg overflow-hidden',
        sizeClasses[size],
        className
      )}
    >
      <div
        className='w-full h-full flex items-center justify-center relative'
        style={{
          background:
            'linear-gradient(135deg, #ff6b6b 0%, #feca57 20%, #48dbfb 40%, #ff9ff3 60%, #54a0ff 80%, #5f27cd 100%)',
        }}
      >
        {/* L Shape */}
        <div
          className='absolute'
          style={{
            color: 'rgba(255, 255, 255, 0.95)',
            fontSize: size === 'lg' ? '28px' : size === 'md' ? '20px' : '14px',
            fontWeight: '700',
            fontFamily:
              'system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
            lineHeight: '1',
            letterSpacing: '-0.02em',
          }}
        >
          L
        </div>
      </div>
    </div>
  );
};
