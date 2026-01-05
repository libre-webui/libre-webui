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

import React, { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Persona } from '@/types';
import {
  Brain,
  Sparkles,
  ChevronDown,
  X,
  Settings2,
  MessageSquare,
  Zap,
} from 'lucide-react';
import { cn } from '@/utils';

interface PersonaIndicatorProps {
  persona: Persona;
  onClear?: () => void;
  className?: string;
}

export const PersonaIndicator: React.FC<PersonaIndicatorProps> = ({
  persona,
  onClear,
  className,
}) => {
  const [showDetails, setShowDetails] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [popupPosition, setPopupPosition] = useState({ top: 0, left: 0 });

  // Calculate popup position when showing details
  useEffect(() => {
    if (showDetails && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      setPopupPosition({
        top: rect.bottom + 8, // 8px gap (mt-2)
        left: rect.left,
      });
    }
  }, [showDetails]);

  const hasAdvancedFeatures = Boolean(
    persona.memory_settings?.enabled || persona.mutation_settings?.enabled
  );

  const getAvatarSrc = () => {
    if (persona.avatar) {
      return persona.avatar;
    }
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(persona.name)}&background=6366f1&color=fff&size=64`;
  };

  return (
    <div className={cn('relative', className)}>
      {/* Trigger button */}
      <button
        ref={buttonRef}
        onClick={() => setShowDetails(!showDetails)}
        className={cn(
          'flex items-center gap-2 px-3 py-1.5 rounded-full transition-all duration-200',
          'bg-primary-50 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/15',
          'border border-primary-200 dark:border-primary-700/50 ophelia:border-[#7c3aed]/30',
          'hover:bg-primary-100 dark:hover:bg-primary-900/40 ophelia:hover:bg-[#9333ea]/20',
          'text-primary-700 dark:text-primary-300 ophelia:text-[#c084fc]'
        )}
      >
        <img
          src={getAvatarSrc()}
          alt={persona.name}
          className='w-5 h-5 rounded-full object-cover'
        />
        <span className='text-sm font-medium max-w-[120px] truncate'>
          {persona.name}
        </span>
        {hasAdvancedFeatures && (
          <Sparkles className='h-3 w-3 text-purple-500 dark:text-purple-400' />
        )}
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 transition-transform duration-200',
            showDetails && 'rotate-180'
          )}
        />
      </button>

      {/* Details popup - rendered in portal to escape stacking context */}
      {showDetails &&
        createPortal(
          <>
            <div
              className='fixed inset-0 z-[9998]'
              onClick={() => setShowDetails(false)}
            />
            <div
              className='fixed w-72 z-[9999]'
              style={{ top: popupPosition.top, left: popupPosition.left }}
            >
              <div
                className={cn(
                  'rounded-xl overflow-hidden shadow-xl',
                  'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                  'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]'
                )}
              >
                {/* Header with gradient */}
                <div className='relative h-16'>
                  {persona.background ? (
                    <div
                      className='absolute inset-0 bg-cover bg-center'
                      style={{ backgroundImage: `url(${persona.background})` }}
                    />
                  ) : (
                    <div className='absolute inset-0 bg-gradient-to-br from-primary-400 via-primary-500 to-purple-600 dark:from-primary-600 dark:via-primary-700 dark:to-purple-800 ophelia:from-[#9333ea] ophelia:via-[#7c3aed] ophelia:to-[#6d28d9]' />
                  )}
                  <div className='absolute inset-0 bg-black/10' />

                  {/* Close button */}
                  {onClear && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        onClear();
                        setShowDetails(false);
                      }}
                      className='absolute top-2 right-2 p-1 rounded-full bg-white/20 hover:bg-white/30 backdrop-blur-sm transition-colors'
                      title='Remove persona'
                    >
                      <X className='h-3.5 w-3.5 text-white' />
                    </button>
                  )}

                  {/* Advanced badge */}
                  {hasAdvancedFeatures && (
                    <div className='absolute top-2 left-2 flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/20 backdrop-blur-sm text-white text-[10px] font-medium'>
                      <Brain className='h-3 w-3' />
                      Enhanced
                    </div>
                  )}
                </div>

                {/* Avatar overlapping header */}
                <div className='relative px-4 -mt-6'>
                  <img
                    src={getAvatarSrc()}
                    alt={persona.name}
                    className='w-12 h-12 rounded-lg object-cover ring-3 ring-white dark:ring-dark-100 ophelia:ring-[#0a0a0a] shadow-md'
                  />
                </div>

                {/* Content */}
                <div className='px-4 pt-2 pb-4'>
                  <h4 className='text-base font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                    {persona.name}
                  </h4>
                  <p className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] flex items-center gap-1 mt-0.5'>
                    <Settings2 className='h-3 w-3' />
                    {persona.model}
                  </p>

                  {persona.description && (
                    <p className='text-xs text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] mt-2 line-clamp-2'>
                      {persona.description}
                    </p>
                  )}

                  {/* System prompt preview */}
                  {persona.parameters.system_prompt && (
                    <div className='mt-3 p-2 rounded-lg bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212] border border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a]'>
                      <div className='flex items-center gap-1 mb-1'>
                        <MessageSquare className='h-2.5 w-2.5 text-gray-400' />
                        <span className='text-[9px] uppercase tracking-wider font-medium text-gray-400'>
                          System
                        </span>
                      </div>
                      <p className='text-[11px] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] line-clamp-2 italic'>
                        &ldquo;{persona.parameters.system_prompt}&rdquo;
                      </p>
                    </div>
                  )}

                  {/* Parameters */}
                  <div className='flex flex-wrap gap-1 mt-3'>
                    <span className='inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
                      <Zap className='h-2.5 w-2.5' />
                      {persona.parameters.temperature?.toFixed(1) || '0.7'}
                    </span>
                    <span className='inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
                      Top-P {persona.parameters.top_p?.toFixed(1) || '0.9'}
                    </span>
                    {persona.memory_settings?.enabled && (
                      <span className='inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-purple-100 dark:bg-purple-900/30 ophelia:bg-[#9333ea]/20 text-purple-700 dark:text-purple-300 ophelia:text-[#c084fc]'>
                        <Brain className='h-2.5 w-2.5' />
                        Memory
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>,
          document.body
        )}
    </div>
  );
};

export default PersonaIndicator;
