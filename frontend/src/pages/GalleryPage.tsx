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
import { Film, ImageIcon, Volume2 } from 'lucide-react';
import { ImageGenerationPanel } from '@/components/ImageGenerationPanel';
import { MediaGenerationPanel } from '@/components/MediaGenerationPanel';
import { ImageEditPanel } from '@/components/ImageEditPanel';
import MediaGallery from '@/components/MediaGallery';
import { Button, PageHeader, PageShell } from '@/components/ui';
import { useAppStore } from '@/store/appStore';
import type { GeneratedMedia, GeneratedMediaKind } from '@/types';
import { cn } from '@/utils';

export const GalleryPage: React.FC = () => {
  const { t } = useTranslation();
  const [mediaCount, setMediaCount] = useState<number | null>(null);
  const [showImageGen, setShowImageGen] = useState(false);
  const [mediaGenerationKind, setMediaGenerationKind] = useState<
    'video' | 'audio' | null
  >(null);
  const [filter, setFilter] = useState<'all' | GeneratedMediaKind>('all');
  const [editSource, setEditSource] = useState<GeneratedMedia | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const imageGenerationEnabled = useAppStore(
    state => state.preferences.imageGenSettings?.enabled === true
  );

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
          mediaCount !== null && mediaCount > 0 ? (
            <span className='inline-flex rounded-full border border-gray-200/80 bg-white/60 px-2.5 py-1 text-xs text-gray-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-dark-500'>
              {t('mediaGallery.itemCount', { count: mediaCount })}
            </span>
          ) : null
        }
        actions={
          <div className='flex flex-wrap gap-2'>
            <Button
              onClick={() => {
                if (imageGenerationEnabled) setShowImageGen(true);
              }}
              disabled={!imageGenerationEnabled}
              className='gap-2 px-4'
            >
              <ImageIcon className='h-4 w-4' aria-hidden='true' />
              {t('gallery.generate')}
            </Button>
            <Button
              variant='outline'
              onClick={() => setMediaGenerationKind('video')}
              className='gap-2 px-4'
            >
              <Film className='h-4 w-4' aria-hidden='true' />
              {t('mediaGeneration.video')}
            </Button>
            <Button
              variant='outline'
              onClick={() => setMediaGenerationKind('audio')}
              className='gap-2 px-4'
            >
              <Volume2 className='h-4 w-4' aria-hidden='true' />
              {t('mediaGeneration.audio')}
            </Button>
          </div>
        }
      />

      <div className='mb-5 flex flex-wrap gap-2'>
        {(['all', 'image', 'video', 'audio'] as const).map(value => (
          <button
            key={value}
            type='button'
            onClick={() => setFilter(value)}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-colors',
              filter === value
                ? 'border-gray-950 bg-gray-950 text-white dark:border-white dark:bg-white dark:text-gray-950'
                : 'border-gray-200 text-gray-600 hover:border-gray-400 dark:border-white/10 dark:text-dark-600'
            )}
          >
            {t(`mediaGallery.filters.${value}`)}
          </button>
        ))}
      </div>

      <MediaGallery
        kind={filter === 'all' ? undefined : filter}
        refreshKey={refreshKey}
        onCountChange={setMediaCount}
        onEditImage={setEditSource}
      />

      <ImageEditPanel
        isOpen={editSource !== null}
        source={editSource}
        onClose={() => setEditSource(null)}
        onEdited={handleImageGenerated}
      />

      <ImageGenerationPanel
        isOpen={showImageGen && imageGenerationEnabled}
        onClose={() => setShowImageGen(false)}
        onImageGenerated={handleImageGenerated}
      />

      <MediaGenerationPanel
        key={mediaGenerationKind || 'closed'}
        isOpen={mediaGenerationKind !== null}
        initialKind={mediaGenerationKind || 'video'}
        onClose={() => setMediaGenerationKind(null)}
        onGenerated={handleImageGenerated}
      />
    </PageShell>
  );
};

export default GalleryPage;
