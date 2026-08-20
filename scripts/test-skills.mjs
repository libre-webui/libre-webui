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

test('remote skill sources resolve to bounded raw-content candidates', () => {
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates('vercel-labs/agent-skills'),
    ['https://raw.githubusercontent.com/vercel-labs/agent-skills/HEAD/SKILL.md']
  );
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates('acme/repo/writer'),
    [
      'https://raw.githubusercontent.com/acme/repo/HEAD/skills/writer/SKILL.md',
      'https://raw.githubusercontent.com/acme/repo/HEAD/skills/.curated/writer/SKILL.md',
      'https://raw.githubusercontent.com/acme/repo/HEAD/writer/SKILL.md',
    ]
  );
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates(
      'https://www.skills.sh/acme/repo/writer'
    ),
    skillService.resolveSkillSourceCandidates('acme/repo/writer')
  );
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates(
      'https://github.com/acme/repo/tree/main/skills/writer'
    ),
    [
      'https://raw.githubusercontent.com/acme/repo/main/skills/writer/SKILL.md',
    ]
  );
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates(
      'https://github.com/acme/repo/blob/main/skills/writer/SKILL.md'
    ),
    [
      'https://raw.githubusercontent.com/acme/repo/main/skills/writer/SKILL.md',
    ]
  );
  assert.deepEqual(
    skillService.resolveSkillSourceCandidates(
      'https://example.com/store/my.skill.md'
    ),
    ['https://example.com/store/my.skill.md']
  );
  assert.throws(
    () => skillService.resolveSkillSourceCandidates('just-one-segment'),
    /owner\/repo/
  );
  assert.throws(
    () => skillService.resolveSkillSourceCandidates('a/b/c/d'),
    /owner\/repo/
  );
});

