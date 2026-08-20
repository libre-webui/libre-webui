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

/**
 * Imperative engine behind hands-free voice mode (AUDIO-02). Framework-free:
 * the React overlay only renders the published state and forwards button
 * presses. The engine owns the microphone stream, RMS endpointing, provider
 * or browser transcription, reply watching, spoken playback, and barge-in.
 * All transitions run through the pure `reduceVoiceMode` machine; its turn
 * counter invalidates stale async work so exactly one turn is ever active.
 */

import { sttApi, ttsApi, type STTModel, type TTSModel } from '@/utils/api';
import { resolveTTSModel } from '@/utils/api';
import {
  activateTTSPlaybackSession,
  batchTextForTTS,
  createTTSPlaybackSession,
  isTTSPlaybackAbort,
  type TTSPlaybackSession,
} from '@/utils/ttsBatching';
import {
  initialVoiceModeState,
  reduceVoiceMode,
  type VoiceModeEvent,
  type VoiceModeState,
} from '@/utils/voiceMode';
import { createLogger } from '@/utils/logger';

const logger = createLogger('utils:voice-mode-controller');

const SPEECH_RMS_THRESHOLD = 0.015;
const SPEECH_START_MS = 200;
const TURN_SILENCE_MS = 1500;
const MAX_TURN_MS = 60_000;
const BARGE_IN_MS = 300;
const REPLY_TIMEOUT_MS = 180_000;

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

const getSpeechRecognition = ():
  (new () => SpeechRecognitionLike) | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition || w.webkitSpeechRecognition;
};

const recordingMimeType = (model: STTModel): string | undefined => {
  if (typeof MediaRecorder === 'undefined') return undefined;
  const accepted = new Set(
    (model.config?.formats || []).map(format => format.toLowerCase())
  );
  const candidate = 'audio/webm;codecs=opus';
  if (accepted.size > 0 && !accepted.has('webm')) return undefined;
  if (
    typeof MediaRecorder.isTypeSupported === 'function' &&
    !MediaRecorder.isTypeSupported(candidate)
  ) {
    return undefined;
  }
  return candidate;
};

export interface VoiceModeTtsPreferences {
  model?: string;
  pluginId?: string;
  voice?: string;
  voiceProfileId?: string;
  speed?: number;
}

export interface VoiceModeSnapshot {
  isStreaming: boolean;
  lastAssistantMessage: { id: string; content: string } | null;
  ttsSettings: VoiceModeTtsPreferences | undefined;
}

export interface VoiceModeControllerOptions {
  locale: string;
  sendMessage: (text: string) => void;
  /** Latest chat state, re-published by the overlay on every render. */
  snapshot: () => VoiceModeSnapshot;
  onState: (state: VoiceModeState) => void;
  onTranscript: (text: string) => void;
  onSupport: (supported: boolean) => void;
  messages: {
    microphoneFailed: string;
    transcriptionFailed: string;
    replyTimeout: string;
  };
}

