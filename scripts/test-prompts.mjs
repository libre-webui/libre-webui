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

/*
 * Prompt library (PROMPT-01): the HTTP surface plus encryption at rest,
 * versioning, rollback, export/import, ownership isolation, and grant reads.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-prompts-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'prompts-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '2'.repeat(64);

const distModule = relativePath =>
  import(
    pathToFileURL(path.join(repoRoot, 'backend', 'dist', relativePath)).href
  );

const { encryptionService } = await distModule('services/encryptionService.js');
const persistenceModule = await distModule('persistence/index.js');
const applicationPersistence = await persistenceModule.initializePersistence({
  dialect: 'sqlite',
  emailCodec: encryptionService,
  env: process.env,
});
const platformStorageModule = await distModule(
  'platform/storage/platformStorageRuntime.js'
);
await platformStorageModule.initializePlatformStorageRuntime({
  persistence: applicationPersistence,
  cipher: encryptionService,
  env: process.env,
});
const [
  { getDatabase },
  { authService },
  { default: promptsRouter },
  promptService,
  grants,
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/prompts.js'),
  distModule('services/promptService.js'),
  distModule('services/resourceGrantService.js'),
]);

const database = getDatabase();
const now = Date.now();
const createUser = id => {
  database
    .prepare(
      `INSERT INTO users
         (id, username, email, password_hash, role, account_status, avatar,
          created_at, updated_at)
       VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
    )
    .run(id, id, now, now);
  return authService.generateToken({
    id,
    username: id,
    email: null,
    role: 'user',
    status: 'active',
    avatar: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
  });
};

const OWNER = 'prompt-owner';
const STRANGER = 'prompt-stranger';
const ownerToken = createUser(OWNER);
const strangerToken = createUser(STRANGER);
const ownerActor = { userId: OWNER, role: 'user', status: 'active' };
const strangerActor = { userId: STRANGER, role: 'user', status: 'active' };

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/prompts', promptsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/api/prompts`;
const headersFor = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

const post = (url, token, body) =>
  fetch(url, {
    method: 'POST',
    headers: headersFor(token),
    body: JSON.stringify(body),
  });

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

const CONTENT = 'Summarize {{topic}} for a {{audience}} reader.';
const VARIABLES = [
  { name: 'topic', type: 'text', required: true },
  { name: 'audience', type: 'select', options: ['novice', 'expert'] },
];

test('prompts round-trip through the API and stay encrypted at rest', async () => {
  const response = await post(baseUrl, ownerToken, {
    slug: 'weekly-brief',
    title: 'Weekly brief',
    description: 'A recurring summary template',
    content: CONTENT,
    variables: VARIABLES,
    tags: ['research', 'weekly'],
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.version, 1);
  assert.equal(created.slug, 'weekly-brief');
  assert.equal(created.ownerUserId, OWNER);
  assert.deepEqual(created.tags, ['research', 'weekly']);
  assert.equal(created.variables.length, 2);

  const row = database
    .prepare('SELECT * FROM prompts WHERE id = ?')
    .get(created.id);
  assert.equal(row.slug, 'weekly-brief', 'slugs stay plaintext for lookup');
  assert.ok(!row.title.includes('Weekly brief'), 'the title is encrypted');
  assert.ok(!row.content.includes('Summarize'), 'the body is encrypted');
  assert.ok(
    !row.description.includes('recurring'),
    'the description is encrypted'
  );
  assert.ok(!row.variables.includes('audience'), 'variables are encrypted');
  assert.ok(!row.tags.includes('research'), 'tags are encrypted');
  assert.equal(encryptionService.decrypt(row.content), CONTENT);

  const fetched = await fetch(`${baseUrl}/${created.id}`, {
    headers: headersFor(ownerToken),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual((await fetched.json()).data, created);

  const listed = await fetch(baseUrl, { headers: headersFor(ownerToken) });
  const items = (await listed.json()).data;
  assert.equal(items.length, 1);
  assert.equal(items[0].content, CONTENT);

  const bySlug = await promptService.getPromptBySlug(OWNER, 'weekly-brief');
  assert.equal(bySlug.id, created.id);
});

test('slug collisions and malformed input are rejected', async () => {
  let response = await post(baseUrl, ownerToken, {
    slug: 'weekly-brief',
    title: 'Duplicate',
    content: 'no placeholders',
  });
  assert.equal(response.status, 409);

  response = await post(baseUrl, ownerToken, {
    slug: 'Not A Slug',
    title: 'Bad slug',
    content: 'body',
  });
  assert.equal(response.status, 400);

  response = await post(baseUrl, ownerToken, {
    slug: 'undeclared',
    title: 'Undeclared placeholder',
    content: 'Hello {{missing}}',
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /undeclared variable "missing"/);

  response = await post(baseUrl, ownerToken, {
    slug: 'too-many-variables',
    title: 'Too many',
    content: 'body',
    variables: Array.from({ length: 21 }, (_, index) => ({
      name: `v${index}`,
      type: 'text',
    })),
  });
  assert.equal(response.status, 400);

  response = await post(baseUrl, ownerToken, {
    slug: 'bad-select',
    title: 'Select without options',
    content: '{{choice}}',
    variables: [{ name: 'choice', type: 'select' }],
  });
  assert.equal(response.status, 400);

  const stored = database
    .prepare('SELECT COUNT(*) AS count FROM prompts')
    .get();
  assert.equal(stored.count, 1, 'no rejected prompt reached the database');
});

test('updates bump the version and archive the prior revision', async () => {
  const created = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'versioned',
        title: 'Versioned',
        content: 'first revision',
      })
    ).json()
  ).data;

  const updated = (
    await (
      await fetch(`${baseUrl}/${created.id}`, {
        method: 'PUT',
        headers: headersFor(ownerToken),
        body: JSON.stringify({
          slug: 'versioned',
          title: 'Versioned',
          content: 'second revision',
        }),
      })
    ).json()
  ).data;
  assert.equal(updated.version, 2);
  assert.equal(updated.content, 'second revision');
  assert.equal(updated.createdAt, created.createdAt);

  const versions = (
    await (
      await fetch(`${baseUrl}/${created.id}/versions`, {
        headers: headersFor(ownerToken),
      })
    ).json()
  ).data;
  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, 1);
  assert.equal(versions[0].content, 'first revision');

  const archived = database
    .prepare('SELECT * FROM prompt_versions WHERE prompt_id = ?')
    .all(created.id);
  assert.equal(archived.length, 1);
  assert.ok(!archived[0].content.includes('first'), 'revisions are encrypted');

  const rolledBack = (
    await (
      await post(`${baseUrl}/${created.id}/rollback`, ownerToken, {
        version: 1,
      })
    ).json()
  ).data;
  assert.equal(rolledBack.version, 3, 'a rollback moves forward, never back');
  assert.equal(rolledBack.content, 'first revision');

  const afterRollback = (
    await (
      await fetch(`${baseUrl}/${created.id}/versions`, {
        headers: headersFor(ownerToken),
      })
    ).json()
  ).data;
  assert.deepEqual(
    afterRollback.map(entry => entry.version),
    [2, 1]
  );

  const missing = await post(`${baseUrl}/${created.id}/rollback`, ownerToken, {
    version: 99,
  });
  assert.equal(missing.status, 400);
});

test('export and import round-trip, guarding slug collisions', async () => {
  const source = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'portable',
        title: 'Portable prompt',
        description: 'exports cleanly',
        content: 'Draft a note about {{subject}}.',
        variables: [{ name: 'subject', type: 'text', required: true }],
        tags: ['portable'],
      })
    ).json()
  ).data;

  const exported = (
    await (
      await fetch(`${baseUrl}/${source.id}/export`, {
        headers: headersFor(ownerToken),
      })
    ).json()
  ).data;
  assert.equal(exported.format, 'libre-prompt.v1');
  assert.equal(exported.slug, 'portable');
  assert.ok(exported.exportedAt > 0);

  let response = await post(`${baseUrl}/import`, ownerToken, exported);
  assert.equal(response.status, 409, 'an import never silently overwrites');

  response = await post(`${baseUrl}/import`, ownerToken, {
    prompt: exported,
    overwriteSlug: true,
  });
  assert.equal(response.status, 201);
  const overwritten = (await response.json()).data;
  assert.equal(overwritten.id, source.id);
  assert.equal(overwritten.version, 2);

  response = await post(`${baseUrl}/import`, strangerToken, exported);
  assert.equal(response.status, 201, 'another user may take the same slug');
  const copied = (await response.json()).data;
  assert.equal(copied.ownerUserId, STRANGER);
  assert.equal(copied.content, exported.content);
  assert.deepEqual(copied.variables, exported.variables);

  response = await post(`${baseUrl}/import`, ownerToken, {
    ...exported,
    format: 'something-else',
  });
  assert.equal(response.status, 400);
});

test('prompts are private by default and readable through a grant', async () => {
  const created = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'shared-prompt',
        title: 'Shared prompt',
        content: 'confidential body',
      })
    ).json()
  ).data;

  assert.equal(await promptService.getPrompt(created.id, strangerActor), null);
  let response = await fetch(`${baseUrl}/${created.id}`, {
    headers: headersFor(strangerToken),
  });
  assert.equal(
    response.status,
    404,
    'no access is indistinguishable from absent'
  );

  const strangerList = (
    await (await fetch(baseUrl, { headers: headersFor(strangerToken) })).json()
  ).data;
  assert.ok(strangerList.every(prompt => prompt.id !== created.id));

  await grants.createGrant(ownerActor, {
    resourceType: 'prompt',
    resourceId: created.id,
    principalType: 'user',
    principalId: STRANGER,
    permission: 'read',
  });

  const shared = await promptService.getPrompt(created.id, strangerActor);
  assert.equal(shared.content, 'confidential body');
  response = await fetch(`${baseUrl}/${created.id}`, {
    headers: headersFor(strangerToken),
  });
  assert.equal(response.status, 200);

  // A read grant is not a write grant.
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PUT',
    headers: headersFor(strangerToken),
    body: JSON.stringify({
      slug: 'shared-prompt',
      title: 'Hijacked',
      content: 'rewritten',
    }),
  });
  assert.equal(response.status, 403);

  await grants.createGrant(ownerActor, {
    resourceType: 'prompt',
    resourceId: created.id,
    principalType: 'user',
    principalId: STRANGER,
    permission: 'write',
  });
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PUT',
    headers: headersFor(strangerToken),
    body: JSON.stringify({
      slug: 'shared-prompt',
      title: 'Collaborated',
      content: 'rewritten together',
    }),
  });
  assert.equal(response.status, 200);
  const collaborated = (await response.json()).data;
  assert.equal(
    collaborated.ownerUserId,
    OWNER,
    'a write never moves ownership'
  );

  // Deletion stays owner-only, removes the versions, and clears the grants.
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(strangerToken),
  });
  assert.equal(response.status, 404);

  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'DELETE',
    headers: headersFor(ownerToken),
  });
  assert.equal(response.status, 200);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM prompts WHERE id = ?')
      .get(created.id).count,
    0
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM prompt_versions WHERE prompt_id = ?'
      )
      .get(created.id).count,
    0,
    'archived revisions cascade with the prompt'
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM resource_grants
          WHERE resource_type = 'prompt' AND resource_id = ?`
      )
      .get(created.id).count,
    0,
    'grants are cleaned up on delete'
  );
});

test('renderPrompt validates values and substitutes placeholders', () => {
  const rendered = promptService.renderPrompt(CONTENT, VARIABLES, {
    topic: 'sea ice',
    audience: 'expert',
  });
  assert.equal(rendered, 'Summarize sea ice for a expert reader.');

  assert.throws(
    () =>
      promptService.renderPrompt(CONTENT, VARIABLES, { audience: 'expert' }),
    /variable "topic" is required/
  );
  assert.throws(
    () =>
      promptService.renderPrompt(CONTENT, VARIABLES, {
        topic: 'sea ice',
        audience: 'nobody',
      }),
    /must be one of the declared options/
  );

  const typed = [
    { name: 'count', type: 'number' },
    { name: 'verbose', type: 'boolean' },
  ];
  assert.equal(
    promptService.renderPrompt('{{count}}/{{verbose}}', typed, {
      count: '7',
      verbose: 'true',
    }),
    '7/true'
  );
  assert.throws(
    () =>
      promptService.renderPrompt('{{count}}', typed, { count: 'not-a-number' }),
    /must be a number/
  );

  // Optional values fall back to the declared default, then to empty.
  assert.equal(
    promptService.renderPrompt(
      '[{{note}}]',
      [{ name: 'note', type: 'text', default: 'none' }],
      {}
    ),
    '[none]'
  );
});
