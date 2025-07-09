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
import { Button } from '@/components/ui/Button';
import { Persona } from '@/types';
import { Download, Edit, Trash2 } from 'lucide-react';

interface PersonaCardProps {
  persona: Persona;
  onEdit: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onDownload: (persona: Persona) => void;
}

const PersonaCard: React.FC<PersonaCardProps> = ({
  persona,
  onEdit,
  onDelete,
  onDownload,
}) => {
  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString();
  };

  const getAvatarSrc = () => {
    if (persona.avatar) {
      return persona.avatar;
    }
    // Default avatar based on name
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(persona.name)}&background=6366f1&color=fff&size=128`;
  };

  return (
    <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300 hover:shadow-md transition-shadow'>
      {/* Background Image */}
      {persona.background && (
        <div
          className='w-full h-24 rounded-md mb-4 bg-cover bg-center'
          style={{ backgroundImage: `url(${persona.background})` }}
        />
      )}

      {/* Avatar and Name */}
      <div className='flex items-center gap-4 mb-4'>
        <img
          src={getAvatarSrc()}
          alt={persona.name}
          className='w-12 h-12 rounded-full object-cover'
        />
        <div className='flex-1'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
            {persona.name}
          </h3>
          <p className='text-sm text-gray-500 dark:text-dark-500'>
            {persona.model}
          </p>
        </div>
      </div>

      {/* Description */}
      {persona.description && (
        <p className='text-gray-600 dark:text-dark-600 mb-4 line-clamp-2'>
          {persona.description}
        </p>
      )}

      {/* Parameters Summary */}
      <div className='mb-4'>
        <div className='flex flex-wrap gap-2 mb-2'>
          <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-400'>
            Temp: {persona.parameters.temperature?.toFixed(1) || '0.7'}
          </span>
          <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-400'>
            Top-P: {persona.parameters.top_p?.toFixed(1) || '0.9'}
          </span>
          <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-purple-100 dark:bg-purple-900/30 text-purple-800 dark:text-purple-400'>
            Context: {persona.parameters.context_window || 4096}
          </span>
        </div>
      </div>

      {/* System Prompt Preview */}
      {persona.parameters.system_prompt && (
        <div className='mb-4'>
          <p className='text-xs text-gray-500 dark:text-dark-500 mb-1'>
            System Prompt:
          </p>
          <p className='text-sm text-gray-600 dark:text-dark-600 line-clamp-2 italic'>
            &ldquo;{persona.parameters.system_prompt}&rdquo;
          </p>
        </div>
      )}

      {/* Footer */}
      <div className='flex items-center justify-between pt-4 border-t border-gray-200 dark:border-dark-300'>
        <div className='text-xs text-gray-500 dark:text-dark-500'>
          Created {formatDate(persona.created_at)}
        </div>
        <div className='flex gap-2'>
          <Button
            onClick={() => onDownload(persona)}
            variant='outline'
            size='sm'
            className='p-2 text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300'
            title='Download persona'
          >
            <Download className='h-4 w-4' />
          </Button>
          <Button
            onClick={() => onEdit(persona)}
            variant='outline'
            size='sm'
            className='p-2'
            title='Edit persona'
          >
            <Edit className='h-4 w-4' />
          </Button>
          <Button
            onClick={() => onDelete(persona)}
            variant='outline'
            size='sm'
            className='p-2 text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300'
            title='Delete persona'
          >
            <Trash2 className='h-4 w-4' />
          </Button>
        </div>
      </div>
    </div>
  );
};

export { PersonaCard };
export default PersonaCard;
