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

import React, { useState, useRef, useEffect, useCallback } from 'react';
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

/**
 * Split text into sentences for sentence-by-sentence TTS playback.
 * Handles common sentence endings while preserving abbreviations.
 */
function splitIntoSentences(text: string): string[] {
  // Split on sentence-ending punctuation followed by space or end of string
  // This regex handles: . ! ? and also handles quotes after punctuation
  const sentences = text.split(/(?<=[.!?]["']?\s)|(?<=[.!?]["']?$)/);

  // Filter out empty strings and trim whitespace
  return sentences.map(s => s.trim()).filter(s => s.length > 0);
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

  // Refs for audio playback
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const stopRequestedRef = useRef(false);
  const sentenceQueueRef = useRef<string[]>([]);
  const currentIndexRef = useRef(0);

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

  /**
   * Generate and play audio for a single piece of text
   */
  const generateAndPlayAudio = useCallback(
    async (
      inputText: string,
      model: string,
      voice: string,
      speed: number
    ): Promise<void> => {
      const response = await ttsApi.generateBase64({
        model,
        input: inputText,
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

      return new Promise((resolve, reject) => {
        audio.onended = () => {
          audioRef.current = null;
          resolve();
        };

        audio.onerror = () => {
          audioRef.current = null;
          reject(new Error(t('ttsButton.playbackFailed')));
        };

        audio.play().catch(reject);
      });
    },
    [t]
  );

  /**
   * Play sentences one by one, pre-fetching the next sentence while current plays
   */
  const playSentenceBysentence = useCallback(
    async (
      sentences: string[],
      model: string,
      voice: string,
      speed: number
    ) => {
      sentenceQueueRef.current = sentences;
      currentIndexRef.current = 0;
      stopRequestedRef.current = false;

      // Pre-fetch the first sentence audio
      let nextAudioPromise: Promise<{
        audioUrl: string;
        mimeType: string;
      } | null> | null = null;

      const prefetchAudio = async (
        inputText: string
      ): Promise<{ audioUrl: string; mimeType: string } | null> => {
        try {
          const response = await ttsApi.generateBase64({
            model,
            input: inputText,
            voice,
            speed,
            response_format: 'mp3',
          });

          if (!response.success || !response.data?.audio) {
            return null;
          }

          return {
            audioUrl: `data:${response.data.mimeType};base64,${response.data.audio}`,
            mimeType: response.data.mimeType,
          };
        } catch {
          return null;
        }
      };

      // Start pre-fetching first sentence
      if (sentences.length > 0) {
        nextAudioPromise = prefetchAudio(sentences[0]);
      }

      for (let i = 0; i < sentences.length; i++) {
        if (stopRequestedRef.current) {
          break;
        }

        currentIndexRef.current = i;

        try {
          // Wait for current sentence's audio (already being fetched)
          const audioData = await nextAudioPromise;

          if (stopRequestedRef.current) {
            break;
          }

          // Start pre-fetching next sentence while this one plays
          if (i + 1 < sentences.length) {
            nextAudioPromise = prefetchAudio(sentences[i + 1]);
          } else {
            nextAudioPromise = null;
          }

          if (!audioData) {
            // Skip this sentence if generation failed
            console.warn(
              `Failed to generate audio for sentence ${i + 1}, skipping`
            );
            continue;
          }

          // Play current sentence
          const audio = new Audio(audioData.audioUrl);
          audioRef.current = audio;

          await new Promise<void>((resolve, _reject) => {
            audio.onended = () => {
              audioRef.current = null;
              resolve();
            };

            audio.onerror = () => {
              audioRef.current = null;
              // Don't reject, just skip to next sentence
              resolve();
            };

            audio.play().catch(() => {
              // Don't reject, just skip to next sentence
              resolve();
            });
          });
        } catch (err) {
          console.error(`Error playing sentence ${i + 1}:`, err);
          // Continue to next sentence
        }
      }
    },
    []
  );

  /**
   * Stop playback and reset state
   */
  const stopPlayback = useCallback(() => {
    stopRequestedRef.current = true;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    setIsPlaying(false);
    setIsLoading(false);
  }, []);

  const handlePlay = async () => {
    if (isLoading) return;

    // If currently playing, stop
    if (isPlaying) {
      stopPlayback();
      return;
    }

    setIsLoading(true);
    setError(null);
    stopRequestedRef.current = false;

    try {
      // Use saved settings from preferences, fall back to first available model
      const ttsSettings = preferences.ttsSettings;
      const model = ttsSettings?.model || availableModels[0]?.model || 'tts-1';
      const voice =
        ttsSettings?.voice ||
        availableModels[0]?.config?.default_voice ||
        'alloy';
      const speed = ttsSettings?.speed || 1.0;
      const streamSentences = ttsSettings?.streamSentences || false;

      if (streamSentences) {
        // Sentence-by-sentence playback mode
        const sentences = splitIntoSentences(text);

        if (sentences.length === 0) {
          throw new Error(t('ttsButton.generateFailed'));
        }

        setIsLoading(false);
        setIsPlaying(true);

        await playSentenceBysentence(sentences, model, voice, speed);

        if (!stopRequestedRef.current) {
          setIsPlaying(false);
        }
      } else {
        // Traditional full-message playback
        await generateAndPlayAudio(text, model, voice, speed);
        setIsLoading(false);
        setIsPlaying(true);

        // Wait for playback to complete
        if (audioRef.current) {
          audioRef.current.onended = () => {
            setIsPlaying(false);
            audioRef.current = null;
          };

          audioRef.current.onerror = () => {
            setError(t('ttsButton.playbackFailed'));
            setIsPlaying(false);
            audioRef.current = null;
          };
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : t('ttsButton.generateFailed');
      setError(errorMessage);
      console.error('TTS error:', err);
      setIsPlaying(false);
      setIsLoading(false);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
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
