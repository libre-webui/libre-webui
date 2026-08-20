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
 * Skills workspace (SKILL-01): the HTTP surface plus encryption at rest,
 * versioning, rollback, export/import, the enabled toggle, the lazy
 * manifest, ownership isolation, and grant reads.
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
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-skills-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'skills-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '3'.repeat(64);

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
  { default: skillsRouter },
  skillService,
  grants,
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/skills.js'),
  distModule('services/skillService.js'),
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

const OWNER = 'skill-owner';
const STRANGER = 'skill-stranger';
const ownerToken = createUser(OWNER);
const strangerToken = createUser(STRANGER);
const ownerActor = { userId: OWNER, role: 'user', status: 'active' };
const strangerActor = { userId: STRANGER, role: 'user', status: 'active' };

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/skills', skillsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}/api/skills`;
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

const INSTRUCTIONS = 'Always cite the source file and line for every claim.';

test('skills round-trip through the API and stay encrypted at rest', async () => {
  const response = await post(baseUrl, ownerToken, {
    slug: 'citation-discipline',
    name: 'Citation discipline',
    description: 'Cite sources precisely when answering code questions',
    instructions: INSTRUCTIONS,
  });
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(created.version, 1);
  assert.equal(created.enabled, true);
  assert.equal(created.ownerUserId, OWNER);

  const row = database
    .prepare('SELECT * FROM skills WHERE id = ?')
    .get(created.id);
  assert.equal(row.slug, 'citation-discipline', 'slugs stay plaintext');
  assert.ok(!row.name.includes('Citation'), 'the name is encrypted');
  assert.ok(!row.description.includes('Cite'), 'the description is encrypted');
  assert.ok(!row.instructions.includes('cite'), 'instructions are encrypted');
  assert.equal(encryptionService.decrypt(row.instructions), INSTRUCTIONS);
  assert.equal(row.enabled, 1);

  const fetched = await fetch(`${baseUrl}/${created.id}`, {
    headers: headersFor(ownerToken),
  });
  assert.equal(fetched.status, 200);
  assert.deepEqual((await fetched.json()).data, created);

  const bySlug = await skillService.getSkillBySlug(
    OWNER,
    'citation-discipline'
  );
  assert.equal(bySlug.id, created.id);

  assert.deepEqual(skillService.skillManifest(created), {
    slug: 'citation-discipline',
    name: 'Citation discipline',
    description: 'Cite sources precisely when answering code questions',
  });
});

test('slug collisions and malformed input are rejected', async () => {
  let response = await post(baseUrl, ownerToken, {
    slug: 'citation-discipline',
    name: 'Duplicate',
    description: 'duplicate slug',
    instructions: 'anything',
  });
  assert.equal(response.status, 409);

  response = await post(baseUrl, ownerToken, {
    slug: 'Not A Slug',
    name: 'Bad slug',
    description: 'bad slug',
    instructions: 'anything',
  });
  assert.equal(response.status, 400);

  // The description is the manifest line, so it is never optional.
  response = await post(baseUrl, ownerToken, {
    slug: 'no-description',
    name: 'No description',
    instructions: 'anything',
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /description is required/);

  response = await post(baseUrl, ownerToken, {
    slug: 'long-description',
    name: 'Long description',
    description: 'x'.repeat(1001),
    instructions: 'anything',
  });
  assert.equal(response.status, 400);

  response = await post(baseUrl, ownerToken, {
    slug: 'no-instructions',
    name: 'No instructions',
    description: 'missing the body',
  });
  assert.equal(response.status, 400);

  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM skills').get().count,
    1,
    'no rejected skill reached the database'
  );
});

test('updates bump the version, archive revisions, and toggle enabled', async () => {
  const created = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'versioned-skill',
        name: 'Versioned skill',
        description: 'first manifest',
        instructions: 'first revision',
      })
    ).json()
  ).data;

  const updated = (
    await (
      await fetch(`${baseUrl}/${created.id}`, {
        method: 'PUT',
        headers: headersFor(ownerToken),
        body: JSON.stringify({
          slug: 'versioned-skill',
          name: 'Versioned skill',
          description: 'second manifest',
          instructions: 'second revision',
          enabled: false,
        }),
      })
    ).json()
  ).data;
  assert.equal(updated.version, 2);
  assert.equal(updated.enabled, false);
  assert.equal(updated.instructions, 'second revision');
  assert.equal(updated.createdAt, created.createdAt);

  // An update that omits `enabled` keeps the stored toggle.
  const kept = (
    await (
      await fetch(`${baseUrl}/${created.id}`, {
        method: 'PUT',
        headers: headersFor(ownerToken),
        body: JSON.stringify({
          slug: 'versioned-skill',
          name: 'Versioned skill',
          description: 'third manifest',
          instructions: 'third revision',
        }),
      })
    ).json()
  ).data;
  assert.equal(kept.enabled, false);
  assert.equal(kept.version, 3);

  const versions = (
    await (
      await fetch(`${baseUrl}/${created.id}/versions`, {
        headers: headersFor(ownerToken),
      })
    ).json()
  ).data;
  assert.deepEqual(
    versions.map(entry => entry.version),
    [2, 1]
  );
  assert.equal(versions[1].instructions, 'first revision');

  const archived = database
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? AND version = 1')
    .get(created.id);
  assert.ok(
    !archived.instructions.includes('first'),
    'revisions are encrypted'
  );

  const rolledBack = (
    await (
      await post(`${baseUrl}/${created.id}/rollback`, ownerToken, {
        version: 1,
      })
    ).json()
  ).data;
  assert.equal(rolledBack.version, 4, 'a rollback moves forward, never back');
  assert.equal(rolledBack.instructions, 'first revision');
  assert.equal(rolledBack.description, 'third manifest');

  const missing = await post(`${baseUrl}/${created.id}/rollback`, ownerToken, {
    version: 99,
  });
  assert.equal(missing.status, 400);
});

