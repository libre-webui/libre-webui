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
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown,
  User,
  Brain,
  Cpu,
  Check,
  Sparkles,
  Bot,
  Zap,
  ImageIcon,
  Plus,
} from 'lucide-react';
import { cn } from '@/utils';
import { OllamaModel, Persona } from '@/types';

interface ModelGroup {
  type: 'personas' | 'ollama' | 'plugins';
  label: string;
  icon: React.ReactNode;
  models: OllamaModel[];
  color: string;
}

interface ModelSelectorProps {
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  currentPersona?: Persona | null;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
  showImageGen?: boolean;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  selectedModel,
  onModelChange,
  currentPersona,
  className,
  disabled = false,
  compact = false,
  showImageGen = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Group models by type
  const groupedModels: ModelGroup[] = [
    {
      type: 'personas' as const,
      label: 'Personas',
      icon: (
        <User className='h-4 w-4 text-purple-600 dark:text-purple-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => model.isPersona),
      color: 'purple',
    },
    {
      type: 'ollama' as const,
      label: 'Ollama Models',
      icon: (
        <Bot className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => !model.isPersona && !model.isPlugin),
      color: 'green',
    },
    {
      type: 'plugins' as const,
      label: 'Plugin Models',
      icon: (
        <Zap className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      ),
      models: models.filter(model => model.isPlugin),
      color: 'green',
    },
  ].filter(group => group.models.length > 0);

  // Filter models based on search term
  const filteredGroups = groupedModels
    .map(group => ({
      ...group,
      models: group.models.filter(
        model =>
          model.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          (model.personaName &&
            model.personaName
              .toLowerCase()
              .includes(searchTerm.toLowerCase())) ||
          (model.pluginName &&
            model.pluginName.toLowerCase().includes(searchTerm.toLowerCase()))
      ),
    }))
    .filter(group => group.models.length > 0);

  // Find current model info
  const currentModel = models.find(
    m =>
      m.name === selectedModel ||
      (selectedModel.startsWith('persona:') && m.name === selectedModel)
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(event.target as Node)
      ) {
        setIsOpen(false);
        setSearchTerm('');
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus search input when dropdown opens
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isOpen]);

  const handleModelSelect = (modelName: string) => {
    const syntheticEvent = {
      target: { value: modelName },
    } as React.ChangeEvent<HTMLSelectElement>;

    onModelChange(syntheticEvent);
    setIsOpen(false);
    setSearchTerm('');
  };

  const getModelIcon = (model: OllamaModel) => {
    if (model.isPersona) {
      return <User className='h-4 w-4 text-purple-600 dark:text-purple-400' />;
    }
    if (model.isPlugin) {
      return (
        <Zap className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
      );
    }
    return (
      <Bot className='h-4 w-4 text-green-600 dark:text-green-400 ophelia:text-[#a855f7]' />
    );
  };

  const getModelLabel = (model: OllamaModel) => {
    if (model.isPersona) {
      return model.personaName || model.name;
    }
    if (model.isPlugin) {
      return `${model.name}`;
    }
    return model.name;
  };

  const getModelSubLabel = (model: OllamaModel) => {
    if (model.isPersona) {
      return `via ${model.model}`;
    }
    if (model.isPlugin) {
      return `via ${model.pluginName}`;
    }
    return null;
  };

