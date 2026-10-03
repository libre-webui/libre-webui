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

import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Upload, X, Image as ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/utils';
import toast from 'react-hot-toast';

interface ImageUploadProps {
  images: string[];
  onImagesChange: (images: string[]) => void;
  maxImages?: number;
  className?: string;
}

export const ImageUpload: React.FC<ImageUploadProps> = ({
  images,
  onImagesChange,
  maxImages = 5,
  className,
}) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const readAsDataUrl = (file: File): Promise<string | null> =>
    new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => {
        toast.error(t('chat.mediaUpload.readFailed', { name: file.name }));
        resolve(null);
      };
      reader.readAsDataURL(file);
    });

  const handleFileSelect = async (files: FileList | null) => {
    if (!files) return;

    const remainingSlots = maxImages - images.length;
    const candidates = Array.from(files).slice(0, Math.max(remainingSlots, 0));

    // Reject invalid files individually so one bad file cannot drop the rest.
    const accepted = candidates.filter(file => {
      if (!file.type.startsWith('image/')) {
        toast.error(
          t('chat.mediaUpload.unsupportedFileType', { name: file.name })
        );
        return false;
      }
      if (file.size > 10 * 1024 * 1024) {
        // 10MB limit
        toast.error(t('chat.mediaUpload.imageTooLarge', { name: file.name }));
        return false;
      }
      return true;
    });

    if (files.length > remainingSlots) {
      toast.error(t('chat.mediaUpload.maxImagesAllowed', { count: maxImages }));
    }

    const results = await Promise.all(accepted.map(readAsDataUrl));
    const newImages = results.filter(
      (result): result is string => result !== null
    );
    if (newImages.length > 0) {
      onImagesChange([...images, ...newImages]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    void handleFileSelect(e.dataTransfer.files);
  };

  const removeImage = (index: number) => {
    const newImages = images.filter((_, i) => i !== index);
    onImagesChange(newImages);
  };

  const canAddMore = images.length < maxImages;

  return (
    <div className={cn('space-y-3', className)}>
      {/* Upload Area */}
      {canAddMore && (
        <div
          className={cn(
            'border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-4 transition-colors',
            'hover:border-primary-400 dark:hover:border-primary-500',
            dragActive &&
              'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type='file'
            multiple
            accept='image/*'
            onChange={e => {
              void handleFileSelect(e.target.files);
              // Allow re-selecting the same file after it was removed.
              e.target.value = '';
            }}
            className='hidden'
          />

          <div className='flex flex-col items-center text-center'>
            <Upload
              className='h-8 w-8 text-gray-400 dark:text-gray-500 mb-2'
              aria-hidden='true'
            />
            <p className='text-sm text-gray-700 dark:text-gray-300 mb-2'>
              {t('chat.mediaUpload.dropImagesHere')}{' '}
              <button
                type='button'
                onClick={() => fileInputRef.current?.click()}
                className='text-primary-600 dark:text-primary-400 hover:underline font-medium'
              >
                {t('chat.mediaUpload.browse')}
              </button>
            </p>
            <p className='text-xs text-ink-muted'>
              {t('chat.mediaUpload.supportedFormats')}
            </p>
          </div>
        </div>
      )}

      {/* Image Preview Grid */}
      {images.length > 0 && (
        <div className='grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3'>
          {images.map((image, index) => (
            <div
              key={index}
              className='relative group aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700'
            >
              <img
                src={image}
                alt={t('chat.mediaUpload.uploadAlt', { number: index + 1 })}
                className='w-full h-full object-cover'
              />
              <div className='absolute inset-0 bg-black/0 group-hover:bg-black/50 transition-all duration-200 flex items-center justify-center'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => removeImage(index)}
                  aria-label={t('chat.mediaUpload.removeImage', {
                    number: index + 1,
                  })}
                  className='opacity-0 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 p-1 rounded-full'
                >
                  <X className='h-4 w-4' aria-hidden='true' />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Quick Add Button */}
      {canAddMore && images.length > 0 && (
        <Button
          variant='outline'
          size='sm'
          onClick={() => fileInputRef.current?.click()}
          className='w-full sm:w-auto'
        >
          <ImageIcon className='h-4 w-4' aria-hidden='true' />
          {t('chat.mediaUpload.addMore', {
            count: images.length,
            max: maxImages,
          })}
        </Button>
      )}
    </div>
  );
};

export default ImageUpload;