test('export and import round-trip, guarding slug collisions', async () => {
  const source = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'portable-skill',
        name: 'Portable skill',
        description: 'exports cleanly',
        instructions: 'Do the portable thing.',
        enabled: false,
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
  assert.equal(exported.format, 'libre-skill.v1');
  assert.equal(exported.enabled, false);
  assert.ok(exported.exportedAt > 0);

  let response = await post(`${baseUrl}/import`, ownerToken, exported);
  assert.equal(response.status, 409, 'an import never silently overwrites');

  response = await post(`${baseUrl}/import`, ownerToken, {
    skill: exported,
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
  assert.equal(copied.instructions, exported.instructions);
  assert.equal(copied.enabled, false);

  response = await post(`${baseUrl}/import`, ownerToken, {
    ...exported,
    format: 'something-else',
  });
  assert.equal(response.status, 400);
});

test('skills are private by default and readable through a grant', async () => {
  const created = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'shared-skill',
        name: 'Shared skill',
        description: 'shared manifest',
        instructions: 'confidential instructions',
      })
    ).json()
  ).data;

  assert.equal(await skillService.getSkill(created.id, strangerActor), null);
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
  assert.ok(strangerList.every(skill => skill.id !== created.id));

  await grants.createGrant(ownerActor, {
    resourceType: 'skill',
    resourceId: created.id,
    principalType: 'user',
    principalId: STRANGER,
    permission: 'read',
  });

  const shared = await skillService.getSkill(created.id, strangerActor);
  assert.equal(shared.instructions, 'confidential instructions');
  response = await fetch(`${baseUrl}/${created.id}`, {
    headers: headersFor(strangerToken),
  });
  assert.equal(response.status, 200);

  // A read grant is not a write grant.
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PUT',
    headers: headersFor(strangerToken),
    body: JSON.stringify({
      slug: 'shared-skill',
      name: 'Hijacked',
      description: 'rewritten manifest',
      instructions: 'rewritten',
    }),
  });
  assert.equal(response.status, 403);

  await grants.createGrant(ownerActor, {
    resourceType: 'skill',
    resourceId: created.id,
    principalType: 'user',
    principalId: STRANGER,
    permission: 'write',
  });
  response = await fetch(`${baseUrl}/${created.id}`, {
    method: 'PUT',
    headers: headersFor(strangerToken),
    body: JSON.stringify({
      slug: 'shared-skill',
      name: 'Collaborated',
      description: 'shared manifest',
      instructions: 'rewritten together',
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).data.ownerUserId,
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
      .prepare('SELECT COUNT(*) AS count FROM skills WHERE id = ?')
      .get(created.id).count,
    0
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM skill_versions WHERE skill_id = ?'
      )
      .get(created.id).count,
    0,
    'archived revisions cascade with the skill'
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM resource_grants
          WHERE resource_type = 'skill' AND resource_id = ?`
      )
      .get(created.id).count,
    0,
    'grants are cleaned up on delete'
  );
});

test('skills round-trip through the SKILL.md interchange form', async () => {
  const markdown = skillService.skillToMarkdown({
    slug: 'md-roundtrip',
    name: 'Markdown roundtrip',
    description: 'Frontmatter plus body, exactly.',
    instructions: '# Steps\n\n- keep the body verbatim\n- including lists',
  });
  assert.match(markdown, /^---\nname: Markdown roundtrip\n/);
  assert.match(markdown, /\ndescription: Frontmatter plus body, exactly\.\n/);

  const parsed = skillService.skillFromMarkdown(markdown);
  assert.equal(parsed.slug, 'md-roundtrip');
  assert.equal(parsed.name, 'Markdown roundtrip');
  assert.equal(parsed.description, 'Frontmatter plus body, exactly.');
  assert.equal(
    parsed.instructions,
    '# Steps\n\n- keep the body verbatim\n- including lists'
  );

  const imported = await skillService.importSkill(OWNER, { markdown });
  assert.equal(imported.slug, 'md-roundtrip');
  assert.equal(imported.instructions, parsed.instructions);

  const exported = await skillService.exportSkill(imported.id, ownerActor);
  assert.ok(exported?.markdown, 'exports carry the SKILL.md form');
  assert.equal(
    skillService.skillFromMarkdown(exported.markdown).instructions,
    parsed.instructions
  );

  // A slugless SKILL.md derives its slug from the name.
  const derived = skillService.skillFromMarkdown(
    '---\nname: Style Guide\ndescription: How to write here.\n---\n\nBody.'
  );
  assert.equal(derived.slug, 'style-guide');

  assert.throws(
    () => skillService.skillFromMarkdown('no frontmatter at all'),
    /frontmatter/
  );
});