  const getCurrentModelDisplay = () => {
    if (!currentModel) {
      return compact ? (
        <div className='flex items-center gap-2 min-w-0'>
          <Bot className='h-4 w-4' />
          <span className='text-xs font-medium text-gray-400 dark:text-gray-500 truncate'>
            Select Model
          </span>
        </div>
      ) : (
        'Select Model'
      );
    }

    if (compact) {
      const modelName = getModelLabel(currentModel);

      return (
        <div className='flex items-center gap-2 min-w-0'>
          {getModelIcon(currentModel)}
          <span className='text-xs font-medium text-gray-700 dark:text-gray-200 ophelia:text-[#e5e5e5] truncate'>
            {modelName}
          </span>
        </div>
      );
    }

    const label = getModelLabel(currentModel);
    const subLabel = getModelSubLabel(currentModel);

    return (
      <div className='flex items-center gap-2 min-w-0'>
        {getModelIcon(currentModel)}
        <div className='flex flex-col min-w-0'>
          <span className='text-sm font-medium truncate'>{label}</span>
          {subLabel && (
            <span className='text-xs text-gray-500 dark:text-gray-400 truncate'>
              {subLabel}
            </span>
          )}
        </div>
        {currentModel.isPersona && currentPersona && (
          <div className='flex items-center gap-1 ml-auto'>
            <Brain className='h-3 w-3 text-purple-600 dark:text-purple-400' />
            {currentPersona.embedding_model && (
              <Sparkles className='h-3 w-3 text-purple-500 dark:text-purple-300' />
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className={cn('relative', className)} ref={dropdownRef}>
      {/* Custom Select Button */}
      <button
        type='button'
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className={cn(
          compact
            ? 'h-[44px] sm:h-[52px] px-3 flex items-center justify-between text-left w-full '
            : 'w-full flex items-center justify-between gap-2 px-3 py-2 text-left ',
          'bg-gray-50 dark:bg-dark-200 ophelia:bg-[#121212] border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
          'rounded-lg text-sm hover:bg-gray-100 dark:hover:bg-dark-100 ophelia:hover:bg-[#1a1a1a]',
          'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20 focus:border-primary-500 ophelia:focus:border-[#9333ea]',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
        title={
          compact
            ? currentModel
              ? getModelLabel(currentModel)
              : 'Select Model'
            : undefined
        }
      >
        {getCurrentModelDisplay()}
        <ChevronDown
          className={cn(
            compact ? 'h-3 w-3' : 'h-4 w-4',
            'text-gray-400 flex-shrink-0',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {/* Portal Dropdown */}
      {isOpen &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-start sm:items-center justify-center p-2 sm:p-4'>
            {/* Background overlay */}
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setIsOpen(false)}
            />

            {/* Dropdown */}
            <div
              className={cn(
                'relative bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] border border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a] shadow-2xl',
                'w-full max-w-sm sm:w-96 sm:max-w-[90vw]',
                'mt-2 sm:mt-0 rounded-xl sm:rounded-xl',
                'max-h-[85vh] sm:max-h-none flex flex-col'
              )}
              onClick={e => e.stopPropagation()}
            >
              {/* Search */}
              <div className='p-3 sm:p-4 border-b border-gray-200 dark:border-dark-200 ophelia:border-[#1a1a1a] flex-shrink-0'>
                <input
                  ref={searchInputRef}
                  type='text'
                  placeholder='Search models...'
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  onClick={e => e.stopPropagation()}
                  onMouseDown={e => e.stopPropagation()}
                  className={cn(
                    'w-full px-3 py-2.5 sm:py-2 text-sm bg-gray-50 dark:bg-dark-200 ophelia:bg-[#121212] ophelia:text-[#fafafa] ophelia:placeholder-[#737373]',
                    'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626] rounded-lg',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20 focus:border-primary-500 ophelia:focus:border-[#9333ea]',
                    'touch-manipulation'
                  )}
                />
              </div>

              {/* Models List */}
              <div className='flex-1 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-dark-400 max-h-80 sm:max-h-80'>
                {filteredGroups.length > 0 ? (
                  filteredGroups.map(group => (
                    <div key={group.type}>
                      {/* Group Header */}
                      <div className='px-3 sm:px-3 py-2.5 sm:py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] bg-gray-100 dark:bg-dark-300 ophelia:bg-[#0a0a0a] border-b border-gray-200 dark:border-dark-400 ophelia:border-[#1a1a1a] sticky top-0'>
                        <div className='flex items-center gap-2'>
                          {group.icon}
                          {group.label} ({group.models.length})
                        </div>
                      </div>

                      {/* Models */}
                      {group.models.map(model => (
                        <div
                          key={model.name}
                          onMouseDown={e => {
                            e.preventDefault();
                            handleModelSelect(model.name);
                          }}
                          onTouchStart={e => {
                            e.preventDefault();
                            handleModelSelect(model.name);
                          }}
                          className={cn(
                            'px-3 sm:px-4 py-3.5 sm:py-3 cursor-pointer border-b border-gray-100 dark:border-dark-200 ophelia:border-[#1a1a1a] last:border-b-0',
                            'hover:bg-gray-50 dark:hover:bg-dark-200 ophelia:hover:bg-[#121212] active:bg-gray-100 dark:active:bg-dark-100 ophelia:active:bg-[#1a1a1a]',
                            'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] touch-manipulation',
                            'transition-colors duration-150 ease-in-out',
                            (selectedModel === model.name ||
                              (selectedModel.startsWith('persona:') &&
                                model.name === selectedModel)) &&
                              'bg-primary-50 dark:bg-primary-900 ophelia:bg-[rgba(147,51,234,0.15)] border-l-4 border-primary-500 ophelia:border-l-[#9333ea]'
                          )}
                        >
                          <div className='flex items-center gap-3'>
                            {getModelIcon(model)}
                            <div className='flex-1 min-w-0'>
                              <div className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] truncate'>
                                {getModelLabel(model)}
                              </div>
                              {getModelSubLabel(model) && (
                                <div className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373] truncate'>
                                  {getModelSubLabel(model)}
                                </div>
                              )}
                            </div>
                            {(selectedModel === model.name ||
                              (selectedModel.startsWith('persona:') &&
                                model.name === selectedModel)) && (
                              <Check className='h-4 w-4 text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7] flex-shrink-0' />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ))
                ) : (
                  <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400 ophelia:text-[#737373] bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]'>
                    <Cpu className='h-8 w-8 mx-auto mb-2 text-gray-300 dark:text-gray-600 ophelia:text-[#525252]' />
                    <p className='text-sm'>No models found</p>
                  </div>
                )}

                {/* Image Generation Action */}
                {showImageGen && (
                  <div className='border-t border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'>
                    <div className='px-3 sm:px-3 py-2.5 sm:py-2 text-xs font-semibold text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3] bg-gray-100 dark:bg-dark-300 ophelia:bg-[#0a0a0a] border-b border-gray-200 dark:border-dark-400 ophelia:border-[#1a1a1a]'>
                      <div className='flex items-center gap-2'>
                        <Plus className='h-4 w-4 text-blue-600 dark:text-blue-400 ophelia:text-[#a855f7]' />
                        Actions
                      </div>
                    </div>
                    <div
                      onMouseDown={e => {
                        e.preventDefault();
                        setIsOpen(false);
                        navigate('/gallery');
                      }}
                      onTouchStart={e => {
                        e.preventDefault();
                        setIsOpen(false);
                        navigate('/gallery');
                      }}
                      className={cn(
                        'px-3 sm:px-4 py-3.5 sm:py-3 cursor-pointer',
                        'hover:bg-blue-50 dark:hover:bg-blue-900/20 ophelia:hover:bg-[rgba(147,51,234,0.1)]',
                        'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a] touch-manipulation',
                        'transition-colors duration-150 ease-in-out'
                      )}
                    >
                      <div className='flex items-center gap-3'>
                        <ImageIcon className='h-4 w-4 text-blue-600 dark:text-blue-400 ophelia:text-[#a855f7]' />
                        <div className='flex-1 min-w-0'>
                          <div className='text-sm font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                            Generate Image
                          </div>
                          <div className='text-xs text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                            Create images with AI
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Hidden select for form compatibility */}
      <select
        value={selectedModel}
        onChange={onModelChange}
        className='sr-only'
        tabIndex={-1}
      >
        {models.map(model => (
          <option key={model.name} value={model.name}>
            {getModelLabel(model)}
          </option>
        ))}
      </select>
    </div>
  );
};

export default ModelSelector;
