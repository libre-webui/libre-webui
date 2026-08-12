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
    .getByRole('textbox', { name: 'Text to speak' })
    .fill('Generate this sentence in the consented voice.');
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
  expect(request.body).toContain('wav');
});
