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
 * Assistant profiles: persona bindings (validation, revision counter,
 * encryption at rest), the bound library prompt composed into the turn's
 * system prompt, and the skill binding narrowing the lazy load_skill
 * manifest and the tool's own reach.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-profiles-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'assistant-profiles-test-secret-long-enough';
process.env.ENCRYPTION_KEY ||= '6'.repeat(64);

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

const [personas, prompts, skills, builtins, chatRequest, database] =
  await Promise.all([
    distModule('services/personaService.js'),
    distModule('services/promptService.js'),
    distModule('services/skillService.js'),
    distModule('services/builtinToolsService.js'),
    distModule('services/chatRequestService.js'),
    distModule('db.js'),
  ]);

const { personaService, normalizePersonaBindings } = personas;
const db = database.getDatabase();
const now = Date.now();

const createUser = id => {
  db.prepare(
    `INSERT INTO users
       (id, username, email, password_hash, role, account_status, avatar,
        created_at, updated_at)
     VALUES (?, ?, NULL, 'unused', 'user', 'active', NULL, ?, ?)`
  ).run(id, id, now, now);
  return { userId: id, role: 'user', status: 'active' };
};

const OWNER = createUser('profile-owner');
const STRANGER = createUser('profile-stranger');

const SERVER_ID = 'profile-server-1';
db.prepare(
  `INSERT INTO tool_servers
     (id, user_id, name, description, kind, base_url, spec, spec_digest,
      spec_revision, auth_mode, auth_header, access_mode, enabled,
      timeout_ms, max_response_bytes, created_at, updated_at)
   VALUES (?, ?, 'Profile Server', NULL, 'openapi', 'http://example.test',
           NULL, NULL, 1, 'none', NULL, 'admins-only', 1, 30000, 262144, ?, ?)`
).run(SERVER_ID, OWNER.userId, now, now);

after(async () => {
  database.closeDatabase();
  await rm(dataDir, { recursive: true, force: true });
});

// Fixtures the bindings point at.
const boundPrompt = await prompts.createPrompt(OWNER.userId, {
  slug: 'tone-prompt',
  title: 'Tone',
  content: 'You are {{tone}}.',
  variables: [{ name: 'tone', type: 'text', default: 'kind' }],
});
const foreignPrompt = await prompts.createPrompt(STRANGER.userId, {
  slug: 'foreign-prompt',
  title: 'Foreign',
  content: 'Speak only in riddles.',
});
const alphaSkill = await skills.createSkill(OWNER.userId, {
  slug: 'alpha-skill',
  name: 'Alpha',
  description: 'The alpha skill for testing',
  instructions: 'Always start with alpha.',
});
const betaSkill = await skills.createSkill(OWNER.userId, {
  slug: 'beta-skill',
  name: 'Beta',
  description: 'The beta skill for testing',
  instructions: 'Always start with beta.',
});

const baseParameters = {
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  context_window: 4096,
  max_tokens: 1024,
  system_prompt: '',
  repeat_penalty: 1.1,
  presence_penalty: 0,
  frequency_penalty: 0,
};

let boundPersona;

// === 1. Bindings round-trip, normalized and encrypted at rest ===

