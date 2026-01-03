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
import { createPortal } from 'react-dom';
import { ollamaApi } from '@/utils/api';
import { Button } from '@/components/ui/Button';
import { RunningModel } from '@/types';
import toast from 'react-hot-toast';
import {
  Download,
  Trash2,
  Info,
  RefreshCw,
  Activity,
  HardDrive,
  Cpu,
  Zap,
  Search,
  X,
  Server,
  Copy,
  FileCode,
  TestTube,
  ChevronDown,
  ChevronUp,
  Settings,
  Clock,
  Hash,
  Layers,
  MemoryStick,
  Gauge,
  ExternalLink,
  Cloud,
  Check,
  Filter,
} from 'lucide-react';
import { cn } from '@/utils';

interface ModelInfo {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details?: {
    format?: string;
    family?: string;
    parameter_size?: string;
    quantization_level?: string;
    families?: string[];
    parent_model?: string;
  };
}

interface ModelDetails {
  modelfile?: string;
  parameters?: string;
  template?: string;
  license?: string;
  system?: string;
  details?: {
    format?: string;
    family?: string;
    families?: string[];
    parameter_size?: string;
    quantization_level?: string;
  };
  model_info?: Record<string, unknown>;
}

interface LibraryModel {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

export const ModelManager: React.FC = () => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [runningModels, setRunningModels] = useState<RunningModel[]>([]);
  const [libraryModels, setLibraryModels] = useState<LibraryModel[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [libraryFilter, setLibraryFilter] = useState<string>('all');
  const [librarySearch, setLibrarySearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [pullModelName, setPullModelName] = useState('');
  const [pulling, setPulling] = useState(false);
  const [pullProgress, setPullProgress] = useState<{
    status: string;
    percent?: number;
    total?: number;
    completed?: number;
  } | null>(null);
  const [cancelPull, setCancelPull] = useState<(() => void) | null>(null);

  // Model details modal
  const [selectedModelDetails, setSelectedModelDetails] =
    useState<ModelDetails | null>(null);
  const [selectedModelName, setSelectedModelName] = useState<string>('');
  const [showDetailsModal, setShowDetailsModal] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);

  // Copy model
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [copySource, setCopySource] = useState('');
  const [copyDestination, setCopyDestination] = useState('');
  const [copying, setCopying] = useState(false);

  // Create model
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [createModelName, setCreateModelName] = useState('');
  const [createModelfile, setCreateModelfile] = useState('');
  const [creating, setCreating] = useState(false);

  // Embeddings test
  const [showEmbeddingsModal, setShowEmbeddingsModal] = useState(false);
  const [embeddingsModel, setEmbeddingsModel] = useState('');
  const [embeddingsInput, setEmbeddingsInput] = useState('');
  const [embeddingsResult, setEmbeddingsResult] = useState<number[] | null>(
    null
  );
  const [generatingEmbeddings, setGeneratingEmbeddings] = useState(false);

  // System info
  const [ollamaVersion, setOllamaVersion] = useState<string | null>(null);
  const [isHealthy, setIsHealthy] = useState<boolean | null>(null);

  // Expanded sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['pull', 'local'])
  );

  const toggleSection = (section: string) => {
    setExpandedSections(prev => {
      const newSet = new Set(prev);
      if (newSet.has(section)) {
        newSet.delete(section);
      } else {
        newSet.add(section);
      }
      return newSet;
    });
  };

  // Load models and running models
  const loadData = async () => {
    setLoading(true);
    try {
      const [modelsResponse, runningResponse, versionResponse, healthResponse] =
        await Promise.all([
          ollamaApi.getModels(),
          ollamaApi.listRunningModels(),
          ollamaApi.getVersion(),
          ollamaApi.checkHealth(),
        ]);

      if (modelsResponse.success) {
        setModels(modelsResponse.data || []);
      }

      if (runningResponse.success) {
        setRunningModels(
          Array.isArray(runningResponse.data) ? runningResponse.data : []
        );
      }

      if (versionResponse.success && versionResponse.data) {
        setOllamaVersion(versionResponse.data.version);
      }

      setIsHealthy(healthResponse.success);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to load models: ' + errorMessage);
      setIsHealthy(false);
    } finally {
      setLoading(false);
    }
  };

  // Load library models
  const loadLibraryModels = async () => {
    setLoadingLibrary(true);
    try {
      const response = await ollamaApi.getLibraryModels();
      if (response.success && response.data) {
        setLibraryModels(response.data);
      }
    } catch (error: unknown) {
      console.error('Failed to load library models:', error);
    } finally {
      setLoadingLibrary(false);
    }
  };

  useEffect(() => {
    loadData();
    loadLibraryModels();
  }, []);

  const handlePullModel = async () => {
    if (!pullModelName.trim()) {
      toast.error('Please enter a model name');
      return;
    }

    setPulling(true);
    setPullProgress({ status: 'starting' });

    try {
      const cancelFn = ollamaApi.pullModelStream(
        pullModelName.trim(),
        progress => {
          setPullProgress(progress);
        },
        () => {
          setPullProgress(null);
          setPulling(false);
          setCancelPull(null);
          toast.success(`Model ${pullModelName} pulled successfully`);
          setPullModelName('');
          loadData();
        },
        error => {
          setPullProgress(null);
          setPulling(false);
          setCancelPull(null);
          toast.error('Failed to pull model: ' + error);
        }
      );
      setCancelPull(() => cancelFn);
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to pull model: ' + errorMessage);
      setPullProgress(null);
      setPulling(false);
      setCancelPull(null);
    }
  };

