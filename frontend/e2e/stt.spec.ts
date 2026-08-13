/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test('provider speech input discloses its route and transcribes recorded audio', async ({
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
    sttTranscript: 'Provider transcription works.',
    sessions: [
      {
        id: 'stt-session',
        title: 'Speech transcription',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  });

  await page.addInitScript(() => {
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
          data: new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], {
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
  });

  await page.goto('/c/stt-session');

  const source = page.getByLabel('Speech recognition source');
  await expect(source).toHaveValue('openai:gpt-4o-mini-transcribe');
  const microphone = page.getByRole('button', {
    name: 'Record and send audio to openai for transcription',
  });
  await expect(microphone).toBeVisible();

  await microphone.click();
  await expect(page.getByTitle('Stop listening')).toBeVisible();
  await page.getByTitle('Stop listening').click();

  await expect(page.locator('textarea').last()).toHaveValue(
    'Provider transcription works.'
  );
  expect(mockApi.sttTranscriptionRequests).toHaveLength(1);
  expect(mockApi.sttTranscriptionRequests[0].contentType).toMatch(
    /^multipart\/form-data;/
  );
  expect(mockApi.sttTranscriptionRequests[0].body).toContain(
    'gpt-4o-mini-transcribe'
  );
  expect(mockApi.sttTranscriptionRequests[0].body).toContain('openai');
});
