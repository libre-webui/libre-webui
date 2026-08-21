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

import { expect, test, type Page } from '@playwright/test';
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
  // Drag toward the panel: shrinking is never blocked by the split-mode
  // width clamp that protects the chat column.
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 140, startY);
  await page.mouse.up();

  const resizedBox = await panel.boundingBox();
  expect(resizedBox).not.toBeNull();
  expect(resizedBox!.width).toBeLessThan(initialBox!.width - 80);
  await expect
    .poll(() => page.evaluate(() => document.body.style.cursor))
    .toBe('');

  await page.mouse.move(startX + 240, startY);
  const afterReleaseBox = await panel.boundingBox();
  expect(afterReleaseBox).not.toBeNull();
  expect(Math.abs(afterReleaseBox!.width - resizedBox!.width)).toBeLessThan(2);
});

const generatedReactArtifact = `
Here is the dashboard component:

\`\`\`jsx
import { useState } from 'react';
import { BarChart, Bar, XAxis, ResponsiveContainer } from 'recharts';
import { Activity } from 'lucide-react';

const data = [
  { day: 'Mon', visits: 12 },
  { day: 'Tue', visits: 19 },
  { day: 'Wed', visits: 7 },
];

export default function VisitsPanel() {
  const [label, setLabel] = useState('Weekly visits');

  return (
    <div className="p-4">
      <h1 id="heading" className="text-lg font-bold text-slate-900">{label}</h1>
      <Activity id="icon" className="w-4 h-4 text-rose-500" />
      <div className="h-40 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data}>
            <XAxis dataKey="day" />
            <Bar dataKey="visits" fill="#2563eb" />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <button id="rename" className="bg-slate-900 px-3 py-2 text-white" onClick={() => setLabel('Renamed')}>
        Rename
      </button>
    </div>
  );
}
\`\`\`
`;

const generatedMermaidArtifact = `
Here is the flow:

\`\`\`mermaid
flowchart LR
  Request[Request] --> Sandbox[Sandbox]
  Sandbox --> Response[Response]
\`\`\`
`;

const generatedCdnHtmlArtifact = `
A dashboard that loads its libraries from a CDN:

\`\`\`html
<!doctype html>
<html>
  <head>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.js"></script>
  </head>
  <body class="bg-slate-100">
    <h1 id="title" class="text-2xl font-bold text-slate-900">CDN Dashboard</h1>
    <canvas id="board" width="240" height="120"></canvas>
    <script>
      document.getElementById('title').dataset.chartReady = String(typeof Chart === 'function');
      new Chart(document.getElementById('board'), {
        type: 'bar',
        data: { labels: ['a', 'b'], datasets: [{ data: [3, 5] }] },
        options: { animation: false, responsive: false },
      });
      document.getElementById('title').dataset.chartDrawn = 'true';
    </script>
  </body>
</html>
\`\`\`
`;

const sessionWith = (id: string, title: string, content: string) => ({
  id,
  title,
  model: 'llama3.2:3b',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    {
      id: `${id}-user`,
      role: 'user' as const,
      content: 'Build it',
      timestamp: Date.now() - 1_000,
    },
    {
      id: `${id}-assistant`,
      role: 'assistant' as const,
      model: 'llama3.2:3b',
      content,
      timestamp: Date.now(),
    },
  ],
});

/**
 * The vendored runtime is several megabytes on disk. Reading it through a cold
 * dev server while a browser waits is what makes these tests flaky, so each
 * worker pulls it once up front.
 */
test.beforeAll(async ({ request }) => {
  const assets = [
    'react-bootstrap.js',
    'mermaid-bootstrap.js',
    'react.js',
    'react-dom-client.js',
    'recharts.js',
    'lucide-react.js',
    'globals/tailwind.js',
    'globals/chart.js',
  ];
  for (const asset of assets) {
    await request.get(`/artifact-runtime/${asset}`).catch(() => undefined);
  }
});

