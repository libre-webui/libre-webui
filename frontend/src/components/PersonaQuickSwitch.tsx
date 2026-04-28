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

import React, { useState, useEffect } from 'react';
import { Persona } from '@/types';
import {
  Users,
  Search,
  Star,
  Sparkles,
  X,
  ChevronRight,
  Settings2,
} from 'lucide-react';
import { personaApi } from '@/utils/api';
import { cn } from '@/utils';
import toast from 'react-hot-toast';

interface PersonaQuickSwitchProps {
  currentPersonaId?: string;
  onSelectPersona: (persona: Persona) => void;
  onClearPersona?: () => void;
  isOpen: boolean;
  onClose: () => void;
  className?: string;
}

export const PersonaQuickSwitch: React.FC<PersonaQuickSwitchProps> = ({
  currentPersonaId,
  onSelectPersona,
  onClearPersona,
  isOpen,
  onClose,
  className,
}) => {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadPersonas();
    }
  }, [isOpen]);

  const loadPersonas = async () => {
    setIsLoading(true);
    try {
      const response = await personaApi.getPersonas();
      if (response.success && response.data) {
        setPersonas(response.data);
      }
    } catch (error) {
      console.error('Failed to load personas:', error);
      toast.error('Failed to load personas');
    } finally {
      setIsLoading(false);
    }
  };

  const filteredPersonas = personas.filter(
    persona =>
      persona.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      persona.description?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      persona.model.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // Sort: favorites first, then by name
  const sortedPersonas = [...filteredPersonas].sort((a, b) => {
    if (a.is_favorite && !b.is_favorite) return -1;
    if (!a.is_favorite && b.is_favorite) return 1;
    return a.name.localeCompare(b.name);
  });

  const getAvatarSrc = (persona: Persona) => {
    if (persona.avatar) {
      return persona.avatar;
    }
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(persona.name)}&background=6366f1&color=fff&size=64`;
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className='fixed inset-0 z-[9998]' onClick={onClose} />

      {/* Panel */}
      <div
        className={cn(
          'fixed z-[9999] w-80 max-h-[70vh] flex flex-col',
          'bg-white dark:bg-dark-100',
          'rounded-2xl shadow-2xl',
          'border border-gray-200 dark:border-dark-300',
          'overflow-hidden',
          className
        )}
      >
        {/* Header */}
        <div className='flex-shrink-0 px-4 py-3 border-b border-gray-100 dark:border-dark-200'>
          <div className='flex items-center justify-between mb-3'>
            <div className='flex items-center gap-2'>
              <Users className='h-5 w-5 text-primary-600 dark:text-primary-400' />
              <h3 className='font-semibold text-gray-900 dark:text-gray-100'>
                Switch Persona
              </h3>
            </div>
            <button
              onClick={onClose}
              className='p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
            >
              <X className='h-4 w-4' />
            </button>
          </div>

          {/* Search */}
          <div className='relative'>
            <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400' />
            <input
              type='text'
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder='Search personas...'
              className={cn(
                'w-full pl-9 pr-3 py-2 text-sm rounded-lg',
                'bg-gray-50 dark:bg-dark-50',
                'border border-gray-200 dark:border-dark-300',
                'text-gray-900 dark:text-gray-100',
                'placeholder:text-gray-400 dark:placeholder:text-gray-500',
                'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 dark:focus:border-primary-400'
              )}
            />
          </div>
        </div>

        {/* Current persona */}
        {currentPersonaId && onClearPersona && (
          <div className='flex-shrink-0 px-4 py-2 bg-primary-50 dark:bg-primary-900/20 border-b border-primary-100 dark:border-primary-800/30'>
            <div className='flex items-center justify-between'>
              <span className='text-xs text-primary-700 dark:text-primary-300'>
                Active persona
              </span>
              <button
                onClick={() => {
                  onClearPersona();
                  onClose();
                }}
                className='text-xs text-primary-600 dark:text-primary-400 hover:underline'
              >
                Clear
              </button>
            </div>
          </div>
        )}

        {/* List */}
        <div className='flex-1 overflow-y-auto p-2'>
          {isLoading ? (
            <div className='flex items-center justify-center py-8'>
              <div className='animate-spin h-6 w-6 border-2 border-primary-500 border-t-transparent rounded-full' />
            </div>
          ) : sortedPersonas.length === 0 ? (
            <div className='text-center py-8 text-gray-500 dark:text-gray-400'>
              <Users className='h-8 w-8 mx-auto mb-2 opacity-50' />
              <p className='text-sm'>
                {searchQuery ? 'No personas found' : 'No personas yet'}
              </p>
            </div>
          ) : (
            <div className='space-y-1'>
              {sortedPersonas.map(persona => {
                const isActive = persona.id === currentPersonaId;
                const hasAdvancedFeatures = Boolean(
                  persona.memory_settings?.enabled ||
                  persona.mutation_settings?.enabled
                );

                return (
                  <button
                    key={persona.id}
                    onClick={() => {
                      onSelectPersona(persona);
                      onClose();
                    }}
                    className={cn(
                      'w-full flex items-center gap-3 p-3 rounded-xl transition-all duration-200',
                      'text-left',
                      isActive
                        ? [
                            'bg-primary-50 dark:bg-primary-900/30',
                            'border border-primary-200 dark:border-primary-700/50',
                          ]
                        : [
                            'hover:bg-gray-50 dark:hover:bg-dark-50',
                            'border border-transparent',
                          ]
                    )}
                  >
                    {/* Avatar */}
                    <div className='relative flex-shrink-0'>
                      <img
                        src={getAvatarSrc(persona)}
                        alt={persona.name}
                        className='w-10 h-10 rounded-lg object-cover'
                      />
                      {hasAdvancedFeatures && (
                        <div className='absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-gradient-to-br from-purple-500 to-primary-500 rounded-full flex items-center justify-center'>
                          <Sparkles className='h-2.5 w-2.5 text-white' />
                        </div>
                      )}
                    </div>

                    {/* Info */}
                    <div className='flex-1 min-w-0'>
                      <div className='flex items-center gap-1.5'>
                        <span
                          className={cn(
                            'font-medium text-sm truncate',
                            isActive
                              ? 'text-primary-700 dark:text-primary-300'
                              : 'text-gray-900 dark:text-gray-100'
                          )}
                        >
                          {persona.name}
                        </span>
                        {persona.is_favorite && (
                          <Star className='h-3 w-3 text-amber-500 fill-amber-500 flex-shrink-0' />
                        )}
                      </div>
                      <div className='flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400'>
                        <Settings2 className='h-3 w-3' />
                        <span className='truncate'>{persona.model}</span>
                      </div>
                    </div>

                    {/* Arrow */}
                    <ChevronRight
                      className={cn(
                        'h-4 w-4 flex-shrink-0',
                        isActive
                          ? 'text-primary-500 dark:text-primary-400'
                          : 'text-gray-300 dark:text-gray-600'
                      )}
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className='flex-shrink-0 px-4 py-3 border-t border-gray-100 dark:border-dark-200 bg-gray-50 dark:bg-dark-50'>
          <p className='text-[11px] text-gray-500 dark:text-gray-400 text-center'>
            {personas.length} persona{personas.length !== 1 ? 's' : ''}{' '}
            available
          </p>
        </div>
      </div>
    </>
  );
};

export default PersonaQuickSwitch;
