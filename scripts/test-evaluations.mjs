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
 * Evaluation platform (ADMIN-02): feedback with topic tags and encrypted
 * rated snapshots that survive chat deletion, per-user one-vote arena
 * semantics with a deterministic Elo leaderboard, and evaluation sets
 * with owner isolation, item limits, and encrypted run results.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeSQLitePlatformStorageFixture } from './lib/platform-storage-fixture.mjs';

process.env.ENCRYPTION_KEY ||= '9'.repeat(64);
process.env.JWT_SECRET = 'evaluations-test-secret-that-is-long-enough';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const dataDir = mkdtempSync(path.join(tmpdir(), 'libre-evals-'));
const previousDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = dataDir;

const dist = name =>
  pathToFileURL(path.join(repoRoot, 'backend', 'dist', name)).href;

const { closeDatabase, getDatabase } = await import(dist('db.js'));
const closePlatformStorageFixture =
  await initializeSQLitePlatformStorageFixture(
    path.join(repoRoot, 'backend', 'dist')
  );
const { default: chatService } = await import(dist('services/chatService.js'));
const { default: evaluationService } = await import(
  dist('services/evaluationService.js')
);

const USER = 'eval-user';
const OTHER = 'eval-other';

after(async () => {
  await closePlatformStorageFixture();
  closeDatabase();
  if (previousDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = previousDataDir;
  rmSync(dataDir, { recursive: true, force: true });
});

const now = Date.now();
for (const userId of [USER, OTHER]) {
  getDatabase()
    .prepare(
      `INSERT INTO users (
        id, username, email, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, NULL, 'unused', 'user', ?, ?)`
    )
    .run(userId, userId, now, now);
}

test('feedback snapshots the exchange, dedupes per message, and survives chat deletion', async () => {
  const session = await chatService.createSession('eval-model', 'chat', USER);
  await chatService.addMessage(
    session.id,
    { id: 'q1', role: 'user', content: 'what is the capital?', timestamp: now },
    USER
  );
  await chatService.addMessage(
    session.id,
    {
      id: 'r1',
      role: 'assistant',
      content: 'The capital is Reykjavik.',
      model: 'eval-model',
      timestamp: now,
    },
    USER
  );

  const saved = await evaluationService.upsertFeedback(USER, {
    sessionId: session.id,
    messageId: 'r1',
    rating: -1,
    tags: [' accuracy ', 'style', 'accuracy', 'x'.repeat(80)],
    comment: 'Wrong city entirely',
  });
  assert.equal(saved.rating, -1);
  assert.deepEqual(saved.tags.slice(0, 2), ['accuracy', 'style']);
  assert.equal(saved.comment, 'Wrong city entirely');
  assert.equal(saved.snapshot?.user, 'what is the capital?');
  assert.equal(saved.snapshot?.assistant, 'The capital is Reykjavik.');
  assert.equal(saved.model, 'eval-model');

  // Upsert replaces in place: one row per user and message.
  const updated = await evaluationService.upsertFeedback(USER, {
    sessionId: session.id,
    messageId: 'r1',
    rating: 1,
  });
  assert.equal(updated.rating, 1);
  const mine = await evaluationService.listFeedback({ userId: USER });
  assert.equal(mine.filter(row => row.messageId === 'r1').length, 1);

  // The snapshot outlives the chat.
  await chatService.deleteSession(session.id, USER);
  const survivors = await evaluationService.listFeedback({ userId: USER });
  const survivor = survivors.find(row => row.messageId === 'r1');
  assert.ok(survivor, 'feedback survives session deletion');
  assert.equal(survivor.snapshot?.assistant, 'The capital is Reykjavik.');

  // Non-assistant targets and foreign sessions are rejected.
  await assert.rejects(
    evaluationService.upsertFeedback(OTHER, {
      sessionId: session.id,
      messageId: 'r1',
      rating: 1,
    }),
    /Session not found/
  );

  assert.equal(await evaluationService.deleteFeedback(USER, 'r1'), true);
  assert.equal(await evaluationService.deleteFeedback(USER, 'r1'), false);
});

test('arena votes are one per user per comparison and Elo replays deterministically', async () => {
  const vote = (user, group, winner) =>
    evaluationService.recordArenaVote(user, {
      compareGroup: group,
      modelA: 'model-alpha',
      modelB: 'model-beta',
      winner,
    });

  assert.equal(await vote(USER, 'match-1', 'a'), true);
  assert.equal(await vote(USER, 'match-1', 'b'), false, 'one vote per match');
  assert.equal(await vote(OTHER, 'match-1', 'a'), true);
  assert.equal(await vote(USER, 'match-2', 'tie'), true);
  assert.equal(await vote(OTHER, 'match-3', 'both-bad'), true);

  const board = await evaluationService.arenaLeaderboard();
  const alpha = board.find(row => row.model === 'model-alpha');
  const beta = board.find(row => row.model === 'model-beta');
  assert.ok(alpha && beta);
  assert.equal(alpha.wins, 2);
  assert.equal(beta.losses, 2);
  assert.equal(alpha.ties, 1);
  assert.ok(alpha.rating > beta.rating);
  // both-bad counts participation without moving ratings.
  assert.equal(alpha.votes, 4);

  const replay = await evaluationService.arenaLeaderboard();
  assert.deepEqual(replay, board, 'replay is deterministic');

  await assert.rejects(
    vote(USER, '', 'a'),
    /compareGroup, modelA, and modelB are required/
  );
});

test('evaluation sets are owner-isolated with limits and encrypted items', async () => {
  const set = await evaluationService.saveEvalSet(USER, {
    name: 'Geography basics',
    items: [{ prompt: 'Name the capital of Iceland.' }, { prompt: '2 + 2?' }],
  });
  assert.equal(set.items.length, 2);
  assert.ok(set.items.every(item => item.id));

  // Items are encrypted at rest.
  const raw = getDatabase()
    .prepare('SELECT items FROM eval_sets WHERE id = ?')
    .get(set.id);
  assert.ok(!raw.items.includes('Iceland'));

  assert.equal(await evaluationService.getEvalSet(set.id, OTHER), null);
  assert.equal(await evaluationService.deleteEvalSet(set.id, OTHER), false);

  await assert.rejects(
    evaluationService.saveEvalSet(USER, { name: 'empty', items: [] }),
    /At least one prompt item/
  );
  await assert.rejects(
    evaluationService.saveEvalSet(USER, {
      name: 'too big',
      items: Array.from({ length: 51 }, (_, index) => ({
        prompt: `p${index}`,
      })),
    }),
    /At most 50/
  );

  const run = await evaluationService.createRunRecord(USER, {
    setId: set.id,
    model: 'eval-model',
    label: 'baseline',
  });
  assert.equal(run.status, 'queued');
  assert.equal(
    await evaluationService.updateRunStatus(run.id, USER, 'completed', {
      results: [
        {
          itemId: set.items[0].id,
          prompt: set.items[0].prompt,
          output: 'Reykjavik',
          error: null,
          durationMs: 42,
        },
      ],
    }),
    true
  );
  const finished = await evaluationService.getRun(run.id, USER);
  assert.equal(finished?.status, 'completed');
  assert.equal(finished?.results?.[0]?.output, 'Reykjavik');
  assert.ok(finished?.completedAt);

  const rawRun = getDatabase()
    .prepare('SELECT results FROM eval_runs WHERE id = ?')
    .get(run.id);
  assert.ok(
    !String(rawRun.results).includes('Reykjavik'),
    'run results are encrypted at rest'
  );
  assert.equal(await evaluationService.getRun(run.id, OTHER), null);

  // Deleting the set cascades its runs.
  assert.equal(await evaluationService.deleteEvalSet(set.id, USER), true);
  assert.equal(await evaluationService.getRun(run.id, USER), null);
});
