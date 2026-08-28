/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { ApiResponse } from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { api, createDemoResponse } from './client';

export interface STTModel {
  model: string;
  plugin: string;
  config?: {
    formats?: string[];
    max_audio_bytes?: number;
    max_duration_seconds?: number;
    languages?: string[];
  };
}

export interface STTTranscription {
  text: string;
  language?: string;
  duration?: number;
}

export const sttApi = {
  getModels: (): Promise<ApiResponse<STTModel[]>> => {
    if (isDemoMode()) return createDemoResponse<STTModel[]>([]);
    return api.get('/stt/models').then(response => response.data);
  },

  transcribe: async (
    audio: Blob,
    model: STTModel,
    options: {
      language?: string;
      signal?: AbortSignal;
      fallbackMessage?: string;
    } = {}
  ): Promise<STTTranscription> => {
    const form = new FormData();
    const extension = extensionForAudioType(audio.type);
    form.append('audio', audio, `recording.${extension}`);
    form.append('model', model.model);
    form.append('pluginId', model.plugin);
    if (options.language) form.append('language', options.language);
    const response = await api.post<ApiResponse<STTTranscription>>(
      '/stt/transcribe',
      form,
      { signal: options.signal }
    );
    if (!response.data.success || !response.data.data) {
      throw new Error(
        response.data.message ||
          response.data.error ||
          options.fallbackMessage ||
          'Transcription failed'
      );
    }
    return response.data.data;
  },
};

function extensionForAudioType(mimeType: string): string {
  const normalized = mimeType.split(';', 1)[0].toLowerCase();
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('flac')) return 'flac';
  if (normalized.includes('mp4') || normalized.includes('m4a')) return 'm4a';
  return 'mp3';
}
