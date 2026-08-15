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

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test('batched read-aloud reuses the selected saved voice for every batch', async ({
  page,
}) => {
  const model = 'meituan-longcat/LongCat-AudioDiT-3.5B';
  const voiceProfileId = 'saved-longcat-voice';
  const spokenText = [
    'The first sentence introduces a calm and measured response.',
    'The second sentence gives the next idea enough room to breathe.',
    'The third sentence keeps a natural rhythm between generated clips.',
    'The fourth sentence confirms that playback remains in order.',
    'The fifth sentence closes the response in the same saved voice.',
  ].join(' ');
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    preferences: {
      ttsSettings: {
        enabled: true,
        autoPlay: false,
        model,
        voice: '',
        voiceProfileId,
        speed: 1,
        pluginId: 'longcat-audiodit',
        streamSentences: true,
      },
    },
    ttsModels: [
      {
        model,
        plugin: 'longcat-audiodit',
        config: {
          voices: [],
          default_voice: '',
          formats: ['wav'],
          default_format: 'wav',
          max_characters: 140,
          supports_voice_cloning: true,
          clone_requires_transcript: true,
        },
      },
    ],
    sessions: [
      {
        id: 'saved-voice-playback',
        title: 'Saved voice playback',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: 'saved-voice-assistant',
            role: 'assistant',
            content: spokenText,
            timestamp: now,
            model: 'llama3.2:3b',
          },
        ],
      },
    ],
  });

  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:e2e-tts',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => undefined,
    });

    class MockAudio {
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;

      pause() {}

      play() {
        queueMicrotask(() => this.onended?.());
        return Promise.resolve();
      }

      removeAttribute() {}

      load() {}
    }

    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: MockAudio,
    });
  });

  await page.goto('/c/saved-voice-playback');
  const readAloud = page.locator('button[title="Read aloud"]');
  await expect(readAloud).toBeVisible();
  await readAloud.click();

  await expect
    .poll(() => mockApi.ttsGenerationRequests.length)
    .toBeGreaterThan(1);
  expect(
    mockApi.ttsGenerationRequests.every(
      request =>
        request.voiceProfileId === voiceProfileId &&
        request.voice === undefined &&
        request.input.length <= 140
    )
  ).toBe(true);
});

test('auto-play surfaces blocked audio and retries from a real click', async ({
  page,
}) => {
  const model = 'mock-autoplay-tts';
  const mockApi = await mockLibreWebUiApi(page, {
    preferences: {
      ttsSettings: {
        enabled: true,
        autoPlay: true,
        model,
        voice: 'calm',
        voiceProfileId: '',
        speed: 1,
        pluginId: 'mock-tts',
        streamSentences: true,
      },
    },
    ttsModels: [
      {
        model,
        plugin: 'mock-tts',
        config: {
          voices: ['calm'],
          default_voice: 'calm',
          formats: ['wav'],
          default_format: 'wav',
          max_characters: 600,
        },
      },
    ],
    sessions: [
      {
        id: 'autoplay-recovery',
        title: 'Autoplay recovery',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    chatStream: {
      chunks: ['This response should begin speaking automatically.'],
      chunkDelayMs: 20,
      completionDelayMs: 20,
      duplicateCompletion: true,
    },
  });

  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');

    type AudioProbe = Window & {
      __allowTtsAudio: boolean;
      __ttsContextCount: number;
      __ttsResumeCalls: number;
      __ttsStarts: number;
    };
    const probe = window as AudioProbe;
    probe.__allowTtsAudio = false;
    probe.__ttsContextCount = 0;
    probe.__ttsResumeCalls = 0;
    probe.__ttsStarts = 0;

    class MockBufferSource {
      buffer: { duration: number } | null = null;
      onended: (() => void) | null = null;

      connect() {}

      disconnect() {}

      start() {
        probe.__ttsStarts += 1;
        queueMicrotask(() => this.onended?.());
      }

      stop() {}
    }

    class GatedAudioContext {
      currentTime = 0;
      destination = {};
      state = 'suspended';

      constructor() {
        probe.__ttsContextCount += 1;
      }

      createBufferSource() {
        return new MockBufferSource();
      }

      async decodeAudioData() {
        return { duration: 0.05 };
      }

      resume() {
        probe.__ttsResumeCalls += 1;
        if (!probe.__allowTtsAudio) {
          return Promise.reject(
            Object.assign(new Error('User activation is required'), {
              name: 'NotAllowedError',
            })
          );
        }
        this.state = 'running';
        return Promise.resolve();
      }
    }

    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: GatedAudioContext,
    });
    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: undefined,
    });
  });

  await page.goto('/c/autoplay-recovery');
  await page.waitForLoadState('networkidle');

  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill('Please answer aloud.');
  await input.press('Enter');

  const enableAudio = page.getByRole('button', {
    name: 'Enable audio and read aloud',
  });
  await expect(enableAudio).toBeVisible();
  expect(mockApi.ttsGenerationRequests).toHaveLength(0);
  expect(
    await page.evaluate(
      () => (window as unknown as { __ttsStarts: number }).__ttsStarts
    )
  ).toBe(0);

  await page.evaluate(() => {
    (window as unknown as { __allowTtsAudio: boolean }).__allowTtsAudio = true;
  });
  await enableAudio.click();

  await expect
    .poll(() => mockApi.ttsGenerationRequests.length)
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { __ttsStarts: number }).__ttsStarts
      )
    )
    .toBeGreaterThan(0);
  await page.waitForTimeout(50);
  expect(mockApi.ttsGenerationRequests).toHaveLength(1);
  expect(
    await page.evaluate(
      () => (window as unknown as { __ttsResumeCalls: number }).__ttsResumeCalls
    )
  ).toBeGreaterThan(1);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { __ttsContextCount: number }).__ttsContextCount
    )
  ).toBe(1);
});

