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

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { X, ImageIcon, Loader2, Download, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui';
import { cn } from '@/utils';
import {
  findPreferredImagePlugin,
  getImageGenImageFileExtension,
  getImageGenImageSource,
  imageGenApi,
  resolveImageGenOption,
  type ImageGenPlugin,
} from '@/utils/api';
import { toast } from 'react-hot-toast';
import { createLogger } from '@/utils/logger';
import { useAppStore } from '@/store/appStore';
import type { ImageGenSettings } from '@/types';

const logger = createLogger('components:image-generation-panel');

type PreferredImageSettings = Partial<
  Pick<ImageGenSettings, 'model' | 'pluginId' | 'quality' | 'size' | 'style'>
>;

interface ImagePanelSelection {
  pluginId: string;
  model: string;
  size: string;
  quality: string;
  style: string;
  sizes: string[];
  qualities: string[];
  styles: string[];
  maxPromptLength: number | null;
}

function getImagePanelSelection(
  plugin: ImageGenPlugin,
  preferred: PreferredImageSettings = {}
): ImagePanelSelection {
  const sizes =
    plugin.config?.sizes && plugin.config.sizes.length > 0
      ? plugin.config.sizes
      : [preferred.size || plugin.config?.default_size || '1024x1024'];
  const qualities =
    plugin.config?.qualities && plugin.config.qualities.length > 0
      ? plugin.config.qualities
      : [preferred.quality || plugin.config?.default_quality || 'standard'];
  const styles =
    plugin.config?.styles && plugin.config.styles.length > 0
      ? plugin.config.styles
      : [];

  return {
    pluginId: plugin.id,
    model: resolveImageGenOption(plugin.models, preferred.model, undefined, ''),
    size: resolveImageGenOption(
      sizes,
      preferred.size,
      plugin.config?.default_size,
      '1024x1024'
    ),
    quality: resolveImageGenOption(
      qualities,
      preferred.quality,
      plugin.config?.default_quality,
      'standard'
    ),
    style:
      styles.length > 0
        ? resolveImageGenOption(
            styles,
            preferred.style,
            plugin.config?.default_style,
            styles[0]
          )
        : '',
    sizes,
    qualities,
    styles,
    maxPromptLength: plugin.config?.max_prompt_length ?? null,
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
  const savedImageGenSettings = useAppStore(
    state => state.preferences.imageGenSettings
  );
  const imageGenerationEnabled = savedImageGenSettings?.enabled === true;
  const [plugins, setPlugins] = useState<ImageGenPlugin[]>([]);
  const [selectedPlugin, setSelectedPlugin] = useState<string>('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [prompt, setPrompt] = useState('');
  const [size, setSize] = useState('1024x1024');
  const [quality, setQuality] = useState('standard');
  const [style, setStyle] = useState('');
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
  const [availableStyles, setAvailableStyles] = useState<string[]>([]);
  const [maxPromptLength, setMaxPromptLength] = useState<number | null>(null);
  const titleId = React.useId();

  const applyPluginSelection = useCallback(
    (plugin: ImageGenPlugin, preferred?: PreferredImageSettings) => {
      const selection = getImagePanelSelection(plugin, preferred);
      setSelectedPlugin(selection.pluginId);
      setSelectedModel(selection.model);
      setSize(selection.size);
      setQuality(selection.quality);
      setStyle(selection.style);
      setAvailableSizes(selection.sizes);
      setAvailableQualities(selection.qualities);
      setAvailableStyles(selection.styles);
      setMaxPromptLength(selection.maxPromptLength);
    },
    []
  );

  // Load available plugins and restore the exact saved provider/model.
  useEffect(() => {
    let cancelled = false;

    const loadPlugins = async () => {
      try {
        const response = await imageGenApi.getPlugins();
        if (cancelled) return;

        const availablePlugins =
          response.success && response.data
            ? response.data.filter(plugin => plugin.models.length > 0)
            : [];
        setPlugins(availablePlugins);

        const preferredPlugin = findPreferredImagePlugin(
          availablePlugins,
          savedImageGenSettings
        );
        if (preferredPlugin) {
          applyPluginSelection(preferredPlugin, savedImageGenSettings);
        } else {
          setSelectedPlugin('');
          setSelectedModel('');
        }
      } catch (error) {
        if (cancelled) return;
        setPlugins([]);
        setSelectedPlugin('');
        setSelectedModel('');
        logger.error('Failed to load image generation plugins:', error);
      }
    };

    if (isOpen && imageGenerationEnabled) {
      void loadPlugins();
    }

    return () => {
      cancelled = true;
    };
  }, [
    applyPluginSelection,
    imageGenerationEnabled,
    isOpen,
    savedImageGenSettings,
  ]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.body.style.overflow = 'hidden';
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handlePluginChange = (pluginId: string) => {
    const plugin = plugins.find(candidate => candidate.id === pluginId);
    if (!plugin) return;

    applyPluginSelection(plugin, {
      model: selectedModel,
      size,
      quality,
      style,
    });
  };

  const handleGenerate = async () => {
    if (
      !imageGenerationEnabled ||
      !selectedPlugin ||
      !selectedModel ||
      !prompt.trim()
    ) {
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
        pluginId: selectedPlugin,
        prompt: prompt.trim(),
        size,
        quality,
        ...(style ? { style } : {}),
      });

      if (
        response.success &&
        response.data?.images &&
        response.data.images.length > 0
      ) {
        const imageData = getImageGenImageSource(response.data.images[0]);

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
      logger.error('Image generation failed:', error);
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
    link.download = `generated-image-${Date.now()}.${getImageGenImageFileExtension(
      generatedImage
    )}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (!isOpen || !imageGenerationEnabled) return null;

  const currentPlugin = plugins.find(p => p.id === selectedPlugin);

  return createPortal(
    <div
      className='fixed inset-0 z-[99999] flex items-center justify-center p-3 sm:p-6'
      role='dialog'
      aria-modal='true'
      aria-labelledby={titleId}
    >
      {/* Backdrop */}
      <div
        className='absolute inset-0 bg-black/55 backdrop-blur-sm'
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={cn(
          'relative bg-white/95 dark:bg-dark-25/95',
          'border border-gray-200/80 dark:border-white/10',
          'rounded-3xl shadow-2xl backdrop-blur-xl',
          'flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden'
        )}
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className='flex items-center justify-between border-b border-gray-200/70 px-5 py-4 dark:border-white/[0.08] sm:px-6 sm:py-5'>
          <div>
            <h2
              id={titleId}
              className='text-xl font-normal tracking-[-0.025em] text-gray-950 dark:text-dark-950'
            >
              {t('imageGeneration.title')}
            </h2>
          </div>
          <button
            onClick={onClose}
            className='rounded-xl p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-dark-500 dark:hover:bg-white/[0.06] dark:hover:text-dark-900'
            title={t('common.close', { defaultValue: 'Close' })}
          >
            <X className='h-5 w-5 text-gray-500 dark:text-gray-400' />
          </button>
        </div>

        {/* Content */}
        <div className='scroll-region min-h-0 flex-1 space-y-5 p-5 scrollbar-thin sm:p-6'>
          {!currentPlugin ? (
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
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('settings.plugins.title')}
                  </label>
                  <select
                    value={selectedPlugin}
                    onChange={e => handlePluginChange(e.target.value)}
                    className={cn(
                      'w-full rounded-xl px-3 py-2.5 text-sm',
                      'bg-white/70 dark:bg-white/[0.035]',
                      'border border-gray-200/80 dark:border-white/10',
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
                      'w-full rounded-xl px-3 py-2.5 text-sm',
                      'bg-white/70 dark:bg-white/[0.035]',
                      'border border-gray-200/80 dark:border-white/10',
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

                {availableStyles.length > 0 && (
                  <div>
                    <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                      {t('imageGeneration.style')}
                    </label>
                    <select
                      value={style}
                      onChange={e => setStyle(e.target.value)}
                      className={cn(
                        'w-full rounded-xl px-3 py-2.5 text-sm',
                        'bg-white/70 dark:bg-white/[0.035]',
                        'border border-gray-200/80 dark:border-white/10',
                        'text-gray-900 dark:text-gray-100',
                        'focus:outline-none focus:ring-2 focus:ring-primary-500/20'
                      )}
                    >
                      {availableStyles.map(option => (
                        <option key={option} value={option}>
                          {option.charAt(0).toUpperCase() + option.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {/* Size & Quality */}
              <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                <div>
                  <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1'>
                    {t('imageGeneration.size')}
                  </label>
                  <select
                    value={size}
                    onChange={e => setSize(e.target.value)}
                    className={cn(
                      'w-full rounded-xl px-3 py-2.5 text-sm',
                      'bg-white/70 dark:bg-white/[0.035]',
                      'border border-gray-200/80 dark:border-white/10',
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
                      'w-full rounded-xl px-3 py-2.5 text-sm',
                      'bg-white/70 dark:bg-white/[0.035]',
                      'border border-gray-200/80 dark:border-white/10',
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
                    'w-full resize-none rounded-2xl px-4 py-3 text-sm leading-6',
                    'bg-white/70 dark:bg-white/[0.035]',
                    'border border-gray-200/80 dark:border-white/10',
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
                      'mt-1 text-end text-xs',
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
                <div className='relative overflow-hidden rounded-2xl border border-gray-200/80 dark:border-white/10'>
                  <img
                    src={generatedImage}
                    alt='Generated'
                    className='w-full h-auto'
                  />
                  <button
                    onClick={handleDownload}
                    className={cn(
                      'absolute bottom-3 end-3 rounded-lg p-2',
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
        {currentPlugin && (
          <div className='border-t border-gray-200/70 p-4 dark:border-white/[0.08] sm:px-6 sm:py-5'>
            <Button
              onClick={handleGenerate}
              disabled={
                isGenerating ||
                !imageGenerationEnabled ||
                !prompt.trim() ||
                !selectedPlugin ||
                !selectedModel
              }
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
