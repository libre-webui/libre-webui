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

import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, VolumeX, Loader2, Square } from 'lucide-react';
import { ttsApi, TTSModel } from '@/utils/api';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';

// Module-level cache for TTS models to avoid repeated API calls
let cachedModels: TTSModel[] | null = null;
let cachePromise: Promise<TTSModel[]> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

async function getCachedTTSModels(): Promise<TTSModel[]> {
  const now = Date.now();

  // Return cached models if still valid
  if (cachedModels !== null && now - cacheTimestamp < CACHE_TTL) {
    return cachedModels;
  }

  // If a request is already in flight, wait for it
  if (cachePromise) {
    return cachePromise;
  }

  // Make new request
  cachePromise = (async () => {
    try {
      const response = await ttsApi.getModels();
      if (response.success && response.data && response.data.length > 0) {
        cachedModels = response.data;
        cacheTimestamp = now;
        return response.data;
      }
      cachedModels = [];
      cacheTimestamp = now;
      return [];
    } catch {
      cachedModels = [];
      cacheTimestamp = now;
      return [];
    } finally {
      cachePromise = null;
    }
  })();

  return cachePromise;
}

interface TTSButtonProps {
  text: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const TTSButton: React.FC<TTSButtonProps> = ({
  text,
  className,
  size = 'sm',
}) => {
  const { t } = useTranslation();
  const { preferences } = useAppStore();
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<TTSModel[]>([]);
  const [hasModels, setHasModels] = useState<boolean | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Check for available TTS models on mount (using cache)
  useEffect(() => {
    let mounted = true;

    getCachedTTSModels().then(models => {
      if (mounted) {
        setAvailableModels(models);
        setHasModels(models.length > 0);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  const handlePlay = async () => {
    if (isLoading) return;

    // If currently playing, stop
    if (isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      setIsPlaying(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      // Use saved settings from preferences, fall back to first available model
      const ttsSettings = preferences.ttsSettings;
      const model = ttsSettings?.model || availableModels[0]?.model || 'tts-1';
      const voice =
        ttsSettings?.voice ||
        availableModels[0]?.config?.default_voice ||
        'alloy';
      const speed = ttsSettings?.speed || 1.0;

      const response = await ttsApi.generateBase64({
        model,
        input: text,
        voice,
        speed,
        response_format: 'mp3',
      });

      if (!response.success || !response.data?.audio) {
        throw new Error(response.message || t('ttsButton.generateFailed'));
      }

      const audioUrl = `data:${response.data.mimeType};base64,${response.data.audio}`;
      const audio = new Audio(audioUrl);
      audioRef.current = audio;

      audio.onended = () => {
        setIsPlaying(false);
        audioRef.current = null;
      };

      audio.onerror = () => {
        setError(t('ttsButton.playbackFailed'));
        setIsPlaying(false);
        audioRef.current = null;
      };

      await audio.play();
      setIsPlaying(true);
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t('ttsButton.generateFailed');
      setError(errorMessage);
      console.error('TTS error:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  // Don't render if no TTS models are available
  if (hasModels === false) {
    return null;
  }

  // Don't render while checking for models
  if (hasModels === null) {
    return null;
  }

  const sizeClasses = {
    sm: 'h-6 w-6 p-1',
    md: 'h-8 w-8 p-1.5',
    lg: 'h-10 w-10 p-2',
  };

  const iconSizes = {
    sm: 'h-3.5 w-3.5',
    md: 'h-4 w-4',
    lg: 'h-5 w-5',
  };

  return (
    <button
      onClick={handlePlay}
      disabled={isLoading || !text}
      title={
        error
          ? error
          : isPlaying
            ? t('ttsButton.stopSpeaking')
            : isLoading
              ? t('ttsButton.generatingSpeech')
              : t('ttsButton.readAloud')
      }
      className={cn(
        'rounded-full transition-all duration-200',
        'hover:bg-gray-100 dark:hover:bg-dark-200',
        'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        error
          ? 'text-red-500 dark:text-red-400'
          : isPlaying
            ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20'
            : 'text-gray-500 dark:text-gray-400',
        sizeClasses[size],
        className
      )}
    >
      {isLoading ? (
        <Loader2 className={cn(iconSizes[size], 'animate-spin')} />
      ) : isPlaying ? (
        <Square className={iconSizes[size]} />
      ) : error ? (
        <VolumeX className={iconSizes[size]} />
      ) : (
        <Volume2 className={iconSizes[size]} />
      )}
    </button>
  );
};

export default TTSButton;
