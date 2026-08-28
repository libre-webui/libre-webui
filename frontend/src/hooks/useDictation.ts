/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import { sttApi, type STTModel } from '@/utils/api';
import { createLogger } from '@/utils/logger';

const logger = createLogger('hooks:dictation');

// Minimal typings for the vendor-prefixed Web Speech API.
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        results: ArrayLike<ArrayLike<{ transcript: string }>>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const getSpeechRecognition = (): SpeechRecognitionConstructor | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
};

const RECORDING_MIME_TYPES = [
  { mimeType: 'audio/webm;codecs=opus', format: 'webm' },
] as const;

const DEFAULT_MAX_RECORDING_SECONDS = 5 * 60;
const RECORDING_DURATION_HEADROOM_SECONDS = 0.25;

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing';

function preferredRecordingMimeType(model: STTModel): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const accepted = new Set(
    (model.config?.formats || []).map(format => format.toLowerCase())
  );
  return RECORDING_MIME_TYPES.find(
    candidate =>
      (accepted.size === 0 || accepted.has(candidate.format)) &&
      (typeof MediaRecorder.isTypeSupported !== 'function' ||
        MediaRecorder.isTypeSupported(candidate.mimeType))
  )?.mimeType;
}

interface UseDictationOptions {
  /**
   * Called when a dictation begins, before any transcript arrives — the
   * consumer snapshots its current input as the base to append to.
   */
  onStart: () => void;
  /** Full transcript of the current dictation (interim or final). */
  onText: (text: string) => void;
  /**
   * A dictation belongs to one context (chat session, Work task). When
   * this key changes — or the consumer unmounts — everything in flight is
   * cancelled.
   */
  ownerKey?: string;
}

/**
 * Push-to-talk dictation for a composer, extracted from the chat input's
 * inline implementation. Browser Web Speech is preferred (free, streaming);
 * a provider STT model records with MediaRecorder and transcribes on stop.
 * Provider models come from /stt/models, so an admins-only STT mode simply
 * yields an empty list and the browser path (when supported) still works.
 */
