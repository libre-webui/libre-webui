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
import { useTranslation } from 'react-i18next';
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
import {
  Brain,
  Database,
  Info,
  User,
  Sliders,
  Check,
  Sparkles,
  Trash2,
  HardDrive,
  Clock,
  TrendingUp,
  Zap,
  RefreshCw,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { AvatarUpload } from '@/components/AvatarUpload';
import { PersonaBackgroundUpload } from '@/components/PersonaBackgroundUpload';
import { cn } from '@/utils';

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

// Reusable slider component to eliminate duplication
interface ParameterSliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  hint?: string;
  format?: (value: number) => string;
  colorClass?: string;
}

const ParameterSlider: React.FC<ParameterSliderProps> = ({
  label,
  value,
  min,
  max,
  step,
  onChange,
  hint,
  format = v => String(v),
  colorClass = 'text-gray-700 dark:text-dark-600',
}) => {
  const progress = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <label className={cn('block text-sm font-medium mb-2', colorClass)}>
        {label}: {format(value)}
      </label>
      <input
        type='range'
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className='w-full h-2 bg-gray-200 dark:bg-dark-200 rounded-lg appearance-none cursor-pointer slider'
        style={{ '--progress': `${progress}%` } as React.CSSProperties}
      />
      {hint && (
        <p
          className={cn(
            'text-xs mt-1',
            colorClass.replace('700', '500').replace('600', '400')
          )}
        >
          {hint}
        </p>
      )}
    </div>
  );
};

// Reusable toggle switch component
interface ToggleSwitchProps {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  colorClass?: string;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  label,
  checked,
  onChange,
  colorClass = 'text-gray-700 dark:text-dark-600',
}) => (
  <label className='flex items-center gap-3 cursor-pointer'>
    <div
      className={cn(
        'relative w-10 h-5 rounded-full transition-colors',
        checked
          ? 'bg-primary-500 dark:bg-primary-600'
          : 'bg-gray-300 dark:bg-dark-300'
      )}
      onClick={() => onChange(!checked)}
    >
      <div
        className={cn(
          'absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform',
          checked && 'translate-x-5'
        )}
      />
    </div>
    <span className={cn('text-sm font-medium', colorClass)}>{label}</span>
  </label>
);

// Default form values
const DEFAULT_FORM_DATA: ExtendedFormData = {
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
};

// Embedding model patterns for detection - expanded to catch more embedding models
const EMBEDDING_PATTERNS = [
  'embed', // Catches most embedding models (mxbai-embed, nomic-embed, snowflake-arctic-embed, etc.)
  'e5', // Microsoft E5 models
  'bge', // BGE models
  'gte', // GTE models
  'minilm', // MiniLM models
  'multilingual',
  'sentence',
  'universal',
  'instructor', // Instructor embedding models
  'jina', // Jina embedding models
  'paraphrase', // Paraphrase models
  'mpnet', // MPNet models
  'contriever', // Contriever models
];

// Memory status interface
interface MemoryStatus {
  status: 'active' | 'wiped' | 'backed_up';
  memory_count: number;
  last_backup?: number;
  size_mb: number;
}

