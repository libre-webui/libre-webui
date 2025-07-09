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
import { User, Users } from 'lucide-react';
import { Select } from '@/components/ui';
import { personaApi } from '@/utils/api';
import { Persona } from '@/types';
import { cn } from '@/utils';

interface PersonaSelectorProps {
  selectedPersonaId?: string;
  onPersonaChange: (personaId: string | undefined) => void;
  disabled?: boolean;
  className?: string;
}

export const PersonaSelector: React.FC<PersonaSelectorProps> = ({
  selectedPersonaId,
  onPersonaChange,
  disabled = false,
  className,
}) => {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const loadPersonas = async () => {
      try {
        setLoading(true);
        const response = await personaApi.getPersonas();
        if (response.success && response.data) {
          setPersonas(response.data);
        }
      } catch (error) {
        console.error('Failed to load personas:', error);
      } finally {
        setLoading(false);
      }
    };

    loadPersonas();
  }, []);

  const selectedPersona = personas.find(p => p.id === selectedPersonaId);

  const options = [
    { value: '', label: 'No Persona' },
    ...personas.map(persona => ({
      value: persona.id,
      label: persona.name,
    })),
  ];

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <div className='flex items-center gap-1 text-gray-600 dark:text-gray-400'>
        {selectedPersona ? (
          <div className='flex items-center gap-2'>
            {selectedPersona.avatar ? (
              <img
                src={selectedPersona.avatar}
                alt={selectedPersona.name}
                className='w-5 h-5 rounded-full object-cover'
              />
            ) : (
              <User className='h-4 w-4' />
            )}
          </div>
        ) : (
          <Users className='h-4 w-4' />
        )}
      </div>

      <Select
        value={selectedPersonaId || ''}
        onChange={e => onPersonaChange(e.target.value || undefined)}
        options={options}
        disabled={disabled || loading}
        className='min-w-32'
      />

      {selectedPersona && (
        <div className='text-xs text-gray-500 dark:text-gray-400 truncate max-w-xs'>
          {selectedPersona.description}
        </div>
      )}
    </div>
  );
};

export default PersonaSelector;
