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
 * Generalized resource sharing (SHARE-01): chats, personas, prompts, and
 * knowledge collections resolve through the common grant model — shared
 * reads carry metadata, mutations stay owner-scoped, revocation applies
 * immediately, and knowledge shares reach the vector ACL so retrieval
 * respects the same permission as a direct fetch.
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import express from 'express';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
);
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'libre-sharing-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'sharing-test-secret-that-is-long-enough';
process.env.ENCRYPTION_KEY ||= '4'.repeat(64);

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
  { default: accessRouter },
  { default: documentsRouter },
  { default: chatService },
  { personaService },
  promptService,
  grantService,
  { default: storageService },
  { default: documentService },
  { getPlatformStorageRuntime },
  { initializeCoordinator },
] = await Promise.all([
  distModule('db.js'),
  distModule('services/authService.js'),
  distModule('routes/access.js'),
  distModule('routes/documents.js'),
  distModule('services/chatService.js'),
  distModule('services/personaService.js'),
  distModule('services/promptService.js'),
  distModule('services/resourceGrantService.js'),
  distModule('storage.js'),
  distModule('services/documentService.js'),
  distModule('platform/storage/index.js'),
  distModule('platform/coordination/service.js'),
]);

await initializeCoordinator();
const jobsModule = await distModule('platform/jobs/index.js');
jobsModule.initializeDurableJobRuntime({
  role: 'embedded',
  runWorker: false,
  handlers: new Map(),
  env: process.env,
});

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

const OWNER = 'share-owner';
const FRIEND = 'share-friend';
const STRANGER = 'share-stranger';
const ownerToken = createUser(OWNER);
createUser(FRIEND);
createUser(STRANGER);
const ownerActor = { userId: OWNER, role: 'user' };
const friendActor = { userId: FRIEND, role: 'user' };
const strangerActor = { userId: STRANGER, role: 'user' };

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/access', accessRouter);
app.use('/api/documents', documentsRouter);
const server = createServer(app);
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});
const { port } = server.address();
const headersFor = token => ({
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await persistenceModule.closePersistence();
  await rm(dataDir, { recursive: true, force: true });
});

test('shared chats are readable, listed, and strictly read-only', async () => {
  const session = await chatService.createSession(
    'llama3.2',
    'Quarterly plan',
    OWNER
  );
  await chatService.addMessage(
    session.id,
    { role: 'user', content: 'The quarterly launch target is May.' },
    OWNER
  );

  // Before any grant the session does not exist for other users.
  assert.equal(await chatService.getSessionShared(session.id, friendActor), undefined);

  const grant = await grantService.createGrant(ownerActor, {
    resourceType: 'session',
    resourceId: session.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });

  const shared = await chatService.getSessionShared(session.id, friendActor);
  assert.ok(shared);
  assert.equal(shared.shared.ownerUserId, OWNER);
  assert.equal(shared.shared.permission, 'read');
  assert.equal(shared.session.title, 'Quarterly plan');
  assert.match(shared.session.messages.at(-1).content, /launch target/);

  const listed = await chatService.getAllSessionsWithShared(friendActor);
  assert.ok(listed.some(item => item.id === session.id && item.shared));
  // A third user still sees nothing.
  assert.equal(
    await chatService.getSessionShared(session.id, strangerActor),
    undefined
  );

  // Mutations stay owner-scoped: a read grant cannot rename or delete.
  assert.equal(
    await chatService.updateSession(session.id, { title: 'Hijacked' }, FRIEND),
    undefined
  );
  assert.equal(await chatService.deleteSession(session.id, FRIEND), false);
  const untouched = await chatService.getSession(session.id, OWNER);
  assert.equal(untouched.title, 'Quarterly plan');

  // Revocation applies immediately.
  await grantService.deleteGrant(ownerActor, grant.id);
  assert.equal(
    await chatService.getSessionShared(session.id, friendActor),
    undefined
  );
});