/** Anything the artifact frame tries to load from outside this application. */
const trackExternalRequests = (page: Page): string[] => {
  const external: string[] = [];
  page.on('request', request => {
    const url = request.url();
    if (
      !/^(?:https?:\/\/(?:127\.0\.0\.1|localhost):\d+|data:|blob:|about:)/.test(
        url
      )
    ) {
      external.push(url);
    }
  });
  return external;
};

test('React artifacts compile and mount against the vendored runtime', async ({
  page,
}) => {
  // Compiling the artifact and loading the vendored runtime is heavier than a
  // markup-only preview, especially on a cold dev server.
  test.slow();
  const external = trackExternalRequests(page);
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('react-session', 'React artifact', generatedReactArtifact),
    ],
  });

  await page.goto('/c/react-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  // Scope to the panel: the same artifact is also rendered inline in the
  // message list, where the panel backdrop covers it.
  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe[title="VisitsPanel"]')
    .frameLocator('iframe[title="Artifact"]');

  // JSX compiled and React mounted. The first assertion waits on a cold load
  // of the vendored runtime, which is a large bundle to compile.
  await expect(frame.locator('#heading')).toHaveText('Weekly visits', {
    timeout: 30_000,
  });
  // Tailwind utilities are generated in the frame.
  await expect
    .poll(() =>
      frame
        .locator('#rename')
        .evaluate(el => getComputedStyle(el).backgroundColor)
    )
    .not.toBe('rgba(0, 0, 0, 0)');
  // Charting and icon libraries resolve through the import map.
  await expect(frame.locator('.recharts-bar-rectangle').first()).toBeVisible();
  await expect(frame.locator('#icon')).toBeVisible();
  // State still works after mounting.
  await frame.locator('#rename').click();
  await expect(frame.locator('#heading')).toHaveText('Renamed');

  await expect(
    frame.locator('[data-testid="artifact-runtime-error"]')
  ).toHaveCount(0);
  expect(external).toEqual([]);
});

test('Mermaid artifacts are drawn in the sandbox', async ({ page }) => {
  test.slow();
  const external = trackExternalRequests(page);
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith(
        'mermaid-session',
        'Mermaid artifact',
        generatedMermaidArtifact
      ),
    ],
  });

  await page.goto('/c/mermaid-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  // Scope to the panel: the same artifact is also rendered inline in the
  // message list, where the panel backdrop covers it.
  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe[title="Flowchart"]')
    .frameLocator('iframe[title="Artifact"]');

  await expect(frame.locator('svg')).toBeVisible({ timeout: 30_000 });
  await expect(frame.locator('svg')).toContainText('Sandbox');
  await expect(
    frame.locator('[data-testid="artifact-runtime-error"]')
  ).toHaveCount(0);
  expect(external).toEqual([]);
});

test('HTML artifacts load CDN libraries from the local runtime instead', async ({
  page,
}) => {
  test.slow();
  const external = trackExternalRequests(page);
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('cdn-session', 'CDN artifact', generatedCdnHtmlArtifact),
    ],
  });

  await page.goto('/c/cdn-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  // Scope to the panel: the same artifact is also rendered inline in the
  // message list, where the panel backdrop covers it.
  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe[title="CDN Dashboard"]')
    .frameLocator('iframe[title="Artifact"]');

  // Chart.js was replaced by the vendored build and still ran.
  await expect(frame.locator('#title')).toHaveAttribute(
    'data-chart-ready',
    'true',
    { timeout: 30_000 }
  );
  await expect(frame.locator('#title')).toHaveAttribute(
    'data-chart-drawn',
    'true'
  );
  // Tailwind's CDN build was replaced too, so the utility classes still apply.
  await expect
    .poll(() =>
      frame.locator('#title').evaluate(el => getComputedStyle(el).fontWeight)
    )
    .toBe('700');
  expect(external).toEqual([]);
});

