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
  await expect(
    page
      .getByRole('note')
      .getByText('Record and send audio to openai for transcription', {
        exact: true,
      })
  ).toBeVisible();

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

test('provider transcription remains cancellable while the request is running', async ({
  page,
}) => {
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    sttModels: [
      {
        model: 'cancel-transcription',
        plugin: 'openai',
        config: { formats: ['webm'], max_duration_seconds: 300 },
      },
    ],
    sttTranscript: 'This cancelled transcript must not be inserted.',
    sttTranscriptionDelayMs: 400,
    sessions: [
      {
        id: 'stt-cancel',
        title: 'Cancel transcription',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  });

  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => ({
          getTracks: () => [{ stop: () => undefined }],
        }),
      },
    });
    class MockMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      state: 'inactive' | 'recording' = 'inactive';
      mimeType = 'audio/webm;codecs=opus';
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onerror: (() => void) | null = null;
      onstop: (() => void) | null = null;

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

  await page.goto('/c/stt-cancel');
  await page
    .getByRole('button', {
      name: 'Record and send audio to openai for transcription',
    })
    .click();
  await page.getByTitle('Stop listening').click();
  await expect.poll(() => mockApi.sttTranscriptionRequests.length).toBe(1);

  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForTimeout(450);
  await expect(page.locator('textarea').last()).toHaveValue('');
});

test('late microphone permission cannot record or upload after chat navigation', async ({
  page,
}) => {
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    sttModels: [
      {
        model: 'permission-race',
        plugin: 'openai',
        config: { formats: ['webm'], max_duration_seconds: 300 },
      },
    ],
    sessions: [
      {
        id: 'stt-permission-a',
        title: 'Permission A',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
      {
        id: 'stt-permission-b',
        title: 'Permission B',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  });

  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
    Object.defineProperty(window, 'SpeechRecognition', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: undefined,
    });

    const probe = window as unknown as {
      __resolveMicrophone: () => void;
      __microphoneTrackStops: number;
      __mediaRecorderConstructions: number;
    };
    probe.__microphoneTrackStops = 0;
    probe.__mediaRecorderConstructions = 0;
    let resolvePermission: ((stream: unknown) => void) | undefined;
    const permission = new Promise(resolve => {
      resolvePermission = resolve;
    });
    const stream = {
      getTracks: () => [
        {
          stop: () => {
            probe.__microphoneTrackStops += 1;
          },
        },
      ],
    };
    probe.__resolveMicrophone = () => resolvePermission?.(stream);
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: () => permission },
    });
    class MockMediaRecorder {
      static isTypeSupported() {
        return true;
      }

      constructor() {
        probe.__mediaRecorderConstructions += 1;
      }
    }
    Object.defineProperty(window, 'MediaRecorder', {
      configurable: true,
      value: MockMediaRecorder,
    });
  });

  await page.goto('/c/stt-permission-a');
  await page
    .getByRole('button', {
      name: 'Record and send audio to openai for transcription',
    })
    .click();
  await expect(page.getByTitle('Cancel')).toBeVisible();

  await page.evaluate(() => {
    history.pushState({}, '', '/c/stt-permission-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/c\/stt-permission-b$/);
  await expect(page.getByRole('tab', { name: /Permission B/ })).toHaveAttribute(
    'data-active',
    'true'
  );
  await page.evaluate(() => {
    (
      window as unknown as { __resolveMicrophone: () => void }
    ).__resolveMicrophone();
  });

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __microphoneTrackStops: number })
            .__microphoneTrackStops
      )
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __mediaRecorderConstructions: number })
          .__mediaRecorderConstructions
    )
  ).toBe(0);
  expect(mockApi.sttTranscriptionRequests).toHaveLength(0);
});
