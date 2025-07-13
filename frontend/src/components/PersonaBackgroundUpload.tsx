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
import { Upload, X, ImageIcon } from 'lucide-react';
import { Button } from '@/components/ui';
import toast from 'react-hot-toast';

interface PersonaBackgroundUploadProps {
  value: string;
  onChange: (backgroundUrl: string) => void;
  className?: string;
}

export const PersonaBackgroundUpload: React.FC<
  PersonaBackgroundUploadProps
> = ({ value, onChange, className = '' }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please select a valid image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      // 5MB limit for background images
      toast.error('Background image size must be less than 5MB');
      return;
    }

    setUploading(true);
    try {
      // Convert to data URL
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target?.result as string;
        onChange(dataUrl);
        toast.success('Background uploaded successfully');
      };
      reader.onerror = () => {
        toast.error('Failed to read image file');
      };
      reader.readAsDataURL(file);
    } catch (error) {
      console.error('Failed to upload background:', error);
      toast.error('Failed to upload background image');
    } finally {
      setUploading(false);
    }
  };

  const handleFileInputChange = (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);

    const file = event.dataTransfer.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleRemoveBackground = () => {
    onChange('');
    toast.success('Background removed');
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div>
        <label className='block text-sm font-medium text-gray-700 dark:text-dark-600 mb-2'>
          Background Image
        </label>

        {/* Background Preview and Upload Area */}
        <div className='space-y-3'>
          {value ? (
            <div className='space-y-3'>
              {/* Preview */}
              <div
                className='w-full h-32 rounded-lg bg-cover bg-center border-2 border-gray-300 dark:border-dark-300'
                style={{
                  backgroundImage: `url(${value})`,
                }}
              />

              {/* Controls */}
              <div className='flex items-center gap-3 p-3 bg-gray-50 dark:bg-dark-200 rounded-lg'>
                <div className='flex-1 min-w-0'>
                  <p className='text-sm font-medium text-gray-900 dark:text-gray-100 truncate'>
                    Custom background image
                  </p>
                  <p className='text-xs text-gray-500 dark:text-gray-400'>
                    Click to change or remove
                  </p>
                </div>
                <Button
                  variant='ghost'
                  size='sm'
                  onClick={handleRemoveBackground}
                  className='text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:text-red-300 dark:hover:bg-red-900/20'
                >
                  <X className='h-4 w-4' />
                </Button>
              </div>
            </div>
          ) : (
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                dragOver
                  ? 'border-primary-500 bg-primary-50 dark:bg-primary-900/20'
                  : 'border-gray-300 dark:border-gray-600 hover:border-gray-400 dark:hover:border-gray-500'
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <ImageIcon className='h-12 w-12 mx-auto text-gray-400 dark:text-gray-500 mb-4' />
              <p className='text-sm font-medium text-gray-900 dark:text-gray-100 mb-2'>
                Upload background image
              </p>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-4'>
                Drag and drop an image or click to browse
              </p>
              <Button
                variant='outline'
                size='sm'
                disabled={uploading}
                className='mx-auto'
              >
                <Upload className='h-4 w-4 mr-2' />
                {uploading ? 'Uploading...' : 'Choose Image'}
              </Button>
            </div>
          )}

          {/* URL Input Alternative */}
          <div>
            <label className='block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1'>
              Or enter image URL
            </label>
            <input
              type='url'
              value={value}
              onChange={e => onChange(e.target.value)}
              className='w-full px-3 py-2 text-sm border border-gray-300 dark:border-dark-300 rounded-md bg-white dark:bg-dark-50 text-gray-900 dark:text-dark-800'
              placeholder='https://example.com/background.jpg'
            />
          </div>
        </div>

        <input
          ref={fileInputRef}
          type='file'
          accept='image/*'
          onChange={handleFileInputChange}
          className='hidden'
        />

        <p className='text-xs text-gray-500 dark:text-gray-400 mt-2'>
          Supports: JPG, PNG, GIF, WebP (max 5MB). Wide landscape images work
          best.
        </p>
      </div>
    </div>
  );
};

export default PersonaBackgroundUpload;
