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

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { personaApi, embeddingApi } from '@/utils/api';
import {
  PersonaBindings,
  PersonaParameters,
  UpdatePersonaRequest,
  OllamaModel,
  EmbeddingModel,
} from '@/types';
import { Brain, Plug, Sliders, Sparkles, User } from 'lucide-react';
import toast from 'react-hot-toast';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import { DEFAULT_FORM_DATA } from '@/components/persona-form/defaults';
import { PersonaAdvancedTab } from '@/components/persona-form/PersonaAdvancedTab';
import { PersonaBasicTab } from '@/components/persona-form/PersonaBasicTab';
import { PersonaFormActions } from '@/components/persona-form/PersonaFormActions';
import { PersonaBindingsTab } from '@/components/persona-form/PersonaBindingsTab';
import { PersonaMemoryTab } from '@/components/persona-form/PersonaMemoryTab';
import { PersonaParametersTab } from '@/components/persona-form/PersonaParametersTab';
import type {
  ExtendedFormData,
  MemoryStatus,
  PersonaFormProps,
  PersonaFormTab,
} from '@/components/persona-form/types';

const logger = createLogger('components:persona-form');

const PersonaForm: React.FC<PersonaFormProps> = ({
  persona,
  onSubmit,
  onCancel,
}) => {
  const { preferences } = useAppStore();
  const { t } = useTranslation();
  const [formData, setFormData] = useState<ExtendedFormData>(DEFAULT_FORM_DATA);
  const chatModels = useChatStore(state => state.models);
  const loadChatModels = useChatStore(state => state.loadModels);
  // The chat store's list already merges Ollama and provider (plugin) models;
  // personas can back onto either — the backend routes plugin models by name.
  // Other personas and agent CLIs are not valid persona backends.
  const availableModels = useMemo<OllamaModel[]>(
    () =>
      chatModels.filter(
        model =>
          !model.isPersona &&
          !model.isAgent &&
          !model.isUnavailable &&
          !model.isLegacySelection
      ),
    [chatModels]
  );
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveAndClose, setSaveAndClose] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<PersonaFormTab>('basic');
  const [wipingMemories, setWipingMemories] = useState(false);
  const hasLoadedRef = useRef(false);

  const updateForm = useCallback(
    <K extends keyof ExtendedFormData>(key: K, value: ExtendedFormData[K]) => {
      setFormData(prev => ({ ...prev, [key]: value }));
      setLastSaved(null);
    },
    []
  );

  const updateParameter = useCallback(
    (key: keyof PersonaParameters, value: string | number) => {
      setFormData(prev => ({
        ...prev,
        parameters: { ...prev.parameters, [key]: value },
      }));
      setLastSaved(null);
    },
    []
  );

  const updateSettings = useCallback(
    <T extends 'memory_settings' | 'mutation_settings'>(
      settingsKey: T,
      updates: Partial<NonNullable<ExtendedFormData[T]>>
    ) => {
      setFormData(prev => ({
        ...prev,
        [settingsKey]: { ...prev[settingsKey]!, ...updates },
      }));
      setLastSaved(null);
    },
    []
  );

  const normalizeEmbeddingModels = useCallback((models: EmbeddingModel[]) => {
    const unique = models.reduce((acc: EmbeddingModel[], model) => {
      if (!acc.find(existing => existing.id === model.id)) {
        acc.push(model);
      }
      return acc;
    }, []);

    return unique.length > 0
      ? unique
      : [
          {
            id: 'nomic-embed-text',
            name: 'nomic-embed-text',
            description: 'Ollama - Default embedding model',
            provider: 'ollama' as const,
            dimensions: 0,
            isDetectedEmbedding: true,
          },
        ];
  }, []);

  const personaId = persona?.id;
  const memoryEnabled = !!formData.memory_settings?.enabled;
  const queryClient = useQueryClient();

  const { data: memoryStatus = null, isLoading: loadingMemoryStatus } =
    useQuery({
      queryKey: ['persona-memory-status', personaId],
      queryFn: async (): Promise<MemoryStatus | null> => {
        if (!personaId) return null;
        const response = await personaApi.getMemoryStatus(personaId);
        if (response.success && response.data) return response.data;
        return null;
      },
      enabled: !!personaId && memoryEnabled,
    });

  const reloadMemoryStatus = () =>
    queryClient.invalidateQueries({
      queryKey: ['persona-memory-status', personaId],
    });

  const handleWipeMemories = async () => {
    if (!persona?.id) return;
    if (!confirm(t('personaForm.memory.wipeConfirm'))) return;

    setWipingMemories(true);
    try {
      const response = await personaApi.wipeMemories(persona.id);
      if (response.success) {
        toast.success(
          t('personaForm.memory.wipeSuccess', {
            count: response.data?.deleted_count || 0,
          })
        );
        await reloadMemoryStatus();
      } else {
        toast.error(t('personaForm.error.saveFailed'));
      }
    } catch (_error) {
      toast.error(t('personaForm.error.saveFailed'));
    } finally {
      setWipingMemories(false);
    }
  };

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const initialize = async () => {
      setLoading(true);
      try {
        const [embeddingModelsResponse, defaultsResponse] = await Promise.all([
          embeddingApi.getModels(),
          !persona ? personaApi.getDefaultParameters() : Promise.resolve(null),
          useChatStore.getState().models.length === 0
            ? loadChatModels({ quiet: true })
            : Promise.resolve(),
        ]);

        const embModels = normalizeEmbeddingModels(
          embeddingModelsResponse.success && embeddingModelsResponse.data
            ? embeddingModelsResponse.data
            : []
        );
        setEmbeddingModels(embModels);
        const preferredEmbeddingModelId =
          embModels.find(
            model =>
              model.id === preferences.embeddingSettings?.model ||
              model.rawModel === preferences.embeddingSettings?.model
          )?.id ||
          embModels[0]?.id ||
          '';
        const selectedEmbeddingModelId =
          embModels.find(
            model =>
              model.id === persona?.embedding_model ||
              model.rawModel === persona?.embedding_model
          )?.id ||
          persona?.embedding_model ||
          embModels[0]?.id ||
          '';

        if (persona) {
          setFormData({
            name: persona.name,
            description: persona.description || '',
            model: persona.model,
            parameters: persona.parameters,
            avatar: persona.avatar || '',
            background: persona.background || '',
            embedding_model: selectedEmbeddingModelId,
            memory_settings:
              persona.memory_settings || DEFAULT_FORM_DATA.memory_settings,
            mutation_settings:
              persona.mutation_settings || DEFAULT_FORM_DATA.mutation_settings,
            bindings: persona.bindings,
          });

          if (
            persona.embedding_model &&
            !embModels.find(
              model =>
                model.id === persona.embedding_model ||
                model.rawModel === persona.embedding_model
            )
          ) {
            setEmbeddingModels(prev =>
              normalizeEmbeddingModels([
                ...prev,
                {
                  id: persona.embedding_model!,
                  name: persona.embedding_model!,
                  description:
                    'Previously selected model (not currently available)',
                  provider: 'openai' as const,
                  dimensions: 0,
                },
              ])
            );
          }
        } else {
          const defaults = defaultsResponse?.success
            ? defaultsResponse.data
            : {};
          setFormData(prev => ({
            ...prev,
            parameters: { ...prev.parameters, ...defaults },
            embedding_model: preferredEmbeddingModelId,
          }));
        }
      } catch (error) {
        logger.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    initialize();
  }, [
    persona,
    normalizeEmbeddingModels,
    loadChatModels,
    preferences.embeddingSettings?.model,
  ]);

  const handleSubmit = async (closeAfter: boolean) => {
    setSubmitting(true);
    setSaveAndClose(closeAfter);

    try {
      const payload: UpdatePersonaRequest = {
        name: formData.name,
        description: formData.description,
        model: formData.model,
        parameters: formData.parameters,
        avatar: formData.avatar,
        background: formData.background,
        embedding_model: formData.embedding_model,
        memory_settings: formData.memory_settings,
        mutation_settings: formData.mutation_settings,
        // Left out entirely when untouched: the backend only revalidates and
        // bumps the bindings revision when the field is present.
        bindings: formData.bindings,
      };

      const response = persona
        ? await personaApi.updatePersona(persona.id, payload)
        : await personaApi.createPersona(formData);

      if (response.success) {
        toast.success(
          persona
            ? t('personaForm.success.updated')
            : t('personaForm.success.created')
        );
        setLastSaved(new Date());
        if (closeAfter) onSubmit();
      } else {
        toast.error(`${t('personaForm.error.saveFailed')}: ${response.error}`);
      }
    } catch (error: unknown) {
      toast.error(
        `${t('personaForm.error.saveFailed')}: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      setSubmitting(false);
      setSaveAndClose(false);
    }
  };

  const tabs = useMemo(
    () => [
      { id: 'basic' as const, label: t('personaForm.tabs.basic'), icon: User },
      {
        id: 'parameters' as const,
        label: t('personaForm.tabs.parameters'),
        icon: Sliders,
      },
      {
        id: 'memory' as const,
        label: t('personaForm.tabs.memory'),
        icon: Sparkles,
      },
      {
        id: 'bindings' as const,
        label: t('personaForm.tabs.bindings'),
        icon: Plug,
      },
      {
        id: 'advanced' as const,
        label: t('personaForm.tabs.advanced'),
        icon: Brain,
      },
    ],
    [t]
  );

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='animate-pulse flex items-center gap-3'>
          <div className='w-5 h-5 border-2 border-primary-500 border-t-transparent rounded-full animate-spin' />
          <span className='text-gray-600 dark:text-gray-400'>
            {t('personaForm.loading')}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className='max-w-4xl mx-auto'>
      <div className='mb-6'>
        <h1 className='text-2xl font-bold text-gray-900 dark:text-dark-800'>
          {persona
            ? t('personaForm.title.edit')
            : t('personaForm.title.create')}
        </h1>
        <div className='flex items-center gap-4 mt-1'>
          <p className='text-gray-600 dark:text-dark-600'>
            {persona
              ? t('personaForm.subtitle.edit')
              : t('personaForm.subtitle.create')}
          </p>
          {lastSaved && (
            <div className='flex items-center gap-2 text-sm text-green-600 dark:text-green-400'>
              <div className='w-2 h-2 bg-green-500 rounded-full'></div>
              {t('personaForm.saved')} {lastSaved.toLocaleTimeString()}
            </div>
          )}
        </div>
      </div>

      <form onSubmit={e => e.preventDefault()} className='space-y-6'>
        <div className='bg-white dark:bg-dark-100 rounded-lg shadow-sm border border-gray-200 dark:border-dark-300'>
          <div className='flex border-b border-gray-200 dark:border-dark-300'>
            {tabs.map(tab => (
              <button
                key={tab.id}
                type='button'
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'flex items-center gap-2 px-6 py-4 text-sm font-medium transition-colors',
                  activeTab === tab.id
                    ? 'border-b-2 border-primary-500 text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20'
                    : 'text-gray-500 dark:text-dark-600 hover:text-gray-700 dark:hover:text-dark-800'
                )}
              >
                <tab.icon className='h-4 w-4' />
                {tab.label}
              </button>
            ))}
          </div>

          <div className='p-6'>
            {activeTab === 'basic' && (
              <PersonaBasicTab
                formData={formData}
                availableModels={availableModels}
                onFieldChange={updateForm}
                onParameterChange={updateParameter}
              />
            )}
            {activeTab === 'parameters' && (
              <PersonaParametersTab
                parameters={formData.parameters}
                onParameterChange={updateParameter}
              />
            )}
            {activeTab === 'memory' && (
              <PersonaMemoryTab
                formData={formData}
                persona={persona}
                memoryStatus={memoryStatus}
                loadingMemoryStatus={loadingMemoryStatus}
                wipingMemories={wipingMemories}
                onSettingsChange={updateSettings}
                onWipeMemories={handleWipeMemories}
              />
            )}
            {activeTab === 'bindings' && (
              <PersonaBindingsTab
                bindings={formData.bindings}
                onChange={(bindings: PersonaBindings) =>
                  updateForm('bindings', bindings)
                }
              />
            )}
            {activeTab === 'advanced' && (
              <PersonaAdvancedTab
                embeddingModel={formData.embedding_model}
                embeddingModels={embeddingModels}
                onEmbeddingModelChange={modelId =>
                  updateForm('embedding_model', modelId)
                }
              />
            )}
          </div>
        </div>

        <PersonaFormActions
          persona={persona}
          submitting={submitting}
          saveAndClose={saveAndClose}
          lastSaved={lastSaved}
          onCancel={onCancel}
          onSave={() => handleSubmit(false)}
          onSaveAndClose={() => handleSubmit(true)}
        />
      </form>
    </div>
  );
};

export { PersonaForm };
export default PersonaForm;
