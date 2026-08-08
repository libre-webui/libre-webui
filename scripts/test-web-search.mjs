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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);
delete process.env.SEARXNG_URL;
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-web-search-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase } = await import(dist('db.js'));
const {
  getWebSearchConfig,
  setWebSearchConfig,
  isWebSearchAvailable,
  webSearch,
  buildWebSearchEnhancedContent,
  normalizeWebSearchUrl,
} = await import(dist('services/webSearchService.js'));
const { workToolSchemasForTask, WORK_TOOL_SCHEMAS } = await import(
  dist('services/workAgentService.js')
);

after(() => {
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

test('web search ships disabled and validates its configuration', () => {
  const config = getWebSearchConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.available, false);

  assert.throws(() => normalizeWebSearchUrl('ftp://host'), /http or https/);
  assert.throws(() => normalizeWebSearchUrl('not a url'), /valid http/);
  assert.equal(
    normalizeWebSearchUrl('http://searxng:8080/'),
    'http://searxng:8080'
  );

  // Enabling requires a URL.
  assert.throws(
    () => setWebSearchConfig({ enabled: true, url: '' }),
    /SearXNG URL/
  );
});

test('web search queries the configured instance and bounds results', async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (
      url.pathname !== '/search' ||
      url.searchParams.get('format') !== 'json'
    ) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        results: [
          {
            title: 'Result one',
            url: 'https://example.com/one',
            content: 'x'.repeat(2000),
            engine: 'duckduckgo',
          },
          { title: 'Bad scheme', url: 'javascript:alert(1)' },
          {
            title: 'Result two',
            url: 'https://example.com/two',
            content: 'ok',
          },
        ],
      })
    );
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  try {
    setWebSearchConfig({ enabled: true, url: `http://127.0.0.1:${port}` });
    assert.equal(isWebSearchAvailable(), true);

    const results = await webSearch('libre webui', 5);
    // The javascript: result is discarded; text is bounded.
    assert.deepEqual(
      results.map(result => result.url),
      ['https://example.com/one', 'https://example.com/two']
    );
    assert.ok(results[0].content.length <= 500);

    const enhanced = buildWebSearchEnhancedContent('hello', results, 'hello');
    assert.match(enhanced, /Web search results for "hello"/);
    assert.match(enhanced, /\[1\] Result one/);
    assert.match(enhanced, /User message: hello/);

    // Disabled again: unavailable and queries refuse to run.
    setWebSearchConfig({ enabled: false, url: `http://127.0.0.1:${port}` });
    assert.equal(isWebSearchAvailable(), false);
    await assert.rejects(webSearch('anything'), /not enabled/);
  } finally {
    server.close();
  }
});

test('Work offers web_search only with search enabled and task network access', () => {
  setWebSearchConfig({ enabled: false, url: 'http://searxng:8080' });
  assert.deepEqual(
    workToolSchemasForTask({ networkEnabled: true }),
    WORK_TOOL_SCHEMAS
  );

  setWebSearchConfig({ enabled: true, url: 'http://searxng:8080' });
  const withSearch = workToolSchemasForTask({ networkEnabled: true });
  assert.equal(withSearch.length, WORK_TOOL_SCHEMAS.length + 1);
  assert.equal(withSearch.at(-1).function.name, 'web_search');

  // An offline task stays offline.
  assert.deepEqual(
    workToolSchemasForTask({ networkEnabled: false }),
    WORK_TOOL_SCHEMAS
  );
  setWebSearchConfig({ enabled: false, url: 'http://searxng:8080' });
});

test('search routes gate configuration behind the administrator', () => {
  const source = readFileSync(
    path.join(repoRoot, 'backend', 'src', 'routes', 'search.ts'),
    'utf8'
  );
  assert.match(source, /router\.use\(authenticate\)/);
  assert.match(source, /router\.put\(\s*'\/config',\s*requireAdmin/);
  assert.match(source, /router\.post\(\s*'\/test',\s*requireAdmin/);

  // The private stack keeps SearXNG internal-only.
  const compose = readFileSync(
    path.join(repoRoot, 'deploy', 'private', 'docker-compose.yml'),
    'utf8'
  );
  assert.match(compose, /searxng:/);
  assert.doesNotMatch(compose, /^\s+ports:/m);
  assert.match(compose, /SEARXNG_URL: http:\/\/searxng:8080/);
});
