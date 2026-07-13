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
import { Button, PageHeader, PageShell } from '@/components/ui';

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
    <PageShell width='wide'>
      <PageHeader
        title={t('sidebar.navigation.imagine')}
        description={t('gallery.subtitle')}
        meta={
          imageCount !== null && imageCount > 0 ? (
            <span className='inline-flex rounded-full border border-gray-200/80 bg-white/60 px-2.5 py-1 text-xs text-gray-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-dark-500'>
              {t('gallery.imageCount', { count: imageCount })}
            </span>
          ) : null
        }
        actions={
          <Button onClick={() => setShowImageGen(true)} className='gap-2 px-5'>
            <Plus className='h-4 w-4' aria-hidden='true' />
            {t('gallery.generate')}
          </Button>
        }
      />

      <ImageGallery key={refreshKey} onImageCountChange={setImageCount} />

      <ImageGenerationPanel
        isOpen={showImageGen}
        onClose={() => setShowImageGen(false)}
        onImageGenerated={handleImageGenerated}
      />
    </PageShell>
  );
};

export default GalleryPage;
