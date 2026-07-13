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

import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  MoreHorizontal,
  Star,
  Sparkles,
  MessageSquare,
  Zap,
  Settings2,
  Play,
} from 'lucide-react';
import { personaApi } from '@/utils/api';
import {
  getPersonaAvatarSrc,
  setPersonaAvatarFallback,
} from '@/utils/personaAvatar';
import toast from 'react-hot-toast';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:persona-card');

interface PersonaCardProps {
  persona: Persona;
  onEdit: (persona: Persona) => void;
  onDelete: (persona: Persona) => void;
  onDownload: (persona: Persona) => void;
  onSelect?: (persona: Persona) => void;
  onToggleFavorite?: (persona: Persona) => void;
  isSelected?: boolean;
  compact?: boolean;
}

const PersonaCard: React.FC<PersonaCardProps> = ({
  persona,
  onEdit,
  onDelete,
  onDownload,
  onSelect,
  onToggleFavorite,
  isSelected = false,
  compact = false,
}) => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [showMenu, setShowMenu] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const hasAdvancedFeatures = Boolean(
    persona.memory_settings?.enabled || persona.mutation_settings?.enabled
  );

  const { data: memoryStatus = null } = useQuery({
    queryKey: ['persona-memory-status', persona.id],
    queryFn: async (): Promise<MemoryStatus | null> => {
      const response = await personaApi.getMemoryStatus(persona.id);
      if (response.success && response.data) return response.data;
      return null;
    },
    enabled: hasAdvancedFeatures,
  });

  const reloadMemoryStatus = () =>
    queryClient.invalidateQueries({
      queryKey: ['persona-memory-status', persona.id],
    });

  const handleWipeMemories = async () => {
    if (!confirm(t('personaCard.wipeConfirm'))) {
      return;
    }

    setIsLoading(true);
    try {
      const response = await personaApi.wipeMemories(persona.id);
      if (response.success) {
        toast.success(
          t('personaCard.wipeSuccess', {
            count: response.data?.deleted_count || 0,
          })
        );
        await reloadMemoryStatus();
      } else {
        toast.error(t('personaCard.failed', { action: 'wipe memories' }));
      }
    } catch (error) {
      toast.error(t('personaCard.failed', { action: 'wipe memories' }));
      logger.error(error);
    } finally {
      setIsLoading(false);
      setShowMenu(false);
    }
  };

  const handleBackupPersona = async () => {
    setIsLoading(true);
    try {
      const blob = await personaApi.backupPersona(persona.id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.toLowerCase().replace(/\s+/g, '-')}-backup.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success(t('personaCard.backupSuccess'));
    } catch (error) {
      toast.error(t('personaCard.failed', { action: 'backup persona' }));
      logger.error(error);
    } finally {
      setIsLoading(false);
      setShowMenu(false);
    }
  };

  const handleExportDNA = async () => {
    setIsLoading(true);
    try {
      const blob = await personaApi.exportPersonaDNA(persona.id);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${persona.name.toLowerCase().replace(/\s+/g, '-')}-dna.json`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success(t('personaCard.dnaSuccess'));
    } catch (error) {
      toast.error(t('personaCard.failed', { action: 'export persona DNA' }));
      logger.error(error);
    } finally {
      setIsLoading(false);
      setShowMenu(false);
    }
  };

  const getAvatarSrc = (size = 128) => getPersonaAvatarSrc(persona, size);

  const handleAvatarError =
    (size = 128) =>
    (event: React.SyntheticEvent<HTMLImageElement>) => {
      setPersonaAvatarFallback(event.currentTarget, persona.name, size);
    };

  const formatMemorySize = (sizeInMB: number): string => {
    if (sizeInMB < 1) {
      return `${(sizeInMB * 1024).toFixed(0)} KB`;
    }
    return `${sizeInMB.toFixed(1)} MB`;
  };

  // Compact card for sidebar/selection
  if (compact) {
    return (
      <div
        className={cn(
          'group relative flex items-center gap-3 p-3 rounded-xl cursor-pointer transition-all duration-200',
          'border border-transparent',
          'hover:bg-gray-50 dark:hover:bg-dark-100',
          isSelected && [
            'bg-primary-50 dark:bg-primary-900/20',
            'border-primary-200 dark:border-primary-700',
          ]
        )}
        onClick={() => onSelect?.(persona)}
      >
        {/* Avatar */}
        <div className='relative flex-shrink-0'>
          <img
            src={getAvatarSrc(64)}
            alt={persona.name}
            className='w-10 h-10 rounded-full object-cover ring-2 ring-white dark:ring-dark-100'
            onError={handleAvatarError(64)}
          />
          {hasAdvancedFeatures && (
            <div className='absolute -bottom-0.5 -end-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary-600'>
              <Sparkles className='h-2.5 w-2.5 text-white' />
            </div>
          )}
        </div>

        {/* Info */}
        <div className='flex-1 min-w-0'>
          <div className='flex items-center gap-1.5'>
            <h4 className='font-medium text-sm text-gray-900 dark:text-gray-100 truncate'>
              {persona.name}
            </h4>
            {persona.is_favorite && (
              <Star className='h-3 w-3 text-amber-500 fill-amber-500 flex-shrink-0' />
            )}
          </div>
          <p className='text-xs text-gray-500 dark:text-gray-400 truncate'>
            {persona.model}
          </p>
        </div>

        {/* Quick action */}
        {isSelected && (
          <div className='flex-shrink-0'>
            <div className='w-6 h-6 rounded-full bg-primary-500 dark:bg-primary-600 flex items-center justify-center'>
              <Play className='h-3 w-3 text-white rtl:rotate-180' />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Full card
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-2xl transition-[border-color,background-color] duration-200',
        'bg-white/70 dark:bg-white/[0.035]',
        'border border-gray-200/80 dark:border-white/10',
        'hover:border-gray-300 dark:hover:border-white/20',
        isSelected && [
          'ring-2 ring-primary-500 dark:ring-primary-400',
          'border-primary-300 dark:border-primary-600',
        ]
      )}
    >
      {/* Background Header */}
      <div className='relative h-24'>
        {persona.background ? (
          <div
            className='absolute inset-0 bg-cover bg-center'
            style={{ backgroundImage: `url(${persona.background})` }}
          />
        ) : (
          <div className='absolute inset-0 bg-gray-200 dark:bg-dark-200' />
        )}
        {persona.background && (
          <div className='absolute inset-0 bg-black/15 dark:bg-black/25' />
        )}

        {/* Top badges */}
        <div className='absolute inset-x-3 top-3 flex items-start justify-between'>
          {/* Favorite */}
          <button
            onClick={e => {
              e.stopPropagation();
              onToggleFavorite?.(persona);
            }}
            className={cn(
              'p-1.5 rounded-full transition-all duration-200',
              'border border-white/30 bg-black/20 text-white backdrop-blur-sm hover:bg-black/30',
              persona.is_favorite && 'bg-amber-500/80 hover:bg-amber-500'
            )}
          >
            <Star
              className={cn(
                'h-4 w-4',
                persona.is_favorite
                  ? 'text-white fill-white'
                  : 'text-white/80 hover:text-white'
              )}
            />
          </button>

          {/* Advanced badge */}
          {hasAdvancedFeatures && (
            <div className='flex items-center gap-1 rounded-full border border-white/30 bg-black/20 px-2 py-1 text-[10px] font-medium text-white backdrop-blur-sm'>
              <Sparkles className='h-3 w-3' />
              {t('personaCard.enhanced')}
            </div>
          )}
        </div>
      </div>

      {/* Avatar - overlapping header */}
      <div className='relative -mt-8 px-4'>
        <div className='relative inline-block'>
          <img
            src={getAvatarSrc(128)}
            alt={persona.name}
            className='h-16 w-16 rounded-xl object-cover ring-4 ring-white dark:ring-dark-100'
            onError={handleAvatarError(128)}
          />
          {hasAdvancedFeatures && (
            <div className='absolute -bottom-1 -end-1 flex h-6 w-6 items-center justify-center rounded-lg bg-primary-600 ring-2 ring-white dark:ring-dark-100'>
              <Brain className='h-3.5 w-3.5 text-white' />
            </div>
          )}
        </div>
      </div>

      {/* Content */}
      <div className='px-4 pt-3 pb-4'>
        {/* Name & Model */}
        <div className='mb-3'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 leading-tight'>
            {persona.name}
          </h3>
          <p className='text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1.5 mt-0.5'>
            <Settings2 className='h-3.5 w-3.5' />
            {persona.model}
          </p>
        </div>

        {/* Description */}
        {persona.description && (
          <p className='text-sm text-gray-600 dark:text-gray-400 line-clamp-2 mb-3'>
            {persona.description}
          </p>
        )}

        {/* System prompt preview */}
        {persona.parameters.system_prompt && (
          <div className='mb-3 rounded-xl border border-gray-200/70 bg-gray-50/70 p-2.5 dark:border-white/[0.08] dark:bg-white/[0.025]'>
            <div className='flex items-center gap-1.5 mb-1'>
              <MessageSquare className='h-3 w-3 text-gray-400 dark:text-gray-500' />
              <span className='text-[10px] uppercase tracking-wider font-medium text-gray-400 dark:text-gray-500'>
                {t('personaCard.systemPrompt')}
              </span>
            </div>
            <p className='line-clamp-2 text-xs leading-5 text-gray-600 dark:text-gray-400'>
              &ldquo;{persona.parameters.system_prompt}&rdquo;
            </p>
          </div>
        )}

        {/* Parameters */}
        <div className='flex flex-wrap gap-1.5 mb-3'>
          <span className='inline-flex items-center gap-1 rounded-lg border border-gray-200/70 px-2 py-1 text-[11px] font-medium text-gray-600 dark:border-white/[0.08] dark:text-gray-400'>
            <Zap className='h-3 w-3' />
            {persona.parameters.temperature?.toFixed(1) || '0.7'}
          </span>
          <span className='inline-flex items-center rounded-lg border border-gray-200/70 px-2 py-1 text-[11px] font-medium text-gray-600 dark:border-white/[0.08] dark:text-gray-400'>
            Top-P {persona.parameters.top_p?.toFixed(1) || '0.9'}
          </span>
          <span className='inline-flex items-center rounded-lg border border-gray-200/70 px-2 py-1 text-[11px] font-medium text-gray-600 dark:border-white/[0.08] dark:text-gray-400'>
            {(persona.parameters.context_window || 4096).toLocaleString()} ctx
          </span>
        </div>

        {/* Memory Status */}
        {hasAdvancedFeatures && memoryStatus && (
          <div className='mb-3 rounded-xl border border-primary-200/70 bg-primary-50/50 p-2.5 dark:border-primary-800/40 dark:bg-primary-900/10'>
            <div className='flex items-center justify-between'>
              <div className='flex items-center gap-2'>
                <Database className='h-4 w-4 text-primary-600 dark:text-primary-400' />
                <div>
                  <span className='text-xs font-medium text-primary-700 dark:text-primary-300'>
                    {memoryStatus.memory_count} {t('personaCard.memories')}
                  </span>
                  <span className='ms-2 text-[10px] text-primary-600/70 dark:text-primary-400/70'>
                    {formatMemorySize(memoryStatus.size_mb)}
                  </span>
                </div>
              </div>
              {memoryStatus.status && (
                <span
                  className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                    memoryStatus.status === 'active'
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400'
                      : 'bg-gray-100 dark:bg-dark-200 text-gray-600 dark:text-gray-400'
                  )}
                >
                  {memoryStatus.status}
                </span>
              )}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className='flex items-center justify-between border-t border-gray-200/70 pt-3 dark:border-white/[0.08]'>
          {/* Use button */}
          {onSelect && (
            <Button
              onClick={() => onSelect(persona)}
              size='sm'
              className='px-4'
            >
              <Play className='me-1.5 h-3.5 w-3.5 rtl:rotate-180' />
              {t('personaCard.use')}
            </Button>
          )}

          {/* Action buttons */}
          <div className='ms-auto flex items-center gap-1'>
            <button
              onClick={() => onEdit(persona)}
              className='p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
              title={t('personaCard.editTooltip')}
            >
              <Edit className='h-4 w-4' />
            </button>
            <button
              onClick={() => onDownload(persona)}
              className='p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
              title={t('personaCard.downloadTooltip')}
            >
              <Download className='h-4 w-4' />
            </button>

            {/* More menu */}
            <div className='relative'>
              <button
                onClick={() => setShowMenu(!showMenu)}
                className='p-2 rounded-lg text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
                title={t('common.more', { defaultValue: 'More' })}
              >
                <MoreHorizontal className='h-4 w-4' />
              </button>

              {showMenu && (
                <>
                  <div
                    className='fixed inset-0 z-10'
                    onClick={() => setShowMenu(false)}
                  />
                  <div className='absolute end-0 bottom-full z-20 mb-1 w-44 rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-white/10 dark:bg-dark-100'>
                    {hasAdvancedFeatures && (
                      <>
                        <button
                          onClick={handleBackupPersona}
                          disabled={isLoading}
                          className='w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-50 disabled:opacity-50'
                        >
                          <Archive className='h-4 w-4' />
                          {t('personaCard.backup')}
                        </button>
                        <button
                          onClick={handleExportDNA}
                          disabled={isLoading}
                          className='w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-50 disabled:opacity-50'
                        >
                          <FileDown className='h-4 w-4' />
                          {t('personaCard.exportDNA')}
                        </button>
                        {memoryStatus && memoryStatus.memory_count > 0 && (
                          <button
                            onClick={handleWipeMemories}
                            disabled={isLoading}
                            className='w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50'
                          >
                            <AlertTriangle className='h-4 w-4' />
                            {t('personaCard.wipeMemories')}
                          </button>
                        )}
                        <div className='my-1 border-t border-gray-100 dark:border-dark-200' />
                      </>
                    )}
                    <button
                      onClick={() => {
                        onDelete(persona);
                        setShowMenu(false);
                      }}
                      className='w-full flex items-center gap-2 px-3 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20'
                    >
                      <Trash2 className='h-4 w-4' />
                      {t('common.delete')}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export { PersonaCard };
export default PersonaCard;