test('a profile stores its bindings normalized, versioned, and encrypted', async () => {
  boundPersona = await personaService.createPersona(
    {
      name: 'Bound Assistant',
      model: 'mock-model',
      parameters: { ...baseParameters, system_prompt: 'Stay short.' },
      bindings: {
        tool_server_ids: [SERVER_ID],
        skill_ids: [alphaSkill.id],
        prompt_id: boundPrompt.id,
        voice: { plugin_id: 'piper', voice: 'en_US-amy' },
      },
    },
    OWNER.userId
  );

  assert.deepEqual(boundPersona.bindings, {
    tool_server_ids: [SERVER_ID],
    skill_ids: [alphaSkill.id],
    prompt_id: boundPrompt.id,
    voice: { plugin_id: 'piper', voice: 'en_US-amy' },
    version: 1,
  });

  const fetched = await personaService.getPersonaById(
    boundPersona.id,
    OWNER.userId
  );
  assert.deepEqual(fetched.bindings, boundPersona.bindings);

  // The column holds ciphertext, not the bound ids.
  const row = db
    .prepare('SELECT bindings FROM personas WHERE id = ?')
    .get(boundPersona.id);
  assert.ok(row.bindings, 'the bindings column is populated');
  assert.equal(row.bindings.includes(SERVER_ID), false);
  assert.equal(row.bindings.includes(boundPrompt.id), false);
  assert.equal(row.bindings.includes('piper'), false);
  assert.deepEqual(
    JSON.parse(encryptionService.decrypt(row.bindings)),
    boundPersona.bindings
  );

  // Deduplication and empty-array handling come from the normalizer.
  assert.deepEqual(
    normalizePersonaBindings(
      { skill_ids: ['a', 'a', 'b'], builtin_tools: [] },
      undefined
    ),
    { builtin_tools: [], skill_ids: ['a', 'b'], version: 1 }
  );
});

// === 2. The revision counter ===

test('changing bindings advances the version; omitting them changes nothing', async () => {
  const updated = await personaService.updatePersona(
    boundPersona.id,
    { bindings: { skill_ids: [alphaSkill.id, betaSkill.id] } },
    OWNER.userId
  );
  assert.deepEqual(updated.bindings, {
    skill_ids: [alphaSkill.id, betaSkill.id],
    version: 2,
  });

  // An update that never mentions bindings leaves them exactly as they were.
  const renamed = await personaService.updatePersona(
    boundPersona.id,
    { description: 'still bound' },
    OWNER.userId
  );
  assert.deepEqual(renamed.bindings, updated.bindings);
  const refetched = await personaService.getPersonaById(
    boundPersona.id,
    OWNER.userId
  );
  assert.equal(refetched.bindings.version, 2);

  // Restore the full binding set for the prompt-composition test.
  const restored = await personaService.updatePersona(
    boundPersona.id,
    {
      bindings: {
        tool_server_ids: [SERVER_ID],
        skill_ids: [alphaSkill.id],
        prompt_id: boundPrompt.id,
        voice: { plugin_id: 'piper', voice: 'en_US-amy' },
      },
    },
    OWNER.userId
  );
  assert.equal(restored.bindings.version, 3);
});

// === 3. Rejected bindings ===

test('malformed bindings are refused before they are stored', async () => {
  const rejects = (bindings, pattern) =>
    assert.throws(() => normalizePersonaBindings(bindings, undefined), pattern);

  rejects({ skill_ids: 'alpha' }, /skill_ids must be an array of ids/);
  rejects(
    { skill_ids: Array.from({ length: 33 }, (_, index) => `id-${index}`) },
    /at most 32 entries/
  );
  rejects({ tool_server_ids: [''] }, /tool_server_ids contains an invalid id/);
  rejects({ skill_ids: [42] }, /skill_ids contains an invalid id/);
  rejects({ prompt_id: '  ' }, /prompt_id is invalid/);
  rejects({ voice: { plugin_id: 'piper' } }, /voice is invalid/);
  rejects({ voice: 'piper' }, /voice is invalid/);
  assert.throws(
    () => normalizePersonaBindings(null, undefined),
    /must be an object/
  );

  await assert.rejects(
    () =>
      personaService.createPersona(
        {
          name: 'Rejected Assistant',
          model: 'mock-model',
          parameters: baseParameters,
          bindings: { skill_ids: 'alpha' },
        },
        OWNER.userId
      ),
    /skill_ids must be an array of ids/
  );
  await assert.rejects(
    () =>
      personaService.updatePersona(
        boundPersona.id,
        { bindings: { voice: { plugin_id: 'piper', voice: '' } } },
        OWNER.userId
      ),
    /voice is invalid/
  );
});

// === 4. The bound library prompt leads the persona's own prompt ===

const requestService = new chatRequest.ChatRequestService({
  chatGenerationService: {
    prepareGenerationTarget: async () => {
      throw new Error('not used by these tests');
    },
  },
  personaService,
});

