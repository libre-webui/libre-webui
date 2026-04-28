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
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { X, ImageIcon, Loader2, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/utils';
import { imageGenApi } from '@/utils/api';
import { toast } from 'react-hot-toast';

interface ImageGenPlugin {
  id: string;
  name: string;
  models: string[];
  config?: {
    sizes?: string[];
    default_size?: string;
    qualities?: string[];
    default_quality?: string;
    max_prompt_length?: number;
  };
}

interface ImageGenerationPanelProps {
  isOpen: boolean;
  onClose: () => void;
  onImageGenerated?: (imageData: string, prompt: string, model: string) => void;
}

export const ImageGenerationPanel: React.FC<ImageGenerationPanelProps> = ({
  isOpen,
  onClose,
  onImageGenerated,
}) => {
  const { t } = useTranslation();
  const [plugins, setPlugins] = useState<ImageGenPlugin[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('standard');
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [availableSizes, setAvailableSizes] = useState<string[]>([
    '512x512',
    '768x768',
    '1024x1024',
  ]);
  const [availableQualities, setAvailableQualities] = useState<string[]>([
    'standard',
    'high',
  ]);
  const [maxPromptLength, setMaxPromptLength] = useState<number | null>(null);

  // Load available plugins on mount
  useEffect(() => {
    const loadPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        if (response.success && response.data) {
          setPlugins(response.data);
          // Auto-select first plugin if available
          if (response.data.length > 0) {
            const firstPlugin = response.data[0];
            setSelectedPlugin(firstPlugin.id);
            if (firstPlugin.models.length > 0) {
              setSelectedModel(firstPlugin.models[0]);
            }
            if (firstPlugin.config?.sizes) {
              setAvailableSizes(firstPlugin.config.sizes);
              setSize(
                firstPlugin.config.default_size ||
                  firstPlugin.config.sizes[0] ||
                  '1024x1024'
              );
            }
            if (firstPlugin.config?.qualities) {
              setAvailableQualities(firstPlugin.config.qualities);
              setQuality(
                firstPlugin.config.default_quality ||
                  firstPlugin.config.qualities[0] ||
                  'standard'
              );
            }
            setMaxPromptLength(firstPlugin.config?.max_prompt_length ?? null);
          }
        }
      } catch (error) {
        console.error('Failed to load image generation plugins:', error);
      }
    };

    if (isOpen) {
      loadPlugins();
    }
  }, [isOpen]);

  // Update config when plugin changes — adjust state during render rather than effect
  const [prevSelectedPlugin, setPrevSelectedPlugin] = useState(selectedPlugin);
  if (selectedPlugin !== prevSelectedPlugin) {
    setPrevSelectedPlugin(selectedPlugin);
    const plugin = plugins.find(p => p.id === selectedPlugin);
    if (plugin) {
      if (plugin.models.length > 0 && !plugin.models.includes(selectedModel)) {
        setSelectedModel(plugin.models[0]);
      }
      if (plugin.config?.sizes) {
        setAvailableSizes(plugin.config.sizes);
        if (!plugin.config.sizes.includes(size)) {
          setSize(plugin.config.default_size || plugin.config.sizes[0]);
        }
      }
      if (plugin.config?.qualities) {
        setAvailableQualities(plugin.config.qualities);
        if (!plugin.config.qualities.includes(quality)) {
          setQuality(
            plugin.config.default_quality || plugin.config.qualities[0]
          );
        }
      }
      setMaxPromptLength(plugin.config?.max_prompt_length ?? null);
    }
  }

  const handleGenerate = async () => {
    if (!selectedModel || !prompt.trim()) {
      toast.error(t('imageGeneration.enterPrompt'));
      return;
    }

    if (maxPromptLength && prompt.length > maxPromptLength) {
      toast.error(
        t('imageGeneration.promptTooLong', {
          max: maxPromptLength.toLocaleString(),
        })
      );
      return;
    }

    setIsGenerating(true);
    setGeneratedImage(null);

    try {
      const response = await imageGenApi.generate({
        model: selectedModel,
        prompt: prompt.trim(),
        size,
        quality,
      });

      if (
        response.success &&
        response.data?.images &&
        response.data.images.length > 0
      ) {
        const image = response.data.images[0];
        let imageData: string | null = null;

        if (image.b64_json) {
          imageData = `data:image/png;base64,${image.b64_json}`;
        } else if (image.url) {
          imageData = image.url;
        }

        if (imageData) {
          toast.success(t('imageGeneration.success'));

          // If callback provided, send to chat and close
          if (onImageGenerated) {
            onImageGenerated(imageData, prompt.trim(), selectedModel);
            setPrompt('');
            setGeneratedImage(null);
            onClose();
          } else {
            // No callback - just show in panel
            setGeneratedImage(imageData);
          }
        }
      } else {
        toast.error(t('imageGeneration.failed'));
      }
    } catch (error) {
      console.error('Image generation failed:', error);
      const message =
        error instanceof Error ? error.message : t('imageGeneration.failed');
      toast.error(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = () => {
    if (!generatedImage) return;

    const link = document.createElement('a');
    link.href = generatedImage;
    link.download = `generated-image-${Date.now()}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen) return null;

  const currentPlugin = plugins.find(p => p.id === selectedPlugin);

  return createPortal(
    <div className='fixed inset-0 z-[99999] flex items-center justify-center p-4'>
      {/* Backdrop */}
      <div
        className='absolute inset-0 bg-black/60 backdrop-blur-sm'
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          'relative bg-white dark:bg-dark-100',
          'border border-gray-200 dark:border-dark-300',
          'rounded-2xl shadow-2xl',
          'w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col'
        )}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className='flex items-center justify-between p-4 border-b border-gray-200 dark:border-dark-300'>
          <div className='flex items-center gap-2'>
            <ImageIcon className='h-5 w-5 text-primary-600 dark:text-primary-400' />
            <h2 className='text-lg font-semibold text-gray-900 dark:text-gray-100'>
              {t('imageGeneration.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className='p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-dark-200 transition-colors'
          >
            <X className='h-5 w-5 text-gray-500 dark:text-gray-400' />
          </button>
        </div>

        {/* Content */}
        <div className='flex-1 overflow-y-auto p-4 space-y-4'>
          {plugins.length === 0 ? (
            <div className='text-center py-8'>
              <ImageIcon className='h-12 w-12 mx-auto mb-3 text-gray-300 dark:text-gray-600' />
              <p className='text-gray-500 dark:text-gray-400'>
                {t('imageGeneration.noModels')}
              </p>
              <p className='text-sm text-gray-400 dark:text-gray-500 mt-1'>
                {t('imageGeneration.configurePlugin')}
              </p>
            </div>
          ) : (
            <>
              {/* Plugin & Model Selection */}
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('settings.plugins.title')}
                  </label>
                  <select
                    value={selectedPlugin}
                    onChange={e => setSelectedPlugin(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-sm',
                      'bg-gray-50 dark:bg-dark-200',
                      'border border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                    )}
                  >
                    {plugins.map(plugin => (
                      <option key={plugin.id} value={plugin.id}>
                        {plugin.name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('imageGeneration.model')}
                  </label>
                  <select
                    value={selectedModel}
                    onChange={e => setSelectedModel(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-sm',
                      'bg-gray-50 dark:bg-dark-200',
                      'border border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                    )}
                  >
                    {currentPlugin?.models.map(model => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Size & Quality */}
              <div className='grid grid-cols-2 gap-4'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('imageGeneration.size')}
                  </label>
                  <select
                    value={size}
                    onChange={e => setSize(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-sm',
                      'bg-gray-50 dark:bg-dark-200',
                      'border border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                    )}
                  >
                    {availableSizes.map(s => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('imageGeneration.quality')}
                  </label>
                  <select
                    value={quality}
                    onChange={e => setQuality(e.target.value)}
                    className={cn(
                      'w-full px-3 py-2 rounded-lg text-sm',
                      'bg-gray-50 dark:bg-dark-200',
                      'border border-gray-200 dark:border-dark-300',
                      'text-gray-900 dark:text-gray-100',
                      'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                    )}
                  >
                    {availableQualities.map(q => (
                      <option key={q} value={q}>
                        {q.charAt(0).toUpperCase() + q.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Prompt */}
              <div>
                <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                  {t('imageGeneration.prompt')}
                </label>
                <textarea
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={t('imageGeneration.promptPlaceholder')}
                  rows={5}
                  className={cn(
                    'w-full px-3 py-2 rounded-lg text-sm resize-none',
                    'bg-gray-50 dark:bg-dark-200',
                    'border border-gray-200 dark:border-dark-300',
                    'text-gray-900 dark:text-gray-100',
                    'placeholder-gray-500 dark:placeholder-gray-400',
                    'focus:outline-none focus:ring-2 focus:ring-primary-500/20',
                    maxPromptLength &&
                      prompt.length > maxPromptLength &&
                      'border-red-500 dark:border-red-500'
                  )}
                />
                {maxPromptLength && (
                  <div
                    className={cn(
                      'text-xs mt-1 text-right',
                      prompt.length > maxPromptLength
                        ? 'text-red-500'
                        : 'text-gray-500 dark:text-gray-400'
                    )}
                  >
                    {prompt.length.toLocaleString()} /{' '}
                    {maxPromptLength.toLocaleString()}
                  </div>
                )}
              </div>

              {/* Generated Image Preview */}
              {generatedImage && (
                <div className='relative rounded-xl overflow-hidden border border-gray-200 dark:border-dark-300'>
                  <img
                    src={generatedImage}
                    alt='Generated'
                    className='w-full h-auto'
                  />
                  <button
                    onClick={handleDownload}
                    className={cn(
                      'absolute bottom-3 right-3 p-2 rounded-lg',
                      'bg-white/90 dark:bg-dark-100/90',
                      'hover:bg-white dark:hover:bg-dark-100',
                      'border border-gray-200 dark:border-dark-300',
                      'transition-colors'
                    )}
                    title={t('imageGallery.download')}
                  >
                    <Download className='h-5 w-5 text-gray-700 dark:text-gray-200' />
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {plugins.length > 0 && (
          <div className='p-4 border-t border-gray-200 dark:border-dark-300'>
            <Button
              onClick={handleGenerate}
              disabled={isGenerating || !prompt.trim() || !selectedModel}
              className={cn(
                'w-full py-2.5 rounded-xl font-medium',
                'bg-primary-600 dark:bg-primary-600',
                'hover:bg-primary-700 dark:hover:bg-primary-500',
                'text-white',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                'transition-colors'
              )}
            >
              {isGenerating ? (
                <span className='flex items-center justify-center gap-2'>
                  <Loader2 className='h-4 w-4 animate-spin' />
                  {t('imageGeneration.generating')}
                </span>
              ) : (
                <span className='flex items-center justify-center gap-2'>
                  <Sparkles className='h-4 w-4' />
                  {t('imageGeneration.generate')}
                </span>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};

export default ImageGenerationPanel;
