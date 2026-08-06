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

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ARTIFACT_SANDBOX_READY,
  ARTIFACT_SANDBOX_RENDER,
  buildSvgArtifactDocument,
  HTML_ARTIFACT_SANDBOX,
  openArtifactPreviewWindow,
  SVG_ARTIFACT_SANDBOX,
} from './artifactHtml';

test('artifact sandboxes never combine scripts with same-origin privileges', () => {
  assert.match(HTML_ARTIFACT_SANDBOX, /allow-scripts/);
  assert.doesNotMatch(HTML_ARTIFACT_SANDBOX, /allow-same-origin/);
  assert.doesNotMatch(HTML_ARTIFACT_SANDBOX, /allow-popups-to-escape-sandbox/);
  assert.equal(SVG_ARTIFACT_SANDBOX, '');
});

test('SVG artifacts are wrapped in a no-script, no-network document', () => {
  const document = buildSvgArtifactDocument(
    '<svg><script>parent.document.body.textContent="owned"</script></svg>',
    '<Untrusted title>'
  );

  assert.match(document, /Content-Security-Policy[^>]+default-src 'none'/);
  assert.match(document, /<title>&lt;Untrusted title&gt;<\/title>/);
});

test('new-window HTML previews keep untrusted markup in a sandboxed iframe', () => {
  const attributes = new Map<string, string>();
  const posted: unknown[] = [];
  const iframe = {
    title: '',
    src: '',
    srcdoc: '',
    style: {} as Record<string, string>,
    contentWindow: {
      postMessage(message: unknown) {
        posted.push(message);
      },
    },
    setAttribute(name: string, value: string) {
      attributes.set(name, value);
    },
  };
  let appended: unknown;
  let replaced = false;
  let listener: ((event: MessageEvent) => void) | null = null;
  const previewWindow = {
    opener: {} as unknown,
    addEventListener(type: string, handler: (event: MessageEvent) => void) {
      assert.equal(type, 'message');
      listener = handler;
    },
    document: {
      title: '',
      documentElement: { style: {} as Record<string, string> },
      body: {
        style: {} as Record<string, string>,
        replaceChildren() {
          replaced = true;
        },
        appendChild(child: unknown) {
          appended = child;
        },
      },
      createElement(tagName: string) {
        assert.equal(tagName, 'iframe');
        return iframe;
      },
    },
  };
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { open: () => previewWindow },
  });

  try {
    const result = openArtifactPreviewWindow(
      '<!DOCTYPE html><html><body><script>parent.document.body.textContent="owned"</script></body></html>',
      '/api/artifacts/sandbox',
      'Preview'
    );
    assert.equal(result, previewWindow);
    assert.equal(previewWindow.opener, null);
    assert.equal(replaced, true);
    assert.equal(appended, iframe);
    assert.equal(attributes.get('sandbox'), HTML_ARTIFACT_SANDBOX);
    // Markup reaches the sandbox host as a message, never as inherited-policy
    // srcdoc markup and never through the popup's own DOM.
    assert.equal(iframe.src, '/api/artifacts/sandbox');
    assert.equal(iframe.srcdoc, '');
    assert.equal(posted.length, 0);

    const deliver = listener as ((event: MessageEvent) => void) | null;
    assert.ok(deliver, 'expected a message listener on the preview window');
    // A message from an unrelated window must not deliver the document.
    deliver({
      source: {},
      data: { type: ARTIFACT_SANDBOX_READY },
    } as unknown as MessageEvent);
    assert.equal(posted.length, 0);

    deliver({
      source: iframe.contentWindow,
      data: { type: ARTIFACT_SANDBOX_READY },
    } as unknown as MessageEvent);
    assert.equal(posted.length, 1);
    const message = posted[0] as { type: string; html: string };
    assert.equal(message.type, ARTIFACT_SANDBOX_RENDER);
    assert.equal(message.html.includes('<script>'), true);
  } finally {
    if (previousWindow === undefined) {
      Reflect.deleteProperty(globalThis, 'window');
    } else {
      Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: previousWindow,
      });
    }
  }
});

test('SVG components do not inject artifact markup into the parent DOM', () => {
  const componentsDirectory = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'components'
  );
  for (const filename of [
    'ArtifactRenderer.tsx',
    'ArtifactSlideOutPanel.tsx',
  ]) {
    const source = fs.readFileSync(
      path.join(componentsDirectory, filename),
      'utf8'
    );
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
    assert.match(source, /artifact-svg-preview/);
  }
});
