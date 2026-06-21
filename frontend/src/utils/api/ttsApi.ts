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

// TTS API
export interface TTSModel {
  model: string;
  plugin: string;
  config?: {
    voices?: string[];
    default_voice?: string;
    formats?: string[];
    default_format?: string;
    max_characters?: number;
    supports_streaming?: boolean;
  };
}

export interface TTSPlugin {
  id: string;
  name: string;
  models: string[];
  config?: TTSModel['config'];
}

export interface TTSGenerateRequest {
  model: string;
  input: string;
  voice?: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
}

export interface TTSGenerateBase64Response {
  audio: string;
  format: string;
  mimeType: string;
  size: number;
}

export const ttsApi = {
  // Get all available TTS models
  getModels: (): Promise<ApiResponse<TTSModel[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<TTSModel[]>([
        {
          model: 'tts-1',
          plugin: 'openai',
          config: {
            voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
            default_voice: 'alloy',
            formats: ['mp3', 'opus', 'aac', 'flac', 'wav'],
            default_format: 'mp3',
            max_characters: 4096,
          },
        },
      ]);
    }

    return api.get('/tts/models').then(res => res.data);
  },

  // Get TTS plugins
  getPlugins: (): Promise<ApiResponse<TTSPlugin[]>> => {
    if (isDemoMode()) {
      return createDemoResponse<TTSPlugin[]>([
        {
          id: 'openai',
          name: 'OpenAI GPT',
          models: ['tts-1', 'tts-1-hd'],
          config: {
            voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
            default_voice: 'alloy',
          },
        },
      ]);
    }

    return api.get('/tts/plugins').then(res => res.data);
  },

  // Get voices for a specific plugin
  getVoices: (
    pluginId: string
  ): Promise<
    ApiResponse<{
      voices: string[];
      default_voice?: string;
      formats: string[];
      default_format: string;
      max_characters?: number;
      supports_streaming: boolean;
    }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({
        voices: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer'],
        default_voice: 'alloy',
        formats: ['mp3', 'opus', 'aac', 'flac', 'wav'],
        default_format: 'mp3',
        max_characters: 4096,
        supports_streaming: false,
      });
    }

    return api.get(`/tts/voices/${pluginId}`).then(res => res.data);
  },

  // Generate speech and get as base64
  generateBase64: (
    request: TTSGenerateRequest
  ): Promise<ApiResponse<TTSGenerateBase64Response>> => {
    if (isDemoMode()) {
      // Return a minimal valid audio placeholder for demo
      return createDemoResponse<TTSGenerateBase64Response>({
        audio: '', // Empty base64
        format: request.response_format || 'mp3',
        mimeType: 'audio/mpeg',
        size: 0,
      });
    }

    return api.post('/tts/generate-base64', request).then(res => res.data);
  },

  // Generate speech and get as blob (for direct playback)
  generate: async (request: TTSGenerateRequest): Promise<Blob> => {
    if (isDemoMode()) {
      // Return empty blob for demo
      return new Blob([], { type: 'audio/mpeg' });
    }

    const response = await api.post('/tts/generate', request, {
      responseType: 'blob',
    });
    return response.data;
  },

  // Helper: Play text as speech
  speak: async (
    text: string,
    options: {
      model?: string;
      voice?: string;
      speed?: number;
      onStart?: () => void;
      onEnd?: () => void;
      onError?: (error: Error) => void;
    } = {}
  ): Promise<HTMLAudioElement | null> => {
    try {
      options.onStart?.();

      const response = await ttsApi.generateBase64({
        model: options.model || 'tts-1',
        input: text,
        voice: options.voice,
        speed: options.speed,
        response_format: 'mp3',
      });

      if (!response.success || !response.data?.audio) {
        throw new Error(response.message || 'Failed to generate speech');
      }

      const audioUrl = `data:${response.data.mimeType};base64,${response.data.audio}`;
      const audio = new Audio(audioUrl);

      audio.onended = () => options.onEnd?.();
      audio.onerror = () =>
        options.onError?.(new Error('Audio playback failed'));

      await audio.play();
      return audio;
    } catch (error) {
      const err = error instanceof Error ? error : new Error('Unknown error');
      options.onError?.(err);
      return null;
    }
  },
};