test('a skill imports from a remote store URL through the egress guard', async t => {
  const remoteMarkdown = [
    '---',
    'name: remote-style',
    'description: Imported from a remote store.',
    '---',
    '',
    '# Remote style',
    '',
    '- fetched over HTTP',
    '',
  ].join('\n');
  const remote = createServer((req, res) => {
    if (req.url === '/skills/remote-style/SKILL.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end(remoteMarkdown);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => remote.close());
  const port = remote.address().port;
  const sourceUrl = `http://127.0.0.1:${port}/skills/remote-style/SKILL.md`;

  // Without the allowlist the guard refuses loopback outright.
  delete process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST;
  await assert.rejects(
    skillService.importSkillFromUrl(OWNER, sourceUrl),
    /private or local address/
  );

  process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1';
  try {
    const imported = await skillService.importSkillFromUrl(OWNER, sourceUrl);
    assert.equal(imported.slug, 'remote-style');
    assert.equal(imported.name, 'remote-style');
    assert.match(imported.instructions, /fetched over HTTP/);

    // A 404 on every candidate surfaces as a clear client error.
    await assert.rejects(
      skillService.importSkillFromUrl(
        OWNER,
        `http://127.0.0.1:${port}/missing.md`
      ),
      /No SKILL\.md/
    );
  } finally {
    delete process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST;
  }
});

test('companion files round-trip, stay encrypted, and never escape the skill', async () => {
  const created = (
    await (
      await post(baseUrl, ownerToken, {
        slug: 'bundled-skill',
        name: 'Bundled skill',
        description: 'carries companion files',
        instructions: 'Read reference.md before answering.',
      })
    ).json()
  ).data;

  let response = await fetch(`${baseUrl}/${created.id}/files`, {
    method: 'PUT',
    headers: headersFor(ownerToken),
    body: JSON.stringify({
      path: 'docs/reference.md',
      content: '# Reference\n\nThe canonical checklist.',
    }),
  });
  assert.equal(response.status, 200);
  const saved = (await response.json()).data;
  assert.equal(saved.path, 'docs/reference.md');
  assert.ok(saved.size > 0);

  const row = database
    .prepare('SELECT * FROM skill_files WHERE skill_id = ?')
    .get(created.id);
  assert.ok(!row.content.includes('checklist'), 'file contents are encrypted');
  assert.equal(
    encryptionService.decrypt(row.content),
    '# Reference\n\nThe canonical checklist.'
  );

  const listed = (
    await (
      await fetch(`${baseUrl}/${created.id}/files`, {
        headers: headersFor(ownerToken),
      })
    ).json()
  ).data;
  assert.deepEqual(
    listed.map(file => file.path),
    ['docs/reference.md']
  );

  const content = (
    await (
      await fetch(
        `${baseUrl}/${created.id}/files/content?path=docs%2Freference.md`,
        { headers: headersFor(ownerToken) }
      )
    ).json()
  ).data;
  assert.match(content.content, /canonical checklist/);

  // Traversal, absolute paths, and SKILL.md itself are refused.
  for (const path of ['../escape.md', '/etc/passwd', 'SKILL.md', 'a/../b']) {
    response = await fetch(`${baseUrl}/${created.id}/files`, {
      method: 'PUT',
      headers: headersFor(ownerToken),
      body: JSON.stringify({ path, content: 'nope' }),
    });
    assert.equal(response.status, 400, `"${path}" must be rejected`);
  }

  // A read grant is not enough to write files.
  response = await fetch(`${baseUrl}/${created.id}/files`, {
    method: 'PUT',
    headers: headersFor(strangerToken),
    body: JSON.stringify({ path: 'hijack.md', content: 'nope' }),
  });
  assert.equal(response.status, 404, 'no access reads as absent');

  response = await fetch(
    `${baseUrl}/${created.id}/files?path=docs%2Freference.md`,
    { method: 'DELETE', headers: headersFor(ownerToken) }
  );
  assert.equal(response.status, 200);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM skill_files WHERE skill_id = ?')
      .get(created.id).count,
    0
  );
});

test('imports and exports carry companion files; deletes clean them up', async () => {
  const imported = await skillService.importSkill(OWNER, {
    markdown: [
      '---',
      'name: Folder skill',
      'slug: folder-skill',
      'description: A SKILL.md folder with companions.',
      '---',
      '',
      'Use scripts/run.py as described in docs/usage.md.',
    ].join('\n'),
    files: [
      { path: 'docs/usage.md', content: '# Usage\n\nRun the script.' },
      { path: 'scripts/run.py', content: 'print("hello")' },
    ],
  });

  const exported = await skillService.exportSkill(imported.id, ownerActor);
  assert.deepEqual(
    exported.files.map(file => file.path),
    ['docs/usage.md', 'scripts/run.py']
  );
  assert.match(exported.files[1].content, /hello/);

  // Re-importing the export elsewhere reproduces the whole folder.
  const copied = await skillService.importSkill(STRANGER, exported);
  const copiedExport = await skillService.exportSkill(copied.id, strangerActor);
  assert.equal(copiedExport.files.length, 2);

  // An overwrite import with a files array replaces the set.
  await skillService.importSkill(
    OWNER,
    { ...exported, files: [{ path: 'only.md', content: 'the survivor' }] },
    { overwriteSlug: true }
  );
  const replaced = await skillService.listSkillFiles(imported.id, ownerActor);
  assert.deepEqual(
    replaced.map(file => file.path),
    ['only.md']
  );

  await skillService.deleteSkill(imported.id, OWNER);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM skill_files WHERE skill_id = ?')
      .get(imported.id).count,
    0,
    'companion files are removed with the skill'
  );
});

test('load_skill lists bundled files and read_skill_file serves them', async () => {
  const tools = await distModule('services/builtinToolsService.js');
  await skillService.importSkill(OWNER, {
    markdown: [
      '---',
      'name: Tooling skill',
      'slug: tooling-skill',
      'description: Uses a bundled checklist.',
      '---',
      '',
      'Consult checklist.md first.',
    ].join('\n'),
    files: [{ path: 'checklist.md', content: '1. Verify\n2. Ship' }],
  });
  const context = { actor: ownerActor };

  const loaded = await tools.executeBuiltinTool(
    'load_skill',
    { slug: 'tooling-skill' },
    context
  );
  assert.equal(loaded.isError, false);
  assert.match(loaded.text, /Bundled files \(read one with read_skill_file\)/);
  assert.match(loaded.text, /- checklist\.md \(\d+ bytes\)/);

  const catalog = await tools.effectiveBuiltinTools(context);
  assert.ok(
    catalog.some(tool => tool.name === 'read_skill_file'),
    'read_skill_file joins the catalog when skills exist'
  );

  const file = await tools.executeBuiltinTool(
    'read_skill_file',
    { slug: 'tooling-skill', path: 'checklist.md' },
    context
  );
  assert.equal(file.isError, false);
  assert.match(file.text, /1\. Verify/);

  const missing = await tools.executeBuiltinTool(
    'read_skill_file',
    { slug: 'tooling-skill', path: 'nope.md' },
    context
  );
  assert.equal(missing.isError, true);
  assert.match(missing.text, /bundles no file/);

  const strangerRead = await tools.executeBuiltinTool(
    'read_skill_file',
    { slug: 'tooling-skill', path: 'checklist.md' },
    { actor: strangerActor }
  );
  assert.equal(strangerRead.isError, true, 'skills stay per-user');
});

test('remote folder skills pull their companion files through the guard', async t => {
  assert.deepEqual(
    skillService.parseRawGitHubSkillUrl(
      'https://raw.githubusercontent.com/acme/repo/HEAD/skills/writer/SKILL.md'
    ),
    { owner: 'acme', repo: 'repo', ref: 'HEAD', dir: 'skills/writer' }
  );
  assert.equal(
    skillService.parseRawGitHubSkillUrl(
      'https://raw.githubusercontent.com/acme/repo/HEAD/SKILL.md'
    ),
    null,
    'a root SKILL.md has no folder to walk'
  );
  assert.equal(
    skillService.parseRawGitHubSkillUrl('https://example.com/store/my.md'),
    null
  );

  const remote = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/repos/acme/repo/contents/skills/writer') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            name: 'SKILL.md',
            path: 'skills/writer/SKILL.md',
            type: 'file',
            size: 10,
            download_url: `http://127.0.0.1:${remote.address().port}/raw/SKILL.md`,
          },
          {
            name: 'style.md',
            path: 'skills/writer/style.md',
            type: 'file',
            size: 20,
            download_url: `http://127.0.0.1:${remote.address().port}/raw/style.md`,
          },
          {
            name: 'logo.png',
            path: 'skills/writer/logo.png',
            type: 'file',
            size: 20,
            download_url: `http://127.0.0.1:${remote.address().port}/raw/logo.png`,
          },
          {
            name: 'templates',
            path: 'skills/writer/templates',
            type: 'dir',
            size: 0,
          },
        ])
      );
      return;
    }
    if (
      url.pathname === '/repos/acme/repo/contents/skills/writer/templates'
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            name: 'note.txt',
            path: 'skills/writer/templates/note.txt',
            type: 'file',
            size: 12,
            download_url: `http://127.0.0.1:${remote.address().port}/raw/note.txt`,
          },
        ])
      );
      return;
    }
    if (url.pathname === '/raw/style.md') {
      res.writeHead(200, { 'content-type': 'text/markdown' });
      res.end('# Style rules');
      return;
    }
    if (url.pathname === '/raw/note.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Note template');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => remote.close());

  process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST = '127.0.0.1';
  try {
    const files = await skillService.fetchSkillCompanionFiles(
      { owner: 'acme', repo: 'repo', ref: 'HEAD', dir: 'skills/writer' },
      { apiBase: `http://127.0.0.1:${remote.address().port}` }
    );
    assert.deepEqual(
      files.map(file => file.path).sort(),
      ['style.md', 'templates/note.txt'],
      'SKILL.md and binaries are skipped; subfolders are walked'
    );
    assert.equal(
      files.find(file => file.path === 'style.md').content,
      '# Style rules'
    );
  } finally {
    delete process.env.TOOLS_PRIVATE_NETWORK_ALLOWLIST;
  }
});
