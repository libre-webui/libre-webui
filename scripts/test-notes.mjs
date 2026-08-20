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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

process.env.ENCRYPTION_KEY ||= '0'.repeat(64);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-notes-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase, getDatabase } = await import(dist('db.js'));
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(
    path.join(repoRoot, 'backend', 'dist')
  );
const noteService = await import(dist('services/noteService.js'));
const { createGrant } = await import(dist('services/resourceGrantService.js'));
const builtins = await import(dist('services/builtinToolsService.js'));
const { default: chatGenerationService } = await import(
  dist('services/chatGenerationService.js')
);
const { getPlatformStorageRuntime } = await import(
  dist('platform/storage/index.js')
);

const OWNER = 'note-owner';
const READER = 'note-reader';
const WRITER = 'note-writer';
const STRANGER = 'note-stranger';

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
for (const userId of [OWNER, READER, WRITER, STRANGER]) {
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(userId, userId, now, now);
}

const owner = { userId: OWNER, role: 'user' };
const reader = { userId: READER, role: 'user' };
const writer = { userId: WRITER, role: 'user' };
const stranger = { userId: STRANGER, role: 'user' };

test('notes support pinning and pinned-first ordering', async () => {
  const first = await noteService.createNote(owner, {
    title: 'first',
    content: 'first body',
  });
  const second = await noteService.createNote(owner, {
    title: 'second',
    content: 'second body',
  });
  await noteService.updateNote(owner, first.id, { pinned: true });
  const listed = await noteService.listNotes(owner);
  assert.equal(listed[0].id, first.id, 'pinned note must sort first');
  assert.equal(listed[0].pinned, true);
  assert.equal(listed[1].id, second.id);
});

test('content changes snapshot restorable revisions and prune beyond the cap', async () => {
  const note = await noteService.createNote(owner, {
    title: 'draft',
    content: 'version one',
  });
  await noteService.updateNote(owner, note.id, { content: 'version two' });
  await noteService.updateNote(owner, note.id, { content: 'version three' });
  // A pure pin toggle is not a content change and must not add a revision.
  await noteService.updateNote(owner, note.id, { pinned: true });

  const revisions = await noteService.listRevisions(owner, note.id);
  assert.deepEqual(
    revisions.map(revision => revision.content),
    ['version two', 'version one']
  );

  const restored = await noteService.restoreRevision(
    owner,
    note.id,
    revisions[1].id
  );
  assert.equal(restored.content, 'version one');
  // Restoring snapshots the pre-restore state too, so it is itself undoable.
  const afterRestore = await noteService.listRevisions(owner, note.id);
  assert.equal(afterRestore[0].content, 'version three');
});

test('sharing grants read and write access exactly as granted', async () => {
  const note = await noteService.createNote(owner, {
    title: 'shared plan',
    content: 'the pelican plan',
  });
  await createGrant(owner, {
    resourceType: 'note',
    resourceId: note.id,
    principalType: 'user',
    principalId: READER,
    permission: 'read',
  });
  await createGrant(owner, {
    resourceType: 'note',
    resourceId: note.id,
    principalType: 'user',
    principalId: WRITER,
    permission: 'write',
  });

  const readerView = await noteService.getNote(reader, note.id);
  assert.equal(readerView.content, 'the pelican plan');
  assert.equal(readerView.shared?.permission, 'read');

  await assert.rejects(
    noteService.updateNote(reader, note.id, { content: 'sneaky edit' }),
    /Note not found/
  );

  const writerEdit = await noteService.updateNote(writer, note.id, {
    content: 'the pelican plan, amended',
  });
  assert.equal(writerEdit.shared?.permission, 'write');

  await assert.rejects(noteService.getNote(stranger, note.id), /Note not found/);
  await assert.rejects(noteService.deleteNote(reader, note.id), /Note not found/);

  const readerList = await noteService.listNotes(reader);
  const sharedEntry = readerList.find(entry => entry.id === note.id);
  assert.ok(sharedEntry, 'shared note must appear in the reader list');
  assert.equal(sharedEntry.shared?.ownerUserId, OWNER);
});