  const handleCancelPull = () => {
    if (cancelPull) {
      cancelPull();
      setCancelPull(null);
      setPulling(false);
      setPullProgress(null);
      toast.success('Model pull cancelled');
    }
  };

  const handleDeleteModel = async (modelName: string) => {
    if (!confirm(`Are you sure you want to delete model "${modelName}"?`)) {
      return;
    }

    try {
      await ollamaApi.deleteModel(modelName);
      toast.success(`Model ${modelName} deleted successfully`);
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to delete model: ' + errorMessage);
    }
  };

  const handleShowModel = async (modelName: string) => {
    setLoadingDetails(true);
    setSelectedModelName(modelName);
    setShowDetailsModal(true);

    try {
      const response = await ollamaApi.showModel(modelName, true);
      if (response.success && response.data) {
        setSelectedModelDetails(response.data as unknown as ModelDetails);
      } else {
        toast.error('Failed to load model details');
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to get model info: ' + errorMessage);
    } finally {
      setLoadingDetails(false);
    }
  };

  const handleCopyModel = async () => {
    if (!copySource.trim() || !copyDestination.trim()) {
      toast.error('Please enter both source and destination names');
      return;
    }

    setCopying(true);
    try {
      await ollamaApi.copyModel(copySource.trim(), copyDestination.trim());
      toast.success(`Model copied to ${copyDestination}`);
      setShowCopyModal(false);
      setCopySource('');
      setCopyDestination('');
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to copy model: ' + errorMessage);
    } finally {
      setCopying(false);
    }
  };

  const handleCreateModel = async () => {
    if (!createModelName.trim() || !createModelfile.trim()) {
      toast.error('Please enter model name and Modelfile content');
      return;
    }

    setCreating(true);
    try {
      await ollamaApi.createModel({
        model: createModelName.trim(),
        modelfile: createModelfile.trim(),
      });
      toast.success(`Model ${createModelName} created successfully`);
      setShowCreateModal(false);
      setCreateModelName('');
      setCreateModelfile('');
      await loadData();
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to create model: ' + errorMessage);
    } finally {
      setCreating(false);
    }
  };

  const handleGenerateEmbeddings = async () => {
    if (!embeddingsModel.trim() || !embeddingsInput.trim()) {
      toast.error('Please select a model and enter text');
      return;
    }

    setGeneratingEmbeddings(true);
    setEmbeddingsResult(null);

    try {
      const response = await ollamaApi.generateEmbeddings({
        model: embeddingsModel.trim(),
        input: embeddingsInput.trim(),
      });
      if (response.success && response.data) {
        const embeddings = response.data.embeddings?.[0] || [];
        setEmbeddingsResult(embeddings);
        toast.success(
          `Generated ${embeddings.length}-dimensional embedding vector`
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      toast.error('Failed to generate embeddings: ' + errorMessage);
    } finally {
      setGeneratingEmbeddings(false);
    }
  };

  const formatSize = (bytes: number) => {
    const gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(2)} GB`;
    }
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  };

  const isModelRunning = (modelName: string) => {
    return (
      Array.isArray(runningModels) &&
      runningModels.some((m: RunningModel) => m.name === modelName)
    );
  };

  const getTotalModelSize = () => {
    return models.reduce((acc, model) => acc + model.size, 0);
  };

  const getTotalVRAM = () => {
    return runningModels.reduce(
      (acc, model) => acc + (model.size_vram || 0),
      0
    );
  };

  // Check if a library model is already installed
  const isModelInstalled = (libraryModelName: string) => {
    return models.some(
      m =>
        m.name === libraryModelName || m.name.startsWith(libraryModelName + ':')
    );
  };

  // Filter library models
  const filteredLibraryModels = libraryModels.filter(model => {
    const matchesFilter =
      libraryFilter === 'all' || model.category === libraryFilter;
    const matchesSearch =
      !librarySearch ||
      model.name.toLowerCase().includes(librarySearch.toLowerCase()) ||
      model.description.toLowerCase().includes(librarySearch.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  // Get unique categories from library models
  const libraryCategories = [
    'all',
    ...new Set(libraryModels.map(m => m.category)),
  ];

  // Popular model suggestions with categories (fallback for quick picks)
  const popularModels = [
    { name: 'deepseek-r1', category: 'reasoning', size: '7B' },
    { name: 'llama3.2', category: 'general', size: '3B' },
    { name: 'gemma3', category: 'general', size: '4B' },
    { name: 'qwen2.5', category: 'general', size: '7B' },
    { name: 'mistral', category: 'general', size: '7B' },
    { name: 'codellama', category: 'coding', size: '7B' },
    { name: 'nomic-embed-text', category: 'embedding', size: '137M' },
    { name: 'llava', category: 'vision', size: '7B' },
    { name: 'phi3', category: 'general', size: '3.8B' },
    { name: 'gemma2', category: 'general', size: '9B' },
  ];

  if (loading) {
    return (
      <div className='flex items-center justify-center p-8'>
        <div className='flex items-center gap-3 text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3]'>
          <RefreshCw className='h-5 w-5 animate-spin' />
          Loading models...
        </div>
      </div>
    );
  }

  return (
    <div className='space-y-4'>
      {/* System Status Bar */}
      <div
        className={cn(
          'rounded-xl p-4 border',
          'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
          'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
        )}
      >
        <div className='flex flex-wrap items-center justify-between gap-4'>
          <div className='flex items-center gap-6'>
            {/* Health Status */}
            <div className='flex items-center gap-2'>
              <div
                className={cn(
                  'w-2.5 h-2.5 rounded-full',
                  isHealthy
                    ? 'bg-green-500 ophelia:bg-[#4ade80]'
                    : 'bg-red-500 ophelia:bg-[#f87171]'
                )}
              />
              <span className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'>
                {isHealthy ? 'Ollama Online' : 'Ollama Offline'}
              </span>
            </div>

            {/* Version */}
            {ollamaVersion && (
              <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
                <Server className='h-4 w-4' />
                <span>v{ollamaVersion}</span>
              </div>
            )}

            {/* Model Count */}
            <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
              <HardDrive className='h-4 w-4' />
              <span>
                {models.length} model{models.length !== 1 ? 's' : ''}
              </span>
            </div>

            {/* Total Size */}
            <div className='flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'>
              <Layers className='h-4 w-4' />
              <span>{formatSize(getTotalModelSize())}</span>
            </div>

            {/* Running Models */}
            {runningModels.length > 0 && (
              <div className='flex items-center gap-2 text-sm text-green-600 dark:text-green-400 ophelia:text-[#4ade80]'>
                <Activity className='h-4 w-4' />
                <span>
                  {runningModels.length} running ({formatSize(getTotalVRAM())}{' '}
                  VRAM)
                </span>
              </div>
            )}
          </div>

          <div className='flex items-center gap-2'>
            <Button
              onClick={loadData}
              variant='outline'
              size='sm'
              className={cn(
                'gap-1.5',
                'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
              )}
            >
              <RefreshCw className='h-3.5 w-3.5' />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Pull Model Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
          'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
        )}
      >
        <button
          onClick={() => toggleSection('pull')}
          className={cn(
            'w-full flex items-center justify-between p-4',
            'hover:bg-gray-50 dark:hover:bg-dark-50 ophelia:hover:bg-[#121212]',
            'transition-colors'
          )}
        >
          <div className='flex items-center gap-3'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-primary-100 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/20'
              )}
            >
              <Download className='h-5 w-5 text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7]' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
              Pull New Model
            </h3>
          </div>
          {expandedSections.has('pull') ? (
            <ChevronUp className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          )}
        </button>

        {expandedSections.has('pull') && (
          <div className='p-4 pt-0 space-y-4'>
            <div className='flex gap-2'>
              <div className='relative flex-1'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]' />
                <input
                  type='text'
                  value={pullModelName}
                  onChange={e => setPullModelName(e.target.value)}
                  placeholder='Enter model name (e.g., llama3.2:3b, deepseek-r1:14b)'
                  className={cn(
                    'w-full pl-10 pr-4 py-2.5 rounded-lg border text-sm',
                    'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                    'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                    'text-gray-900 dark:text-dark-700 ophelia:text-[#fafafa]',
                    'placeholder-gray-500 dark:placeholder-gray-400 ophelia:placeholder-[#525252]',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20',
                    'focus:border-primary-500 ophelia:focus:border-[#9333ea]'
                  )}
                  disabled={pulling}
                  onKeyDown={e =>
                    e.key === 'Enter' && !pulling && handlePullModel()
                  }
                />
              </div>
              {pulling ? (
                <Button
                  onClick={handleCancelPull}
                  variant='outline'
                  className={cn(
                    'px-4 py-2.5 gap-2',
                    'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
                    'ophelia:text-[#f87171] ophelia:hover:text-[#fca5a5]',
                    'ophelia:border-[#262626] ophelia:hover:bg-[#1a1a1a]'
                  )}
                >
                  <X className='h-4 w-4' />
                  Cancel
                </Button>
              ) : (
                <Button
                  onClick={handlePullModel}
                  disabled={!pullModelName.trim()}
                  className={cn(
                    'px-4 py-2.5 gap-2',
                    'ophelia:bg-[#9333ea] ophelia:hover:bg-[#7c3aed] ophelia:text-white'
                  )}
                >
                  <Download className='h-4 w-4' />
                  Pull
                </Button>
              )}
            </div>

            {/* Progress Bar */}
            {pulling && pullProgress && (
              <div
                className={cn(
                  'p-4 rounded-lg border',
                  'bg-gray-50 dark:bg-dark-200 ophelia:bg-[#121212]',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]'
                )}
              >
                <div className='flex items-center justify-between mb-2'>
                  <span className='text-sm font-medium text-gray-800 dark:text-dark-700 ophelia:text-[#e5e5e5]'>
                    {pullProgress.status === 'starting'
                      ? 'Initializing...'
                      : pullProgress.status === 'pulling'
                        ? 'Downloading model...'
                        : pullProgress.status === 'verifying sha256'
                          ? 'Verifying integrity...'
                          : pullProgress.status === 'writing manifest'
                            ? 'Writing manifest...'
                            : pullProgress.status ===
                                'removing any unused layers'
                              ? 'Cleaning up...'
                              : pullProgress.status}
                  </span>
                  {pullProgress.percent !== undefined && (
                    <span className='text-sm font-mono text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3]'>
                      {pullProgress.percent}%
                    </span>
                  )}
                </div>

                {pullProgress.percent !== undefined && (
                  <div className='w-full bg-gray-200 dark:bg-dark-400 ophelia:bg-[#262626] rounded-full h-2 overflow-hidden'>
                    <div
                      className={cn(
                        'h-2 rounded-full transition-all duration-300',
                        'bg-primary-500 dark:bg-primary-400 ophelia:bg-[#9333ea]'
                      )}
                      style={{ width: `${pullProgress.percent}%` }}
                    />
                  </div>
                )}

                {pullProgress.total && pullProgress.completed && (
                  <div className='mt-2 text-xs text-gray-600 dark:text-dark-600 ophelia:text-[#737373]'>
                    {formatSize(pullProgress.completed)} /{' '}
                    {formatSize(pullProgress.total)}
                  </div>
                )}
              </div>
            )}

            {/* Popular Models */}
            <div>
              <p className='text-xs font-medium text-gray-500 dark:text-gray-400 ophelia:text-[#737373] mb-2'>
                Popular models:
              </p>
              <div className='flex flex-wrap gap-2'>
                {popularModels.map(model => (
                  <button
                    key={model.name}
                    onClick={() => setPullModelName(model.name)}
                    disabled={pulling}
                    className={cn(
                      'px-3 py-1.5 rounded-full text-xs font-medium transition-colors',
                      'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
                      'text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3]',
                      'hover:bg-gray-200 dark:hover:bg-dark-300 ophelia:hover:bg-[#262626]',
                      'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'disabled:opacity-50 disabled:cursor-not-allowed'
                    )}
                  >
                    {model.name}
                    <span className='ml-1 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]'>
                      {model.size}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Help Link */}
            <a
              href='https://ollama.com/library'
              target='_blank'
              rel='noopener noreferrer'
              className={cn(
                'inline-flex items-center gap-1.5 text-xs',
                'text-primary-600 dark:text-primary-400 ophelia:text-[#a855f7]',
                'hover:underline'
              )}
            >
              <ExternalLink className='h-3 w-3' />
              Browse all models on ollama.com
            </a>
          </div>
        )}
      </div>

      {/* Browse Library Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
          'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
        )}
      >
        <button
          onClick={() => toggleSection('library')}
          className={cn(
            'w-full flex items-center justify-between p-4',
            'hover:bg-gray-50 dark:hover:bg-dark-50 ophelia:hover:bg-[#121212]',
            'transition-colors'
          )}
        >
          <div className='flex items-center gap-3'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-cyan-100 dark:bg-cyan-900/30 ophelia:bg-[#06b6d4]/20'
              )}
            >
              <Cloud className='h-5 w-5 text-cyan-600 dark:text-cyan-400 ophelia:text-[#22d3ee]' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
              Browse Library
            </h3>
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium',
                'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
                'text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
              )}
            >
              {libraryModels.length} available
            </span>
          </div>
          {expandedSections.has('library') ? (
            <ChevronUp className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          )}
        </button>

        {expandedSections.has('library') && (
          <div className='p-4 pt-0 space-y-4'>
            {/* Search and Filter */}
            <div className='flex flex-col sm:flex-row gap-3'>
              <div className='relative flex-1'>
                <Search className='absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]' />
                <input
                  type='text'
                  value={librarySearch}
                  onChange={e => setLibrarySearch(e.target.value)}
                  placeholder='Search models...'
                  className={cn(
                    'w-full pl-10 pr-4 py-2 rounded-lg border text-sm',
                    'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                    'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                    'text-gray-900 dark:text-dark-700 ophelia:text-[#fafafa]',
                    'placeholder-gray-500 dark:placeholder-gray-400 ophelia:placeholder-[#525252]',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20 ophelia:focus:ring-[#9333ea]/20',
                    'focus:border-primary-500 ophelia:focus:border-[#9333ea]'
                  )}
                />
              </div>

              {/* Category Filter */}
              <div className='flex items-center gap-2'>
                <Filter className='h-4 w-4 text-gray-400 ophelia:text-[#525252]' />
                <div className='flex flex-wrap gap-1'>
                  {libraryCategories.map(category => (
                    <button
                      key={category}
                      onClick={() => setLibraryFilter(category)}
                      className={cn(
                        'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                        libraryFilter === category
                          ? 'bg-primary-100 dark:bg-primary-900/30 ophelia:bg-[#9333ea]/20 text-primary-700 dark:text-primary-400 ophelia:text-[#a855f7]'
                          : 'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a] text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3] hover:bg-gray-200 dark:hover:bg-dark-300 ophelia:hover:bg-[#262626]'
                      )}
                    >
                      {category.charAt(0).toUpperCase() + category.slice(1)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* Models Grid */}
            {loadingLibrary ? (
              <div className='flex items-center justify-center py-8'>
                <RefreshCw className='h-5 w-5 animate-spin text-gray-400 ophelia:text-[#737373]' />
              </div>
            ) : filteredLibraryModels.length === 0 ? (
              <div className='text-center py-8 text-gray-500 ophelia:text-[#737373]'>
                No models found matching your criteria
              </div>
            ) : (
              <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3'>
                {filteredLibraryModels.map(model => {
                  const installed = isModelInstalled(model.name);
                  return (
                    <div
                      key={model.name}
                      className={cn(
                        'p-4 rounded-lg border transition-all',
                        'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                        installed
                          ? 'border-green-200 dark:border-green-800/50 ophelia:border-[#22c55e]/30'
                          : 'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]',
                        'hover:shadow-md hover:border-gray-300 dark:hover:border-dark-400 ophelia:hover:border-[#262626]'
                      )}
                    >
                      <div className='flex items-start justify-between gap-2 mb-2'>
                        <h4 className='font-medium text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
                          {model.name}
                        </h4>
                        {installed && (
                          <span
                            className={cn(
                              'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs',
                              'bg-green-100 dark:bg-green-900/30 ophelia:bg-[#22c55e]/20',
                              'text-green-700 dark:text-green-400 ophelia:text-[#4ade80]'
                            )}
                          >
                            <Check className='h-3 w-3' />
                            Installed
                          </span>
                        )}
                      </div>

                      <p className='text-xs text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3] mb-3 line-clamp-2'>
                        {model.description}
                      </p>

                      <div className='flex flex-wrap gap-1.5 mb-3'>
                        {model.sizes.slice(0, 4).map(size => (
                          <span
                            key={size}
                            className={cn(
                              'px-1.5 py-0.5 rounded text-xs',
                              'bg-gray-200 dark:bg-dark-300 ophelia:bg-[#262626]',
                              'text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
                            )}
                          >
                            {size}
                          </span>
                        ))}
                        {model.sizes.length > 4 && (
                          <span className='text-xs text-gray-400 ophelia:text-[#737373]'>
                            +{model.sizes.length - 4} more
                          </span>
                        )}
                      </div>

                      <div className='flex items-center justify-between'>
                        <div className='flex items-center gap-2 text-xs text-gray-500 ophelia:text-[#737373]'>
                          {model.pulls && (
                            <span className='flex items-center gap-1'>
                              <Download className='h-3 w-3' />
                              {model.pulls}
                            </span>
                          )}
                          <span
                            className={cn(
                              'px-1.5 py-0.5 rounded capitalize',
                              'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]'
                            )}
                          >
                            {model.category}
                          </span>
                        </div>

                        <Button
                          onClick={() => {
                            setPullModelName(model.name);
                            toggleSection('pull');
                            if (!expandedSections.has('pull')) {
                              toggleSection('pull');
                            }
                          }}
                          variant='outline'
                          size='sm'
                          disabled={pulling}
                          className={cn(
                            'gap-1 text-xs',
                            'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                            'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                          )}
                        >
                          <Download className='h-3 w-3' />
                          Pull
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Refresh Button */}
            <div className='flex justify-center'>
              <Button
                onClick={loadLibraryModels}
                variant='outline'
                size='sm'
                disabled={loadingLibrary}
                className={cn(
                  'gap-1.5',
                  'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                  'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                )}
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    loadingLibrary && 'animate-spin'
                  )}
                />
                Refresh Library
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Running Models Section */}
      {Array.isArray(runningModels) && runningModels.length > 0 && (
        <div
          className={cn(
            'rounded-xl p-4 border',
            'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
            'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
          )}
        >
          <div className='flex items-center gap-3 mb-4'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-green-100 dark:bg-green-900/30 ophelia:bg-[#22c55e]/20'
              )}
            >
              <Activity className='h-5 w-5 text-green-600 dark:text-green-400 ophelia:text-[#4ade80]' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
              Running Models
            </h3>
            <span
              className={cn(
                'ml-auto px-2 py-0.5 rounded-full text-xs font-medium',
                'bg-green-100 dark:bg-green-900/30 ophelia:bg-[#22c55e]/20',
                'text-green-700 dark:text-green-400 ophelia:text-[#4ade80]'
              )}
            >
              {runningModels.length} active
            </span>
          </div>
          <div className='space-y-2'>
            {runningModels.map((model: RunningModel) => (
              <div
                key={model.name}
                className={cn(
                  'flex items-center justify-between p-4 rounded-lg border',
                  'bg-green-50 dark:bg-green-900/10 ophelia:bg-[#22c55e]/5',
                  'border-green-200 dark:border-green-800/50 ophelia:border-[#22c55e]/20'
                )}
              >
                <div className='flex items-center gap-3'>
                  <div
                    className={cn(
                      'w-2 h-2 rounded-full animate-pulse',
                      'bg-green-500 ophelia:bg-[#4ade80]'
                    )}
                  />
                  <div>
                    <div className='font-medium text-green-800 dark:text-green-400 ophelia:text-[#4ade80]'>
                      {model.name}
                    </div>
                    <div className='flex items-center gap-3 text-sm text-green-600 dark:text-green-500 ophelia:text-[#22c55e]/80'>
                      <span className='flex items-center gap-1'>
                        <MemoryStick className='h-3 w-3' />
                        VRAM: {formatSize(model.size_vram || 0)}
                      </span>
                      {model.size && (
                        <span className='flex items-center gap-1'>
                          <HardDrive className='h-3 w-3' />
                          Size: {formatSize(model.size)}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className={cn(
                    'flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium',
                    'bg-green-100 dark:bg-green-900/30 ophelia:bg-[#22c55e]/10',
                    'text-green-700 dark:text-green-400 ophelia:text-[#4ade80]'
                  )}
                >
                  <Zap className='h-3 w-3' />
                  Active
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Local Models Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
          'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
        )}
      >
        <button
          onClick={() => toggleSection('local')}
          className={cn(
            'w-full flex items-center justify-between p-4',
            'hover:bg-gray-50 dark:hover:bg-dark-50 ophelia:hover:bg-[#121212]',
            'transition-colors'
          )}
        >
          <div className='flex items-center gap-3'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-blue-100 dark:bg-blue-900/30 ophelia:bg-[#a855f7]/20'
              )}
            >
              <HardDrive className='h-5 w-5 text-blue-600 dark:text-blue-400 ophelia:text-[#a855f7]' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
              Local Models
            </h3>
            <span
              className={cn(
                'px-2 py-0.5 rounded-full text-xs font-medium',
                'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
                'text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
              )}
            >
              {models.length} installed
            </span>
          </div>
          {expandedSections.has('local') ? (
            <ChevronUp className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          )}
        </button>

        {expandedSections.has('local') && (
          <div className='p-4 pt-0'>
            {models.length === 0 ? (
              <div
                className={cn(
                  'text-center py-12 rounded-lg border-2 border-dashed',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]'
                )}
              >
                <HardDrive className='h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-gray-600 ophelia:text-[#525252]' />
                <p className='text-gray-600 dark:text-dark-600 ophelia:text-[#737373] mb-2'>
                  No models installed yet
                </p>
                <p className='text-sm text-gray-500 dark:text-gray-500 ophelia:text-[#525252]'>
                  Pull a model above to get started
                </p>
              </div>
            ) : (
              <div className='space-y-3'>
                {models.map(model => (
                  <div
                    key={model.name}
                    className={cn(
                      'p-4 rounded-lg border transition-colors',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]',
                      'hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
                    )}
                  >
                    <div className='flex items-start justify-between gap-4'>
                      <div className='flex-1 min-w-0'>
                        <div className='flex items-center gap-2 flex-wrap'>
                          <h4 className='font-medium text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
                            {model.name}
                          </h4>
                          {isModelRunning(model.name) && (
                            <span
                              className={cn(
                                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium',
                                'bg-green-100 dark:bg-green-900/30 ophelia:bg-[#22c55e]/20',
                                'text-green-700 dark:text-green-400 ophelia:text-[#4ade80]'
                              )}
                            >
                              <span className='w-1.5 h-1.5 rounded-full bg-green-500 ophelia:bg-[#4ade80] animate-pulse' />
                              Running
                            </span>
                          )}
                        </div>

                        <div className='flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3] mt-2'>
                          <span className='flex items-center gap-1'>
                            <HardDrive className='h-3.5 w-3.5' />
                            {formatSize(model.size)}
                          </span>
                          {model.details?.parameter_size && (
                            <span className='flex items-center gap-1'>
                              <Cpu className='h-3.5 w-3.5' />
                              {model.details.parameter_size}
                            </span>
                          )}
                          {model.details?.quantization_level && (
                            <span
                              className={cn(
                                'px-1.5 py-0.5 rounded text-xs',
                                'bg-gray-200 dark:bg-dark-300 ophelia:bg-[#262626]',
                                'text-gray-600 dark:text-gray-400 ophelia:text-[#a3a3a3]'
                              )}
                            >
                              {model.details.quantization_level}
                            </span>
                          )}
                          {model.details?.family && (
                            <span className='text-gray-500 dark:text-gray-500 ophelia:text-[#737373]'>
                              {model.details.family}
                            </span>
                          )}
                        </div>

                        <div className='flex items-center gap-3 text-xs text-gray-400 dark:text-dark-500 ophelia:text-[#525252] mt-2'>
                          <span className='flex items-center gap-1'>
                            <Clock className='h-3 w-3' />
                            {new Date(model.modified_at).toLocaleDateString()}
                          </span>
                          <span
                            className='flex items-center gap-1 font-mono truncate max-w-[200px]'
                            title={model.digest}
                          >
                            <Hash className='h-3 w-3' />
                            {model.digest.slice(0, 12)}...
                          </span>
                        </div>
                      </div>

                      <div className='flex gap-2 flex-shrink-0'>
                        <Button
                          onClick={() => handleShowModel(model.name)}
                          variant='outline'
                          size='sm'
                          className={cn(
                            'gap-1.5',
                            'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                            'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                          )}
                        >
                          <Info className='h-3.5 w-3.5' />
                          Info
                        </Button>
                        <Button
                          onClick={() => {
                            setCopySource(model.name);
                            setShowCopyModal(true);
                          }}
                          variant='outline'
                          size='sm'
                          className={cn(
                            'gap-1.5',
                            'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                            'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                          )}
                        >
                          <Copy className='h-3.5 w-3.5' />
                          Copy
                        </Button>
                        <Button
                          onClick={() => handleDeleteModel(model.name)}
                          variant='outline'
                          size='sm'
                          className={cn(
                            'gap-1.5',
                            'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300',
                            'ophelia:text-[#f87171] ophelia:hover:text-[#fca5a5]',
                            'ophelia:border-[#262626] ophelia:hover:bg-[#1a1a1a]'
                          )}
                        >
                          <Trash2 className='h-3.5 w-3.5' />
                          Delete
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Advanced Actions Section */}
      <div
        className={cn(
          'rounded-xl border overflow-hidden',
          'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
          'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
        )}
      >
        <button
          onClick={() => toggleSection('advanced')}
          className={cn(
            'w-full flex items-center justify-between p-4',
            'hover:bg-gray-50 dark:hover:bg-dark-50 ophelia:hover:bg-[#121212]',
            'transition-colors'
          )}
        >
          <div className='flex items-center gap-3'>
            <div
              className={cn(
                'p-2 rounded-lg',
                'bg-amber-100 dark:bg-amber-900/30 ophelia:bg-[#f59e0b]/20'
              )}
            >
              <Settings className='h-5 w-5 text-amber-600 dark:text-amber-400 ophelia:text-[#fbbf24]' />
            </div>
            <h3 className='text-lg font-semibold text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'>
              Advanced Actions
            </h3>
          </div>
          {expandedSections.has('advanced') ? (
            <ChevronUp className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          ) : (
            <ChevronDown className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
          )}
        </button>

        {expandedSections.has('advanced') && (
          <div className='p-4 pt-0'>
            <div className='grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3'>
              <Button
                onClick={() => setShowCreateModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                  'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                )}
              >
                <FileCode className='h-5 w-5 text-purple-500 ophelia:text-[#a855f7]' />
                <div className='text-left'>
                  <div className='font-medium'>Create Model</div>
                  <div className='text-xs opacity-70'>From Modelfile</div>
                </div>
              </Button>

              <Button
                onClick={() => setShowCopyModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                  'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                )}
              >
                <Copy className='h-5 w-5 text-blue-500 ophelia:text-[#60a5fa]' />
                <div className='text-left'>
                  <div className='font-medium'>Copy Model</div>
                  <div className='text-xs opacity-70'>Duplicate existing</div>
                </div>
              </Button>

              <Button
                onClick={() => setShowEmbeddingsModal(true)}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                  'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                )}
              >
                <TestTube className='h-5 w-5 text-green-500 ophelia:text-[#4ade80]' />
                <div className='text-left'>
                  <div className='font-medium'>Test Embeddings</div>
                  <div className='text-xs opacity-70'>Generate vectors</div>
                </div>
              </Button>

              <Button
                onClick={async () => {
                  try {
                    const response = await ollamaApi.checkHealth();
                    if (response.success) {
                      setIsHealthy(true);
                      toast.success('Ollama is healthy!');
                    }
                  } catch {
                    setIsHealthy(false);
                    toast.error('Ollama health check failed');
                  }
                }}
                variant='outline'
                className={cn(
                  'w-full gap-2 justify-start h-auto py-3 px-4',
                  'ophelia:border-[#262626] ophelia:text-[#a3a3a3]',
                  'ophelia:hover:bg-[#1a1a1a] ophelia:hover:text-[#fafafa]'
                )}
              >
                <Gauge className='h-5 w-5 text-rose-500 ophelia:text-[#fb7185]' />
                <div className='text-left'>
                  <div className='font-medium'>Health Check</div>
                  <div className='text-xs opacity-70'>Test connection</div>
                </div>
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Model Details Modal */}
      {showDetailsModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowDetailsModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  Model Details: {selectedModelName}
                </h3>
                <button
                  onClick={() => setShowDetailsModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
                >
                  <X className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
                </button>
              </div>

              <div className='overflow-y-auto max-h-[calc(85vh-60px)] p-4 space-y-4'>
                {loadingDetails ? (
                  <div className='flex items-center justify-center py-8'>
                    <RefreshCw className='h-6 w-6 animate-spin text-gray-400 ophelia:text-[#737373]' />
                  </div>
                ) : selectedModelDetails ? (
                  <>
                    {/* Model Info */}
                    {selectedModelDetails.details && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          Model Information
                        </h4>
                        <div
                          className={cn(
                            'p-3 rounded-lg text-sm',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]'
                          )}
                        >
                          <div className='grid grid-cols-2 gap-2'>
                            {selectedModelDetails.details.family && (
                              <div>
                                <span className='text-gray-500 ophelia:text-[#737373]'>
                                  Family:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                                  {selectedModelDetails.details.family}
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details.parameter_size && (
                              <div>
                                <span className='text-gray-500 ophelia:text-[#737373]'>
                                  Parameters:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                                  {selectedModelDetails.details.parameter_size}
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details
                              .quantization_level && (
                              <div>
                                <span className='text-gray-500 ophelia:text-[#737373]'>
                                  Quantization:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                                  {
                                    selectedModelDetails.details
                                      .quantization_level
                                  }
                                </span>
                              </div>
                            )}
                            {selectedModelDetails.details.format && (
                              <div>
                                <span className='text-gray-500 ophelia:text-[#737373]'>
                                  Format:
                                </span>{' '}
                                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                                  {selectedModelDetails.details.format}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* System Prompt */}
                    {selectedModelDetails.system && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          System Prompt
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                            'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                          )}
                        >
                          {selectedModelDetails.system}
                        </pre>
                      </div>
                    )}

                    {/* Template */}
                    {selectedModelDetails.template && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          Template
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-40',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                            'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                          )}
                        >
                          {selectedModelDetails.template}
                        </pre>
                      </div>
                    )}

                    {/* Parameters */}
                    {selectedModelDetails.parameters && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          Parameters
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                            'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                          )}
                        >
                          {selectedModelDetails.parameters}
                        </pre>
                      </div>
                    )}

                    {/* License */}
                    {selectedModelDetails.license && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          License
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-32',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                            'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                          )}
                        >
                          {selectedModelDetails.license}
                        </pre>
                      </div>
                    )}

                    {/* Modelfile */}
                    {selectedModelDetails.modelfile && (
                      <div>
                        <h4 className='text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-2'>
                          Modelfile
                        </h4>
                        <pre
                          className={cn(
                            'p-3 rounded-lg text-xs overflow-x-auto max-h-60',
                            'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                            'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                          )}
                        >
                          {selectedModelDetails.modelfile}
                        </pre>
                      </div>
                    )}
                  </>
                ) : (
                  <p className='text-center text-gray-500 ophelia:text-[#737373]'>
                    No details available
                  </p>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Copy Model Modal */}
      {showCopyModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowCopyModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-md rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  Copy Model
                </h3>
                <button
                  onClick={() => setShowCopyModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
                >
                  <X className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    Source Model
                  </label>
                  <select
                    value={copySource}
                    onChange={e => setCopySource(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'
                    )}
                  >
                    <option value=''>Select a model...</option>
                    {models.map(model => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    New Model Name
                  </label>
                  <input
                    type='text'
                    value={copyDestination}
                    onChange={e => setCopyDestination(e.target.value)}
                    placeholder='e.g., my-custom-model'
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]',
                      'placeholder-gray-500 ophelia:placeholder-[#525252]'
                    )}
                  />
                </div>

                <Button
                  onClick={handleCopyModel}
                  disabled={
                    !copySource.trim() || !copyDestination.trim() || copying
                  }
                  className={cn(
                    'w-full gap-2',
                    'ophelia:bg-[#9333ea] ophelia:hover:bg-[#7c3aed] ophelia:text-white'
                  )}
                >
                  {copying ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <Copy className='h-4 w-4' />
                  )}
                  {copying ? 'Copying...' : 'Copy Model'}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Create Model Modal */}
      {showCreateModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowCreateModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-lg rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  Create Custom Model
                </h3>
                <button
                  onClick={() => setShowCreateModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
                >
                  <X className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    Model Name
                  </label>
                  <input
                    type='text'
                    value={createModelName}
                    onChange={e => setCreateModelName(e.target.value)}
                    placeholder='e.g., my-assistant'
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]',
                      'placeholder-gray-500 ophelia:placeholder-[#525252]'
                    )}
                  />
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    Modelfile
                  </label>
                  <textarea
                    value={createModelfile}
                    onChange={e => setCreateModelfile(e.target.value)}
                    placeholder={`FROM llama3.2\nSYSTEM You are a helpful assistant.`}
                    rows={8}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm font-mono',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]',
                      'placeholder-gray-500 ophelia:placeholder-[#525252]',
                      'resize-none'
                    )}
                  />
                  <p className='mt-1 text-xs text-gray-500 ophelia:text-[#737373]'>
                    See{' '}
                    <a
                      href='https://github.com/ollama/ollama/blob/main/docs/modelfile.md'
                      target='_blank'
                      rel='noopener noreferrer'
                      className='text-primary-600 ophelia:text-[#a855f7] hover:underline'
                    >
                      Modelfile docs
                    </a>{' '}
                    for syntax reference
                  </p>
                </div>

                <Button
                  onClick={handleCreateModel}
                  disabled={
                    !createModelName.trim() ||
                    !createModelfile.trim() ||
                    creating
                  }
                  className={cn(
                    'w-full gap-2',
                    'ophelia:bg-[#9333ea] ophelia:hover:bg-[#7c3aed] ophelia:text-white'
                  )}
                >
                  {creating ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <FileCode className='h-4 w-4' />
                  )}
                  {creating ? 'Creating...' : 'Create Model'}
                </Button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Embeddings Test Modal */}
      {showEmbeddingsModal &&
        createPortal(
          <div className='fixed inset-0 z-[999999] flex items-center justify-center p-4'>
            <div
              className='absolute inset-0 bg-black/50 backdrop-blur-sm'
              onClick={() => setShowEmbeddingsModal(false)}
            />
            <div
              className={cn(
                'relative w-full max-w-lg rounded-xl border shadow-2xl',
                'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
                'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between p-4 border-b',
                  'border-gray-200 dark:border-dark-300 ophelia:border-[#1a1a1a]'
                )}
              >
                <h3 className='text-lg font-semibold text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  Test Embeddings
                </h3>
                <button
                  onClick={() => setShowEmbeddingsModal(false)}
                  className='p-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 ophelia:hover:bg-[#1a1a1a]'
                >
                  <X className='h-5 w-5 text-gray-500 ophelia:text-[#737373]' />
                </button>
              </div>

              <div className='p-4 space-y-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    Embedding Model
                  </label>
                  <select
                    value={embeddingsModel}
                    onChange={e => setEmbeddingsModel(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'
                    )}
                  >
                    <option value=''>Select a model...</option>
                    {models.map(model => (
                      <option key={model.name} value={model.name}>
                        {model.name}
                      </option>
                    ))}
                  </select>
                  <p className='mt-1 text-xs text-gray-500 ophelia:text-[#737373]'>
                    Recommended: nomic-embed-text, mxbai-embed-large
                  </p>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                    Input Text
                  </label>
                  <textarea
                    value={embeddingsInput}
                    onChange={e => setEmbeddingsInput(e.target.value)}
                    placeholder='Enter text to generate embeddings for...'
                    rows={3}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg border text-sm',
                      'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                      'border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
                      'text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]',
                      'placeholder-gray-500 ophelia:placeholder-[#525252]',
                      'resize-none'
                    )}
                  />
                </div>

                <Button
                  onClick={handleGenerateEmbeddings}
                  disabled={
                    !embeddingsModel.trim() ||
                    !embeddingsInput.trim() ||
                    generatingEmbeddings
                  }
                  className={cn(
                    'w-full gap-2',
                    'ophelia:bg-[#9333ea] ophelia:hover:bg-[#7c3aed] ophelia:text-white'
                  )}
                >
                  {generatingEmbeddings ? (
                    <RefreshCw className='h-4 w-4 animate-spin' />
                  ) : (
                    <TestTube className='h-4 w-4' />
                  )}
                  {generatingEmbeddings
                    ? 'Generating...'
                    : 'Generate Embeddings'}
                </Button>

                {embeddingsResult && (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 ophelia:text-[#a3a3a3] mb-1'>
                      Result ({embeddingsResult.length} dimensions)
                    </label>
                    <pre
                      className={cn(
                        'p-3 rounded-lg text-xs overflow-x-auto max-h-32',
                        'bg-gray-50 dark:bg-dark-50 ophelia:bg-[#121212]',
                        'text-gray-700 dark:text-gray-300 ophelia:text-[#e5e5e5]'
                      )}
                    >
                      [{embeddingsResult.slice(0, 10).join(', ')}
                      {embeddingsResult.length > 10 && ', ...'} ]
                    </pre>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};

export default ModelManager;
