/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

test('Imagine distinguishes OpenRouter sound generation from speech', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    mediaModels: {
      video: [],
      audio: [
        {
          model: 'google/lyria-3-pro-preview',
          plugin: 'openrouter',
          mode: 'sound',
          config: {
            voices: ['alloy'],
            default_voice: 'alloy',
            formats: ['wav'],
            default_format: 'wav',
          },
        },
        {
          model: 'openai/gpt-4o-mini-tts',
          plugin: 'openrouter',
          mode: 'speech',
        },
      ],
    },
  });

  await page.goto('/gallery');
  await page
    .locator('header')
    .getByRole('button', { name: 'Audio', exact: true })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Generate media' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox', { name: 'Model' })).toHaveValue(
    'sound::openrouter::google/lyria-3-pro-preview'
  );
  await expect(
    dialog.getByRole('combobox', { name: 'Model' }).locator('option')
  ).toHaveText([
    'google/lyria-3-pro-preview (openrouter · Sound)',
    'openai/gpt-4o-mini-tts (openrouter · Speech)',
  ]);

  await dialog
    .getByRole('textbox', { name: 'Prompt' })
    .fill('Warm analogue synth with a soft rain ambience');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();

  await expect.poll(() => mockApi.soundGenerationRequests.length).toBe(1);
  expect(mockApi.soundGenerationRequests[0]).toEqual({
    model: 'google/lyria-3-pro-preview',
    pluginId: 'openrouter',
    prompt: 'Warm analogue synth with a soft rain ambience',
    voice: 'alloy',
    format: 'wav',
  });
});

test('Imagine exposes JSON-declared LongCat voice cloning fields', async ({
  page,
}) => {
  const model = 'meituan-longcat/LongCat-AudioDiT-1B';
  const mockApi = await mockLibreWebUiApi(page, {
    mediaModels: {
      video: [],
      audio: [
        {
          model,
          plugin: 'longcat-audiodit',
          mode: 'speech',
          config: {
            formats: ['wav'],
            default_format: 'wav',
            allows_custom_voice: false,
            supports_voice_cloning: true,
            clone_requires_transcript: true,
            clone_audio_mime_types: ['audio/wav'],
            clone_max_audio_bytes: 5 * 1024 * 1024,
          },
        },
      ],
    },
  });

  await page.goto('/gallery');
  await page
    .locator('header')
    .getByRole('button', { name: 'Audio', exact: true })
    .click();

  const dialog = page.getByRole('dialog', { name: 'Generate media' });
  const cloneToggle = dialog.getByRole('checkbox', {
    name: /Clone a reference voice/,
  });
  await expect(
    dialog.getByRole('textbox', { name: 'Voice or voice ID' })
  ).toHaveCount(0);
  await cloneToggle.check();
  await dialog.getByLabel('Reference audio').setInputFiles({
    name: 'consented-reference.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
  });
  await dialog
    .getByRole('textbox', { name: 'Exact reference transcript' })
    .fill('This is the exact reference recording.');
  await cloneToggle.uncheck();
  await cloneToggle.check();
  await expect(dialog.getByLabel('Reference audio')).toHaveValue('');
  await expect(
    dialog.getByRole('textbox', { name: 'Exact reference transcript' })
  ).toHaveValue('');
  await expect(
    dialog.getByRole('button', { name: 'Generate', exact: true })
  ).toBeDisabled();

  await dialog.getByLabel('Reference audio').setInputFiles({
    name: 'consented-reference.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.from('RIFF\u0000\u0000\u0000\u0000WAVEfmt '),
  });
  await dialog
    .getByRole('textbox', { name: 'Exact reference transcript' })
    .fill('This is the exact reference recording.');
  await dialog
    .getByRole('checkbox', { name: /Save as a reusable voice/ })
    .check();
  await dialog
    .getByRole('textbox', { name: 'Saved voice name' })
    .fill('Robin test voice');
  await dialog
    .getByRole('textbox', { name: 'Text to speak' })
    .fill('Generate this sentence in the consented voice.');
  await expect(
    dialog.getByRole('button', { name: 'Generate', exact: true })
  ).toBeDisabled();
  await dialog
    .getByRole('checkbox', { name: /permission to clone and store/ })
    .check();
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();

  await expect.poll(() => mockApi.voiceCloneRequests.length).toBe(1);
  const request = mockApi.voiceCloneRequests[0];
  expect(request.contentType).toContain('multipart/form-data; boundary=');
  expect(request.body).toContain(model);
  expect(request.body).toContain('longcat-audiodit');
  expect(request.body).toContain('consented-reference.wav');
  expect(request.body).toContain('This is the exact reference recording.');
  expect(request.body).toContain(
    'Generate this sentence in the consented voice.'
  );
  expect(request.body).toContain('saveVoiceName');
  expect(request.body).toContain('Robin test voice');
  expect(request.body).toContain('consentToStore');
  expect(request.body).toContain('wav');
});

