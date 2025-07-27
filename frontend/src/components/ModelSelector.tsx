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
import {
  ChevronDown,
  User,
  Brain,
  Cpu,
  Plug,
  Check,
  Sparkles,
  Server,
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
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  models,
  selectedModel,
  onModelChange,
  currentPersona,
  className,
  disabled = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Group models by type
  const groupedModels: ModelGroup[] = [
    {
      type: 'personas' as const,
      label: 'Personas',
      icon: <User className='h-4 w-4' />,
      models: models.filter(model => model.isPersona),
      color: 'purple',
    },
    {
      type: 'ollama' as const,
      label: 'Ollama Models',
      icon: <Server className='h-4 w-4' />,
      models: models.filter(model => !model.isPersona && !model.isPlugin),
      color: 'blue',
    },
    {
      type: 'plugins' as const,
      label: 'Plugin Models',
      icon: <Plug className='h-4 w-4' />,
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
      return <Plug className='h-4 w-4 text-green-600 dark:text-green-400' />;
    }
    return <Server className='h-4 w-4 text-blue-600 dark:text-blue-400' />;
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

  const getGroupColor = (type: string) => {
    switch (type) {
      case 'personas':
        return 'border-purple-200 dark:border-purple-800 bg-purple-50 dark:bg-purple-900/20';
      case 'plugins':
        return 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20';
      default:
        return 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20';
    }
  };

  const getCurrentModelDisplay = () => {
    if (!currentModel) return 'Select Model';

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
          'w-full flex items-center justify-between gap-2 px-3 py-2 text-left',
          'bg-gray-50 dark:bg-dark-200 border border-gray-200 dark:border-dark-300',
          'rounded-lg text-sm transition-all duration-200',
          'hover:bg-gray-100 dark:hover:bg-dark-100',
          'focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500',
          disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        )}
      >
        {getCurrentModelDisplay()}
        <ChevronDown
          className={cn(
            'h-4 w-4 text-gray-400 transition-transform duration-200',
            isOpen && 'rotate-180'
          )}
        />
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <div className='absolute top-full left-0 right-0 mt-1 z-50 animate-slide-up'>
          <div className='bg-white dark:bg-dark-100 border border-gray-200 dark:border-dark-300 rounded-lg shadow-card dark:shadow-lg max-h-96 overflow-hidden backdrop-blur-sm'>
            {/* Search Input */}
            <div className='p-3 border-b border-gray-100 dark:border-dark-200'>
              <input
                ref={searchInputRef}
                type='text'
                placeholder='Search models...'
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className='w-full px-3 py-2 text-sm bg-gray-50 dark:bg-dark-200 border border-gray-200 dark:border-dark-300 rounded-md focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-all duration-200'
              />
            </div>

            {/* Model Groups */}
            <div className='max-h-80 overflow-y-auto'>
              {filteredGroups.length > 0 ? (
                filteredGroups.map(group => (
                  <div key={group.type} className='py-2'>
                    {/* Group Header */}
                    <div
                      className={cn(
                        'flex items-center gap-2 px-3 py-2 text-xs font-semibold uppercase tracking-wide',
                        'text-gray-500 dark:text-gray-400 border-l-2 mx-2 mb-1',
                        getGroupColor(group.type)
                      )}
                    >
                      {group.icon}
                      {group.label}
                      <span className='ml-auto text-xs bg-gray-200 dark:bg-dark-300 px-2 py-0.5 rounded-full'>
                        {group.models.length}
                      </span>
                    </div>

                    {/* Group Models */}
                    {group.models.map(model => (
                      <button
                        key={model.name}
                        onClick={() => handleModelSelect(model.name)}
                        className={cn(
                          'w-full flex items-center gap-3 px-4 py-2.5 text-left hover:bg-gray-50 dark:hover:bg-dark-200 transition-colors',
                          (selectedModel === model.name ||
                            (selectedModel.startsWith('persona:') &&
                              model.name === selectedModel)) &&
                            'bg-primary-50 dark:bg-primary-900/20 border-r-2 border-primary-500'
                        )}
                      >
                        {getModelIcon(model)}

                        <div className='flex-1 min-w-0'>
                          <div className='flex items-center gap-2'>
                            <span className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                              {getModelLabel(model)}
                            </span>
                            {model.isPersona && (
                              <div className='flex items-center gap-1'>
                                <Brain className='h-3 w-3 text-purple-600 dark:text-purple-400' />
                                {/* Check if persona has advanced features */}
                                <Sparkles className='h-3 w-3 text-purple-500 dark:text-purple-300' />
                              </div>
                            )}
                          </div>
                          {getModelSubLabel(model) && (
                            <span className='text-xs text-gray-500 dark:text-gray-400 truncate'>
                              {getModelSubLabel(model)}
                            </span>
                          )}
                          {model.personaDescription && (
                            <span className='text-xs text-gray-400 dark:text-gray-500 truncate mt-0.5 block'>
                              {model.personaDescription}
                            </span>
                          )}
                        </div>

                        {(selectedModel === model.name ||
                          (selectedModel.startsWith('persona:') &&
                            model.name === selectedModel)) && (
                          <Check className='h-4 w-4 text-primary-600 dark:text-primary-400 flex-shrink-0' />
                        )}
                      </button>
                    ))}
                  </div>
                ))
              ) : (
                <div className='px-4 py-8 text-center text-gray-500 dark:text-gray-400'>
                  <div className='flex flex-col items-center gap-2'>
                    <Cpu className='h-8 w-8 text-gray-300 dark:text-gray-600' />
                    <p className='text-sm'>No models found</p>
                    {searchTerm && (
                      <p className='text-xs'>Try adjusting your search</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
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
