/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  Download,
  ImageOff,
  Loader2,
  Trash2,
  Volume2,
  Wand2,
} from 'lucide-react';
import { toast } from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type {
  GeneratedImage,
  GeneratedMedia,
  GeneratedMediaKind,
} from '@/types';
import { Button } from '@/components/ui';
import { mediaApi } from '@/utils/api';
import ImageLightbox from './ImageLightbox';

interface MediaGalleryProps {
  kind?: GeneratedMediaKind;
  refreshKey?: number;
  onCountChange?: (count: number) => void;
  onEditImage?: (item: GeneratedMedia) => void;
}

export function MediaGallery({
  kind,
  refreshKey,
  onCountChange,
  onEditImage,
}: MediaGalleryProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const limit = 20;
  const queryKey = ['media-gallery', kind || 'all', refreshKey || 0];
  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ pageParam }) => {
      const response = await mediaApi.getGallery({
        limit,
        offset: pageParam,
        ...(kind ? { kind } : {}),
      });
      if (!response.success || !response.data) {
        throw new Error(response.message || t('imageGallery.loadFailed'));
      }
      return response.data;
    },
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.media.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
  const media = useMemo(
    () => query.data?.pages.flatMap(page => page.media) || [],
    [query.data]
  );
  const total = query.data?.pages[0]?.total || 0;

  useEffect(() => onCountChange?.(total), [onCountChange, total]);

  const remove = async (item: GeneratedMedia) => {
    if (deletingId) return;
    setDeletingId(item.id);
    try {
      const response = await mediaApi.deleteGalleryItem(item.id);
      if (!response.success) throw new Error(response.message);
      setSelectedImage(null);
      await queryClient.invalidateQueries({ queryKey: ['media-gallery'] });
      toast.success(t('imageGallery.deleteSuccess'));
    } catch {
      toast.error(t('imageGallery.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  const download = async (item: GeneratedMedia) => {
    const blob = await mediaApi.getGalleryContent(item.id);
    const source = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = source;
    link.download = `generated-${item.id}.${extensionFor(item.mimeType)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(source);
  };

  if (query.isLoading) {
    return (
      <div className='flex justify-center py-12'>
        <Loader2 className='h-8 w-8 animate-spin text-gray-400' />
      </div>
    );
  }
  if (media.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center rounded-2xl border border-dashed border-gray-300 bg-white/30 px-6 py-12 text-center dark:border-white/15 dark:bg-white/[0.02]'>
        <ImageOff className='mb-4 h-10 w-10 text-gray-300 dark:text-gray-600' />
        <h3 className='text-lg font-medium'>{t('mediaGallery.empty')}</h3>
        <p className='mt-2 max-w-sm text-gray-500 dark:text-gray-400'>
          {t('mediaGallery.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className='grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
        {media.map(item => (
          <article
            key={item.id}
            className='overflow-hidden rounded-2xl border border-gray-200/80 bg-white/70 dark:border-white/10 dark:bg-white/[0.025]'
          >
            <MediaPreview
              item={item}
              onOpenImage={source => setSelectedImage(toImage(item, source))}
            />
            <div className='space-y-3 p-3'>
              <p className='line-clamp-2 text-sm text-gray-800 dark:text-gray-200'>
                {item.prompt}
              </p>
              <div className='flex items-center justify-between gap-2'>
                <span className='min-w-0 truncate text-xs text-gray-500'>
                  {item.model}
                </span>
                <div className='flex shrink-0 gap-1'>
                  {item.kind === 'image' && onEditImage && (
                    <button
                      onClick={() => onEditImage(item)}
                      className='rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-white/10'
                      title={t('imageEdit.title')}
                      data-testid={`edit-image-${item.id}`}
                    >
                      <Wand2 className='h-4 w-4' />
                    </button>
                  )}
                  <button
                    onClick={() => void download(item)}
                    className='rounded-lg p-1.5 hover:bg-gray-100 dark:hover:bg-white/10'
                    title={t('imageGallery.download')}
                  >
                    <Download className='h-4 w-4' />
                  </button>
                  <button
                    onClick={() => void remove(item)}
                    disabled={deletingId === item.id}
                    className='rounded-lg p-1.5 hover:bg-red-500/15 hover:text-red-500'
                    title={t('imageGallery.delete')}
                  >
                    {deletingId === item.id ? (
                      <Loader2 className='h-4 w-4 animate-spin' />
                    ) : (
                      <Trash2 className='h-4 w-4' />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </article>
        ))}
      </div>
      {query.hasNextPage && (
        <div className='mt-8 flex justify-center'>
          <Button
            variant='outline'
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
          >
            {query.isFetchingNextPage
              ? t('common.loading')
              : t('imageGallery.loadMore', { current: media.length, total })}
          </Button>
        </div>
      )}
      {selectedImage && (
        <ImageLightbox
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
          onDelete={id => {
            const item = media.find(candidate => candidate.id === id);
            if (item) void remove(item);
          }}
          onDownload={image => {
            const item = media.find(candidate => candidate.id === image.id);
            if (item) void download(item);
          }}
        />
      )}
    </>
  );
}

function MediaPreview({
  item,
  onOpenImage,
}: {
  item: GeneratedMedia;
  onOpenImage: (source: string) => void;
}) {
  const { data: blob, isLoading } = useQuery({
    queryKey: ['media-gallery-content', item.id],
    queryFn: () => mediaApi.getGalleryContent(item.id),
    staleTime: 5 * 60_000,
  });
  const source = useMemo(() => (blob ? URL.createObjectURL(blob) : ''), [blob]);
  useEffect(
    () => () => {
      if (source) URL.revokeObjectURL(source);
    },
    [source]
  );

  if (isLoading || !source) {
    return (
      <div className='flex aspect-video items-center justify-center bg-gray-100 dark:bg-white/[0.03]'>
        <Loader2 className='h-6 w-6 animate-spin text-gray-400' />
      </div>
    );
  }

  if (item.kind === 'image') {
    return (
      <button
        className='block aspect-square w-full overflow-hidden'
        onClick={() => onOpenImage(source)}
      >
        <img
          src={source}
          alt={item.prompt}
          className='h-full w-full object-cover'
          loading='lazy'
        />
      </button>
    );
  }
  if (item.kind === 'video') {
    return (
      <div className='aspect-video bg-black'>
        <video
          src={source}
          controls
          preload='metadata'
          className='h-full w-full object-contain'
        />
      </div>
    );
  }
  return (
    <div className='flex min-h-40 flex-col items-center justify-center gap-3 bg-gradient-to-br from-primary-500/10 to-cyan-500/10 p-4'>
      <Volume2 className='h-9 w-9 text-primary-500' />
      <audio src={source} controls preload='metadata' className='w-full' />
    </div>
  );
}

function toImage(item: GeneratedMedia, source: string): GeneratedImage {
  return {
    id: item.id,
    userId: item.userId,
    prompt: item.prompt,
    model: item.model,
    imageData: source,
    size: item.size,
    quality: item.quality,
    createdAt: item.createdAt,
  };
}

function extensionFor(mimeType: string): string {
  const subtype = mimeType.split('/')[1]?.split(';')[0];
  if (subtype === 'mpeg') return mimeType.startsWith('audio/') ? 'mp3' : 'mpeg';
  if (subtype === 'svg+xml') return 'svg';
  return subtype || 'bin';
}

export default MediaGallery;
