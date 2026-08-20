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

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  AudioLines,
  Check,
  Loader2,
  Mic,
  MicOff,
  SkipForward,
  X,
} from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import {
  VoiceModeController,
  type VoiceModeSnapshot,
} from '@/utils/voiceModeController';
import { initialVoiceModeState, type VoiceModeState } from '@/utils/voiceMode';
import { cn } from '@/utils';

interface VoiceModeOverlayProps {
  onClose: () => void;
  onSendMessage: (text: string) => void;
  isStreaming: boolean;
  lastAssistantMessage: { id: string; content: string } | null;
}

/**
 * Hands-free turn-based voice conversation: listen → transcribe → generate
 * → speak, with barge-in while the reply is playing, a mute toggle, and
 * inline recovery from every failure. The imperative engine lives in
 * `VoiceModeController`; this component renders its published state and
 * forwards button presses.
 */
export const VoiceModeOverlay: React.FC<VoiceModeOverlayProps> = ({
  onClose,
  onSendMessage,
  isStreaming,
  lastAssistantMessage,
}) => {
  const { t, i18n } = useTranslation();
  const { preferences } = useAppStore();
  const [machine, setMachine] = useState<VoiceModeState>(initialVoiceModeState);
  const [lastTranscript, setLastTranscript] = useState('');
  const [supported, setSupported] = useState<boolean | null>(null);

  const controllerRef = useRef<VoiceModeController | null>(null);
  const snapshotRef = useRef<VoiceModeSnapshot>({
    isStreaming: false,
    lastAssistantMessage: null,
    ttsSettings: undefined,
  });

  // Keep the engine's view of chat state fresh; ref writes belong in
  // effects, never in render.
  useEffect(() => {
    snapshotRef.current = {
      isStreaming,
      lastAssistantMessage,
      ttsSettings: preferences.ttsSettings,
    };
  }, [isStreaming, lastAssistantMessage, preferences.ttsSettings]);

  useEffect(() => {
    const controller = new VoiceModeController({
      locale: i18n.language,
      sendMessage: text => onSendMessage(text),
      snapshot: () => snapshotRef.current,
      onState: state => setMachine(state),
      onTranscript: text => setLastTranscript(text),
      onSupport: value => setSupported(value),
      messages: {
        microphoneFailed: t('voiceMode.microphoneFailed'),
        transcriptionFailed: t('voiceMode.transcriptionFailed'),
        replyTimeout: t('voiceMode.replyTimeout'),
      },
    });
    controllerRef.current = controller;
    void controller.start();
    return () => {
      controllerRef.current = null;
      controller.close();
    };
    // The controller lives for the overlay's lifetime; props reach it
    // through the snapshot ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const phase = machine.phase;
  const statusKey =
    supported === false
      ? 'voiceMode.unsupported'
      : phase === 'listening'
        ? machine.muted
          ? 'voiceMode.muted'
          : 'voiceMode.listening'
        : phase === 'transcribing'
          ? 'voiceMode.transcribing'
          : phase === 'generating'
            ? 'voiceMode.generating'
            : phase === 'speaking'
              ? 'voiceMode.speaking'
              : 'voiceMode.starting';

  return createPortal(
    <div
      role='dialog'
      aria-modal='true'
      aria-label={t('voiceMode.title')}
      className='fixed inset-0 z-[70] flex flex-col items-center justify-center gap-6 bg-white/95 p-6 backdrop-blur dark:bg-dark-25/95'
      data-testid='voice-mode-overlay'
    >
      <button
        type='button'
        onClick={onClose}
        aria-label={t('voiceMode.close')}
        className='absolute right-4 top-4 rounded-full p-2 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-dark-100'
      >
        <X className='h-5 w-5' />
      </button>

      <div
        className={cn(
          'flex h-28 w-28 items-center justify-center rounded-full border-4 transition-colors',
          phase === 'listening' && !machine.muted
            ? 'border-primary-500 text-primary-500'
            : phase === 'speaking'
              ? 'border-emerald-500 text-emerald-500'
              : phase === 'generating' || phase === 'transcribing'
                ? 'border-amber-500 text-amber-500'
                : 'border-gray-300 text-gray-400 dark:border-dark-300'
        )}
      >
        {phase === 'transcribing' || phase === 'generating' ? (
          <Loader2 className='h-10 w-10 animate-spin' />
        ) : machine.muted ? (
          <MicOff className='h-10 w-10' />
        ) : phase === 'speaking' ? (
          <AudioLines className='h-10 w-10' />
        ) : (
          <Mic className='h-10 w-10' />
        )}
      </div>

      <div className='text-center'>
        <p
          className='text-base font-medium text-gray-900 dark:text-gray-100'
          data-testid='voice-mode-status'
        >
          {t(statusKey)}
        </p>
        {machine.error && (
          <p className='mt-1 text-sm text-red-600 dark:text-red-400'>
            {machine.error}
          </p>
        )}
        {lastTranscript && (
          <p className='mt-3 max-w-md text-sm text-gray-600 dark:text-gray-300'>
            “{lastTranscript}”
          </p>
        )}
      </div>

      {supported !== false && (
        <div className='flex items-center gap-3'>
          <button
            type='button'
            onClick={() => controllerRef.current?.toggleMute()}
            aria-label={
              machine.muted ? t('voiceMode.unmute') : t('voiceMode.mute')
            }
            aria-pressed={machine.muted}
            className='rounded-full border border-gray-300 p-3 text-gray-700 hover:bg-gray-100 dark:border-dark-300 dark:text-gray-300 dark:hover:bg-dark-100'
          >
            {machine.muted ? (
              <MicOff className='h-5 w-5' />
            ) : (
              <Mic className='h-5 w-5' />
            )}
          </button>
          {phase === 'listening' && !machine.muted && (
            <button
              type='button'
              onClick={() => controllerRef.current?.finishTurn()}
              aria-label={t('voiceMode.finishTurn')}
              className='rounded-full border border-primary-500 p-3 text-primary-600 hover:bg-primary-50 dark:hover:bg-primary-950/30'
            >
              <Check className='h-5 w-5' />
            </button>
          )}
          {phase === 'speaking' && (
            <button
              type='button'
              onClick={() => controllerRef.current?.skipSpeech()}
              aria-label={t('voiceMode.skipReply')}
              className='rounded-full border border-emerald-500 p-3 text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/30'
            >
              <SkipForward className='h-5 w-5' />
            </button>
          )}
        </div>
      )}

      {supported === false && (
        <p className='max-w-md text-center text-sm text-gray-600 dark:text-gray-300'>
          {t('voiceMode.unsupportedHint')}
        </p>
      )}
    </div>,
    document.body
  );
};

export default VoiceModeOverlay;