test('shared personas resolve read-only without leaking owner memories', async () => {
  const persona = await personaService.createPersona(
    {
      name: 'Analyst',
      model: 'llama3.2',
      parameters: { system_prompt: 'You are a careful analyst.' },
    },
    OWNER
  );

  assert.equal(await personaService.getPersonaById(persona.id, FRIEND), null);

  await grantService.createGrant(ownerActor, {
    resourceType: 'persona',
    resourceId: persona.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });

  const resolved = await personaService.getPersonaById(persona.id, FRIEND);
  assert.ok(resolved);
  assert.equal(resolved.shared.ownerUserId, OWNER);
  assert.equal(resolved.shared.permission, 'read');
  assert.equal(resolved.parameters.system_prompt, 'You are a careful analyst.');
  assert.equal(resolved.memories, undefined);

  const listed = await personaService.getPersonasWithShared(FRIEND);
  assert.ok(listed.some(item => item.id === persona.id && item.shared));

  // The grantee cannot mutate the persona through the owner-scoped model.
  await assert.rejects(
    personaService.updatePersona(persona.id, { name: 'Taken over' }, FRIEND)
  );
});

test('prompt lists include shared prompts with access metadata', async () => {
  const prompt = await promptService.createPrompt(OWNER, {
    slug: 'release-notes',
    title: 'Release notes',
    content: 'Summarize the changes in the provided diff.',
  });

  let listed = await promptService.listPromptsWithShared(friendActor);
  assert.ok(!listed.some(item => item.id === prompt.id));

  await grantService.createGrant(ownerActor, {
    resourceType: 'prompt',
    resourceId: prompt.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });

  listed = await promptService.listPromptsWithShared(friendActor);
  const found = listed.find(item => item.id === prompt.id);
  assert.ok(found);
  assert.equal(found.shared.ownerUserId, OWNER);
  assert.equal(found.shared.permission, 'read');
});

test('group grants reach members and stop at membership boundaries', async () => {
  const security = applicationPersistence.repositories.security;
  const groupId = randomUUID();
  await security.groups.insert({
    id: groupId,
    name: 'analysts',
    description: null,
    created_by: OWNER,
    created_at: now,
    updated_at: now,
  });
  await security.groups.addMember({
    group_id: groupId,
    user_id: FRIEND,
    added_by: OWNER,
    added_at: now,
  });

  const note = await (
    await distModule('services/noteService.js')
  ).createNote(ownerActor, { title: 'Team charter', content: 'Ship safely.' });

  await grantService.createGrant(ownerActor, {
    resourceType: 'note',
    resourceId: note.id,
    principalType: 'group',
    principalId: groupId,
    permission: 'read',
  });

  const noteService = await distModule('services/noteService.js');
  const viaGroup = await noteService.getNote(friendActor, note.id);
  assert.ok(viaGroup);
  assert.equal(viaGroup.shared.ownerUserId, OWNER);

  await security.groups.removeMember(groupId, FRIEND);
  await assert.rejects(noteService.getNote(friendActor, note.id));
});

test('group principal lookup and grant names surface through the API', async () => {
  const groupLookup = await fetch(
    `http://127.0.0.1:${port}/api/access/principals/groups?name=analysts`,
    { headers: headersFor(ownerToken) }
  );
  assert.equal(groupLookup.status, 200);
  const group = (await groupLookup.json()).data;
  assert.equal(group.name, 'analysts');

  const session = await chatService.createSession(
    'llama3.2',
    'Named-grant chat',
    OWNER
  );
  await grantService.createGrant(ownerActor, {
    resourceType: 'session',
    resourceId: session.id,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });
  const listResponse = await fetch(
    `http://127.0.0.1:${port}/api/access/grants?type=session&id=${session.id}`,
    { headers: headersFor(ownerToken) }
  );
  assert.equal(listResponse.status, 200);
  const grants = (await listResponse.json()).data;
  assert.equal(grants.length, 1);
  assert.equal(grants[0].principalName, FRIEND);
});

