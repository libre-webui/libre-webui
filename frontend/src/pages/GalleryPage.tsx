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

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import ImageGallery from '@/components/ImageGallery';
import { ImageGenerationPanel } from '@/components/ImageGenerationPanel';
import { Button } from '@/components/ui';
import { cn } from '@/utils';

export const GalleryPage: React.FC = () => {
  const { t } = useTranslation();
  const [imageCount, setImageCount] = useState<number | null>(null);
  const [showImageGen, setShowImageGen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const handleImageGenerated = useCallback(() => {
    // Refresh the gallery when a new image is generated
    setRefreshKey(prev => prev + 1);
  }, []);

  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-7xl mx-auto p-6'>
        {/* Header */}
        <div className='text-center max-w-md mx-auto mb-8'>
          <h2
            className='libre-brand text-4xl sm:text-5xl font-normal text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa] mb-3'
            style={{ fontWeight: 300, letterSpacing: '0.01em' }}
          >
            {t('sidebar.navigation.imagine')}
          </h2>
          <p className='text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3] leading-relaxed'>
            {t('gallery.subtitle')}
            {imageCount !== null && imageCount > 0 && (
              <span className='text-gray-400 dark:text-gray-500 ophelia:text-[#737373]'>
                {' '}
                · {t('gallery.imageCount', { count: imageCount })}
              </span>
            )}
          </p>

          {/* Generate Button */}
          <Button
            onClick={() => setShowImageGen(true)}
            className={cn(
              'mt-4 px-6 py-2.5 rounded-xl font-medium',
              'bg-primary-600 dark:bg-primary-600 ophelia:bg-[#9333ea]',
              'hover:bg-primary-700 dark:hover:bg-primary-500 ophelia:hover:bg-[#a855f7]',
              'text-white',
              'transition-colors'
            )}
          >
            <Plus className='h-4 w-4 mr-2' />
            {t('gallery.generate')}
          </Button>
        </div>

        {/* Gallery */}
        <ImageGallery key={refreshKey} onImageCountChange={setImageCount} />
      </div>

      {/* Image Generation Panel */}
      <ImageGenerationPanel
        isOpen={showImageGen}
        onClose={() => setShowImageGen(false)}
        onImageGenerated={handleImageGenerated}
      />
    </div>
  );
};

export default GalleryPage;
