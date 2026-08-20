/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

// Same minimal Opus/WebM container fixture as the STT spec.
const SUPPORTED_OPUS_WEBM_BYTES = [
  26, 69, 223, 163, 135, 66, 130, 132, 119, 101, 98, 109, 24, 83, 128, 103, 213,
  21, 73, 169, 102, 135, 42, 215, 177, 131, 15, 66, 64, 22, 84, 174, 107, 181,
  174, 179, 215, 129, 1, 131, 129, 2, 134, 134, 65, 95, 79, 80, 85, 83, 99, 162,
  147, 79, 112, 117, 115, 72, 101, 97, 100, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  225, 141, 181, 136, 64, 231, 112, 0, 0, 0, 0, 0, 159, 129, 1, 31, 67, 182,
  117, 138, 231, 129, 0, 163, 133, 129, 0, 0, 0, 248,
];

test('voice mode opens hands-free conversation and transcribes a manual turn', async ({
  page,
}) => {
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    sttModels: [
      {
        model: 'gpt-4o-mini-transcribe',
        plugin: 'openai',
        config: { formats: ['webm'], max_audio_bytes: 25 * 1024 * 1024 },
      },
    ],
    sttTranscript: 'Hands-free question.',
    sessions: [
      {
        id: 'voice-mode-session',
        title: 'Voice conversation',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  });

  await page.addInitScript(audioBytes => {
    localStorage.setItem('auth-token', 'e2e-token');
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    const stream = {
      getTracks: () => [{ stop: () => undefined }],
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream },
    });
    class MockMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      state: 'inactive' | 'recording' = 'inactive';
      mimeType: string;
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;

      constructor(_stream: unknown, options?: { mimeType?: string }) {
        this.mimeType = options?.mimeType || 'audio/webm;codecs=opus';
      }

      start() {
        this.state = 'recording';
      }

      stop() {
        this.state = 'inactive';
        this.ondataavailable?.({
          data: new Blob([new Uint8Array(audioBytes)], {
            type: this.mimeType,
          }),
        });
        queueMicrotask(() => this.onstop?.());
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });
  }, SUPPORTED_OPUS_WEBM_BYTES);

  await page.goto('/c/voice-mode-session');

  const openButton = page.getByTestId('voice-mode-open');
  await expect(openButton).toBeVisible();
  await openButton.click();

  const overlay = page.getByTestId('voice-mode-overlay');
  await expect(overlay).toBeVisible();
  await expect(page.getByTestId('voice-mode-status')).toHaveText('Listening…');

  // Mute pauses capture; unmute resumes a fresh turn.
  await page.getByRole('button', { name: 'Mute microphone' }).click();
  await expect(page.getByTestId('voice-mode-status')).toHaveText(
    'Microphone muted'
  );
  await page.getByRole('button', { name: 'Unmute microphone' }).click();
  await expect(page.getByTestId('voice-mode-status')).toHaveText('Listening…');

  // Manually finish the turn: the mocked recording transcribes and the
  // transcript is sent as a chat message.
  await page.getByRole('button', { name: 'Done speaking' }).click();
  await expect(overlay.getByText('“Hands-free question.”')).toBeVisible();
  expect(mockApi.sttTranscriptionRequests.length).toBeGreaterThanOrEqual(1);

  // Close tears the session down and returns to the composer.
  await page.getByRole('button', { name: 'Close voice mode' }).click();
  await expect(overlay).not.toBeVisible();
});
