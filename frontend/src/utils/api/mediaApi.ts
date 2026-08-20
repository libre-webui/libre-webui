/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { ApiResponse, GeneratedMedia, GeneratedMediaKind } from '@/types';
import { api } from './client';

export interface VideoGenModel {
  model: string;
  plugin: string;
  config?: {
    resolutions?: string[];
    default_resolution?: string;
    aspect_ratios?: string[];
    default_aspect_ratio?: string;
    durations?: number[];
    default_duration?: number;
    supports_audio?: boolean;
    default_generate_audio?: boolean;
    cancel_endpoint?: string;
    cancel_method?: 'POST' | 'DELETE';
  };
}

export interface AudioGenModel {
  model: string;
  plugin: string;
  mode: 'speech' | 'sound';
  config?: {
    voices?: string[];
    default_voice?: string;
    formats?: string[];
    default_format?: string;
    max_prompt_length?: number;
    max_characters?: number;
    allows_custom_voice?: boolean;
    supports_voice_cloning?: boolean;
    clone_requires_transcript?: boolean;
    clone_audio_mime_types?: string[];
    clone_max_audio_bytes?: number;
  };
}

export interface MediaModelCatalog {
  video: VideoGenModel[];
  audio: AudioGenModel[];
}

export interface VideoGenerationJob {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  model: string;
  pluginId: string;
  prompt?: string;
  cancellable: boolean;
  galleryId?: string;
  error?: string;
  media?: GeneratedMedia;
  createdAt: number;
  updatedAt: number;
}

export const mediaApi = {
  getModels: (): Promise<ApiResponse<MediaModelCatalog>> =>
    api.get('/media/models').then(response => response.data),

  generateAudio: (
    request: {
      model: string;
      pluginId: string;
      input: string;
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
    },
    signal?: AbortSignal
  ): Promise<ApiResponse<GeneratedMedia>> =>
    api
      .post('/media/audio/generate', request, { signal })
      .then(response => response.data),

  cloneVoice: (
    request: {
      model: string;
      pluginId: string;
      input: string;
      referenceAudio: File;
      referenceText?: string;
      responseFormat?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      saveVoiceName?: string;
      consentToStore?: boolean;
      consentTtlDays?: number;
    },
    signal?: AbortSignal
  ): Promise<ApiResponse<GeneratedMedia>> => {
    const form = new FormData();
    form.set('model', request.model);
    form.set('pluginId', request.pluginId);
    form.set('input', request.input);
    form.set('reference_audio', request.referenceAudio);
    if (request.referenceText) {
      form.set('reference_text', request.referenceText);
    }
    if (request.responseFormat) {
      form.set('response_format', request.responseFormat);
    }
    if (request.saveVoiceName) {
      form.set('saveVoiceName', request.saveVoiceName);
    }
    if (request.consentToStore) {
      form.set('consentToStore', 'true');
    }
    if (request.consentTtlDays !== undefined) {
      form.set('consentTtlDays', String(request.consentTtlDays));
    }

    return api
      .post('/media/audio/voice-clone', form, { signal })
      .then(response => response.data);
  },

  generateSound: (
    request: {
      model: string;
      pluginId: string;
      prompt: string;
      voice?: string;
      format?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';
    },
    signal?: AbortSignal
  ): Promise<ApiResponse<GeneratedMedia>> =>
    api
      .post('/media/sound/generate', request, { signal })
      .then(response => response.data),

  generateVideo: (
    request: {
      model: string;
      pluginId: string;
      prompt: string;
      duration?: number;
      resolution?: string;
      aspect_ratio?: string;
      generate_audio?: boolean;
    },
    signal?: AbortSignal
  ): Promise<ApiResponse<VideoGenerationJob>> =>
    api
      .post('/media/video/generate', request, { signal })
      .then(response => response.data),

  getVideoJob: (
    jobId: string,
    signal?: AbortSignal
  ): Promise<ApiResponse<VideoGenerationJob>> =>
    api
      .get(`/media/video/jobs/${jobId}`, { signal })
      .then(response => response.data),

  listVideoJobs: (options?: {
    limit?: number;
    active?: boolean;
  }): Promise<ApiResponse<{ jobs: VideoGenerationJob[] }>> =>
    api
      .get('/media/video/jobs', { params: options })
      .then(response => response.data),

  resumeVideoJob: (
    jobId: string,
    signal?: AbortSignal
  ): Promise<ApiResponse<VideoGenerationJob>> =>
    api
      .post(
        `/media/video/jobs/${encodeURIComponent(jobId)}/resume`,
        undefined,
        {
          signal,
        }
      )
      .then(response => response.data),

  cancelVideoJob: (jobId: string): Promise<ApiResponse<void>> =>
    api
      .delete(`/media/video/jobs/${encodeURIComponent(jobId)}`)
      .then(response => response.data),

  getGallery: (params?: {
    limit?: number;
    offset?: number;
    kind?: GeneratedMediaKind;
  }): Promise<ApiResponse<{ media: GeneratedMedia[]; total: number }>> =>
    api.get('/media/gallery', { params }).then(response => response.data),

  deleteGalleryItem: (mediaId: string): Promise<ApiResponse<void>> =>
    api.delete(`/media/gallery/${mediaId}`).then(response => response.data),

  getGalleryContent: (mediaId: string): Promise<Blob> =>
    api
      .get(`/media/gallery/${mediaId}/content`, { responseType: 'blob' })
      .then(response => response.data),
};
