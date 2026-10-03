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

import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { X, Download, Trash2, Clock, Cpu, Maximize2 } from 'lucide-react';
import { confirmAction } from '@/components/ui/confirmStore';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import { cn } from '@/utils';
import { GeneratedImage } from '@/types';
import { getImageGenImageFileExtension } from '@/utils/api';

interface ImageLightboxProps {
  image: GeneratedImage;
  onClose: () => void;
  onDelete?: (imageId: string) => void;
  onDownload?: (image: GeneratedImage) => void;
}

export const ImageLightbox: React.FC<ImageLightboxProps> = ({
  image,
  onClose,
  onDelete,
  onDownload,
}) => {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  // Focus trap, Escape and focus restore.
  useDialogFocus(dialogRef, { onClose });

  useEffect(() => {
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  const handleDelete = async () => {
    if (!onDelete) return;
    const confirmed = await confirmAction({
      title: t('imageGallery.deleteConfirm'),
      destructive: true,
    });
    if (confirmed) onDelete(image.id);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const handleDownload = () => {
    if (onDownload) {
      onDownload(image);
    } else {
      const link = document.createElement('a');
      link.href = image.imageData;
      link.download = `generated-${
        image.id
      }.${getImageGenImageFileExtension(image.imageData)}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return createPortal(
    <div
      className='fixed inset-0 z-99999 flex items-center justify-center'
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className='absolute inset-0 bg-black/90 backdrop-blur-sm' />

      {/* Content */}
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-label={t('gallery.lightboxLabel')}
        className='relative flex flex-col lg:flex-row max-w-7xl max-h-[95vh] w-full mx-4 gap-4'
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          type='button'
          onClick={onClose}
          aria-label={t('common.close')}
          className={cn(
            'absolute -top-12 inset-e-0 lg:top-0 lg:-inset-e-12 z-10',
            'p-2 rounded-full',
            'bg-white/10 hover:bg-white/20',
            'transition-colors'
          )}
        >
          <X className='h-6 w-6 text-white' aria-hidden='true' />
        </button>

        {/* Image */}
        <div className='flex-1 flex items-center justify-center min-h-0'>
          <img
            src={image.imageData}
            alt={image.prompt}
            className='max-w-full max-h-[70vh] lg:max-h-[90vh] object-contain rounded-lg'
          />
        </div>

        {/* Info Panel */}
        <div
          className={cn(
            'w-full lg:w-80 shrink-0',
            'bg-white dark:bg-dark-100',
            'rounded-xl p-4 lg:p-5',
            'overflow-y-auto max-h-[25vh] lg:max-h-[90vh]'
          )}
        >
          {/* Prompt */}
          <div className='mb-4'>
            <h3 className='text-sm font-medium text-gray-500 dark:text-gray-400 mb-1'>
              {t('gallery.prompt')}
            </h3>
            <p className='text-gray-900 dark:text-gray-100 text-sm leading-relaxed'>
              {image.prompt}
            </p>
          </div>

          {/* Metadata */}
          <div className='space-y-3 mb-4'>
            <div className='flex items-center gap-2 text-sm'>
              <Cpu className='h-4 w-4 text-gray-400 dark:text-gray-500' />
              <span className='text-gray-500 dark:text-gray-400'>
                {t('gallery.model')}:
              </span>
              <span className='text-gray-900 dark:text-gray-100'>
                {image.model}
              </span>
            </div>

            {image.size && (
              <div className='flex items-center gap-2 text-sm'>
                <Maximize2 className='h-4 w-4 text-gray-400 dark:text-gray-500' />
                <span className='text-gray-500 dark:text-gray-400'>
                  {t('gallery.size')}:
                </span>
                <span className='text-gray-900 dark:text-gray-100'>
                  {image.size}
                </span>
              </div>
            )}

            {image.quality && (
              <div className='flex items-center gap-2 text-sm'>
                <span className='w-4 h-4 flex items-center justify-center text-gray-400 dark:text-gray-500 text-xs font-bold'>
                  Q
                </span>
                <span className='text-gray-500 dark:text-gray-400'>
                  {t('gallery.quality')}:
                </span>
                <span className='text-gray-900 dark:text-gray-100 capitalize'>
                  {image.quality}
                </span>
              </div>
            )}

            <div className='flex items-center gap-2 text-sm'>
              <Clock className='h-4 w-4 text-gray-400 dark:text-gray-500' />
              <span className='text-gray-500 dark:text-gray-400'>
                {t('gallery.created')}:
              </span>
              <span className='text-gray-900 dark:text-gray-100'>
                {formatDate(image.createdAt)}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className='flex gap-2 pt-4 border-t border-gray-200 dark:border-dark-300'>
            <button
              type='button'
              onClick={handleDownload}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg',
                'bg-ink text-ink-inverse hover:opacity-90',
                'font-medium text-sm',
                'transition-opacity'
              )}
            >
              <Download className='h-4 w-4' />
              {t('gallery.download')}
            </button>

            {onDelete && (
              <button
                type='button'
                onClick={() => void handleDelete()}
                className={cn(
                  'p-2.5 rounded-lg',
                  'bg-gray-100 dark:bg-dark-200',
                  'hover:bg-red-100 dark:hover:bg-red-900/30',
                  'text-gray-600 dark:text-gray-300',
                  'hover:text-red-600 dark:hover:text-red-400',
                  'transition-colors'
                )}
                title={t('imageGallery.delete')}
                aria-label={t('imageGallery.delete')}
              >
                <Trash2 className='h-4 w-4' />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default ImageLightbox;
