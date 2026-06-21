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

import type { ApiResponse, GeneratedImage } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

// Image Generation API
export interface ImageGenModel {
  model: string;
  plugin: string;
  config?: {
    sizes?: string[];
    default_size?: string;
    qualities?: string[];
    default_quality?: string;
    styles?: string[];
    default_style?: string;
    max_prompt_length?: number;
  };
}

export interface ImageGenPlugin {
  id: string;
  name: string;
  models: string[];
  config?: ImageGenModel['config'];
}

export interface ImageGenRequest {
  model: string;
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
}

export interface ImageGenResponse {
  images: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

export const imageGenApi = {
  // Get all available image generation models
  getModels: (): Promise<ApiResponse<ImageGenModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<ImageGenModel[]>([
        {
          model: 'dall-e-3',
          plugin: 'openai',
          config: {
            sizes: ['1024x1024', '1792x1024', '1024x1792'],
            default_size: '1024x1024',
            qualities: ['standard', 'hd'],
            default_quality: 'standard',
            styles: ['vivid', 'natural'],
            default_style: 'vivid',
            max_prompt_length: 4000,
          },
        },
      ]);
    }

    return api.get('/image-gen/models').then(res => res.data);
  },

  // Get image generation plugins
  getPlugins: (): Promise<ApiResponse<ImageGenPlugin[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<ImageGenPlugin[]>([
        {
          id: 'openai',
          name: 'OpenAI DALL-E',
          models: ['dall-e-3', 'dall-e-2'],
          config: {
            sizes: ['1024x1024', '1792x1024', '1024x1792'],
            default_size: '1024x1024',
            qualities: ['standard', 'hd'],
            default_quality: 'standard',
          },
        },
      ]);
    }

    return api.get('/image-gen/plugins').then(res => res.data);
  },

  // Get config for a specific plugin
  getConfig: (
    pluginId: string
  ): Promise<ApiResponse<ImageGenModel['config']>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        sizes: ['1024x1024', '1792x1024', '1024x1792'],
        default_size: '1024x1024',
        qualities: ['standard', 'hd'],
        default_quality: 'standard',
        styles: ['vivid', 'natural'],
        default_style: 'vivid',
        max_prompt_length: 4000,
      });
    }

    return api.get(`/image-gen/config/${pluginId}`).then(res => res.data);
  },

  // Generate image
  generate: (
    request: ImageGenRequest
  ): Promise<ApiResponse<ImageGenResponse>> => {
    if (isDemoMode()) {
      return createDemoResponse<ImageGenResponse>({
        images: [
          {
            url: 'https://placehold.co/1024x1024/purple/white?text=Demo+Image',
            revised_prompt: request.prompt,
          },
        ],
      });
    }

    return api.post('/image-gen/generate', request).then(res => res.data);
  },

  // Gallery endpoints
  getGallery: (params?: {
    limit?: number;
    offset?: number;
  }): Promise<ApiResponse<{ images: GeneratedImage[]; total: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse<{ images: GeneratedImage[]; total: number }>({
        images: [],
        total: 0,
      });
    }

    return api.get('/image-gen/gallery', { params }).then(res => res.data);
  },

  getGalleryImage: (imageId: string): Promise<ApiResponse<GeneratedImage>> => {
    if (isDemoMode()) {
      return createDemoResponse<GeneratedImage>({
        id: imageId,
        userId: 'demo',
        prompt: 'Demo image prompt',
        model: 'dall-e-3',
        imageData: 'https://placehold.co/1024x1024/purple/white?text=Demo',
        createdAt: Date.now(),
      });
    }

    return api.get(`/image-gen/gallery/${imageId}`).then(res => res.data);
  },

  deleteGalleryImage: (imageId: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse<void>(undefined);
    }

    return api.delete(`/image-gen/gallery/${imageId}`).then(res => res.data);
  },
};
