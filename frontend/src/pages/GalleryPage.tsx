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

import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import ImageGallery from '@/components/ImageGallery';

export const GalleryPage: React.FC = () => {
  const [imageCount, setImageCount] = useState<number | null>(null);

  return (
    <div className='h-full overflow-auto'>
      <div className='max-w-7xl mx-auto p-6'>
        {/* Header */}
        <div className='text-center max-w-md mx-auto mb-8'>
          <div className='flex items-center justify-center gap-3 mb-3'>
            <Sparkles className='h-8 w-8 text-purple-500 dark:text-purple-400 ophelia:text-[#a855f7]' />
            <h2
              className='libre-brand text-4xl sm:text-5xl font-normal text-gray-900 dark:text-dark-800 ophelia:text-[#fafafa]'
              style={{ fontWeight: 300, letterSpacing: '0.01em' }}
            >
              Imagine
            </h2>
          </div>
          <p className='text-gray-600 dark:text-dark-600 ophelia:text-[#a3a3a3] leading-relaxed'>
            Your AI-generated image gallery
            {imageCount !== null && imageCount > 0 && (
              <span className='text-gray-400 dark:text-gray-500 ophelia:text-[#737373]'>
                {' '}
                · {imageCount} {imageCount === 1 ? 'image' : 'images'}
              </span>
            )}
          </p>
        </div>

        {/* Gallery */}
        <ImageGallery onImageCountChange={setImageCount} />
      </div>
    </div>
  );
};

export default GalleryPage;
