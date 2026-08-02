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
  galleryId?: string;
  error?: string;
  media?: GeneratedMedia;
  createdAt: number;
  updatedAt: number;
}

export const mediaApi = {
  getModels: (): Promise<ApiResponse<MediaModelCatalog>> =>
    api.get('/media/models').then(response => response.data),

  generateAudio: (request: {
    model: string;
    pluginId: string;
    input: string;
    voice?: string;
    response_format?: 'mp3' | 'pcm';
    speed?: number;
  }): Promise<ApiResponse<GeneratedMedia>> =>
    api.post('/media/audio/generate', request).then(response => response.data),

  generateSound: (request: {
    model: string;
    pluginId: string;
    prompt: string;
    voice?: string;
    format?: 'wav' | 'mp3' | 'flac' | 'opus' | 'pcm16';
  }): Promise<ApiResponse<GeneratedMedia>> =>
    api.post('/media/sound/generate', request).then(response => response.data),

  generateVideo: (request: {
    model: string;
    pluginId: string;
    prompt: string;
    duration?: number;
    resolution?: string;
    aspect_ratio?: string;
    generate_audio?: boolean;
  }): Promise<ApiResponse<VideoGenerationJob>> =>
    api.post('/media/video/generate', request).then(response => response.data),

  getVideoJob: (jobId: string): Promise<ApiResponse<VideoGenerationJob>> =>
    api.get(`/media/video/jobs/${jobId}`).then(response => response.data),

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
