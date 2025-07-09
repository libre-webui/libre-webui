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
import { Button } from '@/components/ui/Button';
import { personaApi, ollamaApi } from '@/utils/api';
import {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
  PersonaParameters,
  OllamaModel,
} from '@/types';
import toast from 'react-hot-toast';

interface PersonaFormProps {
  persona: Persona | null;
  onSubmit: () => void;
  onCancel: () => void;
}

const PersonaForm: React.FC<PersonaFormProps> = ({
  persona,
  onSubmit,
  onCancel,
}) => {
  const [formData, setFormData] = useState<CreatePersonaRequest>({
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
  });

  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Load available models and populate form if editing
  useEffect(() => {
    const loadData = async () => {
      setLoading(true);
      try {
        // Load available models
        const modelsResponse = await ollamaApi.getModels();
        if (modelsResponse.success) {
          setAvailableModels(modelsResponse.data || []);
        }

        // Load default parameters if creating new persona
        if (!persona) {
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
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
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
      });
    }
  }, [persona]);

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

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='text-gray-600 dark:text-dark-600'>Loading form...</div>
      </div>
    );
  }

  return (
    <div className='max-w-4xl mx-auto'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-800'>
          {persona ? 'Edit Persona' : 'Create New Persona'}
        </h1>
        <p className='text-gray-600 dark:text-dark-600 mt-1'>
          {persona
            ? 'Update your persona settings'
            : 'Create a new AI persona with custom personality and settings'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className='space-y-6'>
        {/* Basic Information */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            Basic Information
          </h3>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Name *
              </label>
              <input
                type='text'
                value={formData.name}
                onChange={e =>
                  setFormData(prev => ({ ...prev, name: e.target.value }))
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
                placeholder='Enter persona name'
                required
              />
            </div>

            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Model *
              </label>
              <select
                value={formData.model}
                onChange={e =>
                  setFormData(prev => ({ ...prev, model: e.target.value }))
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
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

          <div className='mt-4'>
            <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
              Description
            </label>
            <textarea
              value={formData.description}
              onChange={e =>
                setFormData(prev => ({ ...prev, description: e.target.value }))
              }
              className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
              rows={3}
              placeholder='Describe your persona...'
            />
          </div>
        </div>

        {/* Visual Settings */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            Visual Settings
          </h3>

          <div className='grid grid-cols-1 md:grid-cols-2 gap-4'>
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Avatar URL
              </label>
              <input
                type='url'
                value={formData.avatar}
                onChange={e =>
                  setFormData(prev => ({ ...prev, avatar: e.target.value }))
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
                placeholder='https://example.com/avatar.png'
              />
            </div>

            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Background Image URL
              </label>
              <input
                type='url'
                value={formData.background}
                onChange={e =>
                  setFormData(prev => ({ ...prev, background: e.target.value }))
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
                placeholder='https://example.com/background.png'
              />
            </div>
          </div>
        </div>

        {/* Model Parameters */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            Model Parameters
          </h3>

          <div className='grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4'>
            {/* Temperature */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Temperature ({formData.parameters.temperature})
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
                className='w-full'
              />
              <div className='flex justify-between text-xs text-gray-500 dark:text-dark-500 mt-1'>
                <span>Focused</span>
                <span>Creative</span>
              </div>
            </div>

            {/* Top P */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Top P ({formData.parameters.top_p})
              </label>
              <input
                type='range'
                min='0'
                max='1'
                step='0.1'
                value={formData.parameters.top_p}
                onChange={e =>
                  handleParameterChange('top_p', parseFloat(e.target.value))
                }
                className='w-full'
              />
              <div className='flex justify-between text-xs text-gray-500 dark:text-dark-500 mt-1'>
                <span>Precise</span>
                <span>Diverse</span>
              </div>
            </div>

            {/* Top K */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Top K ({formData.parameters.top_k})
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
                className='w-full'
              />
            </div>

            {/* Context Window */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Context Window
              </label>
              <input
                type='number'
                min='128'
                max='131072'
                value={formData.parameters.context_window}
                onChange={e =>
                  handleParameterChange(
                    'context_window',
                    parseInt(e.target.value)
                  )
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
              />
            </div>

            {/* Max Tokens */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Max Tokens
              </label>
              <input
                type='number'
                min='1'
                max='8192'
                value={formData.parameters.max_tokens}
                onChange={e =>
                  handleParameterChange('max_tokens', parseInt(e.target.value))
                }
                className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
              />
            </div>

            {/* Repeat Penalty */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-dark-700 mb-2'>
                Repeat Penalty ({formData.parameters.repeat_penalty})
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
                className='w-full'
              />
            </div>
          </div>
        </div>

        {/* System Prompt */}
        <div className='bg-white dark:bg-dark-100 rounded-lg p-6 shadow-sm border border-gray-200 dark:border-dark-300'>
          <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 mb-4'>
            System Prompt
          </h3>

          <textarea
            value={formData.parameters.system_prompt}
            onChange={e =>
              handleParameterChange('system_prompt', e.target.value)
            }
            className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-700'
            rows={6}
            placeholder='Enter the system prompt that defines your persona behavior...'
          />
          <p className='text-sm text-gray-500 dark:text-dark-500 mt-2'>
            The system prompt defines how your persona will behave and respond
            to users.
          </p>
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