test('attachments store bytes in the blob store and clean up with the note', async () => {
  const note = await noteService.createNote(owner, {
    title: 'with files',
    content: 'body',
  });
  const added = await noteService.addAttachment(owner, note.id, {
    buffer: Buffer.from('attachment payload bytes'),
    filename: 'payload.bin',
    contentType: 'application/octet-stream',
  });
  const listed = await noteService.listAttachments(owner, note.id);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].filename, 'payload.bin');

  const opened = await noteService.openAttachment(owner, note.id, added.id);
  const chunks = [];
  for await (const chunk of opened.body.body) chunks.push(chunk);
  assert.equal(
    Buffer.concat(chunks).toString('utf8'),
    'attachment payload bytes'
  );

  const blobId = getDatabase()
    .prepare('SELECT blob_id FROM note_attachments WHERE id = ?')
    .get(added.id).blob_id;
  await noteService.deleteNote(owner, note.id);
  assert.equal(
    getDatabase()
      .prepare('SELECT COUNT(*) AS count FROM note_attachments WHERE note_id = ?')
      .get(note.id).count,
    0
  );
  const platform = getPlatformStorageRuntime();
  await assert.rejects(
    platform.blobStore.stat(blobId, OWNER),
    /not found|missing|unknown/i,
    'attachment bytes must be released with the note'
  );
});

test('the note tools list, read, and mutate through the same access checks', async () => {
  const note = await noteService.createNote(owner, {
    title: 'tool target',
    content: 'original tool content',
  });
  const context = { actor: owner };

  const listed = await builtins.executeBuiltinTool('list_notes', {}, context);
  assert.match(listed.text, /tool target/);

  const read = await builtins.executeBuiltinTool(
    'read_note',
    { note_id: note.id },
    context
  );
  assert.match(read.text, /original tool content/);

  const updated = await builtins.executeBuiltinTool(
    'update_note',
    { note_id: note.id, content: 'tool-edited content' },
    context
  );
  assert.equal(updated.isError, false);
  const revisions = await noteService.listRevisions(owner, note.id);
  assert.equal(
    revisions[0].content,
    'original tool content',
    'a tool edit must snapshot the previous version'
  );

  const denied = await builtins.executeBuiltinTool(
    'read_note',
    { note_id: note.id },
    { actor: stranger }
  );
  assert.equal(denied.isError, true);

  const catalog = await builtins.effectiveBuiltinTools(context);
  const byName = new Map(catalog.map(tool => [tool.name, tool]));
  assert.equal(byName.get('update_note')?.sideEffect, true);
  assert.equal(byName.get('create_note')?.sideEffect, true);
  assert.equal(byName.get('read_note')?.sideEffect, false);
});

test('AI assist proposes without persisting and respects read access', async () => {
  const note = await noteService.createNote(owner, {
    title: 'assist me',
    content: 'imperfect draft',
  });
  const originalPrepare = chatGenerationService.prepareGenerationTarget;
  const originalExecute = chatGenerationService.executeNonStreaming;
  let sawPrompt = '';
  chatGenerationService.prepareGenerationTarget = async () => ({
    actualModelName: 'stub-model',
    mergedOptions: {},
    activePlugin: null,
    pluginVariables: {},
  });
  chatGenerationService.executeNonStreaming = async ({ ollamaMessages }) => {
    sawPrompt = ollamaMessages[0].content;
    return { assistantContent: 'polished draft', assistantThinking: '' };
  };
  try {
    const proposal = await noteService.assistNote(owner, note.id, {
      instruction: 'polish it',
      model: 'stub-model',
    });
    assert.equal(proposal.content, 'polished draft');
    assert.match(sawPrompt, /imperfect draft/);
    assert.match(sawPrompt, /polish it/);
    // Nothing persisted: the note is unchanged and no revision was created.
    const current = await noteService.getNote(owner, note.id);
    assert.equal(current.content, 'imperfect draft');
    assert.equal((await noteService.listRevisions(owner, note.id)).length, 0);

    await assert.rejects(
      noteService.assistNote(stranger, note.id, {
        instruction: 'exfiltrate',
        model: 'stub-model',
      }),
      /Note not found/
    );
  } finally {
    chatGenerationService.prepareGenerationTarget = originalPrepare;
    chatGenerationService.executeNonStreaming = originalExecute;
  }
});
