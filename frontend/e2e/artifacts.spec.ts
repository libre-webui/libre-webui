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

import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const generatedMultiFileArtifact = `
Here are the files for the game:

index.html
\`\`\`html
<!doctype html>
<html>
  <head>
    <title>Mini Canvas Game</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <canvas id="game" width="320" height="180"></canvas>
    <script src="game.js"></script>
  </body>
</html>
\`\`\`

style.css
\`\`\`css
html, body { margin: 0; min-height: 100%; background: #050816; }
canvas { display: block; width: 100%; max-width: 640px; margin: 2rem auto; border: 2px solid #38bdf8; }
\`\`\`

game.js
\`\`\`js
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
let x = 20;
function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#38bdf8';
  ctx.fillRect(x, 70, 40, 40);
  x = (x + 2) % canvas.width;
  requestAnimationFrame(draw);
}
draw();
\`\`\`
`;

test('chat detects multi-file HTML artifacts and renders them in the slide-out panel', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'artifact-session',
        title: 'Generated game',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'Make a tiny canvas game',
            timestamp: Date.now() - 1_000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            model: 'llama3.2:3b',
            content: generatedMultiFileArtifact,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  });

  await page.goto('/c/artifact-session');

  await expect(
    page.getByRole('heading', { name: 'Mini Canvas Game' }).first()
  ).toBeVisible();
  await expect(
    page.getByText(
      'Bundled generated HTML, CSS, and JavaScript files into one runnable artifact.'
    )
  ).toBeVisible();

  await page.locator('button[title="Open in panel"]:visible').first().click();

  const panel = page.getByTestId('artifact-slide-out-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Mini Canvas Game')).toBeVisible();

  const frame = page.frameLocator('iframe[title="Mini Canvas Game"]').first();
  await expect(frame.locator('#game')).toBeVisible();
});

test('artifact panel resize releases pointer state after mouse up', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'resize-session',
        title: 'Resizable artifact',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'Make a game',
            timestamp: Date.now() - 1_000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            model: 'llama3.2:3b',
            content: generatedMultiFileArtifact,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  });

  await page.goto('/c/resize-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const panel = page.getByTestId('artifact-slide-out-panel');
  const handle = page.getByTestId('artifact-resize-handle');
  await expect(panel).toBeVisible();

  const initialBox = await panel.boundingBox();
  const handleBox = await handle.boundingBox();
  expect(initialBox).not.toBeNull();
  expect(handleBox).not.toBeNull();

  const startX = handleBox!.x + handleBox!.width / 2;
  const startY = handleBox!.y + handleBox!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 140, startY);
  await page.mouse.up();

  const resizedBox = await panel.boundingBox();
  expect(resizedBox).not.toBeNull();
  expect(resizedBox!.width).toBeGreaterThan(initialBox!.width + 80);
  await expect
    .poll(() => page.evaluate(() => document.body.style.cursor))
    .toBe('');

  await page.mouse.move(startX - 240, startY);
  const afterReleaseBox = await panel.boundingBox();
  expect(afterReleaseBox).not.toBeNull();
  expect(Math.abs(afterReleaseBox!.width - resizedBox!.width)).toBeLessThan(2);
});
