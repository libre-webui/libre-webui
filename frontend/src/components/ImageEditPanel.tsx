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

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Eraser, Loader2, Wand2, X } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { Button } from '@/components/ui';
import { imageGenApi, mediaApi, type ImageGenModel } from '@/utils/api';
import type { GeneratedMedia } from '@/types';
import { createLogger } from '@/utils/logger';

const logger = createLogger('components:image-edit-panel');

interface ImageEditPanelProps {
  isOpen: boolean;
  onClose: () => void;
  source: GeneratedMedia | null;
  onEdited: () => void;
}

const editableModels = (models: ImageGenModel[]): ImageGenModel[] =>
  models.filter(model => Boolean(model.config?.edit_endpoint));

/**
 * Inpainting and compositing editor (IMAGE-01): paint a mask over a gallery
 * image (painted regions are repainted by the model), optionally attach
 * reference images for compositing, and describe the change. The result is
 * saved back to the gallery with provenance.
 */
export const ImageEditPanel: React.FC<ImageEditPanelProps> = ({
  isOpen,
  onClose,
  source,
  onEdited,
}) => {
  const { t } = useTranslation();
  const [models, setModels] = useState<ImageGenModel[]>([]);
  const [selectionKey, setSelectionKey] = useState('');
  const [prompt, setPrompt] = useState('');
  const [brushSize, setBrushSize] = useState(36);
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [generating, setGenerating] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [hasMask, setHasMask] = useState(false);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const strokesRef = useRef<HTMLCanvasElement | null>(null);
  const displayRef = useRef<HTMLCanvasElement | null>(null);
  const paintingRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);

  const selected = models.find(
    model => `${model.plugin}:${model.model}` === selectionKey
  );

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    void imageGenApi.getModels().then(response => {
      if (cancelled || !response.success || !response.data) return;
      const editable = editableModels(response.data);
      setModels(editable);
      setSelectionKey(current =>
        editable.some(model => `${model.plugin}:${model.model}` === current)
          ? current
          : editable[0]
            ? `${editable[0].plugin}:${editable[0].model}`
            : ''
      );
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !source) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    void mediaApi
      .getGalleryContent(source.id)
      .then(blob => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(error => {
        logger.error('Failed to load the source image:', error);
        toast.error(t('imageEdit.loadFailed'));
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setImageUrl(null);
      setHasMask(false);
      setReferenceFiles([]);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, source?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const redraw = () => {
    const display = displayRef.current;
    const image = imageRef.current;
    const strokes = strokesRef.current;
    if (!display || !image || !strokes) return;
    const context = display.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, display.width, display.height);
    context.drawImage(image, 0, 0, display.width, display.height);
    context.save();
    context.globalAlpha = 0.55;
    context.drawImage(strokes, 0, 0, display.width, display.height);
    context.restore();
  };

  const handleImageLoaded = () => {
    const image = imageRef.current;
    const display = displayRef.current;
    if (!image || !display) return;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    display.width = width;
    display.height = height;
    const strokes = document.createElement('canvas');
    strokes.width = width;
    strokes.height = height;
    strokesRef.current = strokes;
    setHasMask(false);
    redraw();
  };

  const paintAt = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const display = displayRef.current;
    const strokes = strokesRef.current;
    if (!display || !strokes) return;
    const rect = display.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * display.width;
    const y = ((event.clientY - rect.top) / rect.height) * display.height;
    const context = strokes.getContext('2d');
    if (!context) return;
    const radius = (brushSize / rect.width) * display.width;
    context.fillStyle = 'rgba(239, 68, 68, 1)';
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
    setHasMask(true);
    redraw();
  };

  const clearMask = () => {
    const strokes = strokesRef.current;
    if (!strokes) return;
    strokes.getContext('2d')?.clearRect(0, 0, strokes.width, strokes.height);
    setHasMask(false);
    redraw();
  };

  const buildMaskBlob = async (): Promise<Blob | null> => {
    const strokes = strokesRef.current;
    if (!strokes || !hasMask) return null;
    const mask = document.createElement('canvas');
    mask.width = strokes.width;
    mask.height = strokes.height;
    const context = mask.getContext('2d');
    if (!context) return null;
    // Opaque everywhere, then erase the painted regions: transparent mask
    // pixels are the areas the provider repaints.
    context.fillStyle = '#000000';
    context.fillRect(0, 0, mask.width, mask.height);
    context.globalCompositeOperation = 'destination-out';
    context.drawImage(strokes, 0, 0);
    return new Promise(resolve =>
      mask.toBlob(blob => resolve(blob), 'image/png')
    );
  };

  const handleSubmit = async () => {
    if (!source || !selected || !prompt.trim() || generating) return;
    setGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const mask = await buildMaskBlob();
      const response = await mediaApi.editImage(
        {
          model: selected.model,
          pluginId: selected.plugin,
          prompt: prompt.trim(),
          sourceMediaId: source.id,
          images: referenceFiles,
          ...(mask ? { mask } : {}),
        },
        controller.signal
      );
      if (!response.success) {
        throw new Error(response.message || response.error || 'Edit failed');
      }
      toast.success(t('imageEdit.saved'));
      onEdited();
      onClose();
    } catch (error) {
      if (!controller.signal.aborted) {
        logger.error('Image edit failed:', error);
        toast.error(
          error instanceof Error ? error.message : t('imageEdit.failed')
        );
      }
    } finally {
      setGenerating(false);
      abortRef.current = null;
    }
  };

  if (!isOpen || !source) return null;

  const maxReferences = Math.max(
    0,
    (selected?.config?.max_reference_images ?? 1) - 1
  );

  return createPortal(
    <div
      role='dialog'
      aria-modal='true'
      aria-label={t('imageEdit.title')}
      className='fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4'
      data-testid='image-edit-panel'
    >
      <div className='flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl dark:bg-dark-100'>
        <div className='flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-dark-300'>
          <h2 className='flex items-center gap-2 text-base font-semibold text-gray-900 dark:text-gray-100'>
            <Wand2 className='h-4 w-4' />
            {t('imageEdit.title')}
          </h2>
          <button
            type='button'
            onClick={onClose}
            aria-label={t('common.close')}
            className='rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-dark-200'
          >
            <X className='h-5 w-5' />
          </button>
        </div>
        <div className='flex-1 space-y-4 overflow-y-auto p-4'>
          {models.length === 0 ? (
            <p className='text-sm text-gray-600 dark:text-gray-400'>
              {t('imageEdit.noModels')}
            </p>
          ) : (
            <>
              <div className='relative'>
                {imageUrl ? (
                  <>
                    <img
                      ref={imageRef}
                      src={imageUrl}
                      alt={source.prompt}
                      className='hidden'
                      onLoad={handleImageLoaded}
                    />
                    <canvas
                      ref={displayRef}
                      onPointerDown={event => {
                        paintingRef.current = true;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        paintAt(event);
                      }}
                      onPointerMove={event => {
                        if (paintingRef.current) paintAt(event);
                      }}
                      onPointerUp={() => {
                        paintingRef.current = false;
                      }}
                      className='w-full cursor-crosshair rounded-xl border border-gray-200 dark:border-dark-300'
                      data-testid='image-edit-canvas'
                    />
                  </>
                ) : (
                  <div className='flex h-56 items-center justify-center'>
                    <Loader2 className='h-6 w-6 animate-spin text-gray-400' />
                  </div>
                )}
              </div>
              <p className='text-xs text-gray-500 dark:text-gray-400'>
                {t('imageEdit.maskHint')}
              </p>
              <div className='flex flex-wrap items-center gap-3'>
                <label className='flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300'>
                  {t('imageEdit.brushSize')}
                  <input
                    type='range'
                    min={8}
                    max={96}
                    value={brushSize}
                    onChange={event => setBrushSize(Number(event.target.value))}
                  />
                </label>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  onClick={clearMask}
                  disabled={!hasMask}
                >
                  <Eraser className='mr-1 h-3.5 w-3.5' />
                  {t('imageEdit.clearMask')}
                </Button>
              </div>
              <label className='block text-xs font-medium text-gray-700 dark:text-gray-300'>
                {t('imageEdit.model')}
                <select
                  value={selectionKey}
                  onChange={event => setSelectionKey(event.target.value)}
                  className='mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50'
                >
                  {models.map(model => (
                    <option
                      key={`${model.plugin}:${model.model}`}
                      value={`${model.plugin}:${model.model}`}
                    >
                      {model.plugin} · {model.model}
                    </option>
                  ))}
                </select>
              </label>
              <label className='block text-xs font-medium text-gray-700 dark:text-gray-300'>
                {t('imageEdit.prompt')}
                <textarea
                  value={prompt}
                  onChange={event => setPrompt(event.target.value)}
                  rows={3}
                  placeholder={t('imageEdit.promptPlaceholder')}
                  className='mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-dark-300 dark:bg-dark-50'
                  data-testid='image-edit-prompt'
                />
              </label>
              {maxReferences > 0 && (
                <label className='block text-xs font-medium text-gray-700 dark:text-gray-300'>
                  {t('imageEdit.referenceImages', { total: maxReferences })}
                  <input
                    type='file'
                    accept='image/png,image/jpeg,image/webp'
                    multiple
                    onChange={event =>
                      setReferenceFiles(
                        Array.from(event.target.files ?? []).slice(
                          0,
                          maxReferences
                        )
                      )
                    }
                    className='mt-1 block w-full text-xs'
                  />
                </label>
              )}
            </>
          )}
        </div>
        <div className='flex items-center justify-end gap-2 border-t border-gray-200 px-4 py-3 dark:border-dark-300'>
          <Button type='button' variant='outline' onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            type='button'
            onClick={() => void handleSubmit()}
            disabled={generating || !selected || !prompt.trim() || !imageUrl}
            data-testid='image-edit-submit'
          >
            {generating ? (
              <Loader2 className='mr-1 h-4 w-4 animate-spin' />
            ) : (
              <Wand2 className='mr-1 h-4 w-4' />
            )}
            {t('imageEdit.apply')}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImageEditPanel;
