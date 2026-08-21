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
  buildSvgArtifactDocument,
  HTML_ARTIFACT_SANDBOX,
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