test('read-aloud stops, restarts, and releases audio on navigation', async ({
  page,
}) => {
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    preferences: {
      ttsSettings: {
        enabled: true,
        autoPlay: false,
        model: 'lifecycle-tts',
        voice: 'calm',
        voiceProfileId: '',
        speed: 1,
        pluginId: 'mock-tts',
        streamSentences: true,
      },
    },
    ttsModels: [
      {
        model: 'lifecycle-tts',
        plugin: 'mock-tts',
        config: {
          voices: ['calm'],
          default_voice: 'calm',
          formats: ['wav'],
          default_format: 'wav',
          max_characters: 600,
        },
      },
    ],
    sessions: [
      {
        id: 'tts-lifecycle-a',
        title: 'TTS lifecycle A',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: 'tts-lifecycle-message',
            role: 'assistant',
            content: 'This response remains active until the user stops it.',
            timestamp: now,
            model: 'llama3.2:3b',
          },
        ],
      },
      {
        id: 'tts-lifecycle-b',
        title: 'TTS lifecycle B',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [],
      },
    ],
  });

  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'e2e-token');
    Object.defineProperty(window, 'AudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'webkitAudioContext', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: () => 'blob:tts-lifecycle',
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: () => undefined,
    });

    const probe = window as unknown as {
      __ttsLifecyclePlays: number;
      __ttsLifecyclePauses: number;
    };
    probe.__ttsLifecyclePlays = 0;
    probe.__ttsLifecyclePauses = 0;
    class LifecycleAudio {
      currentTime = 0;
      onended: (() => void) | null = null;
      onerror: (() => void) | null = null;

      pause() {
        probe.__ttsLifecyclePauses += 1;
      }

      async play() {
        probe.__ttsLifecyclePlays += 1;
      }

      removeAttribute() {}

      load() {}
    }
    Object.defineProperty(window, 'Audio', {
      configurable: true,
      value: LifecycleAudio,
    });
  });

  await page.goto('/c/tts-lifecycle-a');
  await page.getByRole('button', { name: 'Read aloud' }).click();
  await expect
    .poll(() => mockApi.ttsGenerationRequests.length)
    .toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ttsLifecyclePlays: number })
            .__ttsLifecyclePlays
      )
    )
    .toBe(1);

  await page.getByRole('button', { name: 'Stop speaking' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ttsLifecyclePauses: number })
            .__ttsLifecyclePauses
      )
    )
    .toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Read aloud' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ttsLifecyclePlays: number })
            .__ttsLifecyclePlays
      )
    )
    .toBe(2);

  const pausesBeforeNavigation = await page.evaluate(
    () =>
      (window as unknown as { __ttsLifecyclePauses: number })
        .__ttsLifecyclePauses
  );

  await page.evaluate(() => {
    history.pushState({}, '', '/c/tts-lifecycle-b');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page).toHaveURL(/\/c\/tts-lifecycle-b$/);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __ttsLifecyclePauses: number })
            .__ttsLifecyclePauses
      )
    )
    .toBeGreaterThan(pausesBeforeNavigation);
});
