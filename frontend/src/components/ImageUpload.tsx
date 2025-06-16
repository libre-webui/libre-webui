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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  const handleFileSelect = (files: FileList | null) => {
    if (!files) return;

    const newImages: string[] = [];
    const remainingSlots = maxImages - images.length;

    for (let i = 0; i < Math.min(files.length, remainingSlots); i++) {
      const file = files[i];

      if (!file.type.startsWith('image/')) {
        toast.error(`File ${file.name} is not an image`);
        continue;
      }

      if (file.size > 10 * 1024 * 1024) {
        // 10MB limit
        toast.error(`Image ${file.name} is too large (max 10MB)`);
        continue;
      }

      const reader = new FileReader();
      reader.onload = e => {
        if (e.target?.result) {
          newImages.push(e.target.result as string);
          if (newImages.length === Math.min(files.length, remainingSlots)) {
            onImagesChange([...images, ...newImages]);
          }
        }
      };
      reader.readAsDataURL(file);
    }

    if (files.length > remainingSlots) {
      toast.error(`Only ${remainingSlots} more images can be added`);
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
    handleFileSelect(e.dataTransfer.files);
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
            onChange={e => handleFileSelect(e.target.files)}
            className='hidden'
          />

          <div className='flex flex-col items-center text-center'>
            <Upload className='h-8 w-8 text-gray-400 dark:text-gray-500 mb-2' />
            <p className='text-sm text-gray-700 dark:text-gray-300 mb-2'>
              Drop images here or{' '}
              <button
                onClick={() => fileInputRef.current?.click()}
                className='text-primary-600 dark:text-primary-400 hover:underline font-medium'
              >
                browse
              </button>
            </p>
            <p className='text-xs text-gray-500 dark:text-gray-400'>
              Supports: JPG, PNG, GIF, WebP (max 10MB each)
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
                alt={`Upload ${index + 1}`}
                className='w-full h-full object-cover'
              />
              <div className='absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-50 transition-all duration-200 flex items-center justify-center'>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={() => removeImage(index)}
                  className='opacity-0 group-hover:opacity-100 transition-opacity bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 hover:bg-red-100 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 p-1 rounded-full'
                >
                  <X className='h-4 w-4' />
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
          <ImageIcon className='h-4 w-4 mr-2' />
          Add More Images ({images.length}/{maxImages})
        </Button>
      )}
    </div>
  );
};

export default ImageUpload;
