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

const generatedFilenameQualifiedArtifact = `
This app uses nested paths in fence metadata:

\`\`\`html filename="src/index.html"
<!doctype html>
<html>
  <head>
    <title>Filename Bundle</title>
    <link rel="stylesheet" href="./styles/app.css">
  </head>
  <body>
    <main id="app">Loading bundle...</main>
    <script src="./game.js"></script>
  </body>
</html>
\`\`\`

\`\`\`css filename="src/styles/app.css"
:root { --bundle-accent: #38bdf8; }
body { margin: 0; background: #020617; color: var(--bundle-accent); }
\`\`\`

\`\`\`javascript filename="src/game.js"
document.getElementById('app').textContent = 'Bundle ready';
document.body.dataset.bundleReady = 'true';
\`\`\`
`;

const generatedBareHtmlDocument = `
Here is the complete page:

<!doctype html>
<html>
  <head>
    <title>Bare HTML Artifact</title>
  </head>
  <body>
    <button id="launch">Launch</button>
    <script>
      document.getElementById('launch').textContent = 'Bare HTML ready';
    </script>
  </body>
</html>

It should run as a preview.
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

  const frame = page
    .frameLocator('iframe[title="Mini Canvas Game"]')
    .first()
    .frameLocator('iframe[title="Artifact"]');
  await expect(frame.locator('#game')).toBeVisible();

  const iframe = panel.locator('iframe[title="Mini Canvas Game"]').first();
  await expect(iframe).toHaveAttribute('sandbox', /allow-scripts/);
  await expect(iframe).not.toHaveAttribute('sandbox', /allow-same-origin/);
  await expect(iframe).not.toHaveAttribute(
    'sandbox',
    /allow-popups-to-escape-sandbox/
  );
  await expect(iframe).toHaveAttribute('sandbox', /allow-pointer-lock/);
  await expect(iframe).toHaveAttribute('allow', /clipboard-write/);
  await expect(iframe).toHaveAttribute('allow', /fullscreen/);

  const canReadParentDocument = await frame.locator('body').evaluate(() => {
    try {
      return Boolean(parent.document.body);
    } catch {
      return false;
    }
  });
  expect(canReadParentDocument).toBe(false);
});

test('SVG artifacts stay isolated from the authenticated parent document', async ({
  page,
}) => {
  const now = Date.now();
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'hostile-svg-session',
        title: 'Hostile SVG',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: 'assistant-svg',
            role: 'assistant',
            content: '',
            timestamp: now,
            artifacts: [
              {
                id: 'hostile-svg-artifact',
                type: 'svg',
                title: 'Isolated SVG',
                content:
                  '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" onload="parent.document.documentElement.dataset.svgEscaped=\'true\'"><rect width="100" height="100" fill="red"/></svg>',
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      },
    ],
  });

  await page.goto('/c/hostile-svg-session');

  const inlinePreview = page
    .getByTestId('artifact-svg-preview')
    .filter({ visible: true })
    .first();
  await expect(inlinePreview).toHaveAttribute('sandbox', '');
  await expect(page.locator('html')).not.toHaveAttribute('data-svg-escaped');

  await page.locator('button[title="Open in panel"]:visible').first().click();
  const panelPreview = page
    .getByTestId('artifact-slide-out-panel')
    .getByTestId('artifact-svg-preview');
  await expect(panelPreview).toHaveAttribute('sandbox', '');
  await expect(page.locator('html')).not.toHaveAttribute('data-svg-escaped');
});

test('chat detects filename-qualified HTML bundles and removes local file references', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'filename-bundle-session',
        title: 'Filename bundle',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'Generate an app with nested filenames',
            timestamp: Date.now() - 1_000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            model: 'llama3.2:3b',
            content: generatedFilenameQualifiedArtifact,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  });

  await page.goto('/c/filename-bundle-session');

  await expect(
    page.getByRole('heading', { name: 'Filename Bundle' }).first()
  ).toBeVisible();

  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .frameLocator('iframe[title="Filename Bundle"]')
    .first()
    .frameLocator('iframe[title="Artifact"]');
  await expect(frame.locator('#app')).toHaveText('Bundle ready');
  await expect(frame.locator('body')).toHaveAttribute(
    'data-bundle-ready',
    'true'
  );
  await expect
    .poll(() =>
      frame.locator('body').evaluate(body => getComputedStyle(body).color)
    )
    .toBe('rgb(56, 189, 248)');
  await expect(frame.locator('link[href$="app.css"]')).toHaveCount(0);
  await expect(frame.locator('script[src$="game.js"]')).toHaveCount(0);
});

test('chat extracts standalone full HTML documents that are not fenced', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'bare-html-session',
        title: 'Bare HTML',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          {
            id: 'user-1',
            role: 'user',
            content: 'Return one full HTML page',
            timestamp: Date.now() - 1_000,
          },
          {
            id: 'assistant-1',
            role: 'assistant',
            model: 'llama3.2:3b',
            content: generatedBareHtmlDocument,
            timestamp: Date.now(),
          },
        ],
      },
    ],
  });

  await page.goto('/c/bare-html-session');

  await expect(
    page.getByRole('heading', { name: 'Bare HTML Artifact' }).first()
  ).toBeVisible();

  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .frameLocator('iframe[title="Bare HTML Artifact"]')
    .first()
    .frameLocator('iframe[title="Artifact"]');
  await expect(frame.locator('#launch')).toHaveText('Bare HTML ready');
});

test('html artifacts show a themed fallback when no preview content is available', async ({
  page,
}) => {
  const now = Date.now();

  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'empty-artifact-session',
        title: 'Empty artifact',
        model: 'llama3.2:3b',
        createdAt: now,
        updatedAt: now,
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            content: '',
            timestamp: now,
            artifacts: [
              {
                id: 'empty-html-artifact',
                type: 'html',
                title: 'Empty HTML Artifact',
                content: '   ',
                createdAt: now,
                updatedAt: now,
              },
            ],
          },
        ],
      },
    ],
  });

  await page.goto('/c/empty-artifact-session');

  await expect(
    page.getByRole('heading', { name: 'Empty HTML Artifact' }).first()
  ).toBeVisible();
  await expect(page.getByTestId('artifact-html-fallback')).toContainText(
    'Preview unavailable'
  );

  await page.locator('button[title="Open in panel"]:visible').first().click();

  const panel = page.getByTestId('artifact-slide-out-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('artifact-html-fallback')).toContainText(
    'Switch to code view'
  );

  await panel.getByRole('button', { name: 'Code' }).first().click();
  await expect(panel.getByTestId('artifact-html-fallback')).toHaveCount(0);
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