const generatedThreeArtifact = `
A rotating cube:

\`\`\`html
<!doctype html>
<html>
  <head>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js"></script>
  </head>
  <body>
    <div id="status">starting</div>
    <div id="stage"></div>
    <script>
      try {
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
        camera.position.z = 4;
        const renderer = new THREE.WebGLRenderer();
        renderer.setSize(240, 120);
        document.getElementById('stage').appendChild(renderer.domElement);
        const controls = new THREE.OrbitControls(camera, renderer.domElement);
        scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()));
        renderer.render(scene, camera);
        document.getElementById('status').dataset.ready = String(Boolean(controls.update));
      } catch (error) {
        document.getElementById('status').textContent = 'FAILED: ' + String(error).slice(0, 140);
      }
    </script>
  </body>
</html>
\`\`\`
`;

test('Three.js artifacts get the addons their CDN tags expect', async ({
  page,
}) => {
  test.slow();
  const warnings: string[] = [];
  page.on('console', message => {
    if (/Multiple instances|not a constructor/i.test(message.text())) {
      warnings.push(message.text().slice(0, 120));
    }
  });
  const external = trackExternalRequests(page);

  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('three-session', 'Three artifact', generatedThreeArtifact),
    ],
  });

  await page.goto('/c/three-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  // OrbitControls lives outside Three's core package; the vendored bundle
  // carries the addons and hangs them off the global the way the CDN did.
  await expect(frame.locator('#status')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(frame.locator('canvas')).toBeVisible();
  // Two CDN tags map to one bundle; inlining it twice would load a second copy
  // of Three, which it warns about and which breaks instanceof checks.
  expect(warnings).toEqual([]);
  expect(external).toEqual([]);
});

const generatedStorageArtifact = `
A counter that remembers:

\`\`\`html
<!doctype html>
<html>
  <body>
    <div id="out">starting</div>
    <script>
      localStorage.setItem('visits', String(Number(localStorage.getItem('visits') || 0) + 1));
      sessionStorage.setItem('session', 'yes');
      document.cookie = 'seen=1';
      document.getElementById('out').textContent =
        'visits=' + localStorage.getItem('visits') +
        ' session=' + sessionStorage.getItem('session') +
        ' cookie=' + document.cookie +
        ' length=' + localStorage.length;
    </script>
  </body>
</html>
\`\`\`
`;

test('artifacts that use storage keep running', async ({ page }) => {
  test.slow();
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(String(error).slice(0, 120)));

  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith(
        'storage-session',
        'Storage artifact',
        generatedStorageArtifact
      ),
    ],
  });

  await page.goto('/c/storage-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  // An opaque origin makes real storage throw, which used to take the whole
  // artifact down; the frame gets in-memory stand-ins instead.
  await expect(frame.locator('#out')).toHaveText(
    'visits=1 session=yes cookie=seen=1 length=1',
    { timeout: 30_000 }
  );
  expect(failures.filter(message => /SecurityError/.test(message))).toEqual([]);
});

const generatedToneArtifact = `
\`\`\`html
<!doctype html>
<html>
  <head>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/14.8.49/Tone.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.0/dist/confetti.browser.min.js"></script>
  </head>
  <body>
    <div id="out">starting</div>
    <script>
      document.getElementById('out').textContent =
        'tone=' + (typeof Tone === 'object' ? 'yes' : 'no');
    </script>
  </body>
</html>
\`\`\`
`;

test('vendored libraries load and missing ones are named', async ({ page }) => {
  test.slow();
  const external = trackExternalRequests(page);

  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('tone-session', 'Tone artifact', generatedToneArtifact),
    ],
  });

  await page.goto('/c/tone-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  // Tone.js is vendored, so the CDN tag resolves to the local build.
  await expect(frame.locator('#out')).toHaveText('tone=yes', {
    timeout: 30_000,
  });
  // Confetti is not, and an artifact cannot fetch it; say so rather than fail
  // silently with a policy violation in the console.
  await expect(
    frame.locator('[data-testid="artifact-missing-library"]')
  ).toContainText('confetti.browser.min.js');
  expect(external).toEqual([]);
});

