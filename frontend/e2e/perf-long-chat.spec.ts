/*
 * Opt-in benchmark, not a regression test: LIBRE_BENCH=1 npx playwright test
 * e2e/perf-long-chat.spec.ts prints load and streaming cost for a long chat.
 */
import { expect, test } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';

const COUNT = Number(process.env.BENCH_MESSAGES || 250);
const body = (i: number) =>
  [
    `## Answer ${i}`,
    '',
    `Point one with **bold** and a [link](https://example.com/${i}).`,
    '',
    '- alpha\n- beta\n- gamma',
    '',
    '| col | value |\n| --- | --- |\n| a | 1 |\n| b | 2 |',
    '',
    i % 5 === 0
      ? '```ts\nconst x: number = ' + i + ';\nexport default x;\n```'
      : 'Closing line.',
  ].join('\n');

const messages = Array.from({ length: COUNT }, (_, i) => ({
  id: `m-${i}`,
  role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
  model: 'llama3.2:3b',
  content: i % 2 === 0 ? `Question ${i}?` : body(i),
  timestamp: Date.now() - (COUNT - i) * 1000,
}));

test('long chat: load + streaming cost', async ({ page }) => {
  test.skip(!process.env.LIBRE_BENCH, 'set LIBRE_BENCH=1 to run the benchmark');
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'long-session',
        title: 'Long',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages,
      },
    ],
    chatStream: {
      chunks: Array.from({ length: 120 }, (_, i) => `token${i} `),
      finalChunk: 'done.',
      chunkDelayMs: 25,
      completionDelayMs: 300,
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const pick = (name: string) =>
      metrics.find(m => m.name === name)?.value ?? 0;
    return {
      script: pick('ScriptDuration'),
      layout: pick('LayoutDuration'),
      style: pick('RecalcStyleDuration'),
      task: pick('TaskDuration'),
      nodes: pick('Nodes'),
    };
  };

  const t0 = Date.now();
  await page.goto('/c/long-session');
  await expect(page.getByText(`Answer ${COUNT - 1}`)).toBeVisible();
  const loadMs = Date.now() - t0;
  await page.waitForTimeout(500);
  const before = await metrics();

  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill('Go.');
  await input.press('Enter');
  await expect(page.getByText('token119 done.')).toBeVisible({
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  const after = await metrics();
  const d = (k: keyof typeof before) =>
    ((after[k] - before[k]) * 1000).toFixed(0);
  console.log(
    `BENCH messages=${COUNT} load=${loadMs}ms nodes=${after.nodes} streaming: script=${d('script')}ms layout=${d('layout')}ms style=${d('style')}ms task=${d('task')}ms`
  );
});