test('video jobs can stop waiting, reopen, and resume without losing the handle', async ({
  page,
}) => {
  const mockApi = await mockLibreWebUiApi(page, {
    mediaModels: {
      video: [
        {
          model: 'video-model',
          plugin: 'video-provider',
          config: { durations: [5], default_duration: 5 },
        },
      ],
      audio: [],
    },
  });

  await page.goto('/gallery');
  await page
    .locator('header')
    .getByRole('button', { name: 'Video', exact: true })
    .click();
  let dialog = page.getByRole('dialog', { name: 'Generate media' });
  const prompt = dialog.getByRole('textbox', { name: 'Prompt' });
  await prompt.fill('A durable video job');
  await dialog.getByRole('button', { name: 'Generate', exact: true }).click();
  await expect.poll(() => mockApi.videoGenerationRequests.length).toBe(1);

  const stopWaiting = dialog.getByRole('button', { name: 'Stop waiting' });
  await expect(stopWaiting).toBeVisible();
  await prompt.fill('');
  await expect(stopWaiting).toBeEnabled();
  await stopWaiting.click();
  await expect(
    dialog.getByRole('button', { name: 'Generate', exact: true })
  ).toBeVisible();

  await dialog.locator('button').first().click();
  await expect(dialog).toBeHidden();
  await page
    .locator('header')
    .getByRole('button', { name: 'Video', exact: true })
    .click();
  dialog = page.getByRole('dialog', { name: 'Generate media' });
  await expect(dialog.getByText('A durable video job')).toBeVisible();
  await dialog.getByRole('button', { name: 'Resume' }).click();
  await expect.poll(() => mockApi.videoResumeRequests).toEqual(['video-job-1']);
  await expect(dialog.getByText('A durable video job')).toHaveCount(0);
});

test('provider cancellation is offered only for a cancellable saved video job', async ({
  page,
}) => {
  const now = Date.now();
  const mockApi = await mockLibreWebUiApi(page, {
    mediaModels: {
      video: [{ model: 'video-model', plugin: 'video-provider' }],
      audio: [],
    },
    mediaVideoJobs: [
      {
        id: 'cancellable-job',
        status: 'in_progress',
        model: 'video-model',
        pluginId: 'video-provider',
        prompt: 'A cancellable provider render',
        cancellable: true,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'wait-only-job',
        status: 'pending',
        model: 'video-model',
        pluginId: 'video-provider',
        prompt: 'A wait-only provider render',
        cancellable: false,
        createdAt: now - 1,
        updatedAt: now - 1,
      },
    ],
  });

  await page.goto('/gallery');
  await page
    .locator('header')
    .getByRole('button', { name: 'Video', exact: true })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Generate media' });
  const cancellableRow = dialog.getByTestId('video-job-cancellable-job');
  const waitOnlyRow = dialog.getByTestId('video-job-wait-only-job');
  await expect(
    cancellableRow.getByRole('button', { name: 'Cancel job' })
  ).toBeVisible();
  await expect(
    waitOnlyRow.getByRole('button', { name: 'Cancel job' })
  ).toHaveCount(0);
  await cancellableRow.getByRole('button', { name: 'Cancel job' }).click();
  await expect
    .poll(() => mockApi.videoCancelRequests)
    .toEqual(['cancellable-job']);
});