// The boilerplate three.js is written with today: an import map and a module
// script, not classic script tags.
const generatedThreeModuleArtifact = `
\`\`\`html
<!doctype html>
<html>
  <head>
    <script type="importmap">
      {
        "imports": {
          "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
          "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
        }
      }
    </script>
  </head>
  <body>
    <div id="status">starting</div>
    <script type="module">
      import * as THREE from 'three';
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(60, 2, 0.1, 100);
      const renderer = new THREE.WebGLRenderer();
      renderer.setSize(240, 120);
      document.body.appendChild(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      scene.add(new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 64, 16), new THREE.MeshNormalMaterial()));
      renderer.render(scene, camera);
      document.getElementById('status').dataset.ready = String(Boolean(controls.update));
    </script>
  </body>
</html>
\`\`\`
`;

const generatedTypeScriptArtifact = `
\`\`\`html
<!doctype html>
<html>
  <body>
    <div id="root"></div>
    <script type="text/babel">
      interface Product { id: number; name: string; price: number }
      const items: Product[] = [{ id: 1, name: 'Desk', price: 120 }];
      const total: number = items.reduce((sum, item) => sum + item.price, 0);
      function App(): JSX.Element {
        return <div id="total">Total: {total}</div>;
      }
      ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    </script>
  </body>
</html>
\`\`\`
`;

test('module scripts and import maps resolve to the local runtime', async ({
  page,
}) => {
  test.slow();
  const external = trackExternalRequests(page);
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('three-module', 'Three module', generatedThreeModuleArtifact),
    ],
  });

  await page.goto('/c/three-module');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  await expect(frame.locator('#status')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  await expect(frame.locator('canvas')).toBeVisible();
  expect(external).toEqual([]);
});

test('TypeScript in a text/babel script compiles', async ({ page }) => {
  test.slow();
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('ts-artifact', 'TS artifact', generatedTypeScriptArtifact),
    ],
  });

  await page.goto('/c/ts-artifact');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  // Interfaces and type annotations must be stripped, not treated as
  // reserved words by a JSX-only parser.
  await expect(frame.locator('#total')).toHaveText('Total: 120', {
    timeout: 30_000,
  });
});

// A document with a <header> element and no <head> — the shape that made the
// runtime land in the wrong place, or nowhere at all.
const generatedHeaderlessArtifact = `
\`\`\`html
<!doctype html>
<html>
  <body>
    <header class="site-header">Catalogue</header>
    <div id="root"></div>
    <script type="text/babel">
      interface Product { id: number; name: string; price: number }
      const items: Product[] = [
        { id: 1, name: 'Desk', price: 120 },
        { id: 2, name: 'Lamp', price: 45 },
      ];
      function App(): JSX.Element {
        const total: number = items.reduce((sum, item) => sum + item.price, 0);
        return <div id="total">Total: {total}</div>;
      }
      ReactDOM.createRoot(document.getElementById('root')).render(<App />);
    </script>
  </body>
</html>
\`\`\`
`;

test('the runtime loads even without a head element', async ({ page }) => {
  test.slow();
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(String(error).slice(0, 140)));

  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('headerless', 'Catalogue', generatedHeaderlessArtifact),
    ],
  });

  await page.goto('/c/headerless');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  await expect(frame.locator('#total')).toHaveText('Total: 165', {
    timeout: 30_000,
  });
  expect(failures.filter(message => /runInline/.test(message))).toEqual([]);
});

// How generated HTML usually arrives: Tailwind utilities with nothing loading
// them, and a Google Fonts link.
const generatedStyledArtifact = `
\`\`\`html
<!doctype html>
<html>
  <head>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap" rel="stylesheet">
  </head>
  <body class="bg-slate-100">
    <div class="max-w-md mx-auto p-6">
      <h1 id="title" class="text-2xl font-bold text-slate-900">Catalogue</h1>
      <div class="flex items-center justify-between gap-4 rounded-lg bg-white p-4 shadow">
        <span>Desk</span><span class="font-semibold">$120</span>
      </div>
    </div>
  </body>
</html>
\`\`\`
`;

