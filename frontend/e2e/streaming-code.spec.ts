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
import {
  getStreamingMarkdownSegments,
  preprocessLaTeX,
  shouldUseStreamingCodeRenderer,
  type StreamingMarkdownCodeSegment,
} from '../src/components/ui/messageContentUtils';
import { mockLibreWebUiApi } from './lib/mockApi';

test('streaming code parser follows CommonMark fence forms', () => {
  const cases = [
    {
      name: 'an incomplete backtick fence',
      content: 'Intro\n```ts\nconst value = 42;',
      language: 'ts',
      code: 'const value = 42;',
      complete: false,
    },
    {
      name: 'a complete indented fence',
      content: '  ```python\n  print("hello")\n  ```',
      language: 'python',
      code: 'print("hello")\n',
      complete: true,
    },
    {
      name: 'a tilde fence',
      content: '~~~css\nbody { color: red; }\n~~~',
      language: 'css',
      code: 'body { color: red; }\n',
      complete: true,
    },
    {
      name: 'a four-backtick fence containing triple backticks',
      content: '````markdown\n```nested```\n````',
      language: 'markdown',
      code: '```nested```\n',
      complete: true,
    },
    {
      name: 'a CRLF fence',
      content: '```sh\r\necho ready\r\n```\r\n',
      language: 'sh',
      code: 'echo ready\r\n',
      complete: true,
    },
  ];

  for (const testCase of cases) {
    const codeSegments = getStreamingMarkdownSegments(testCase.content).filter(
      (segment): segment is StreamingMarkdownCodeSegment =>
        segment.type === 'code'
    );

    expect(
      codeSegments,
      `${testCase.name} should produce one code segment`
    ).toEqual([
      {
        type: 'code',
        content: testCase.code,
        language: testCase.language,
        complete: testCase.complete,
      },
    ]);
    expect(shouldUseStreamingCodeRenderer(testCase.content)).toBe(true);
  }

  const multipleBlocks = getStreamingMarkdownSegments(
    'Before\n```js\none();\n```\nBetween\n~~~py\ntwo()\n~~~\nAfter'
  );
  expect(
    multipleBlocks.filter(segment => segment.type === 'code')
  ).toHaveLength(2);
  expect(multipleBlocks[multipleBlocks.length - 1]).toEqual({
    type: 'text',
    content: 'After',
  });

  for (const plainText of [
    'Use ```inline``` in a sentence.',
    '    ```js\nindentedCodeBlock();\n    ```',
  ]) {
    expect(shouldUseStreamingCodeRenderer(plainText)).toBe(false);
    expect(getStreamingMarkdownSegments(plainText)).toEqual([
      { type: 'text', content: plainText },
    ]);
  }

  const html = '<!doctype html><html><body><main>Hello</main>';
  expect(getStreamingMarkdownSegments(html)).toEqual([
    {
      type: 'code',
      content: html,
      language: 'html',
      complete: false,
    },
  ]);

  const structuralHtml = '<html lang="en">\n<head><title>Streaming';
  expect(shouldUseStreamingCodeRenderer(structuralHtml)).toBe(true);
  expect(shouldUseStreamingCodeRenderer('<html> is the root element.')).toBe(
    false
  );
  expect(
    shouldUseStreamingCodeRenderer(
      '<!doctype html> declares an HTML5 document.'
    )
  ).toBe(false);

  const htmlWithIntro = [
    'Here is the complete page:',
    '',
    '<!doctype html>',
    '<html>',
    '<body>Ready</body>',
    '</html>',
    '',
    'I can adjust the colors next.',
  ].join('\n');
  expect(getStreamingMarkdownSegments(htmlWithIntro)).toEqual([
    { type: 'text', content: 'Here is the complete page:\n\n' },
    {
      type: 'code',
      content: '<!doctype html>\n<html>\n<body>Ready</body>\n</html>',
      language: 'html',
      complete: true,
    },
    { type: 'text', content: '\n\nI can adjust the colors next.' },
  ]);

  const partialHtmlWithIntro =
    'Building it now:\n\n<!doctype html>\n<html>\n<body>Streaming';
  expect(getStreamingMarkdownSegments(partialHtmlWithIntro)).toEqual([
    { type: 'text', content: 'Building it now:\n\n' },
    {
      type: 'code',
      content: '<!doctype html>\n<html>\n<body>Streaming',
      language: 'html',
      complete: false,
    },
  ]);
});

test('LaTeX preprocessing never changes generated code', () => {
  const fencedCode = [
    '```js',
    "const tokens = ['$&', '$`', \"$'\", '__CODE_BLOCK_1__'];",
    'const math = "\\\\(leave me alone\\\\)";',
    '```',
  ].join('\n');
  const source = `Before \\(x\\)\n${fencedCode}\nInline \`\\(also untouched\\)\`\nAfter \\[y\\]`;

  expect(preprocessLaTeX(source)).toBe(
    `Before $x$\n${fencedCode}\nInline \`\\(also untouched\\)\`\nAfter $$y$$`
  );
});

