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