export class VoiceModeController {
  private state: VoiceModeState = initialVoiceModeState;
  private closed = false;
  private useBrowserRecognition = false;
  private sttModel: STTModel | null = null;
  private ttsModels: TTSModel[] = [];
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private monitorTimer: number | null = null;
  private pollTimer: number | null = null;
  private recognition: SpeechRecognitionLike | null = null;
  private ttsSession: TTSPlaybackSession | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly options: VoiceModeControllerOptions) {}

  async start(): Promise<void> {
    try {
      const [sttResponse, ttsResponse] = await Promise.all([
        sttApi.getModels().catch(() => ({ success: false as const, data: [] })),
        ttsApi.getModels().catch(() => ({ success: false as const, data: [] })),
      ]);
      if (this.closed) return;
      const sttModels = (sttResponse.success && sttResponse.data) || [];
      this.ttsModels = (ttsResponse.success && ttsResponse.data) || [];
      const providerModel = sttModels.find(model =>
        Boolean(recordingMimeType(model))
      );
      const canUseProvider =
        Boolean(providerModel) &&
        typeof navigator !== 'undefined' &&
        Boolean(navigator.mediaDevices?.getUserMedia);
      const canUseBrowser = Boolean(getSpeechRecognition());
      if (canUseProvider && providerModel) {
        this.sttModel = providerModel;
        this.useBrowserRecognition = false;
      } else if (canUseBrowser) {
        this.useBrowserRecognition = true;
      } else {
        this.options.onSupport(false);
        return;
      }
      this.options.onSupport(true);
      if (!this.useBrowserRecognition) {
        await this.ensureStream();
        if (this.closed) return;
      }
      const next = this.send({ type: 'start' });
      this.beginTurn(next.turn);
    } catch (error) {
      logger.warn('Voice mode failed to start:', error);
      if (!this.closed) this.options.onSupport(false);
    }
  }

  close(): void {
    this.closed = true;
    this.clearMonitor();
    this.clearPoll();
    this.stopRecorder();
    this.stopRecognition();
    this.abortController?.abort();
    this.ttsSession?.cancel();
    this.ttsSession = null;
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    if (this.audioContext) {
      void this.audioContext.close().catch(() => undefined);
      this.audioContext = null;
    }
  }

  toggleMute(): void {
    if (this.state.muted) {
      const next = this.send({ type: 'unmute' });
      if (next.phase === 'listening') {
        this.stopRecorder();
        this.stopRecognition();
        this.beginTurn(next.turn);
      }
    } else {
      this.send({ type: 'mute' });
    }
  }

  /** Manual end-of-turn control; also the fallback when RMS is unavailable. */
  finishTurn(): void {
    if (this.state.phase !== 'listening' || this.state.muted) return;
    if (this.useBrowserRecognition) {
      this.recognition?.stop();
    } else {
      this.finishProviderCapture(this.state.turn);
    }
  }

  skipSpeech(): void {
    if (this.state.phase !== 'speaking') return;
    this.ttsSession?.cancel();
    this.clearMonitor();
    const next = this.send({ type: 'spoken' });
    if (next.phase === 'listening') this.beginTurn(next.turn);
  }

  private send(event: VoiceModeEvent): VoiceModeState {
    this.state = reduceVoiceMode(this.state, event);
    this.options.onState(this.state);
    return this.state;
  }

  private staleTurn(turn: number): boolean {
    return this.closed || this.state.turn !== turn;
  }

  private clearMonitor(): void {
    if (this.monitorTimer !== null) {
      window.clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  private clearPoll(): void {
    if (this.pollTimer !== null) {
      window.clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private stopRecorder(): void {
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch {
        // Already stopped.
      }
    }
  }

  private stopRecognition(): void {
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onend = null;
      recognition.onerror = null;
      try {
        recognition.stop();
      } catch {
        // Already stopped.
      }
    }
  }

  private rmsLevel(): number {
    if (!this.analyser) return 0;
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let index = 0; index < samples.length; index += 1) {
      sum += samples[index] * samples[index];
    }
    return Math.sqrt(sum / samples.length);
  }

  private async ensureStream(): Promise<MediaStream> {
    if (this.stream) return this.stream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.stream = stream;
    try {
      const AudioContextCtor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (AudioContextCtor) {
        const context = new AudioContextCtor();
        void context.resume().catch(() => undefined);
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        this.audioContext = context;
        this.analyser = analyser;
      }
    } catch (error) {
      logger.warn('Voice mode analyser unavailable:', error);
    }
    return stream;
  }

  private fail(turn: number, message: string): void {
    if (this.staleTurn(turn)) return;
    this.clearMonitor();
    this.clearPoll();
    const next = this.send({ type: 'fail', message });
    if (next.phase === 'listening') this.beginTurn(next.turn);
  }

  private beginTurn(turn: number): void {
    if (this.closed || this.state.turn !== turn) return;
    if (this.state.phase !== 'listening') return;
    this.stopRecognition();
    if (this.useBrowserRecognition) {
      this.startBrowserCapture(turn);
    } else {
      void this.startProviderCapture(turn);
    }
  }

  private startBrowserCapture(turn: number): void {
    const Recognition = getSpeechRecognition();
    if (!Recognition) return;
    const recognition = new Recognition();
    recognition.lang = this.options.locale;
    recognition.continuous = false;
    recognition.interimResults = false;
    let transcript = '';
    recognition.onresult = event => {
      transcript = Array.from(
        { length: event.results.length },
        (_, index) => event.results[index]?.[0]?.transcript ?? ''
      )
        .join(' ')
        .trim();
    };
    recognition.onend = () => {
      if (this.staleTurn(turn)) return;
      if (this.state.muted) return;
      const state = this.send({ type: 'captured' });
      if (state.phase === 'transcribing') {
        this.handleTranscript(turn, transcript);
      }
    };
    recognition.onerror = () => {
      if (this.staleTurn(turn)) return;
      this.fail(turn, this.options.messages.microphoneFailed);
    };
    this.recognition = recognition;
    try {
      recognition.start();
    } catch {
      this.fail(turn, this.options.messages.microphoneFailed);
    }
  }

  private async startProviderCapture(turn: number): Promise<void> {
    const model = this.sttModel;
    if (!model) return;
    const mimeType = recordingMimeType(model);
    if (!mimeType) {
      this.fail(turn, this.options.messages.microphoneFailed);
      return;
    }
    try {
      const stream = await this.ensureStream();
      if (this.staleTurn(turn)) return;
      this.chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType });
      this.recorder = recorder;
      recorder.ondataavailable = event => {
        if (event.data.size > 0) this.chunks.push(event.data);
      };
      recorder.onstop = () => {
        if (this.staleTurn(turn) && this.state.phase !== 'transcribing') {
          return;
        }
        const blob = new Blob(this.chunks, { type: mimeType });
        this.chunks = [];
        if (blob.size === 0) {
          this.handleTranscript(turn, '');
          return;
        }
        this.transcribeRecording(turn, blob);
      };
      recorder.start();

      // Endpointing: wait for speech, then close the turn on silence. The
      // manual finish control covers environments without an analyser.
      let speechMs = 0;
      let silenceMs = 0;
      let heardSpeech = false;
      const startedAt = Date.now();
      this.clearMonitor();
      this.monitorTimer = window.setInterval(() => {
        if (this.staleTurn(turn)) {
          this.clearMonitor();
          return;
        }
        if (this.state.muted) {
          speechMs = 0;
          silenceMs = 0;
          return;
        }
        if (this.analyser) {
          if (this.rmsLevel() > SPEECH_RMS_THRESHOLD) {
            speechMs += 50;
            silenceMs = 0;
            if (speechMs >= SPEECH_START_MS) heardSpeech = true;
          } else {
            speechMs = 0;
            if (heardSpeech) silenceMs += 50;
          }
        }
        if (
          (heardSpeech && silenceMs >= TURN_SILENCE_MS) ||
          Date.now() - startedAt >= MAX_TURN_MS
        ) {
          this.finishProviderCapture(turn);
        }
      }, 50);
    } catch (error) {
      logger.warn('Voice mode microphone failed:', error);
      this.fail(turn, this.options.messages.microphoneFailed);
    }
  }

  private finishProviderCapture(turn: number): void {
    if (this.staleTurn(turn)) return;
    this.clearMonitor();
    const state = this.send({ type: 'captured' });
    if (state.phase !== 'transcribing') return;
    this.stopRecorder();
  }

  private transcribeRecording(turn: number, blob: Blob): void {
    const model = this.sttModel;
    if (!model) {
      this.fail(turn, this.options.messages.transcriptionFailed);
      return;
    }
    const controller = new AbortController();
    this.abortController = controller;
    void sttApi
      .transcribe(blob, model, {
        language: this.options.locale?.split('-')[0],
        signal: controller.signal,
      })
      .then(result => this.handleTranscript(turn, result.text ?? ''))
      .catch(error => {
        if (controller.signal.aborted) return;
        logger.warn('Voice mode transcription failed:', error);
        this.fail(turn, this.options.messages.transcriptionFailed);
      });
  }

  private handleTranscript(turn: number, text: string): void {
    if (this.staleTurn(turn)) return;
    const next = this.send({ type: 'transcript', text });
    if (next.phase === 'generating') {
      this.startGeneration(next.turn, text.trim());
    } else if (next.phase === 'listening') {
      this.beginTurn(next.turn);
    }
  }

  private startGeneration(turn: number, text: string): void {
    this.options.onTranscript(text);
    const previousAssistantId =
      this.options.snapshot().lastAssistantMessage?.id ?? null;
    let sawActivity = false;
    const startedAt = Date.now();
    this.options.sendMessage(text);
    this.clearPoll();
    this.pollTimer = window.setInterval(() => {
      if (this.staleTurn(turn)) {
        this.clearPoll();
        return;
      }
      const snapshot = this.options.snapshot();
      const assistant = snapshot.lastAssistantMessage;
      const replied =
        assistant !== null && assistant.id !== previousAssistantId;
      if (snapshot.isStreaming || replied) sawActivity = true;
      if (sawActivity && !snapshot.isStreaming && replied) {
        this.clearPoll();
        const speak =
          this.ttsModels.length > 0 && assistant.content.trim() !== '';
        const next = this.send({ type: 'reply', speak });
        if (next.phase === 'speaking') {
          this.speakReply(turn, assistant.content);
        } else if (next.phase === 'listening') {
          this.beginTurn(next.turn);
        }
        return;
      }
      if (Date.now() - startedAt > REPLY_TIMEOUT_MS) {
        this.clearPoll();
        this.fail(turn, this.options.messages.replyTimeout);
      }
    }, 250);
  }

  private speakReply(turn: number, text: string): void {
    const ttsSettings = this.options.snapshot().ttsSettings;
    const selectedModel = resolveTTSModel(
      this.ttsModels,
      ttsSettings?.model,
      ttsSettings?.pluginId
    );
    if (!selectedModel) {
      this.finishSpeaking(turn);
      return;
    }
    const savedSelectionIsValid =
      selectedModel.model === ttsSettings?.model &&
      (!ttsSettings?.pluginId || selectedModel.plugin === ttsSettings.pluginId);
    const voice = savedSelectionIsValid
      ? ttsSettings?.voice || selectedModel.config?.default_voice
      : selectedModel.config?.default_voice;
    const voiceProfileId = savedSelectionIsValid
      ? ttsSettings?.voiceProfileId || undefined
      : undefined;
    const providerMaxChars = Math.max(
      1,
      selectedModel.config?.max_characters || 600
    );
    const maxChars = Math.min(providerMaxChars, 600);
    const batches = batchTextForTTS(text, {
      locale: this.options.locale,
      maxChars,
      targetChars: Math.min(maxChars, 420),
      minChars: Math.min(maxChars, 80),
    });
    if (batches.length === 0) {
      this.finishSpeaking(turn);
      return;
    }
    const session = createTTSPlaybackSession({
      concurrency: 3,
      initialBufferSize: Math.min(2, batches.length),
      generate: (input, { signal }) =>
        ttsApi.generate(
          {
            model: selectedModel.model,
            pluginId: selectedModel.plugin,
            input,
            voice: voiceProfileId ? undefined : voice || undefined,
            voiceProfileId,
            speed: ttsSettings?.speed || 1.0,
            response_format: selectedModel.config?.default_format,
          },
          { signal }
        ),
      onStateChange: () => undefined,
    });
    this.ttsSession = session;
    const release = activateTTSPlaybackSession(session);
    this.startBargeInMonitor(turn, session);
    void session
      .play(batches)
      .then(() => {
        if (this.staleTurn(turn)) return;
        this.finishSpeaking(turn);
      })
      .catch(error => {
        if (this.staleTurn(turn) || isTTSPlaybackAbort(error)) return;
        logger.warn('Voice mode speech failed:', error);
        this.finishSpeaking(turn);
      })
      .finally(() => {
        release();
        if (this.ttsSession === session) this.ttsSession = null;
      });
  }

  private startBargeInMonitor(turn: number, session: TTSPlaybackSession): void {
    if (!this.analyser) return;
    this.clearMonitor();
    let speechMs = 0;
    this.monitorTimer = window.setInterval(() => {
      if (this.staleTurn(turn) || this.state.muted) {
        speechMs = 0;
        return;
      }
      if (this.rmsLevel() > SPEECH_RMS_THRESHOLD) {
        speechMs += 50;
        if (speechMs >= BARGE_IN_MS) {
          this.clearMonitor();
          session.cancel();
          const next = this.send({ type: 'barge-in' });
          if (next.phase === 'listening') this.beginTurn(next.turn);
        }
      } else {
        speechMs = 0;
      }
    }, 50);
  }

  private finishSpeaking(turn: number): void {
    if (this.staleTurn(turn)) return;
    this.clearMonitor();
    const next = this.send({ type: 'spoken' });
    if (next.phase === 'listening') this.beginTurn(next.turn);
  }
}