test('code stays in a specialized block throughout a live response', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'streaming-code-session',
        title: 'Streaming code',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    chatStream: {
      chunks: [
        'Here is the implementation:\n',
        '  ```typescript\n',
        'const answer: number = 42;\n',
        'export default answer;\n',
      ],
      finalChunk: '  ```\nDone.',
      chunkDelayMs: 350,
      completionDelayMs: 1500,
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });

  await page.goto('/c/streaming-code-session');
  await page.waitForLoadState('networkidle');

  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await expect(input).toBeVisible();
  await input.fill('Show me a typed constant.');
  await input.press('Enter');

  const codeBlock = page.getByTestId('code-block');
  await expect(codeBlock).toHaveCount(1);
  await expect(codeBlock).toHaveAttribute('data-state', 'streaming');
  await expect(codeBlock).toHaveAttribute('data-language', 'typescript');
  await expect(codeBlock.locator('pre code')).toContainText(
    'const answer: number = 42;'
  );
  await expect(page.getByTestId('message-streaming-cursor')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Copy code: typescript', exact: true })
  ).toBeVisible();
  await expect(page.locator('body')).not.toContainText('```typescript');
  // The code surface follows the active theme's dark-50 token (the same
  // surface the artifact panel uses), not a hardcoded palette.
  const codeSurface = await codeBlock.evaluate(element => {
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-dark-50')
      .trim()
      .split(/\s+/)
      .join(', ');
    return {
      actual: getComputedStyle(element).backgroundColor,
      expected: `rgb(${token})`,
    };
  });
  expect(codeSurface.actual).toBe(codeSurface.expected);

  await expect(codeBlock).toHaveAttribute('data-state', 'complete');
  await expect(page.getByTestId('message-streaming-cursor')).toBeVisible();
  await expect(page.locator('body')).toContainText('Done.');
  const streamingBody = codeBlock.locator('pre');
  const streamingMetrics = await streamingBody.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      maxHeight: style.maxHeight,
      minHeight: style.minHeight,
      overflow: style.overflow,
      padding: style.padding,
    };
  });
  const streamingBox = await streamingBody.boundingBox();

  await expect(page.getByTestId('message-streaming-cursor')).toHaveCount(0, {
    timeout: 4_000,
  });
  await expect(codeBlock).toHaveAttribute('data-state', 'complete');
  await expect(codeBlock.locator('pre code span').first()).toBeVisible();
  await expect(codeBlock.locator('pre code')).toContainText(
    'const answer: number = 42;'
  );
  await expect(page.locator('body')).not.toContainText('```');

  const completedBody = codeBlock.locator('pre');
  const completedMetrics = await completedBody.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      maxHeight: style.maxHeight,
      minHeight: style.minHeight,
      overflow: style.overflow,
      padding: style.padding,
    };
  });
  const completedBox = await completedBody.boundingBox();

  expect(completedMetrics).toEqual(streamingMetrics);
  expect(streamingBox).not.toBeNull();
  expect(completedBox).not.toBeNull();
  expect(completedBox!.width).toBeCloseTo(streamingBox!.width, 0);
  expect(completedBox!.height).toBeCloseTo(streamingBox!.height, 0);
});

test('long code streams follow the tail until the reader scrolls away', async ({
  page,
}) => {
  const firstLines =
    Array.from({ length: 60 }, (_, index) => `line-${index}`).join('\n') + '\n';
  const laterLines =
    Array.from({ length: 20 }, (_, index) => `line-${index + 60}`).join('\n') +
    '\n';

  await mockLibreWebUiApi(page, {
    sessions: [
      {
        id: 'long-stream-session',
        title: 'Long stream',
        model: 'llama3.2:3b',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [],
      },
    ],
    chatStream: {
      chunks: ['```text\n', firstLines, laterLines],
      finalChunk: '```',
      chunkDelayMs: 700,
      completionDelayMs: 500,
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem('i18nextLng', 'en');
    localStorage.setItem('auth-token', 'e2e-token');
  });

  await page.goto('/c/long-stream-session');
  await page.waitForLoadState('networkidle');

  const input = page.locator('textarea[rows="1"][dir="auto"]');
  await input.fill('Stream a long list.');
  await input.press('Enter');

  const codeBlock = page.getByTestId('code-block');
  const code = codeBlock.locator('pre code');
  const viewport = codeBlock.locator('pre');
  await expect(code).toContainText('line-59');

  const followedTail = await viewport.evaluate(element => ({
    distanceFromBottom:
      element.scrollHeight - element.scrollTop - element.clientHeight,
    scrollTop: element.scrollTop,
  }));
  expect(followedTail.scrollTop).toBeGreaterThan(0);
  expect(followedTail.distanceFromBottom).toBeLessThanOrEqual(1);

  await viewport.evaluate(element => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(code).toContainText('line-79');
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0);

  await expect(codeBlock).toHaveAttribute('data-state', 'complete');
});
