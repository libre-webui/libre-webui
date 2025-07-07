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

import React from 'react';
import { useAppStore } from '@/store/appStore';

export const BackgroundRenderer: React.FC = () => {
  const { preferences, backgroundImage } = useAppStore();

  const backgroundSettings = preferences.backgroundSettings || {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
  };

  // Use backgroundImage from store if available, otherwise use the one from preferences
  const activeImageUrl = backgroundImage || backgroundSettings.imageUrl;

  if (!backgroundSettings.enabled || !activeImageUrl) {
    return null;
  }

  return (
    <div
      className='fixed inset-0 pointer-events-none z-0'
      style={{
        backgroundImage: `url(${activeImageUrl})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundRepeat: 'no-repeat',
        filter: `blur(${backgroundSettings.blurAmount}px)`,
        opacity: backgroundSettings.opacity,
        transform: 'scale(1.1)', // Slightly scale up to avoid blur edges
      }}
    />
  );
};