test('Tailwind and fonts arrive even when nothing loads them', async ({
  page,
}) => {
  test.slow();
  const external = trackExternalRequests(page);

  await mockLibreWebUiApi(page, {
    sessions: [sessionWith('styled', 'Catalogue', generatedStyledArtifact)],
  });

  await page.goto('/c/styled');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  await expect(frame.locator('#title')).toBeVisible({ timeout: 30_000 });
  // Utilities were generated despite the artifact loading no Tailwind.
  await expect
    .poll(() =>
      frame.locator('#title').evaluate(el => getComputedStyle(el).fontWeight)
    )
    .toBe('700');
  // The Google Fonts link became the vendored face.
  await expect(frame.locator('style[data-artifact-fonts]')).toHaveCount(1);
  expect(external).toEqual([]);
});

// A single unversioned CDN tag — the shape whose URL-anchored pattern never
// matched when it was tested against the whole document.
const generatedSingleTagThreeArtifact = `
\`\`\`html
<!doctype html>
<html>
  <body>
    <div id="status">starting</div>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
    <script>
      const scene = new THREE.Scene();
      scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()));
      document.getElementById('status').dataset.ready = String(scene.children.length === 1);
    </script>
  </body>
</html>
\`\`\`
`;

test('a single unversioned CDN tag still resolves to its bundle', async ({
  page,
}) => {
  test.slow();
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('three-single', 'Cube', generatedSingleTagThreeArtifact),
    ],
  });

  await page.goto('/c/three-single');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  await expect(frame.locator('#status')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  // The bundle was available, so nothing should be reported as missing.
  await expect(
    frame.locator('[data-testid="artifact-missing-library"]')
  ).toHaveCount(0);
});

// Generated three.js scenes reach past the core package constantly; the one
// that started this used an environment, which the bundle did not carry.
const generatedThreeAddonArtifact = `
\`\`\`html
<!doctype html>
<html>
  <body>
    <div id="status">starting</div>
    <script type="importmap">
      { "imports": { "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/" } }
    </script>
    <script type="module">
      import * as THREE from 'three';
      import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
      import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setSize(320, 200);
      document.body.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(45, 1.6, 0.1, 100);
      camera.position.z = 4;
      const controls = new OrbitControls(camera, renderer.domElement);
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new RoomEnvironment(renderer), 0.04).texture;
      scene.add(new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), new THREE.MeshPhysicalMaterial({ roughness: 0.4 })));
      renderer.render(scene, camera);
      document.getElementById('status').dataset.ready = JSON.stringify({
        environment: Boolean(scene.environment),
        controls: Boolean(controls.update),
      });
    </script>
  </body>
</html>
\`\`\`
`;

test('three.js addons beyond controls and loaders are available', async ({
  page,
}) => {
  test.slow();
  const external = trackExternalRequests(page);
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('three-addons', 'Shark', generatedThreeAddonArtifact),
    ],
  });

  await page.goto('/c/three-addons');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const frame = page
    .getByTestId('artifact-slide-out-panel')
    .frameLocator('iframe')
    .first()
    .frameLocator('iframe[title="Artifact"]');

  // An environment resolves only if the addon itself is in the bundle: falling
  // back to the Three namespace yields undefined and throws on construction.
  await expect(frame.locator('#status')).toHaveAttribute(
    'data-ready',
    '{"environment":true,"controls":true}',
    { timeout: 30_000 }
  );
  await expect(frame.locator('canvas')).toBeVisible();
  expect(external).toEqual([]);
});

test('on desktop the panel splits the screen and the chat stays usable', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      sessionWith('split-session', 'Split layout', generatedMultiFileArtifact),
    ],
  });

  await page.goto('/c/split-session');
  await page.locator('button[title="Open in panel"]:visible').first().click();

  const panel = page.getByTestId('artifact-slide-out-panel');
  await expect(panel).toBeVisible();

  // The shell content shrinks beside the panel instead of sliding under it.
  const shellBox = await page.getByTestId('app-shell-content').boundingBox();
  const panelBox = await panel.boundingBox();
  expect(shellBox!.x + shellBox!.width).toBeLessThanOrEqual(panelBox!.x + 2);

  // Interacting with the chat no longer dismisses the panel.
  const input = page.locator('textarea').first();
  await input.click();
  await input.fill('make it blue instead');
  await expect(panel).toBeVisible();
  await expect(input).toHaveValue('make it blue instead');
});
