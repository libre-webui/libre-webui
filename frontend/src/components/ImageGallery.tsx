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

import React, { useState, useEffect, useCallback } from 'react';
import { Trash2, Download, Loader2, ImageOff } from 'lucide-react';
import { cn } from '@/utils';
import { imageGenApi } from '@/utils/api';
import { GeneratedImage } from '@/types';
import { toast } from 'react-hot-toast';
import ImageLightbox from './ImageLightbox';

interface ImageGalleryProps {
  onImageCountChange?: (count: number) => void;
}

export const ImageGallery: React.FC<ImageGalleryProps> = ({
  onImageCountChange,
}) => {
  const [images, setImages] = useState<GeneratedImage[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [selectedImage, setSelectedImage] = useState<GeneratedImage | null>(
    null
  );
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const LIMIT = 20;

  const loadImages = useCallback(
    async (offset = 0, append = false) => {
      try {
        if (offset === 0) {
          setIsLoading(true);
        } else {
          setIsLoadingMore(true);
        }

        const response = await imageGenApi.getGallery({ limit: LIMIT, offset });

        if (response.success && response.data) {
          if (append) {
            setImages(prev => [...prev, ...response.data!.images]);
          } else {
            setImages(response.data.images);
          }
          setTotal(response.data.total);
          onImageCountChange?.(response.data.total);
        }
      } catch (error) {
        console.error('Failed to load gallery:', error);
        toast.error('Failed to load gallery');
      } finally {
        setIsLoading(false);
        setIsLoadingMore(false);
      }
    },
    [onImageCountChange]
  );

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  const handleLoadMore = () => {
    loadImages(images.length, true);
  };

  const handleDelete = async (imageId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    if (deletingId) return;

    setDeletingId(imageId);
    try {
      const response = await imageGenApi.deleteGalleryImage(imageId);
      if (response.success) {
        setImages(prev => prev.filter(img => img.id !== imageId));
        setTotal(prev => prev - 1);
        onImageCountChange?.(total - 1);
        toast.success('Image deleted');

        // Close lightbox if deleting the currently viewed image
        if (selectedImage?.id === imageId) {
          setSelectedImage(null);
        }
      } else {
        toast.error('Failed to delete image');
      }
    } catch (error) {
      console.error('Failed to delete image:', error);
      toast.error('Failed to delete image');
    } finally {
      setDeletingId(null);
    }
  };

  const handleDownload = (image: GeneratedImage, e: React.MouseEvent) => {
    e.stopPropagation();

    const link = document.createElement('a');
    link.href = image.imageData;
    link.download = `generated-${image.id}.png`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  if (isLoading) {
    return (
      <div className='flex items-center justify-center py-20'>
        <Loader2 className='h-8 w-8 animate-spin text-gray-400 dark:text-gray-500' />
      </div>
    );
  }

  if (images.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center py-20 text-center'>
        <ImageOff className='h-16 w-16 text-gray-300 dark:text-gray-600 ophelia:text-[#404040] mb-4' />
        <h3 className='text-lg font-medium text-gray-900 dark:text-gray-100 ophelia:text-[#fafafa] mb-2'>
          No images yet
        </h3>
        <p className='text-gray-500 dark:text-gray-400 ophelia:text-[#737373] max-w-sm'>
          Generated images will appear here. Use the image generation feature to
          create your first image.
        </p>
      </div>
    );
  }

  return (
    <>
      {/* Masonry Grid using CSS columns */}
      <div
        className={cn(
          'columns-1 sm:columns-2 lg:columns-3 xl:columns-4',
          'gap-4 space-y-4'
        )}
      >
        {images.map(image => (
          <div
            key={image.id}
            className={cn(
              'break-inside-avoid group relative cursor-pointer',
              'rounded-xl overflow-hidden',
              'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#121212]',
              'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
              'hover:border-gray-300 dark:hover:border-dark-400 ophelia:hover:border-[#404040]',
              'transition-all duration-200',
              'hover:shadow-lg dark:hover:shadow-dark-400/20 ophelia:hover:shadow-[#9333ea]/10'
            )}
            onClick={() => setSelectedImage(image)}
          >
            {/* Image */}
            <img
              src={image.imageData}
              alt={image.prompt}
              className='w-full h-auto object-cover'
              loading='lazy'
            />

            {/* Hover Overlay */}
            <div
              className={cn(
                'absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent',
                'opacity-0 group-hover:opacity-100 transition-opacity duration-200',
                'flex flex-col justify-end p-3'
              )}
            >
              {/* Prompt Preview */}
              <p className='text-white text-sm line-clamp-2 mb-2'>
                {image.prompt}
              </p>

              {/* Meta Info */}
              <div className='flex items-center justify-between'>
                <span className='text-white/70 text-xs'>
                  {formatDate(image.createdAt)}
                </span>

                {/* Action Buttons */}
                <div className='flex items-center gap-1'>
                  <button
                    onClick={e => handleDownload(image, e)}
                    className={cn(
                      'p-1.5 rounded-lg',
                      'bg-white/20 hover:bg-white/30',
                      'transition-colors'
                    )}
                    title='Download'
                  >
                    <Download className='h-4 w-4 text-white' />
                  </button>
                  <button
                    onClick={e => handleDelete(image.id, e)}
                    disabled={deletingId === image.id}
                    className={cn(
                      'p-1.5 rounded-lg',
                      'bg-white/20 hover:bg-red-500/80',
                      'transition-colors',
                      deletingId === image.id && 'opacity-50 cursor-not-allowed'
                    )}
                    title='Delete'
                  >
                    {deletingId === image.id ? (
                      <Loader2 className='h-4 w-4 text-white animate-spin' />
                    ) : (
                      <Trash2 className='h-4 w-4 text-white' />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Load More Button */}
      {images.length < total && (
        <div className='flex justify-center mt-8'>
          <button
            onClick={handleLoadMore}
            disabled={isLoadingMore}
            className={cn(
              'px-6 py-2.5 rounded-xl font-medium',
              'bg-gray-100 dark:bg-dark-200 ophelia:bg-[#1a1a1a]',
              'hover:bg-gray-200 dark:hover:bg-dark-300 ophelia:hover:bg-[#262626]',
              'text-gray-700 dark:text-gray-200 ophelia:text-[#fafafa]',
              'border border-gray-200 dark:border-dark-300 ophelia:border-[#262626]',
              'transition-colors',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
          >
            {isLoadingMore ? (
              <span className='flex items-center gap-2'>
                <Loader2 className='h-4 w-4 animate-spin' />
                Loading...
              </span>
            ) : (
              `Load More (${images.length} of ${total})`
            )}
          </button>
        </div>
      )}

      {/* Lightbox */}
      {selectedImage && (
        <ImageLightbox
          image={selectedImage}
          onClose={() => setSelectedImage(null)}
          onDelete={id => {
            handleDelete(id, { stopPropagation: () => {} } as React.MouseEvent);
          }}
          onDownload={img => {
            handleDownload(img, {
              stopPropagation: () => {},
            } as React.MouseEvent);
          }}
        />
      )}
    </>
  );
};

export default ImageGallery;
