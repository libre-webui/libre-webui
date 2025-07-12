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

import React, { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/Button';
import { personaApi, ollamaApi } from '@/utils/api';
import {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
  PersonaParameters,
  OllamaModel,
  EmbeddingModel,
} from '@/types';
import { Brain, Database, Info, User, Sliders } from 'lucide-react';
import toast from 'react-hot-toast';

interface PersonaFormProps {
  persona: Persona | null;
  onSubmit: () => void;
  onCancel: () => void;
}

interface ExtendedFormData extends CreatePersonaRequest {
  embedding_model?: string;
  memory_settings?: {
    enabled: boolean;
    max_memories: number;
    auto_cleanup: boolean;
    retention_days: number;
  };
  mutation_settings?: {
    enabled: boolean;
    sensitivity: 'low' | 'medium' | 'high';
    auto_adapt: boolean;
  };
}

const PersonaForm: React.FC<PersonaFormProps> = ({
  persona,
  onSubmit,
  onCancel,
}) => {
  const [formData, setFormData] = useState<ExtendedFormData>({
    name: '',
    description: '',
    model: '',
    parameters: {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      context_window: 4096,
      max_tokens: 1024,
      system_prompt: '',
      repeat_penalty: 1.1,
      presence_penalty: 0.0,
      frequency_penalty: 0.0,
    },
    avatar: '',
    background: '',
    embedding_model: '',
    memory_settings: {
      enabled: false,
      max_memories: 1000,
      auto_cleanup: true,
      retention_days: 90,
    },
    mutation_settings: {
      enabled: false,
      sensitivity: 'medium',
      auto_adapt: true,
    },
  });

  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'basic' | 'parameters' | 'advanced'
  >('basic');
  const hasLoadedRef = useRef(false);

  // Load available models and populate form if editing
  useEffect(() => {
    if (hasLoadedRef.current) return;

    const loadData = async () => {
      setLoading(true);
      hasLoadedRef.current = true;
      try {
        // Load available models
        const modelsResponse = await ollamaApi.getModels();
        if (modelsResponse.success) {
          setAvailableModels(modelsResponse.data || []);

          // Filter embedding models from available Ollama models
          // Common embedding model patterns
          const embeddingPatterns = [
            'embed',
            'nomic',
            'bge',
            'gte',
            'multilingual',
            'sentence',
            'universal',
            'minilm',
          ];

          const ollamaEmbeddingModels: EmbeddingModel[] = (
            modelsResponse.data || []
          )
            .filter(model =>
              embeddingPatterns.some(pattern =>
                model.name.toLowerCase().includes(pattern.toLowerCase())
              )
            )
            .map(model => ({
              id: model.name, // Use full model name including tag
              name: model.name,
              description: `${model.details?.parameter_size || 'Unknown size'} - ${model.details?.family || 'Ollama model'}`,
              provider: 'ollama' as const,
              dimensions: 768, // Default dimensions, will be determined at runtime
            }))
            // Remove duplicates based on ID
            .reduce((unique: EmbeddingModel[], model) => {
              if (!unique.find((m: EmbeddingModel) => m.id === model.id)) {
                unique.push(model);
              }
              return unique;
            }, []);

          // Set embedding models from Ollama, with fallback to default options
          if (ollamaEmbeddingModels.length > 0) {
            setEmbeddingModels(ollamaEmbeddingModels);
          } else {
            // Fallback to hardcoded options if no embedding models found
            setEmbeddingModels([
              {
                id: 'nomic-embed-text',
                name: 'nomic-embed-text',
                description: 'Default embedding model (install if needed)',
                provider: 'ollama' as const,
                dimensions: 768,
              },
            ]);
          }
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, []); // Only run once on mount

  // Handle persona-specific embedding model logic
  useEffect(() => {
    if (persona && persona.embedding_model && embeddingModels.length > 0) {
      setEmbeddingModels(prevModels => {
        const savedModel = persona.embedding_model!;

        // Check if exact match exists
        const exactMatch = prevModels.some(model => model.id === savedModel);

        // Check if there's a model that matches without tag (e.g., "nomic-embed-text" vs "nomic-embed-text:latest")
        const baseModelName = savedModel.split(':')[0];
        const taggedMatch = prevModels.find(
          model =>
            model.id.startsWith(baseModelName + ':') ||
            model.id === baseModelName
        );

        if (exactMatch) {
          // Exact match found, no need to add anything
          return prevModels;
        } else if (taggedMatch) {
          // Found a tagged version, update the persona's form data to use the tagged version
          setFormData(prev => ({
            ...prev,
            embedding_model: taggedMatch.id,
          }));
          return prevModels;
        } else {
          // No match found, add the saved model as unavailable
          return [
            ...prevModels,
            {
              id: savedModel,
              name: savedModel,
              description:
                'Previously selected model (not currently installed)',
              provider: 'ollama' as const,
              dimensions: 768,
            },
          ];
        }
      });
    }
  }, [persona, embeddingModels]);

  // Load default parameters for new personas
  useEffect(() => {
    if (!persona) {
      const loadDefaults = async () => {
        try {
          const defaultsResponse = await personaApi.getDefaultParameters();
          if (defaultsResponse.success && defaultsResponse.data) {
            setFormData(prev => ({
              ...prev,
              parameters: {
                ...prev.parameters,
                ...defaultsResponse.data,
              },
            }));
          }
        } catch (error) {
          console.error('Error loading default parameters:', error);
        }
      };
      loadDefaults();
    }
  }, [persona]);

  // Populate form when editing
  useEffect(() => {
    if (persona) {
      setFormData({
        name: persona.name,
        description: persona.description || '',
        model: persona.model,
        parameters: persona.parameters,
        avatar: persona.avatar || '',
        background: persona.background || '',
        embedding_model: persona.embedding_model || '',
        memory_settings: persona.memory_settings || {
          enabled: false,
          max_memories: 1000,
          auto_cleanup: true,
          retention_days: 90,
        },
        mutation_settings: persona.mutation_settings || {
          enabled: false,
          sensitivity: 'medium',
          auto_adapt: true,
        },
      });
    }
  }, [persona]);

  // Set default embedding model when embedding models are loaded (for new personas only)
  useEffect(() => {
    if (embeddingModels.length > 0 && !formData.embedding_model && !persona) {
      updateFormData({ embedding_model: embeddingModels[0].id });
    }
  }, [embeddingModels, formData.embedding_model, persona]);

  // Set default embedding model for existing persona if it doesn't have one
  useEffect(() => {
    if (
      persona &&
      embeddingModels.length > 0 &&
      !persona.embedding_model &&
      !formData.embedding_model
    ) {
      updateFormData({ embedding_model: embeddingModels[0].id });
    }
  }, [persona, embeddingModels, formData.embedding_model]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      if (persona) {
        // Update existing persona
        const updateData: UpdatePersonaRequest = {
          name: formData.name,
          description: formData.description,
          model: formData.model,
          parameters: formData.parameters,
          avatar: formData.avatar,
          background: formData.background,
          embedding_model: formData.embedding_model,
          memory_settings: formData.memory_settings,
          mutation_settings: formData.mutation_settings,
        };

        const response = await personaApi.updatePersona(persona.id, updateData);
        if (response.success) {
          toast.success('Persona updated successfully');
          onSubmit();
        } else {
          toast.error('Failed to update persona: ' + response.error);
        }
      } else {
        // Create new persona
        const response = await personaApi.createPersona(formData);
        if (response.success) {
          toast.success('Persona created successfully');
          onSubmit();
        } else {
          toast.error('Failed to create persona: ' + response.error);
        }
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to save persona: ' + errorMessage);
    } finally {
      setSubmitting(false);
    }
  };

  const handleParameterChange = (
    key: keyof PersonaParameters,
    value: string | number
  ) => {
    setFormData(prev => ({
      ...prev,
      parameters: {
        ...prev.parameters,
        [key]: value,
      },
    }));
  };

  const updateFormData = (updates: Partial<ExtendedFormData>) => {
    setFormData(prev => ({ ...prev, ...updates }));
  };

  const updateMemorySettings = (
    updates: Partial<ExtendedFormData['memory_settings']>
  ) => {
    setFormData(prev => ({
      ...prev,
      memory_settings: { ...prev.memory_settings!, ...updates },
    }));
  };

  const updateMutationSettings = (
    updates: Partial<ExtendedFormData['mutation_settings']>
  ) => {
    setFormData(prev => ({
      ...prev,
      mutation_settings: { ...prev.mutation_settings!, ...updates },
    }));
  };

  // Helper function to calculate slider progress percentage
  const getSliderProgress = (
    value: number,
    min: number,
    max: number
  ): number => {
    return ((value - min) / (max - min)) * 100;
  };

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='text-gray-600 dark:text-gray-400'>Loading form...</div>
      </div>
    );
  }

  const tabs = [
    { id: 'basic', label: 'Basic Info', icon: User },
    { id: 'parameters', label: 'Parameters', icon: Sliders },
    { id: 'advanced', label: 'Advanced', icon: Brain },
  ];

  return (
    <div className='max-w-4xl mx-auto'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-800'>
          {persona ? 'Edit Persona' : 'Create New Persona'}
        </h1>
        <p className='text-gray-600 dark:text-dark-600 mt-1'>
          {persona
            ? 'Customize your AI persona with advanced memory, adaptive learning, and intelligent parameters'
            : 'Create a new AI persona with custom personality, memory systems, and adaptive learning capabilities'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-6'>
        {/* Tab Navigation */}
        <div className='bg-white dark:bg-dark-100 rounded-lg shadow-sm border border-gray-200 dark:border-dark-300'>
          <div className='flex border-b border-gray-200 dark:border-dark-300'>
            {tabs.map(tab => (
              <button
                key={tab.id}
                type='button'
                onClick={() =>
                  setActiveTab(tab.id as 'basic' | 'parameters' | 'advanced')
                }
                className={`flex items-center gap-2 px-6 py-4 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20'
                    : 'text-gray-500 dark:text-dark-600 hover:text-gray-700 dark:hover:text-dark-800'
                }`}
              >
                <tab.icon className='h-4 w-4' />
                {tab.label}
              </button>
            ))}
          </div>

          <div className='p-6'>
            {/* Basic Information Tab */}
            {activeTab === 'basic' && (
              <div className='space-y-6'>
                <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Name *
                    </label>
                    <input
                      type='text'
                      value={formData.name}
                      onChange={e => updateFormData({ name: e.target.value })}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                      placeholder='Enter persona name'
                      required
                    />
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Model *
                    </label>
                    <select
                      value={formData.model}
                      onChange={e => updateFormData({ model: e.target.value })}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                      required
                    >
                      <option value=''>Select a model</option>
                      {availableModels.map(model => (
                        <option key={model.name} value={model.name}>
                          {model.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                    Description
                  </label>
                  <textarea
                    value={formData.description}
                    onChange={e =>
                      updateFormData({ description: e.target.value })
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                    rows={3}
                    placeholder='Describe your persona...'
                  />
                </div>

                <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Avatar URL
                    </label>
                    <input
                      type='url'
                      value={formData.avatar}
                      onChange={e => updateFormData({ avatar: e.target.value })}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                      placeholder='https://example.com/avatar.jpg'
                    />
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Background URL
                    </label>
                    <input
                      type='url'
                      value={formData.background}
                      onChange={e =>
                        updateFormData({ background: e.target.value })
                      }
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                      placeholder='https://example.com/background.jpg'
                    />
                  </div>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                    System Prompt
                  </label>
                  <textarea
                    value={formData.parameters.system_prompt}
                    onChange={e =>
                      handleParameterChange('system_prompt', e.target.value)
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                    rows={6}
                    placeholder='Enter the system prompt that defines your persona behavior...'
                  />
                  <p className='text-sm text-gray-500 dark:text-dark-600 mt-2'>
                    The system prompt defines how your persona will behave and
                    respond to users.
                  </p>
                </div>
              </div>
            )}

            {/* Parameters Tab */}
            {activeTab === 'parameters' && (
              <div className='space-y-6'>
                <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Temperature: {formData.parameters.temperature?.toFixed(1)}
                    </label>
                    <input
                      type='range'
                      min='0'
                      max='2'
                      step='0.1'
                      value={formData.parameters.temperature}
                      onChange={e =>
                        handleParameterChange(
                          'temperature',
                          parseFloat(e.target.value)
                        )
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.temperature || 0.8, 0, 2)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Controls creativity vs consistency
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Top-P: {formData.parameters.top_p?.toFixed(1)}
                    </label>
                    <input
                      type='range'
                      min='0'
                      max='1'
                      step='0.1'
                      value={formData.parameters.top_p}
                      onChange={e =>
                        handleParameterChange(
                          'top_p',
                          parseFloat(e.target.value)
                        )
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.top_p || 0.9, 0, 1)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Controls response diversity
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Top-K: {formData.parameters.top_k}
                    </label>
                    <input
                      type='range'
                      min='1'
                      max='100'
                      step='1'
                      value={formData.parameters.top_k}
                      onChange={e =>
                        handleParameterChange('top_k', parseInt(e.target.value))
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.top_k || 40, 1, 100)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Limits vocabulary to top-k tokens
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Context Window: {formData.parameters.context_window}
                    </label>
                    <input
                      type='range'
                      min='128'
                      max='131072'
                      step='128'
                      value={formData.parameters.context_window}
                      onChange={e =>
                        handleParameterChange(
                          'context_window',
                          parseInt(e.target.value)
                        )
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.context_window || 4096, 128, 131072)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Maximum conversation history length
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Max Tokens: {formData.parameters.max_tokens}
                    </label>
                    <input
                      type='range'
                      min='1'
                      max='8192'
                      step='1'
                      value={formData.parameters.max_tokens}
                      onChange={e =>
                        handleParameterChange(
                          'max_tokens',
                          parseInt(e.target.value)
                        )
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.max_tokens || 1024, 1, 8192)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Maximum response length
                    </p>
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      Repeat Penalty:{' '}
                      {formData.parameters.repeat_penalty?.toFixed(1)}
                    </label>
                    <input
                      type='range'
                      min='0.5'
                      max='2'
                      step='0.1'
                      value={formData.parameters.repeat_penalty}
                      onChange={e =>
                        handleParameterChange(
                          'repeat_penalty',
                          parseFloat(e.target.value)
                        )
                      }
                      className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                      style={
                        {
                          '--progress': `${getSliderProgress(formData.parameters.repeat_penalty || 1.1, 0.5, 2)}%`,
                        } as React.CSSProperties
                      }
                    />
                    <p className='text-xs text-gray-500 dark:text-dark-600 mt-1'>
                      Reduces repetitive responses
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Advanced Tab */}
            {activeTab === 'advanced' && (
              <div className='space-y-8'>
                {/* Embedding Model Selection */}
                <div className='bg-primary-50 dark:bg-primary-900/20 rounded-lg p-6 border border-primary-200 dark:border-primary-800'>
                  <div className='flex items-center gap-3 mb-4'>
                    <Database className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                    <h3 className='text-lg font-semibold text-primary-900 dark:text-primary-100'>
                      Embedding Model
                    </h3>
                  </div>
                  <div>
                    <label className='block text-sm font-medium text-primary-700 dark:text-primary-300 mb-2'>
                      Embedding Model
                    </label>
                    <select
                      value={formData.embedding_model}
                      onChange={e =>
                        updateFormData({ embedding_model: e.target.value })
                      }
                      className='w-full px-3 py-2 border border-primary-300 dark:border-primary-600 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                    >
                      {embeddingModels.length === 0 ? (
                        <option value='' disabled>
                          No embedding models found - install one first
                        </option>
                      ) : (
                        embeddingModels.map(model => (
                          <option key={model.id} value={model.id}>
                            {model.name} - {model.description}
                          </option>
                        ))
                      )}
                    </select>
                    {embeddingModels.length === 0 ? (
                      <div className='mt-2 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md'>
                        <p className='text-sm text-yellow-800 dark:text-yellow-200'>
                          <strong>No embedding models detected.</strong> To
                          enable memory features, install an embedding model
                          like:
                        </p>
                        <code className='block mt-1 text-xs bg-yellow-100 dark:bg-yellow-900/30 p-1 rounded'>
                          ollama pull nomic-embed-text
                        </code>
                      </div>
                    ) : (
                      <p className='text-xs text-primary-600 dark:text-primary-400 mt-1'>
                        Choose from available Ollama embedding models for memory
                        encoding and semantic search. Models are automatically
                        detected from your Ollama installation.
                      </p>
                    )}
                  </div>
                </div>

                {/* Memory Settings */}
                <div className='bg-green-50 dark:bg-green-900/20 rounded-lg p-6 border border-green-200 dark:border-green-800'>
                  <div className='flex items-center gap-3 mb-4'>
                    <Database className='h-5 w-5 text-green-600 dark:text-green-400' />
                    <h3 className='text-lg font-semibold text-green-900 dark:text-green-100'>
                      Memory System
                    </h3>
                  </div>

                  <div className='space-y-4'>
                    <div className='flex items-center gap-3'>
                      <input
                        type='checkbox'
                        checked={formData.memory_settings?.enabled}
                        onChange={e =>
                          updateMemorySettings({ enabled: e.target.checked })
                        }
                        className='rounded'
                      />
                      <label className='text-sm font-medium text-green-700 dark:text-green-300'>
                        Enable Memory System
                      </label>
                    </div>

                    {formData.memory_settings?.enabled && (
                      <>
                        <div>
                          <label className='block text-sm font-medium text-green-700 dark:text-green-300 mb-2'>
                            Max Memories:{' '}
                            {formData.memory_settings.max_memories}
                          </label>
                          <input
                            type='range'
                            min='100'
                            max='10000'
                            step='100'
                            value={formData.memory_settings.max_memories}
                            onChange={e =>
                              updateMemorySettings({
                                max_memories: parseInt(e.target.value),
                              })
                            }
                            className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                            style={
                              {
                                '--progress': `${getSliderProgress(formData.memory_settings.max_memories, 100, 10000)}%`,
                              } as React.CSSProperties
                            }
                          />
                          <p className='text-xs text-green-600 dark:text-green-400 mt-1'>
                            Maximum number of memories to store
                          </p>
                        </div>

                        <div>
                          <label className='block text-sm font-medium text-green-700 dark:text-green-300 mb-2'>
                            Retention Days:{' '}
                            {formData.memory_settings.retention_days}
                          </label>
                          <input
                            type='range'
                            min='7'
                            max='365'
                            step='7'
                            value={formData.memory_settings.retention_days}
                            onChange={e =>
                              updateMemorySettings({
                                retention_days: parseInt(e.target.value),
                              })
                            }
                            className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
                            style={
                              {
                                '--progress': `${getSliderProgress(formData.memory_settings.retention_days, 7, 365)}%`,
                              } as React.CSSProperties
                            }
                          />
                          <p className='text-xs text-green-600 dark:text-green-400 mt-1'>
                            How long to keep memories before automatic cleanup
                          </p>
                        </div>

                        <div className='flex items-center gap-3'>
                          <input
                            type='checkbox'
                            checked={formData.memory_settings.auto_cleanup}
                            onChange={e =>
                              updateMemorySettings({
                                auto_cleanup: e.target.checked,
                              })
                            }
                            className='rounded'
                          />
                          <label className='text-sm font-medium text-green-700 dark:text-green-300'>
                            Auto-cleanup old memories
                          </label>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* Mutation Settings */}
                <div className='bg-primary-50 dark:bg-primary-900/20 rounded-lg p-6 border border-primary-200 dark:border-primary-800'>
                  <div className='flex items-center gap-3 mb-4'>
                    <Brain className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                    <h3 className='text-lg font-semibold text-primary-900 dark:text-primary-100'>
                      Adaptive Learning
                    </h3>
                  </div>

                  <div className='space-y-4'>
                    <div className='flex items-center gap-3'>
                      <input
                        type='checkbox'
                        checked={formData.mutation_settings?.enabled}
                        onChange={e =>
                          updateMutationSettings({ enabled: e.target.checked })
                        }
                        className='rounded'
                      />
                      <label className='text-sm font-medium text-primary-700 dark:text-primary-300'>
                        Enable Adaptive Learning
                      </label>
                    </div>

                    {formData.mutation_settings?.enabled && (
                      <>
                        <div>
                          <label className='block text-sm font-medium text-primary-700 dark:text-primary-300 mb-2'>
                            Learning Sensitivity
                          </label>
                          <select
                            value={formData.mutation_settings.sensitivity}
                            onChange={e =>
                              updateMutationSettings({
                                sensitivity: e.target.value as
                                  | 'low'
                                  | 'medium'
                                  | 'high',
                              })
                            }
                            className='w-full px-3 py-2 border border-primary-300 dark:border-primary-600 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
                          >
                            <option value='low'>
                              Low - Minimal adaptation
                            </option>
                            <option value='medium'>
                              Medium - Balanced adaptation
                            </option>
                            <option value='high'>
                              High - Rapid adaptation
                            </option>
                          </select>
                          <p className='text-xs text-primary-600 dark:text-primary-400 mt-1'>
                            How quickly the persona adapts to user preferences
                          </p>
                        </div>

                        <div className='flex items-center gap-3'>
                          <input
                            type='checkbox'
                            checked={formData.mutation_settings.auto_adapt}
                            onChange={e =>
                              updateMutationSettings({
                                auto_adapt: e.target.checked,
                              })
                            }
                            className='rounded'
                          />
                          <label className='text-sm font-medium text-primary-700 dark:text-primary-300'>
                            Auto-adapt to user preferences
                          </label>
                        </div>

                        <div className='bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4'>
                          <div className='flex items-start gap-3'>
                            <Info className='h-4 w-4 text-yellow-600 mt-0.5' />
                            <div className='text-sm text-yellow-800 dark:text-yellow-300'>
                              <p className='font-medium mb-1'>
                                Learning Capabilities:
                              </p>
                              <ul className='text-xs space-y-1'>
                                <li>
                                  • Mood adjustments based on conversation tone
                                </li>
                                <li>
                                  • Learning user communication preferences
                                </li>
                                <li>• Adapting response style and length</li>
                                <li>• Building contextual understanding</li>
                              </ul>
                            </div>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Form Actions */}
        <div className='flex justify-end gap-4'>
          <Button
            type='button'
            variant='outline'
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button type='submit' disabled={submitting}>
            {submitting
              ? 'Saving...'
              : persona
                ? 'Update Persona'
                : 'Create Persona'}
          </Button>
        </div>
      </form>
    </div>
  );
};

export { PersonaForm };
export default PersonaForm;