test('a bound prompt is rendered ahead of the persona system prompt', async () => {
  const resolved = await requestService.resolvePersonaSystemPrompt(
    { personaId: boundPersona.id },
    OWNER.userId
  );
  assert.equal(resolved, 'You are kind.\n\nStay short.');
});

test('an inaccessible bound prompt degrades to the persona prompt alone', async () => {
  const foreign = await personaService.createPersona(
    {
      name: 'Foreign Bound Assistant',
      model: 'mock-model',
      parameters: { ...baseParameters, system_prompt: 'Stay short.' },
      bindings: { prompt_id: foreignPrompt.id },
    },
    OWNER.userId
  );
  assert.equal(foreign.bindings.prompt_id, foreignPrompt.id);
  assert.equal(
    await prompts.getPrompt(foreignPrompt.id, OWNER),
    null,
    'the stranger granted nothing'
  );

  const resolved = await requestService.resolvePersonaSystemPrompt(
    { personaId: foreign.id },
    OWNER.userId
  );
  assert.equal(resolved, 'Stay short.');

  // No binding and no prompt of its own resolves to nothing at all.
  const bare = await personaService.createPersona(
    {
      name: 'Bare Assistant',
      model: 'mock-model',
      parameters: baseParameters,
    },
    OWNER.userId
  );
  assert.equal(
    await requestService.resolvePersonaSystemPrompt(
      { personaId: bare.id },
      OWNER.userId
    ),
    undefined
  );
});

// === 5. The lazy skill manifest follows the skill binding ===

const loadSkillTool = async context => {
  const catalog = await builtins.effectiveBuiltinTools(context, ['load_skill']);
  return catalog.find(tool => tool.name === 'load_skill');
};

test('the load_skill description carries the manifest the binding permits', async () => {
  const unscoped = await loadSkillTool({ actor: OWNER });
  assert.ok(unscoped, 'load_skill is offered once the user owns skills');
  assert.match(unscoped.description, /alpha-skill: Alpha/);
  assert.match(unscoped.description, /beta-skill: Beta/);

  const scoped = await loadSkillTool({
    actor: OWNER,
    skillIds: [alphaSkill.id],
  });
  assert.match(scoped.description, /alpha-skill: Alpha/);
  assert.equal(
    scoped.description.includes('beta-skill'),
    false,
    'the binding hides the unbound skill from the manifest'
  );

  // A user with no skills is not offered the tool at all.
  assert.equal(await loadSkillTool({ actor: STRANGER }), undefined);
});

test('load_skill only loads a skill the binding permits', async () => {
  const scoped = { actor: OWNER, skillIds: [alphaSkill.id] };

  const allowed = await builtins.executeBuiltinTool(
    'load_skill',
    { slug: 'alpha-skill' },
    scoped
  );
  assert.equal(allowed.isError, false, allowed.text);
  assert.match(allowed.text, /# Skill: Alpha/);
  assert.match(allowed.text, /Always start with alpha\./);

  const excluded = await builtins.executeBuiltinTool(
    'load_skill',
    { slug: 'beta-skill' },
    scoped
  );
  assert.equal(excluded.isError, true);
  assert.match(excluded.text, /No enabled skill named "beta-skill"/);

  // Without the binding the same slug loads fine.
  const unscoped = await builtins.executeBuiltinTool(
    'load_skill',
    { slug: 'beta-skill' },
    { actor: OWNER }
  );
  assert.equal(unscoped.isError, false, unscoped.text);
  assert.match(unscoped.text, /Always start with beta\./);

  // Another user's skill is never reachable.
  const foreign = await builtins.executeBuiltinTool(
    'load_skill',
    { slug: 'alpha-skill' },
    { actor: STRANGER }
  );
  assert.equal(foreign.isError, true);
});

// === 6. Collection scoping ===

test.skip('search_documents forwards collectionIds to the document service', () => {
  // Skipped deliberately: exercising the builtin end to end pulls in the
  // embedding and indexing stack. The pass-through itself is covered where
  // it is written, in builtinToolsService and toolGatewayService.
});
