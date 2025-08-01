/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License a                <span className='text-primary-700 dark:text-primary-300'>
                  Memory Entries:
                </span>
                <span className='ml-1 font-medium text-primary-900 dark:text-primary-100'>*
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/Button';
import { Persona, MemoryStatus } from '@/types';
import {
  Download,
  Edit,
  Trash2,
  Brain,
  Database,
  Archive,
  AlertTriangle,
  FileDown,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { personaApi } from '@/utils/api';
import toast from 'react-hot-toast';

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
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [showAdvancedControls, setShowAdvancedControls] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  // Check if this persona has advanced features enabled
  const hasAdvancedFeatures = Boolean(
    persona.memory_settings?.enabled || persona.mutation_settings?.enabled
  );

  const loadMemoryStatus = useCallback(async () => {
    if (!hasAdvancedFeatures) return;

    try {
      const response = await personaApi.getMemoryStatus(persona.id);
      if (response.success && response.data) {
        setMemoryStatus(response.data);
      }
    } catch (error) {
      console.error('Failed to load memory status:', error);
    }
  }, [persona.id, hasAdvancedFeatures]);

  useEffect(() => {
    loadMemoryStatus();
  }, [loadMemoryStatus]);

  const handleWipeMemories = async () => {
    if (
      !confirm(
        'Are you sure you want to wipe all memories for this persona? This action cannot be undone.'
      )
    ) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await personaApi.wipeMemories(persona.id);
      if (response.success) {
        toast.success(`Wiped ${response.data?.deleted_count || 0} memories`);
        await loadMemoryStatus();
      } else {
        toast.error('Failed to wipe memories');
      }
    } catch (error) {
      toast.error('Failed to wipe memories');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBackupPersona = async () => {
    setIsLoading(true);
    try {
      const blob = await personaApi.backupPersona(persona.id);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.toLowerCase().replace(/\s+/g, '-')}-backup.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success('Persona backup downloaded successfully');
    } catch (error) {
      toast.error('Failed to backup persona');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleExportDNA = async () => {
    setIsLoading(true);
    try {
      const blob = await personaApi.exportPersonaDNA(persona.id);

      // Create download link
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.toLowerCase().replace(/\s+/g, '-')}-dna.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      toast.success('Persona DNA exported successfully');
    } catch (error) {
      toast.error('Failed to export persona DNA');
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

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

  const formatMemorySize = (sizeInMB: number): string => {
    if (sizeInMB < 1) {
      return `${(sizeInMB * 1024).toFixed(1)} KB`;
    }
    return `${sizeInMB.toFixed(1)} MB`;
  };

  return (
    <div className='bg-white dark:bg-dark-100 rounded-lg shadow-sm border border-gray-200 dark:border-dark-300 hover:shadow-md transition-all duration-200'>
      {/* Header with background */}
      <div className='relative'>
        {persona.background && (
          <div
            className='w-full h-24 rounded-t-lg bg-cover bg-center'
            style={{ backgroundImage: `url(${persona.background})` }}
          />
        )}

        {/* Advanced features indicator */}
        {hasAdvancedFeatures && (
          <div className='absolute top-2 right-2'>
            <div className='bg-gradient-to-r from-primary-500 to-primary-600 text-white px-2 py-1 rounded-full text-xs font-medium shadow-sm'>
              <Brain className='h-3 w-3 inline mr-1' />
              Enhanced
            </div>
          </div>
        )}
      </div>

      <div className='p-6'>
        {/* Avatar and Name */}
        <div className='flex items-center gap-4 mb-4'>
          <img
            src={getAvatarSrc()}
            alt={persona.name}
            className='w-12 h-12 rounded-full object-cover border-2 border-gray-200 dark:border-gray-600'
          />
          <div className='flex-1'>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800'>
              {persona.name}
            </h3>
            <p className='text-sm text-gray-500 dark:text-dark-600'>
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

        {/* Memory Status (if advanced features enabled) */}
        {hasAdvancedFeatures && memoryStatus && (
          <div className='mb-4 p-3 bg-primary-50 dark:bg-primary-900/20 rounded-lg border border-primary-200 dark:border-primary-800'>
            <div className='flex items-center justify-between mb-2'>
              <div className='flex items-center gap-2'>
                <Database className='h-4 w-4 text-primary-600 dark:text-primary-400' />
                <span className='text-sm font-medium text-primary-900 dark:text-primary-100'>
                  Memory Status
                </span>
              </div>
              {memoryStatus.status && (
                <span
                  className={`text-xs px-2 py-1 rounded-full ${
                    memoryStatus.status === 'active'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-400'
                      : 'bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-dark-600'
                  }`}
                >
                  {memoryStatus.status}
                </span>
              )}
            </div>
            <div className='grid grid-cols-2 gap-3 text-xs'>
              <div>
                <span className='text-primary-700 dark:text-primary-300'>
                  Memories:
                </span>
                <span className='ml-1 font-medium text-primary-900 dark:text-primary-100'>
                  {memoryStatus.memory_count}
                </span>
              </div>
              <div>
                <span className='text-primary-700 dark:text-primary-300'>
                  Size:
                </span>
                <span className='ml-1 font-medium text-primary-900 dark:text-primary-100'>
                  {formatMemorySize(memoryStatus.size_mb)}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* Configuration Summary */}
        <div className='mb-4'>
          <div className='flex flex-wrap gap-2 mb-2'>
            <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-400'>
              Temp: {persona.parameters.temperature?.toFixed(1) || '0.7'}
            </span>
            <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-400'>
              Top-P: {persona.parameters.top_p?.toFixed(1) || '0.9'}
            </span>
            <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-400'>
              Context: {persona.parameters.context_window || 4096}
            </span>
            {persona.memory_settings?.enabled && (
              <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-400'>
                <Brain className='h-3 w-3 mr-1' />
                Memory
              </span>
            )}
            {persona.mutation_settings?.enabled && (
              <span className='inline-flex items-center px-2 py-1 rounded-full text-xs bg-primary-100 dark:bg-primary-900/30 text-primary-800 dark:text-primary-400'>
                Adaptive
              </span>
            )}
          </div>
        </div>

        {/* System Prompt Preview */}
        {persona.parameters.system_prompt && (
          <div className='mb-4'>
            <p className='text-xs text-gray-500 dark:text-dark-600 mb-1'>
              System Prompt:
            </p>
            <p className='text-sm text-gray-600 dark:text-dark-600 line-clamp-2 italic'>
              &ldquo;{persona.parameters.system_prompt}&rdquo;
            </p>
          </div>
        )}

        {/* Advanced Controls Toggle */}
        {hasAdvancedFeatures && (
          <div className='mb-4'>
            <Button
              onClick={() => setShowAdvancedControls(!showAdvancedControls)}
              variant='outline'
              size='sm'
              className='w-full text-gray-600 dark:text-dark-600 border-gray-300 dark:border-dark-300'
            >
              {showAdvancedControls ? (
                <>
                  <ChevronUp className='h-4 w-4 mr-2' />
                  Hide Advanced Controls
                </>
              ) : (
                <>
                  <ChevronDown className='h-4 w-4 mr-2' />
                  Show Advanced Controls
                </>
              )}
            </Button>
          </div>
        )}

        {/* Advanced Controls */}
        {hasAdvancedFeatures && showAdvancedControls && (
          <div className='mb-4 p-3 bg-gray-50 dark:bg-dark-50 rounded-lg border border-gray-200 dark:border-dark-300'>
            <h4 className='text-sm font-medium text-gray-900 dark:text-dark-800 mb-3'>
              Advanced Operations
            </h4>
            <div className='grid grid-cols-2 gap-2'>
              <Button
                onClick={handleBackupPersona}
                disabled={isLoading}
                variant='outline'
                size='sm'
                className='text-primary-600 dark:text-primary-400 border-primary-300 dark:border-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20'
              >
                <Archive className='h-4 w-4 mr-1' />
                Backup
              </Button>
              <Button
                onClick={handleExportDNA}
                disabled={isLoading}
                variant='outline'
                size='sm'
                className='text-primary-600 dark:text-primary-400 border-primary-300 dark:border-primary-600 hover:bg-primary-50 dark:hover:bg-primary-900/20'
              >
                <FileDown className='h-4 w-4 mr-1' />
                Export DNA
              </Button>
              {memoryStatus && memoryStatus.memory_count > 0 && (
                <Button
                  onClick={handleWipeMemories}
                  disabled={isLoading}
                  variant='outline'
                  size='sm'
                  className='text-red-600 dark:text-red-400 border-red-300 dark:border-red-600 hover:bg-red-50 dark:hover:bg-red-900/20'
                >
                  <AlertTriangle className='h-4 w-4 mr-1' />
                  Wipe Memory
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className='flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-600'>
          <div className='text-xs text-gray-500 dark:text-dark-600'>
            Created {formatDate(persona.created_at)}
          </div>
          <div className='flex gap-2'>
            <Button
              onClick={() => onDownload(persona)}
              variant='outline'
              size='sm'
              className='p-2 text-primary-600 hover:text-primary-700 dark:text-primary-400 dark:hover:text-primary-300'
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
    </div>
  );
};

export { PersonaCard };
export default PersonaCard;
