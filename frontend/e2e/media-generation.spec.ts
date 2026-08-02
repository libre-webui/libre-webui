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
