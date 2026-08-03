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
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const fetcher = await import(
  pathToFileURL(
    path.join(repoRoot, 'backend', 'dist', 'utils', 'webpageFetcher.js')
  ).href
);

test('webpage fetching rejects every local and non-routable IP form', () => {
  for (const address of [
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.0.1',
    '224.0.0.1',
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
  ]) {
    assert.equal(fetcher.isPublicIpAddress(address), false, address);
  }

  for (const address of ['93.184.216.34', '2606:4700:4700::1111']) {
    assert.equal(fetcher.isPublicIpAddress(address), true, address);
  }
});

test('literal SSRF targets are blocked before a connection is attempted', async () => {
  for (const target of [
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'http://[::ffff:a9fe:a9fe]/latest/meta-data/',
  ]) {
    await assert.rejects(
      fetcher.fetchWebpageAsText(target),
      /private or local address/,
      target
    );
  }
});

test('the socket lookup stays pinned to the validated DNS answer', async () => {
  const lookup = fetcher.createPinnedLookup({
    address: '93.184.216.34',
    family: 4,
  });

  const result = await new Promise((resolve, reject) => {
    lookup('localhost', { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });

  assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }]);
});

test('webpage URLs cannot contain embedded credentials', async () => {
  await assert.rejects(
    fetcher.fetchWebpageAsText('https://user:password@example.com/'),
    /embedded credentials/
  );
});
