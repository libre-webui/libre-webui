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

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

// HuggingFace Hub API types
export interface HuggingFaceModel {
  id: string;
  modelId: string;
  author: string;
  downloads: number;
  likes: number;
  tags: string[];
  pipeline_tag?: string;
  library_name?: string;
  gated: boolean | string;
  hasGguf?: boolean;
}

export interface GgufFileInfo {
  filename: string;
  size: number;
  sizeFormatted: string;
  quantization?: string;
  url: string;
  ollamaCommand: string;
}

// HuggingFace Hub API
export const huggingfaceHubApi = {
  // Get models with filters
  getModels: (params?: {
    task?: string;
    search?: string;
    author?: string;
    sort?: 'downloads' | 'likes' | 'lastModified';
    direction?: 'asc' | 'desc';
    limit?: number;
  }): Promise<ApiResponse<HuggingFaceModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<HuggingFaceModel[]>([
        {
          id: 'meta-llama/Llama-3.3-70B-Instruct',
          modelId: 'meta-llama/Llama-3.3-70B-Instruct',
          author: 'meta-llama',
          downloads: 1000000,
          likes: 5000,
          tags: ['text-generation', 'llama'],
          pipeline_tag: 'text-generation',
          gated: false,
        },
      ]);
    }

    return api
      .get('/huggingface-hub/models', {
        params,
      })
      .then(res => res.data);
  },

  // Get trending models
  getTrending: (params?: {
    task?: string;
    limit?: number;
  }): Promise<ApiResponse<HuggingFaceModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<HuggingFaceModel[]>([]);
    }

    return api
      .get('/huggingface-hub/trending', { params })
      .then(res => res.data);
  },

  // Get specific model details
  getModel: (
    author: string,
    modelName: string
  ): Promise<ApiResponse<HuggingFaceModel>> => {
    if (isDemoMode()) {
      return createDemoResponse<HuggingFaceModel>({
        id: `${author}/${modelName}`,
        modelId: `${author}/${modelName}`,
        author,
        downloads: 0,
        likes: 0,
        tags: [],
        gated: false,
      });
    }

    return api
      .get(`/huggingface-hub/models/${author}/${modelName}`)
      .then(res => res.data);
  },

  // Get available tasks
  getTasks: (): Promise<ApiResponse<string[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<string[]>([
        'text-generation',
        'text-to-speech',
        'text-to-image',
      ]);
    }

    return api.get('/huggingface-hub/tasks').then(res => res.data);
  },

  // Clear model cache
  clearCache: (): Promise<ApiResponse<boolean>> => {
    if (isDemoMode()) {
      return createDemoResponse<boolean>(true);
    }

    return api.post('/huggingface-hub/cache/clear').then(res => res.data);
  },

  // Get GGUF files for a model
  getGgufFiles: (
    author: string,
    modelName: string
  ): Promise<ApiResponse<GgufFileInfo[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<GgufFileInfo[]>([
        {
          filename: 'model-Q4_K_M.gguf',
          size: 4500000000,
          sizeFormatted: '4.19 GB',
          quantization: 'Q4_K_M',
          url: `https://huggingface.co/${author}/${modelName}/resolve/main/model-Q4_K_M.gguf`,
          ollamaCommand: `hf.co/${author}/${modelName}:Q4_K_M`,
        },
      ]);
    }

    return api
      .get(`/huggingface-hub/models/${author}/${modelName}/gguf`)
      .then(res => res.data);
  },

  // Check if a model has GGUF files
  hasGgufFiles: (
    author: string,
    modelName: string
  ): Promise<ApiResponse<{ hasGguf: boolean; count: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ hasGguf: false, count: 0 });
    }

    return api
      .get(`/huggingface-hub/models/${author}/${modelName}/has-gguf`)
      .then(res => res.data);
  },
};
