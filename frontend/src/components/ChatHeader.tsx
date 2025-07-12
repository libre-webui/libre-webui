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
import { User, Settings, Brain, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { PersonaSelector } from './PersonaSelector';
import { personaApi } from '@/utils/api';
import { Persona, ChatSession } from '@/types';
import { cn } from '@/utils';

interface ChatHeaderProps {
  session: ChatSession;
  onPersonaChange?: (personaId: string | undefined) => void;
  className?: string;
}

export const ChatHeader: React.FC<ChatHeaderProps> = ({
  session,
  onPersonaChange,
  className,
}) => {
  const [persona, setPersona] = useState<Persona | null>(null);
  const [showPersonaSelector, setShowPersonaSelector] = useState(false);
  const [_loading, setLoading] = useState(false);

  // Check if persona has advanced features
  const hasAdvancedFeatures = (persona: Persona): boolean => {
    // Check for advanced fields or legacy features in parameters
    return !!(
      persona.embedding_model ||
      persona.memory_settings ||
      (persona.parameters as Record<string, unknown>)?.legacy_features
    );
  };

  useEffect(() => {
    const loadPersona = async () => {
      if (!session.personaId) {
        setPersona(null);
        return;
      }

      try {
        setLoading(true);
        const response = await personaApi.getPersona(session.personaId);
        if (response.success && response.data) {
          setPersona(response.data);
        }
      } catch (error) {
        console.error('Failed to load persona:', error);
      } finally {
        setLoading(false);
      }
    };

    loadPersona();
  }, [session.personaId]);

  const handlePersonaChange = (personaId: string | undefined) => {
    setShowPersonaSelector(false);
    if (onPersonaChange) {
      onPersonaChange(personaId);
    }
  };

  return (
    <div
      className={cn(
        'px-4 py-3 border-b border-gray-200 dark:border-dark-200 bg-white dark:bg-dark-50',
        className
      )}
    >
      <div className='flex items-center justify-between'>
        <div className='flex items-center gap-3'>
          <h1 className='text-lg font-semibold text-gray-900 dark:text-dark-800 truncate'>
            {session.title}
          </h1>

          {persona && (
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-1 rounded-full text-sm',
                hasAdvancedFeatures(persona)
                  ? 'bg-gradient-to-r from-purple-50 to-pink-50 dark:from-purple-900/20 dark:to-pink-900/20 text-purple-700 dark:text-purple-300 border border-purple-200 dark:border-purple-800'
                  : 'bg-primary-50 dark:bg-primary-900/20 text-primary-700 dark:text-primary-300'
              )}
            >
              {persona.avatar ? (
                <img
                  src={persona.avatar}
                  alt={persona.name}
                  className='w-5 h-5 rounded-full object-cover'
                />
              ) : (
                <User className='h-4 w-4' />
              )}
              <span className='font-medium'>{persona.name}</span>
              {hasAdvancedFeatures(persona) && (
                <div
                  className='flex items-center gap-1'
                  title='Advanced: Memory & Adaptive Learning Active'
                >
                  <Brain className='h-3 w-3' />
                  <Sparkles className='h-3 w-3' />
                </div>
              )}
            </div>
          )}
        </div>

        <div className='flex items-center gap-2'>
          {showPersonaSelector ? (
            <div className='flex items-center gap-2'>
              <PersonaSelector
                selectedPersonaId={session.personaId}
                onPersonaChange={handlePersonaChange}
                className='min-w-48'
              />
              <Button
                variant='ghost'
                size='sm'
                onClick={() => setShowPersonaSelector(false)}
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant='ghost'
              size='sm'
              onClick={() => setShowPersonaSelector(true)}
              className='flex items-center gap-2'
            >
              <Settings className='h-4 w-4' />
              {persona ? 'Change Persona' : 'Add Persona'}
            </Button>
          )}
        </div>
      </div>

      {persona && (
        <div className='mt-2 text-sm text-gray-600 dark:text-gray-400'>
          {persona.description}
        </div>
      )}
    </div>
  );
};

export default ChatHeader;