test('shared knowledge collections join listing, retrieval, and the vector ACL', async () => {
  const collectionId = randomUUID();
  await storageService.saveKnowledgeCollection(
    { id: collectionId, name: 'Playbooks', createdAt: now, updatedAt: now },
    OWNER
  );
  const documentId = randomUUID();
  await storageService.saveDocument(
    {
      id: documentId,
      filename: 'incident-runbook.txt',
      content: 'Rotate the pager schedule after every incident retrospective.',
      fileType: 'txt',
      size: 64,
      collectionId,
      uploadedAt: now,
    },
    OWNER
  );
  const chunkId = `${documentId}-chunk-0`;
  await storageService.saveDocumentChunks(documentId, [
    {
      id: chunkId,
      documentId,
      content:
        'Rotate the pager schedule after every incident retrospective.',
      chunkIndex: 0,
      startChar: 0,
      endChar: 61,
    },
  ]);
  const platform = getPlatformStorageRuntime();
  await platform.vectorStore.upsert({
    actor: { userId: OWNER },
    records: [
      {
        namespace: 'document-chunk',
        id: chunkId,
        ownerUserId: OWNER,
        resourceId: documentId,
        model: 'test-embedder',
        dimensions: 3,
        version: 'v1',
        sourceRevision: 'rev-1',
        embedding: [0.1, 0.2, 0.3],
        attributes: { chunkIndex: '0', collectionId },
      },
    ],
  });

  // Nothing is visible to the friend before the share exists.
  let search = await documentService.searchDocuments(
    'pager schedule',
    FRIEND,
    undefined,
    5,
    undefined
  );
  assert.equal(search.length, 0);

  const grant = await grantService.createGrant(ownerActor, {
    resourceType: 'knowledge-collection',
    resourceId: collectionId,
    principalType: 'user',
    principalId: FRIEND,
    permission: 'read',
  });

  // The share propagated to the vector ACL without re-embedding anything.
  const aclRows = database
    .prepare(
      `SELECT principal_type, principal_id FROM platform_vector_acl
       WHERE vector_id = ?`
    )
    .all(chunkId);
  assert.deepEqual(aclRows, [
    { principal_type: 'user', principal_id: FRIEND },
  ]);

  // Collections and documents list for the grantee with shared metadata.
  const collections = await documentService.listCollectionsWithShared(
    friendActor
  );
  const sharedCollection = collections.find(item => item.id === collectionId);
  assert.ok(sharedCollection);
  assert.equal(sharedCollection.shared.ownerUserId, OWNER);
  assert.equal(sharedCollection.name, 'Playbooks');

  const sharedDocuments = await documentService.listSharedDocuments(
    friendActor
  );
  assert.equal(sharedDocuments.length, 1);
  assert.equal(sharedDocuments[0].document.id, documentId);

  // Retrieval reaches the shared chunk for the grantee, not for strangers.
  search = await documentService.searchDocuments(
    'pager schedule',
    FRIEND,
    undefined,
    5,
    undefined
  );
  assert.equal(search.length, 1);
  assert.match(search[0].content, /pager schedule/);
  assert.equal(
    (
      await documentService.searchDocuments(
        'pager schedule',
        STRANGER,
        undefined,
        5,
        undefined
      )
    ).length,
    0
  );

  // Direct document reads follow the collection grant, read-only.
  const sharedRead = await documentService.getDocumentShared(
    documentId,
    friendActor
  );
  assert.ok(sharedRead);
  assert.equal(sharedRead.shared.permission, 'read');
  assert.equal(sharedRead.ownerUserId, OWNER);

  // Revoking the share clears the ACL and hides everything again.
  await grantService.deleteGrant(ownerActor, grant.id);
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS count FROM platform_vector_acl WHERE vector_id = ?')
      .get(chunkId).count,
    0
  );
  assert.equal(
    (await documentService.getDocumentShared(documentId, friendActor)),
    undefined
  );
  search = await documentService.searchDocuments(
    'pager schedule',
    FRIEND,
    undefined,
    5,
    undefined
  );
  assert.equal(search.length, 0);
});