const PersonaForm: React.FC<PersonaFormProps> = ({
  persona,
  onSubmit,
  onCancel,
}) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState<ExtendedFormData>(DEFAULT_FORM_DATA);
  const [availableModels, setAvailableModels] = useState<OllamaModel[]>([]);
  const [embeddingModels, setEmbeddingModels] = useState<EmbeddingModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [saveAndClose, setSaveAndClose] = useState(false);
  const [lastSaved, setLastSaved] = useState<Date | null>(null);
  const [activeTab, setActiveTab] = useState<
    'basic' | 'parameters' | 'memory' | 'advanced'
  >('basic');
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [loadingMemoryStatus, setLoadingMemoryStatus] = useState(false);
  const [wipingMemories, setWipingMemories] = useState(false);
  const hasLoadedRef = useRef(false);

  // Generic update function that clears lastSaved indicator
  const updateForm = useCallback(
    <K extends keyof ExtendedFormData>(key: K, value: ExtendedFormData[K]) => {
      setFormData(prev => ({ ...prev, [key]: value }));
      setLastSaved(null);
    },
    []
  );

  // Update nested parameter
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

  // Update nested settings (memory or mutation)
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

  // Extract embedding models from Ollama models
  // Shows detected embedding models first, then all other models as alternatives
  const extractEmbeddingModels = useCallback(
    (models: OllamaModel[]): EmbeddingModel[] => {
      // First, find models that match embedding patterns
      const detectedEmbedding = models
        .filter(model =>
          EMBEDDING_PATTERNS.some(pattern =>
            model.name.toLowerCase().includes(pattern.toLowerCase())
          )
        )
        .map(model => ({
          id: model.name,
          name: model.name,
          description: `${model.details?.parameter_size || 'Unknown size'} - ${model.details?.family || 'Ollama model'}`,
          provider: 'ollama' as const,
          dimensions: 768,
          isDetectedEmbedding: true,
        }));

      // Then add all other models as potential alternatives (some embedding models might not match patterns)
      const otherModels = models
        .filter(
          model =>
            !EMBEDDING_PATTERNS.some(pattern =>
              model.name.toLowerCase().includes(pattern.toLowerCase())
            )
        )
        .map(model => ({
          id: model.name,
          name: model.name,
          description: `${model.details?.parameter_size || 'Unknown size'} - ${model.details?.family || 'Other model'}`,
          provider: 'ollama' as const,
          dimensions: 768,
          isDetectedEmbedding: false,
        }));

      // Combine: detected embedding models first, then others
      const allModels = [...detectedEmbedding, ...otherModels];

      // Remove duplicates
      const unique = allModels.reduce((acc: EmbeddingModel[], model) => {
        if (!acc.find(m => m.id === model.id)) acc.push(model);
        return acc;
      }, []);

      return unique.length > 0
        ? unique
        : [
            {
              id: 'nomic-embed-text',
              name: 'nomic-embed-text',
              description: 'Default embedding model (install if needed)',
              provider: 'ollama' as const,
              dimensions: 768,
            },
          ];
    },
    []
  );

  // Load memory status for existing persona
  const loadMemoryStatus = useCallback(async () => {
    if (!persona?.id) return;
    setLoadingMemoryStatus(true);
    try {
      const response = await personaApi.getMemoryStatus(persona.id);
      if (response.success && response.data) {
        setMemoryStatus(response.data);
      }
    } catch (error) {
      console.error('Failed to load memory status:', error);
    } finally {
      setLoadingMemoryStatus(false);
    }
  }, [persona?.id]);

  // Wipe all memories for persona
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
        await loadMemoryStatus();
      } else {
        toast.error(t('personaForm.error.saveFailed'));
      }
    } catch (_error) {
      toast.error(t('personaForm.error.saveFailed'));
    } finally {
      setWipingMemories(false);
    }
  };

  // Single consolidated initialization effect
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;

    const initialize = async () => {
      setLoading(true);
      try {
        // Load models and default parameters in parallel
        const [modelsResponse, defaultsResponse] = await Promise.all([
          ollamaApi.getModels(),
          !persona ? personaApi.getDefaultParameters() : Promise.resolve(null),
        ]);

        if (modelsResponse.success && modelsResponse.data) {
          setAvailableModels(modelsResponse.data);
          const embModels = extractEmbeddingModels(modelsResponse.data);
          setEmbeddingModels(embModels);

          // Set initial form data
          if (persona) {
            // Editing existing persona
            setFormData({
              name: persona.name,
              description: persona.description || '',
              model: persona.model,
              parameters: persona.parameters,
              avatar: persona.avatar || '',
              background: persona.background || '',
              embedding_model:
                persona.embedding_model || embModels[0]?.id || '',
              memory_settings:
                persona.memory_settings || DEFAULT_FORM_DATA.memory_settings,
              mutation_settings:
                persona.mutation_settings ||
                DEFAULT_FORM_DATA.mutation_settings,
            });

            // Handle missing embedding model in available list
            if (
              persona.embedding_model &&
              !embModels.find(m => m.id === persona.embedding_model)
            ) {
              const baseModelName = persona.embedding_model.split(':')[0];
              const taggedMatch = embModels.find(
                m =>
                  m.id.startsWith(baseModelName + ':') || m.id === baseModelName
              );
              if (taggedMatch) {
                setFormData(prev => ({
                  ...prev,
                  embedding_model: taggedMatch.id,
                }));
              } else {
                setEmbeddingModels(prev => [
                  ...prev,
                  {
                    id: persona.embedding_model!,
                    name: persona.embedding_model!,
                    description:
                      'Previously selected model (not currently installed)',
                    provider: 'ollama' as const,
                    dimensions: 768,
                  },
                ]);
              }
            }
          } else {
            // Creating new persona - apply defaults
            const defaults = defaultsResponse?.success
              ? defaultsResponse.data
              : {};
            setFormData(prev => ({
              ...prev,
              parameters: { ...prev.parameters, ...defaults },
              embedding_model: embModels[0]?.id || '',
            }));
          }
        }
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    };

    initialize();
  }, [persona, extractEmbeddingModels]);

  // Load memory status when editing existing persona
  useEffect(() => {
    if (persona?.id && formData.memory_settings?.enabled) {
      loadMemoryStatus();
    }
  }, [persona?.id, formData.memory_settings?.enabled, loadMemoryStatus]);

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

  // Tab configuration
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
        id: 'advanced' as const,
        label: t('personaForm.tabs.advanced'),
        icon: Brain,
      },
    ],
    [t]
  );

  // Parameter slider configurations for cleaner rendering
  const parameterSliders = useMemo(
    () => [
      {
        key: 'temperature' as const,
        label: t('personaForm.parameters.temperature'),
        min: 0,
        max: 2,
        step: 0.1,
        hint: t('personaForm.parameters.temperatureHint'),
        format: (v: number) => v.toFixed(1),
      },
      {
        key: 'top_p' as const,
        label: t('personaForm.parameters.topP'),
        min: 0,
        max: 1,
        step: 0.1,
        hint: t('personaForm.parameters.topPHint'),
        format: (v: number) => v.toFixed(1),
      },
      {
        key: 'top_k' as const,
        label: t('personaForm.parameters.topK'),
        min: 1,
        max: 100,
        step: 1,
        hint: t('personaForm.parameters.topKHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'context_window' as const,
        label: t('personaForm.parameters.contextWindow'),
        min: 128,
        max: 131072,
        step: 128,
        hint: t('personaForm.parameters.contextWindowHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'max_tokens' as const,
        label: t('personaForm.parameters.maxTokens'),
        min: 1,
        max: 8192,
        step: 1,
        hint: t('personaForm.parameters.maxTokensHint'),
        format: (v: number) => String(Math.round(v)),
      },
      {
        key: 'repeat_penalty' as const,
        label: t('personaForm.parameters.repeatPenalty'),
        min: 0.5,
        max: 2,
        step: 0.1,
        hint: t('personaForm.parameters.repeatPenaltyHint'),
        format: (v: number) => v.toFixed(1),
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
                      {t('personaForm.basic.name')} *
                    </label>
                    <input
                      type='text'
                      value={formData.name}
                      onChange={e => updateForm('name', e.target.value)}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors'
                      placeholder={t('personaForm.basic.namePlaceholder')}
                      required
                    />
                  </div>

                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                      {t('personaForm.basic.model')} *
                    </label>
                    <select
                      value={formData.model}
                      onChange={e => updateForm('model', e.target.value)}
                      className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors'
                      required
                    >
                      <option value=''>
                        {t('personaForm.basic.selectModel')}
                      </option>
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
                    {t('personaForm.basic.description')}
                  </label>
                  <textarea
                    value={formData.description}
                    onChange={e => updateForm('description', e.target.value)}
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors resize-none'
                    rows={3}
                    placeholder={t('personaForm.basic.descriptionPlaceholder')}
                  />
                </div>

                {/* Avatar & Background side by side on larger screens */}
                <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
                  <AvatarUpload
                    value={formData.avatar || ''}
                    onChange={url => updateForm('avatar', url)}
                  />
                  <PersonaBackgroundUpload
                    value={formData.background || ''}
                    onChange={url => updateForm('background', url)}
                  />
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
                    {t('personaForm.basic.systemPrompt')}
                  </label>
                  <textarea
                    value={formData.parameters.system_prompt}
                    onChange={e =>
                      updateParameter('system_prompt', e.target.value)
                    }
                    className='w-full px-3 py-2 border border-gray-300 dark:border-dark-300 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20 focus:border-primary-500 transition-colors resize-none font-mono text-sm'
                    rows={6}
                    placeholder={t('personaForm.basic.systemPromptPlaceholder')}
                  />
                  <p className='text-xs text-gray-500 dark:text-dark-600 mt-2'>
                    {t('personaForm.basic.systemPromptHint')}
                  </p>
                </div>
              </div>
            )}

            {/* Parameters Tab */}
            {activeTab === 'parameters' && (
              <div className='grid grid-cols-1 md:grid-cols-2 gap-6'>
                {parameterSliders.map(
                  ({ key, label, min, max, step, hint, format }) => (
                    <ParameterSlider
                      key={key}
                      label={label}
                      value={(formData.parameters[key] as number) || 0}
                      min={min}
                      max={max}
                      step={step}
                      hint={hint}
                      format={format}
                      onChange={v => updateParameter(key, v)}
                    />
                  )
                )}
              </div>
            )}

            {/* Memory & Learning Tab */}
            {activeTab === 'memory' && (
              <div className='space-y-6'>
                {/* Memory System Header Card */}
                <div className='rounded-xl overflow-hidden border border-emerald-200/50 dark:border-emerald-700/30'>
                  {/* Header */}
                  <div className='px-5 py-4 bg-gradient-to-r from-emerald-500 to-teal-500 dark:from-emerald-600 dark:to-teal-600'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-3'>
                        <div className='w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center'>
                          <Database className='h-5 w-5 text-white' />
                        </div>
                        <div>
                          <h3 className='font-semibold text-white'>
                            {t('personaForm.memory.title')}
                          </h3>
                          <p className='text-xs text-white/80'>
                            {t('personaForm.memory.subtitle')}
                          </p>
                        </div>
                      </div>
                      <ToggleSwitch
                        label=''
                        checked={formData.memory_settings?.enabled || false}
                        onChange={checked =>
                          updateSettings('memory_settings', {
                            enabled: checked,
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* Memory Status Dashboard (only for existing personas with memory enabled) */}
                  {formData.memory_settings?.enabled && persona?.id && (
                    <div className='px-5 py-4 bg-emerald-50 dark:bg-emerald-900/20 border-b border-emerald-100 dark:border-emerald-800/30'>
                      {loadingMemoryStatus ? (
                        <div className='flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400'>
                          <RefreshCw className='h-4 w-4 animate-spin' />
                          {t('personaForm.memory.loading')}
                        </div>
                      ) : memoryStatus ? (
                        <div className='grid grid-cols-3 gap-4'>
                          <div className='text-center'>
                            <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                              <Database className='h-5 w-5' />
                              {memoryStatus.memory_count.toLocaleString()}
                            </div>
                            <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                              {t('personaForm.memory.memories')}
                            </p>
                          </div>
                          <div className='text-center'>
                            <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                              <HardDrive className='h-5 w-5' />
                              {memoryStatus.size_mb.toFixed(1)}
                            </div>
                            <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                              {t('personaForm.memory.mbUsed')}
                            </p>
                          </div>
                          <div className='text-center'>
                            <div className='flex items-center justify-center gap-1 text-2xl font-bold text-emerald-700 dark:text-emerald-300'>
                              <Clock className='h-5 w-5' />
                              {memoryStatus.last_backup
                                ? new Date(
                                    memoryStatus.last_backup
                                  ).toLocaleDateString()
                                : t('personaForm.memory.never')}
                            </div>
                            <p className='text-xs text-emerald-600 dark:text-emerald-400'>
                              {t('personaForm.memory.lastBackup')}
                            </p>
                          </div>
                        </div>
                      ) : (
                        <p className='text-sm text-emerald-600 dark:text-emerald-400'>
                          {t('personaForm.memory.noData')}
                        </p>
                      )}
                    </div>
                  )}

                  {/* Memory Settings */}
                  {formData.memory_settings?.enabled && (
                    <div className='p-5 bg-white dark:bg-dark-100 space-y-4'>
                      <ParameterSlider
                        label={t('personaForm.memory.maxMemories')}
                        value={formData.memory_settings.max_memories}
                        min={100}
                        max={10000}
                        step={100}
                        hint={t('personaForm.memory.maxMemoriesHint')}
                        format={v => v.toLocaleString()}
                        colorClass='text-emerald-700 dark:text-emerald-300'
                        onChange={v =>
                          updateSettings('memory_settings', { max_memories: v })
                        }
                      />
                      <ParameterSlider
                        label={t('personaForm.memory.retention')}
                        value={formData.memory_settings.retention_days}
                        min={7}
                        max={365}
                        step={7}
                        hint={t('personaForm.memory.retentionHint')}
                        format={v => `${Math.round(v)} days`}
                        colorClass='text-emerald-700 dark:text-emerald-300'
                        onChange={v =>
                          updateSettings('memory_settings', {
                            retention_days: v,
                          })
                        }
                      />
                      <ToggleSwitch
                        label={t('personaForm.memory.autoCleanup')}
                        checked={formData.memory_settings.auto_cleanup}
                        onChange={checked =>
                          updateSettings('memory_settings', {
                            auto_cleanup: checked,
                          })
                        }
                        colorClass='text-emerald-700 dark:text-emerald-300'
                      />

                      {/* Danger Zone - Wipe Memories */}
                      {persona?.id &&
                        memoryStatus &&
                        memoryStatus.memory_count > 0 && (
                          <div className='pt-4 border-t border-gray-200 dark:border-dark-300'>
                            <div className='flex items-center justify-between p-3 bg-red-50 dark:bg-red-900/20 rounded-lg border border-red-200 dark:border-red-800/30'>
                              <div>
                                <p className='text-sm font-medium text-red-700 dark:text-red-300'>
                                  {t('personaForm.memory.wipeAll')}
                                </p>
                                <p className='text-xs text-red-600 dark:text-red-400'>
                                  {t('personaForm.memory.wipeCannot')}
                                </p>
                              </div>
                              <button
                                type='button'
                                onClick={handleWipeMemories}
                                disabled={wipingMemories}
                                className='px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-medium rounded-lg transition-colors disabled:opacity-50 flex items-center gap-1.5'
                              >
                                {wipingMemories ? (
                                  <RefreshCw className='h-3.5 w-3.5 animate-spin' />
                                ) : (
                                  <Trash2 className='h-3.5 w-3.5' />
                                )}
                                {wipingMemories
                                  ? t('personaForm.memory.wiping')
                                  : t('personaForm.memory.wipeButton')}
                              </button>
                            </div>
                          </div>
                        )}
                    </div>
                  )}

                  {/* Disabled state message */}
                  {!formData.memory_settings?.enabled && (
                    <div className='p-5 bg-gray-50 dark:bg-dark-50'>
                      <p className='text-sm text-gray-500 dark:text-gray-400 text-center'>
                        {t('personaForm.memory.enableHint')}
                      </p>
                    </div>
                  )}
                </div>

                {/* Adaptive Learning Card */}
                <div className='rounded-xl overflow-hidden border border-violet-200/50 dark:border-violet-700/30'>
                  {/* Header */}
                  <div className='px-5 py-4 bg-gradient-to-r from-violet-500 to-purple-500 dark:from-violet-600 dark:to-purple-600'>
                    <div className='flex items-center justify-between'>
                      <div className='flex items-center gap-3'>
                        <div className='w-10 h-10 rounded-lg bg-white/20 flex items-center justify-center'>
                          <TrendingUp className='h-5 w-5 text-white' />
                        </div>
                        <div>
                          <h3 className='font-semibold text-white'>
                            {t('personaForm.learning.title')}
                          </h3>
                          <p className='text-xs text-white/80'>
                            {t('personaForm.learning.subtitle')}
                          </p>
                        </div>
                      </div>
                      <ToggleSwitch
                        label=''
                        checked={formData.mutation_settings?.enabled || false}
                        onChange={checked =>
                          updateSettings('mutation_settings', {
                            enabled: checked,
                          })
                        }
                      />
                    </div>
                  </div>

                  {/* Learning Settings */}
                  {formData.mutation_settings?.enabled && (
                    <div className='p-5 bg-white dark:bg-dark-100 space-y-5'>
                      {/* Sensitivity Selection */}
                      <div>
                        <label className='block text-sm font-medium text-violet-700 dark:text-violet-300 mb-3'>
                          {t('personaForm.learning.speed')}
                        </label>
                        <div className='grid grid-cols-3 gap-3'>
                          {[
                            {
                              level: 'low' as const,
                              icon: Zap,
                              label: t('personaForm.learning.slow'),
                              desc: t('personaForm.learning.slowDesc'),
                            },
                            {
                              level: 'medium' as const,
                              icon: TrendingUp,
                              label: t('personaForm.learning.balanced'),
                              desc: t('personaForm.learning.balancedDesc'),
                            },
                            {
                              level: 'high' as const,
                              icon: Sparkles,
                              label: t('personaForm.learning.fast'),
                              desc: t('personaForm.learning.fastDesc'),
                            },
                          ].map(({ level, icon: Icon, label, desc }) => (
                            <button
                              key={level}
                              type='button'
                              onClick={() =>
                                updateSettings('mutation_settings', {
                                  sensitivity: level,
                                })
                              }
                              className={cn(
                                'p-3 rounded-xl text-center transition-all border',
                                formData.mutation_settings?.sensitivity ===
                                  level
                                  ? 'bg-violet-500 border-violet-500 text-white shadow-lg shadow-violet-500/25'
                                  : 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-700/30 text-violet-700 dark:text-violet-300 hover:bg-violet-100 dark:hover:bg-violet-900/30'
                              )}
                            >
                              <Icon className='h-5 w-5 mx-auto mb-1' />
                              <p className='text-sm font-medium'>{label}</p>
                              <p className='text-[10px] opacity-70'>{desc}</p>
                            </button>
                          ))}
                        </div>
                      </div>

                      <ToggleSwitch
                        label={t('personaForm.learning.autoAdapt')}
                        checked={formData.mutation_settings.auto_adapt}
                        onChange={checked =>
                          updateSettings('mutation_settings', {
                            auto_adapt: checked,
                          })
                        }
                        colorClass='text-violet-700 dark:text-violet-300'
                      />

                      {/* What it learns */}
                      <div className='p-4 bg-violet-50 dark:bg-violet-900/20 rounded-xl'>
                        <p className='text-xs font-medium text-violet-700 dark:text-violet-300 mb-2 flex items-center gap-1.5'>
                          <Brain className='h-3.5 w-3.5' />
                          {t('personaForm.learning.whatLearns')}
                        </p>
                        <div className='grid grid-cols-2 gap-2 text-xs text-violet-600 dark:text-violet-400'>
                          <div className='flex items-center gap-1.5'>
                            <div className='w-1 h-1 rounded-full bg-violet-400' />
                            {t('personaForm.learning.conversationTone')}
                          </div>
                          <div className='flex items-center gap-1.5'>
                            <div className='w-1 h-1 rounded-full bg-violet-400' />
                            {t('personaForm.learning.responseStyle')}
                          </div>
                          <div className='flex items-center gap-1.5'>
                            <div className='w-1 h-1 rounded-full bg-violet-400' />
                            {t('personaForm.learning.userPreferences')}
                          </div>
                          <div className='flex items-center gap-1.5'>
                            <div className='w-1 h-1 rounded-full bg-violet-400' />
                            {t('personaForm.learning.topicInterests')}
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Disabled state message */}
                  {!formData.mutation_settings?.enabled && (
                    <div className='p-5 bg-gray-50 dark:bg-dark-50'>
                      <p className='text-sm text-gray-500 dark:text-gray-400 text-center'>
                        {t('personaForm.learning.enableHint')}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Advanced Tab */}
            {activeTab === 'advanced' && (
              <div className='space-y-6'>
                {/* Embedding Model Selection */}
                <div className='rounded-xl p-5 bg-gradient-to-br from-primary-50 to-primary-100/50 dark:from-primary-900/30 dark:to-primary-800/20 border border-primary-200/50 dark:border-primary-700/30'>
                  <div className='flex items-center gap-2 mb-4'>
                    <Database className='h-5 w-5 text-primary-600 dark:text-primary-400' />
                    <h3 className='font-semibold text-primary-900 dark:text-primary-100'>
                      {t('personaForm.advanced.embeddingModel')}
                    </h3>
                  </div>
                  <p className='text-xs text-primary-600 dark:text-primary-400 mb-3'>
                    {t('personaForm.advanced.embeddingHint')}
                  </p>
                  <select
                    value={formData.embedding_model}
                    onChange={e =>
                      updateForm('embedding_model', e.target.value)
                    }
                    className='w-full px-3 py-2.5 border border-primary-200 dark:border-primary-700 rounded-lg bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800 focus:ring-2 focus:ring-primary-500/20'
                  >
                    {embeddingModels.length === 0 ? (
                      <option value='' disabled>
                        {t('personaForm.advanced.noModels')}
                      </option>
                    ) : (
                      <>
                        {/* Detected embedding models */}
                        {embeddingModels.filter(
                          (
                            m: EmbeddingModel & {
                              isDetectedEmbedding?: boolean;
                            }
                          ) => m.isDetectedEmbedding
                        ).length > 0 && (
                          <optgroup
                            label={t('personaForm.advanced.embeddingModels')}
                          >
                            {embeddingModels
                              .filter(
                                (
                                  m: EmbeddingModel & {
                                    isDetectedEmbedding?: boolean;
                                  }
                                ) => m.isDetectedEmbedding
                              )
                              .map(model => (
                                <option key={model.id} value={model.id}>
                                  {model.name} - {model.description}
                                </option>
                              ))}
                          </optgroup>
                        )}
                        {/* Other models */}
                        {embeddingModels.filter(
                          (
                            m: EmbeddingModel & {
                              isDetectedEmbedding?: boolean;
                            }
                          ) => !m.isDetectedEmbedding
                        ).length > 0 && (
                          <optgroup
                            label={t('personaForm.advanced.otherModels')}
                          >
                            {embeddingModels
                              .filter(
                                (
                                  m: EmbeddingModel & {
                                    isDetectedEmbedding?: boolean;
                                  }
                                ) => !m.isDetectedEmbedding
                              )
                              .map(model => (
                                <option key={model.id} value={model.id}>
                                  {model.name} - {model.description}
                                </option>
                              ))}
                          </optgroup>
                        )}
                      </>
                    )}
                  </select>
                  {embeddingModels.length === 0 && (
                    <div className='mt-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/50 rounded-lg'>
                      <p className='text-sm text-amber-800 dark:text-amber-200'>
                        {t('personaForm.advanced.installHint')}{' '}
                        <code className='px-1.5 py-0.5 bg-amber-100 dark:bg-amber-900/40 rounded text-xs'>
                          ollama pull nomic-embed-text
                        </code>
                      </p>
                    </div>
                  )}
                  <p className='text-[10px] text-primary-500 dark:text-primary-500 mt-2'>
                    {t('personaForm.advanced.recommended')}
                  </p>
                </div>

                {/* Info about advanced features */}
                <div className='p-4 bg-gray-50 dark:bg-dark-50 rounded-xl border border-gray-200 dark:border-dark-300'>
                  <div className='flex items-start gap-3'>
                    <Info className='h-5 w-5 text-gray-400 mt-0.5 flex-shrink-0' />
                    <div>
                      <p className='text-sm font-medium text-gray-700 dark:text-gray-300'>
                        {t('personaForm.advanced.aboutTitle')}
                      </p>
                      <p className='text-xs text-gray-500 dark:text-gray-400 mt-1'>
                        {t('personaForm.advanced.aboutDescription')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Form Actions */}
        <div className='flex items-center justify-between'>
          <Button
            type='button'
            variant='ghost'
            onClick={onCancel}
            disabled={submitting}
            className='text-gray-600 dark:text-gray-400'
          >
            {t('personaForm.actions.cancel')}
          </Button>

          <div className='flex items-center gap-3'>
            {lastSaved && (
              <div className='flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400'>
                <Check className='h-4 w-4' />
                <span>{t('personaForm.saved')}</span>
              </div>
            )}
            <Button
              type='button'
              variant='outline'
              onClick={() => handleSubmit(false)}
              disabled={submitting}
            >
              {submitting && !saveAndClose
                ? t('personaForm.actions.saving')
                : t('personaForm.actions.save')}
            </Button>
            <Button
              type='button'
              onClick={() => handleSubmit(true)}
              disabled={submitting}
            >
              {submitting && saveAndClose
                ? t('personaForm.actions.saving')
                : persona
                  ? t('personaForm.actions.saveClose')
                  : t('personaForm.actions.create')}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
};

export { PersonaForm };
export default PersonaForm;
