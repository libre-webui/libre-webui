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

import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePortableArchiveJson } from './dataArchive';

test('accepts the current portable archive format', () => {
  const archive = parsePortableArchiveJson(
    JSON.stringify({ format: 'libre-webui-user-data', version: 2 })
  );
  assert.equal(archive.version, 2);
});

test('accepts the legacy archive so the backend can migrate it', () => {
  const archive = parsePortableArchiveJson(
    JSON.stringify({ format: 'libre-webui-export', version: '1.0' })
  );
  assert.equal(archive.format, 'libre-webui-export');
});

test('rejects malformed JSON, unrelated files, and future versions', () => {
  assert.throws(() => parsePortableArchiveJson('{'), /not valid JSON/);
  assert.throws(
    () => parsePortableArchiveJson(JSON.stringify({ format: 'other' })),
    /not a Libre WebUI/
  );
  assert.throws(
    () =>
      parsePortableArchiveJson(
        JSON.stringify({ format: 'libre-webui-user-data', version: 3 })
      ),
    /Unsupported portable archive version 3/
  );
});
