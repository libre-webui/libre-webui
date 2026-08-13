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
import {
  findTTSModel,
  resolveTTSModel,
  ttsApi,
  type TTSModel,
} from '@/utils/api';
import { useAppStore } from '@/store/appStore';
import { cn } from '@/utils';
import { createLogger } from '@/utils/logger';
import {
  activateTTSPlaybackSession,
  batchTextForTTS,
  createTTSPlaybackSession,
  isTTSPlaybackAbort,
  isTTSPlaybackBlocked,
  type TTSPlaybackSession,
  type TTSPlaybackState,
  unlockTTSAudioPlayback,
} from '@/utils/ttsBatching';

const logger = createLogger('components:ttsbutton');

// Module-level cache for TTS models to avoid repeated API calls
let cachedModels: TTSModel[] | null = null;
let cachePromise: Promise<TTSModel[]> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

async function getCachedTTSModels(forceRefresh = false): Promise<TTSModel[]> {
  const now = Date.now();

  // Return cached models if still valid
  if (
    !forceRefresh &&
    cachedModels !== null &&
    now - cacheTimestamp < CACHE_TTL
  ) {
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
  externalPlaybackState?: TTSPlaybackState;
  onStopExternal?: () => void;
  onRetryExternal?: () => void;
}

export const TTSButton: React.FC<TTSButtonProps> = ({
  text,
  className,
  size = 'sm',
  externalPlaybackState,
  onStopExternal,
  onRetryExternal,
}) => {
  const { t, i18n } = useTranslation();
  const { preferences } = useAppStore();
  const [playbackState, setPlaybackState] = useState<TTSPlaybackState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<TTSModel[]>([]);
  const [hasModels, setHasModels] = useState<boolean | null>(null);

  const playbackRef = useRef<TTSPlaybackSession | null>(null);
  const playbackRunRef = useRef(0);

  // Check for available TTS models on mount (using cache)
  useEffect(() => {
    let mounted = true;

    const loadModels = async () => {
      let models = await getCachedTTSModels();
      const savedSelection = findTTSModel(
        models,
        preferences.ttsSettings?.model,
        preferences.ttsSettings?.pluginId
      );
      if (preferences.ttsSettings?.model && !savedSelection) {
        models = await getCachedTTSModels(true);
      }

      if (mounted) {
        setAvailableModels(models);
        setHasModels(models.length > 0);
      }
    };

    void loadModels();

    return () => {
      mounted = false;
    };
  }, [preferences.ttsSettings?.model, preferences.ttsSettings?.pluginId]);

  const stopPlayback = () => {
    playbackRunRef.current += 1;
    playbackRef.current?.cancel();
    playbackRef.current = null;
    setPlaybackState('idle');
  };

  const handlePlay = async () => {
    if (
      externalPlaybackState === 'blocked' ||
      externalPlaybackState === 'error'
    ) {
      onRetryExternal?.();
      return;
    }
    if (
      externalPlaybackState === 'loading' ||
      externalPlaybackState === 'generating' ||
      externalPlaybackState === 'buffering' ||
      externalPlaybackState === 'playing'
    ) {
      onStopExternal?.();
      return;
    }
    if (
      playbackState === 'loading' ||
      playbackState === 'generating' ||
      playbackState === 'buffering' ||
      playbackState === 'playing'
    ) {
      stopPlayback();
      return;
    }
    if (playbackRef.current) {
      stopPlayback();
      return;
    }

    // `resume()` must be invoked before this event handler yields. The same
    // shared context is used after provider generation completes.
    const audioUnlock = unlockTTSAudioPlayback();
    setPlaybackState('loading');
    setError(null);
    const runId = playbackRunRef.current + 1;
    playbackRunRef.current = runId;

    try {
      const audioUnlockState = await audioUnlock;
      if (playbackRunRef.current !== runId) return;
      if (audioUnlockState === 'blocked') {
        setPlaybackState('blocked');
        return;
      }

      // Use saved settings from preferences, fall back to first available model
      const ttsSettings = preferences.ttsSettings;
      const selectedModel = resolveTTSModel(
        availableModels,
        ttsSettings?.model,
        ttsSettings?.pluginId
      );
      const model = selectedModel?.model || ttsSettings?.model || 'tts-1';
      const pluginId = selectedModel?.plugin || ttsSettings?.pluginId;
      const savedSelectionIsValid =
        selectedModel?.model === ttsSettings?.model &&
        (!ttsSettings?.pluginId ||
          selectedModel?.plugin === ttsSettings.pluginId);
      const voice = savedSelectionIsValid
        ? ttsSettings?.voice || selectedModel?.config?.default_voice
        : selectedModel?.config?.default_voice;
      const voiceProfileId = savedSelectionIsValid
        ? ttsSettings?.voiceProfileId || undefined
        : undefined;
      const speed = ttsSettings?.speed || 1.0;
      const responseFormat = selectedModel?.config?.default_format;
      const providerMaxChars = Math.max(
        1,
        selectedModel?.config?.max_characters || 600
      );
      const maxChars = Math.min(providerMaxChars, 600);
      const shouldBatch =
        ttsSettings?.streamSentences !== false || text.length > maxChars;
      const batches = shouldBatch
        ? batchTextForTTS(text, {
            locale: i18n.language,
            maxChars,
            targetChars: Math.min(maxChars, 420),
            minChars: Math.min(maxChars, 80),
          })
        : [text.trim()];

      if (batches.length === 0) {
        throw new Error(t('ttsButton.generateFailed'));
      }

      const session = createTTSPlaybackSession({
        concurrency: 3,
        initialBufferSize: Math.min(2, batches.length),
        generate: (input, { signal }) =>
          ttsApi.generate(
            {
              model,
              pluginId,
              input,
              voice: voiceProfileId ? undefined : voice || undefined,
              voiceProfileId,
              speed,
              response_format: responseFormat,
            },
            { signal }
          ),
        onStateChange: state => {
          if (playbackRunRef.current !== runId) return;
          setPlaybackState(state);
        },
      });
      playbackRef.current = session;
      const releaseExclusivePlayback = activateTTSPlaybackSession(session);

      try {
        await session.play(batches);
      } finally {
        releaseExclusivePlayback();
        if (playbackRef.current === session) playbackRef.current = null;
      }
    } catch (err) {
      if (playbackRunRef.current !== runId) return;
      if (isTTSPlaybackAbort(err)) {
        setPlaybackState('idle');
        return;
      }
      if (isTTSPlaybackBlocked(err)) {
        setPlaybackState('blocked');
        return;
      }
      const errorMessage =
        err instanceof Error ? err.message : t('ttsButton.generateFailed');
      setError(errorMessage);
      logger.error('TTS error:', err);
      setPlaybackState('error');
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      playbackRunRef.current += 1;
      playbackRef.current?.cancel();
      playbackRef.current = null;
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

  const displayState =
    externalPlaybackState &&
    !['idle', 'ended', 'cancelled'].includes(externalPlaybackState)
      ? externalPlaybackState
      : playbackState;
  const isBusy =
    displayState === 'loading' ||
    displayState === 'generating' ||
    displayState === 'buffering';
  const isPlaying = displayState === 'playing';
  const isBlocked = displayState === 'blocked';
  const isError = Boolean(error) || displayState === 'error';
  const title = error
    ? error
    : isError
      ? t('ttsButton.playbackFailed')
      : isBlocked
        ? t('ttsButton.enableAudio')
        : isPlaying || isBusy
          ? isPlaying
            ? t('ttsButton.stopSpeaking')
            : displayState === 'buffering'
              ? t('ttsButton.bufferingSpeech')
              : displayState === 'generating'
                ? t('ttsButton.generatingSpeech')
                : t('ttsButton.preparingSpeech')
          : t('ttsButton.readAloud');

  return (
    <button
      onClick={handlePlay}
      disabled={!text}
      title={title}
      aria-label={title}
      aria-busy={isBusy || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-full transition-all duration-200',
        'hover:bg-gray-100 dark:hover:bg-dark-200',
        'focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-1',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        isError
          ? 'text-red-500 dark:text-red-400'
          : isBlocked
            ? 'w-auto gap-1 bg-amber-50 px-2 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300'
            : isPlaying
              ? 'text-primary-600 dark:text-primary-400 bg-primary-50 dark:bg-primary-900/20'
              : 'text-gray-500 dark:text-gray-400',
        !isBlocked && sizeClasses[size],
        isBlocked && size === 'sm' && 'h-7',
        isBlocked && size === 'md' && 'h-8',
        isBlocked && size === 'lg' && 'h-10',
        className
      )}
    >
      {isBusy ? (
        <Loader2 className={cn(iconSizes[size], 'animate-spin')} />
      ) : isPlaying ? (
        <Square className={iconSizes[size]} />
      ) : isError || isBlocked ? (
        <VolumeX className={iconSizes[size]} />
      ) : (
        <Volume2 className={iconSizes[size]} />
      )}
      {isBlocked && (
        <span className='whitespace-nowrap text-xs font-medium'>
          {t('ttsButton.enableAudioShort')}
        </span>
      )}
    </button>
  );
};

export default TTSButton;
