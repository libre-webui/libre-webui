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
import { Button } from '@/components/ui';
import { useAppStore } from '@/store/appStore';
import { preferencesApi } from '@/utils/api';
import toast from 'react-hot-toast';

interface BackgroundUploadProps {
  className?: string;
}

export const BackgroundUpload: React.FC<BackgroundUploadProps> = ({
  className = '',
}) => {
  const { t } = useTranslation();
  const {
    preferences,
    setPreferences,
    backgroundImage,
    uploadBackgroundImage,
    removeBackgroundImage,
  } = useAppStore();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const backgroundSettings = preferences.backgroundSettings || {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
  };

  const handleFileSelect = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast.error('Please select a valid image file');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      // 5MB limit
      toast.error('Image file size must be less than 5MB');
      return;
    }

    setUploading(true);
    try {
      await uploadBackgroundImage(file);
      toast.success('Background image uploaded successfully');
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
    removeBackgroundImage();
    toast.success('Background image removed');
  };

  const handleToggleBackground = async (enabled: boolean) => {
    // Always use backgroundImage from store as the source of truth
    const currentImageUrl =
      backgroundImage || backgroundSettings.imageUrl || '';
    const updatedBackgroundSettings = {
      ...backgroundSettings,
      imageUrl: currentImageUrl,
      enabled,
    };
    setPreferences({
      backgroundSettings: updatedBackgroundSettings,
    });

    // Only save to backend if we have valid data (don't overwrite with empty values)
    if (currentImageUrl || !enabled) {
      try {
        await preferencesApi.updatePreferences({
          backgroundSettings: updatedBackgroundSettings,
        });
      } catch (error) {
        console.error('Failed to update preferences:', error);
      }
    }
  };

  const handleBlurChange = async (blurAmount: number) => {
    // Always use backgroundImage from store as the source of truth
    const currentImageUrl =
      backgroundImage || backgroundSettings.imageUrl || '';
    const updatedBackgroundSettings = {
      ...backgroundSettings,
      imageUrl: currentImageUrl,
      blurAmount,
    };
    setPreferences({
      backgroundSettings: updatedBackgroundSettings,
    });

    // Only save to backend if we have a valid image
    if (currentImageUrl) {
      try {
        await preferencesApi.updatePreferences({
          backgroundSettings: updatedBackgroundSettings,
        });
      } catch (error) {
        console.error('Failed to update preferences:', error);
      }
    }
  };

  const handleOpacityChange = async (opacity: number) => {
    // Always use backgroundImage from store as the source of truth
    const currentImageUrl =
      backgroundImage || backgroundSettings.imageUrl || '';
    const updatedBackgroundSettings = {
      ...backgroundSettings,
      imageUrl: currentImageUrl,
      opacity,
    };
    setPreferences({
      backgroundSettings: updatedBackgroundSettings,
    });

    // Only save to backend if we have a valid image
    if (currentImageUrl) {
      try {
        await preferencesApi.updatePreferences({
          backgroundSettings: updatedBackgroundSettings,
        });
      } catch (error) {
        console.error('Failed to update preferences:', error);
      }
    }
  };

  return (
    <div className={`space-y-4 ${className}`}>
      <div>
        <h4 className='text-md font-medium text-gray-900 dark:text-gray-100 mb-3'>
          {t('settings.appearance.background.title')}
        </h4>

        {/* Toggle Background */}
        <div className='flex items-center justify-between mb-4'>
          <div className='flex flex-col'>
            <span className='text-sm font-medium text-gray-700 dark:text-gray-300'>
              {t('settings.appearance.background.enable')}
            </span>
            <span className='text-xs text-gray-500 dark:text-gray-400'>
              {t('settings.appearance.background.enableDescription')}
            </span>
          </div>
          <label className='relative inline-flex items-center cursor-pointer'>
            <input
              type='checkbox'
              className='sr-only peer'
              checked={backgroundSettings.enabled}
              onChange={e => handleToggleBackground(e.target.checked)}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 dark:peer-focus:ring-primary-800 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-primary-600"></div>
          </label>
        </div>

        {/* Upload Area */}
        <div className='space-y-4'>
          {backgroundImage ? (
            <div className='relative'>
              <div className='flex items-center gap-3 p-3 bg-gray-50 dark:bg-dark-200 rounded-lg'>
                <div className='flex-shrink-0'>
                  <img
                    src={backgroundImage}
                    alt='Background preview'
                    className='w-12 h-12 object-cover rounded-md'
                  />
                </div>
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
                {t('settings.appearance.background.upload')}
              </p>
              <p className='text-xs text-gray-500 dark:text-gray-400 mb-4'>
                {t('settings.appearance.background.dragDrop')}
              </p>
              <Button
                variant='outline'
                size='sm'
                disabled={uploading}
                className='mx-auto'
              >
                <Upload className='h-4 w-4 mr-2' />
                {uploading
                  ? t('common.loading')
                  : t('settings.appearance.background.chooseImage')}
              </Button>
            </div>
          )}

          <input
            ref={fileInputRef}
            type='file'
            accept='image/*'
            onChange={handleFileInputChange}
            className='hidden'
          />
        </div>

        {/* Background Settings */}
        {backgroundImage && (
          <div className='space-y-4 mt-4'>
            {/* Blur Amount */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                {t('settings.appearance.background.blur')}:{' '}
                {backgroundSettings.blurAmount}px
              </label>
              <input
                type='range'
                min='0'
                max='30'
                step='1'
                value={backgroundSettings.blurAmount}
                onChange={e => handleBlurChange(parseInt(e.target.value))}
                className='w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700'
              />
            </div>

            {/* Opacity */}
            <div>
              <label className='block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2'>
                {t('settings.appearance.background.opacity')}:{' '}
                {Math.round(backgroundSettings.opacity * 100)}%
              </label>
              <input
                type='range'
                min='0.1'
                max='1'
                step='0.1'
                value={backgroundSettings.opacity}
                onChange={e => handleOpacityChange(parseFloat(e.target.value))}
                className='w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700'
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
