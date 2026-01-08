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

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, Trash2, Clock, Cpu, Maximize2 } from 'lucide-react';
import { cn } from '@/utils';
import { GeneratedImage } from '@/types';

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
  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    // Prevent body scroll when lightbox is open
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
    };
  }, [onClose]);

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
      link.download = `generated-${image.id}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  return createPortal(
    <div
      className='fixed inset-0 z-[99999] flex items-center justify-center'
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className='absolute inset-0 bg-black/90 backdrop-blur-sm' />

      {/* Content */}
      <div
        className='relative flex flex-col lg:flex-row max-w-7xl max-h-[95vh] w-full mx-4 gap-4'
        onClick={e => e.stopPropagation()}
      >
        {/* Close Button */}
        <button
          onClick={onClose}
          className={cn(
            'absolute -top-12 right-0 lg:top-0 lg:-right-12 z-10',
            'p-2 rounded-full',
            'bg-white/10 hover:bg-white/20',
            'transition-colors'
          )}
        >
          <X className='h-6 w-6 text-white' />
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
            'w-full lg:w-80 flex-shrink-0',
            'bg-white dark:bg-dark-100 ophelia:bg-[#0a0a0a]',
            'rounded-xl p-4 lg:p-5',
            'overflow-y-auto max-h-[25vh] lg:max-h-[90vh]'
          )}
        >
          {/* Prompt */}
          <div className='mb-4'>
            <h3 className='text-sm font-medium text-gray-500 dark:text-gray-400 ophelia:text-[#737373] mb-1'>
              Prompt
            </h3>
            <p className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] text-sm leading-relaxed'>
              {image.prompt}
            </p>
          </div>

          {/* Metadata */}
          <div className='space-y-3 mb-4'>
            <div className='flex items-center gap-2 text-sm'>
              <Cpu className='h-4 w-4 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]' />
              <span className='text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                Model:
              </span>
              <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                {image.model}
              </span>
            </div>

            {image.size && (
              <div className='flex items-center gap-2 text-sm'>
                <Maximize2 className='h-4 w-4 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]' />
                <span className='text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                  Size:
                </span>
                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                  {image.size}
                </span>
              </div>
            )}

            {image.quality && (
              <div className='flex items-center gap-2 text-sm'>
                <span className='w-4 h-4 flex items-center justify-center text-gray-400 dark:text-gray-500 ophelia:text-[#525252] text-xs font-bold'>
                  Q
                </span>
                <span className='text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                  Quality:
                </span>
                <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] capitalize'>
                  {image.quality}
                </span>
              </div>
            )}

            <div className='flex items-center gap-2 text-sm'>
              <Clock className='h-4 w-4 text-gray-400 dark:text-gray-500 ophelia:text-[#525252]' />
              <span className='text-gray-500 dark:text-gray-400 ophelia:text-[#737373]'>
                Created:
              </span>
              <span className='text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa]'>
                {formatDate(image.createdAt)}
              </span>
            </div>
          </div>

          {/* Actions */}
          <div className='flex gap-2 pt-4 border-t border-gray-200 dark:border-dark-300 ophelia:border-[#262626]'>
            <button
              onClick={handleDownload}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg',
                'bg-blue-600 dark:bg-blue-600 ophelia:bg-[#9333ea]',
                'hover:bg-blue-700 dark:hover:bg-blue-500 ophelia:hover:bg-[#a855f7]',
                'text-white font-medium text-sm',
                'transition-colors'
              )}
            >
              <Download className='h-4 w-4' />
              Download
            </button>

            {onDelete && (
              <button
                onClick={() => onDelete(image.id)}
                className={cn(
                  'p-2.5 rounded-lg',
                  'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
                  'hover:bg-red-100 dark:hover:bg-red-900/30 ophelia:hover:bg-red-900/30',
                  'text-gray-600 dark:text-gray-300 ophelia:text-[#a3a3a3]',
                  'hover:text-red-600 dark:hover:text-red-400 ophelia:hover:text-red-400',
                  'transition-colors'
                )}
                title='Delete image'
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