export function useDictation({
  onStart,
  onText,
  ownerKey,
}: UseDictationOptions) {
  const { t, i18n } = useTranslation();
  const [phase, setPhaseState] = useState<DictationPhase>('idle');
  const [sttModels, setSttModels] = useState<STTModel[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const transcriptionAbortRef = useRef<AbortController | null>(null);
  const recordingTimeoutRef = useRef<number | null>(null);
  const runRef = useRef(0);
  const phaseRef = useRef<DictationPhase>('idle');
  const ownerRef = useRef<string | undefined>(undefined);
  const onStartRef = useRef(onStart);
  const onTextRef = useRef(onText);
  useEffect(() => {
    onStartRef.current = onStart;
    onTextRef.current = onText;
  }, [onStart, onText]);

  useEffect(() => {
    let cancelled = false;
    sttApi
      .getModels()
      .then(response => {
        if (!cancelled && response.success && response.data) {
          setSttModels(response.data);
        }
      })
      .catch(() => {
        if (!cancelled) setSttModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const browserSpeechSupported = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.isSecureContext &&
      typeof navigator !== 'undefined' &&
      Boolean(navigator.mediaDevices) &&
      Boolean(getSpeechRecognition()),
    []
  );
  const providerMicrophoneSupported =
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia);
  const providerSttModel = useMemo(
    () =>
      providerMicrophoneSupported
        ? sttModels.find(model => Boolean(preferredRecordingMimeType(model)))
        : undefined,
    [providerMicrophoneSupported, sttModels]
  );
  const supported = browserSpeechSupported || Boolean(providerSttModel);

  const clearRecordingTimeout = useCallback(() => {
    if (recordingTimeoutRef.current !== null) {
      window.clearTimeout(recordingTimeoutRef.current);
      recordingTimeoutRef.current = null;
    }
  }, []);

  const setPhase = useCallback((next: DictationPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const cancel = useCallback(() => {
    runRef.current += 1;
    clearRecordingTimeout();

    recognitionRef.current?.stop();
    recognitionRef.current = null;
    transcriptionAbortRef.current?.abort();
    transcriptionAbortRef.current = null;

    const recorder = mediaRecorderRef.current;
    mediaRecorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onerror = null;
      recorder.onstop = null;
      if (recorder.state === 'recording') recorder.stop();
    }
    mediaStreamRef.current?.getTracks().forEach(track => track.stop());
    mediaStreamRef.current = null;

    setPhase('idle');
  }, [clearRecordingTimeout, setPhase]);

  // Cancel pending microphone permission, recording, and provider work
  // before the consumer unmounts or its owning context changes.
  useEffect(() => {
    ownerRef.current = ownerKey;
    return cancel;
  }, [cancel, ownerKey]);

  const toggle = useCallback(async () => {
    const phaseNow = phaseRef.current;
    if (phaseNow === 'starting' || phaseNow === 'transcribing') {
      cancel();
      return;
    }
    if (phaseNow === 'recording') {
      if (mediaRecorderRef.current?.state === 'recording') {
        // Make a second click a real cancellation even before
        // MediaRecorder's asynchronous stop callback creates the request.
        setPhase('transcribing');
        mediaRecorderRef.current.stop();
      } else {
        cancel();
      }
      return;
    }

    // Browser speech is free and streams interim text; provider STT is
    // the fallback when the browser lacks the Web Speech API.
    if (!browserSpeechSupported && providerSttModel) {
      const runId = runRef.current + 1;
      runRef.current = runId;
      const owner = ownerRef.current;
      onStartRef.current();
      setPhase('starting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
        });
        if (runRef.current !== runId || ownerRef.current !== owner) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        mediaStreamRef.current = stream;
        const mimeType = preferredRecordingMimeType(providerSttModel);
        const recorder = mimeType
          ? new MediaRecorder(stream, { mimeType })
          : new MediaRecorder(stream);
        const chunks: Blob[] = [];
        recorder.ondataavailable = event => {
          if (event.data.size > 0) chunks.push(event.data);
        };
        recorder.onerror = () => {
          stream.getTracks().forEach(track => track.stop());
          clearRecordingTimeout();
          if (runRef.current !== runId) return;
          mediaRecorderRef.current = null;
          mediaStreamRef.current = null;
          setPhase('idle');
          toast.error(t('voiceMode.transcriptionFailed'));
        };
        recorder.onstop = () => {
          stream.getTracks().forEach(track => track.stop());
          clearRecordingTimeout();
          if (runRef.current !== runId || ownerRef.current !== owner) {
            return;
          }
          mediaRecorderRef.current = null;
          mediaStreamRef.current = null;
          if (chunks.length === 0) {
            setPhase('idle');
            return;
          }
          const recording = new Blob(chunks, {
            type: recorder.mimeType || chunks[0].type || 'audio/webm',
          });
          const controller = new AbortController();
          transcriptionAbortRef.current = controller;
          setPhase('transcribing');
          void sttApi
            .transcribe(recording, providerSttModel, {
              language: i18n.language,
              signal: controller.signal,
              fallbackMessage: t('voiceMode.transcriptionFailed'),
            })
            .then(result => {
              if (
                runRef.current !== runId ||
                ownerRef.current !== owner ||
                controller.signal.aborted
              ) {
                return;
              }
              onTextRef.current(result.text.trim());
            })
            .catch(error => {
              if (!controller.signal.aborted) {
                logger.error('Provider transcription failed:', error);
                toast.error(
                  error instanceof Error
                    ? error.message
                    : t('voiceMode.transcriptionFailed')
                );
              }
            })
            .finally(() => {
              if (
                transcriptionAbortRef.current === controller &&
                runRef.current === runId
              ) {
                transcriptionAbortRef.current = null;
                setPhase('idle');
              }
            });
        };
        mediaRecorderRef.current = recorder;
        recorder.start(250);
        const configuredDuration =
          providerSttModel.config?.max_duration_seconds;
        const maxDurationSeconds =
          typeof configuredDuration === 'number' && configuredDuration > 0
            ? Math.min(configuredDuration, DEFAULT_MAX_RECORDING_SECONDS)
            : DEFAULT_MAX_RECORDING_SECONDS;
        recordingTimeoutRef.current = window.setTimeout(
          () => {
            if (runRef.current === runId && recorder.state === 'recording') {
              recorder.stop();
            }
          },
          Math.max(
            0.1,
            maxDurationSeconds - RECORDING_DURATION_HEADROOM_SECONDS
          ) * 1000
        );
        setPhase('recording');
        return;
      } catch (error) {
        if (runRef.current !== runId) return;
        logger.error('Failed to start provider dictation:', error);
        clearRecordingTimeout();
        mediaStreamRef.current?.getTracks().forEach(track => track.stop());
        mediaStreamRef.current = null;
        mediaRecorderRef.current = null;
        setPhase('idle');
        toast.error(t('voiceMode.transcriptionFailed'));
        return;
      }
    }

    const SpeechRecognitionCtor = getSpeechRecognition();
    if (!SpeechRecognitionCtor) return;

    const runId = runRef.current + 1;
    runRef.current = runId;
    const owner = ownerRef.current;
    const recognition = new SpeechRecognitionCtor();
    recognition.lang = i18n.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    onStartRef.current();
    recognition.onresult = event => {
      if (
        runRef.current !== runId ||
        ownerRef.current !== owner ||
        recognitionRef.current !== recognition
      ) {
        return;
      }
      let transcript = '';
      for (let i = 0; i < event.results.length; i++) {
        transcript += event.results[i][0]?.transcript ?? '';
      }
      onTextRef.current(transcript.trim());
    };
    recognition.onend = () => {
      if (runRef.current !== runId) return;
      recognitionRef.current = null;
      setPhase('idle');
    };
    recognition.onerror = () => {
      if (runRef.current !== runId) return;
      recognitionRef.current = null;
      setPhase('idle');
    };
    recognitionRef.current = recognition;
    setPhase('recording');
    try {
      recognition.start();
    } catch (error) {
      logger.error('Failed to start dictation:', error);
      recognitionRef.current = null;
      setPhase('idle');
    }
  }, [
    browserSpeechSupported,
    cancel,
    clearRecordingTimeout,
    i18n.language,
    providerSttModel,
    setPhase,
    t,
  ]);

  return { supported, phase, toggle, cancel };
}
