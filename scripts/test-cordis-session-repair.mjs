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
import { createHash, randomBytes } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { constants as zstdConstants, zstdCompressSync } from 'node:zlib';
import { Context } from '@deepseek-ai/cordis';
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import {
  planCordisSessionRepair,
  repairCordisSession,
  runRepairCommand,
} from './repair-cordis-sessions.mjs';

const root = await realpath(
  await mkdtemp(path.join(os.tmpdir(), 'libre-cordis-repair-'))
);
test.after(() => rm(root, { recursive: true, force: true }));
let counter = 100;
const rawMessage = (text = 'Original text must remain intact.') => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

async function fixture({
  corrupt = true,
  inbox = false,
  compressed = false,
  store = root,
  cwd,
  text,
} = {}) {
  const sessionId = `session-abcd1234-${counter++}`;
  const project = cwd
    ? `--${cwd
        .replace(/[\\/:]+/g, '-')
        .replace(/^-+/, '')
        .slice(0, 251)}--`
    : '_no-cwd';
  const directory = path.join(store, project, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path.join(directory, 'session.lock'), '', { mode: 0o600 });
  const header = sessionFormatCatalog.encodeCurrentHeader(
    {
      version: 3,
      id: sessionId,
      createdAt: 1,
      isSeeded: false,
      delegationDepth: 0,
      ...(cwd ? { cwd } : {}),
    },
    0
  );
  const user = {
    ...rawMessage(text),
    id: 'original-id',
    source: { kind: 'user' },
  };
  const events = [
    ...(inbox
      ? [
          {
            type: 'agent/inbox/spliced',
            data: { target: 'next-turn', start: 0, inserted: [user] },
          },
        ]
      : []),
    { type: 'turn/start', data: { turn: 1 } },
    ...(inbox
      ? [
          {
            type: 'agent/inbox/spliced',
            data: {
              target: 'next-turn',
              start: 0,
              removedCount: 1,
              inserted: [],
            },
          },
        ]
      : []),
    { type: 'user/message', data: user, surfaceOp: 'append' },
    {
      type: 'turn/end',
      data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
    },
  ].map((event, seq) =>
    sessionFormatCatalog.encodeCurrentEvent({ ...event, seq, time: seq + 1 })
  );
  if (corrupt) {
    events.find(event => event.type === 'user/message').data = rawMessage(text);
    events.at(-1).data.reason.reason = 'user';
    if (inbox) events[0].data.inserted = [rawMessage(text)];
  }
  const rows = [header, ...events];
  const original = compressed
    ? Buffer.concat(
        rows.map(row =>
          zstdCompressSync(`${JSON.stringify(row)}\n`, {
            params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 },
          })
        )
      )
    : Buffer.from(`${rows.map(row => JSON.stringify(row)).join('\n')}\n`);
  const filename = path.join(
    directory,
    `session.v3.jsonl${compressed ? '.zstd' : ''}`
  );
  await writeFile(filename, original, { mode: 0o600 });
  return { sessionId, directory, filename, original, rows, store };
}

test('default command is a dry run and does not change the store', async () => {
  const file = await fixture();
  const before = await readdir(file.directory);
  const [result] = await runRepairCommand([
    '--store',
    root,
    '--session',
    file.sessionId,
  ]);
  assert.equal(result.status, 'repairable');
  assert.equal(result.applied, false);
  assert.equal(result.changes.length, 2);
  assert.deepEqual(await readFile(file.filename), file.original);
  assert.deepEqual(await readdir(file.directory), before);
  assert.deepEqual(
    planCordisSessionRepair(file.original, file.sessionId).bytes,
    planCordisSessionRepair(file.original, file.sessionId).bytes
  );
});

test('apply creates a private exact backup and is idempotent', async () => {
  const file = await fixture({ inbox: true });
  const result = await repairCordisSession({
    store: root,
    sessionId: file.sessionId,
    apply: true,
  });
  assert.equal(result.applied, true);
  assert.deepEqual(await readFile(result.backup), file.original);
  assert.equal((await stat(result.backup)).mode & 0o777, 0o600);
  assert.equal((await stat(file.filename)).mode & 0o777, 0o600);
  const repaired = await readFile(file.filename);
  assert.equal(
    planCordisSessionRepair(repaired, file.sessionId).status,
    'valid'
  );
  const rows = repaired.toString().trim().split('\n').map(JSON.parse);
  const inserted = rows.find(row => row.type === 'agent/inbox/spliced').data
    .inserted[0];
  const delivered = rows.find(row => row.type === 'user/message').data;
  assert.equal(
    inserted.id,
    delivered.id,
    'inbox and delivered aliases share one deterministic identity'
  );
  assert.deepEqual(delivered.content, rawMessage().content);
  assert.deepEqual(rows.at(-1).data.reason, {
    kind: 'aborted',
    reason: { kind: 'user' },
  });
  const before = await readdir(file.directory);
  const repeated = await repairCordisSession({
    store: root,
    sessionId: file.sessionId,
    apply: true,
  });
  assert.equal(repeated.status, 'valid');
  assert.equal(repeated.applied, false);
  assert.deepEqual(await readFile(file.filename), repaired);
  assert.deepEqual(await readdir(file.directory), before);
});

test('valid sessions remain byte-for-byte unchanged even with apply', async () => {
  const file = await fixture({ corrupt: false });
  const result = await repairCordisSession({
    store: root,
    sessionId: file.sessionId,
    apply: true,
  });
  assert.equal(result.status, 'valid');
  assert.deepEqual(await readFile(file.filename), file.original);
  assert.deepEqual((await readdir(file.directory)).sort(), [
    'session.lock',
    'session.v3.jsonl',
  ]);
});

test('an interrupted repair can reuse only its matching private backup', async () => {
  const file = await fixture();
  const backup = path.join(
    file.directory,
    `repair-backup-${createHash('sha256').update(file.original).digest('hex')}.jsonl`
  );
  await writeFile(backup, 'unrelated data', { mode: 0o600 });
  await assert.rejects(
    repairCordisSession({
      store: root,
      sessionId: file.sessionId,
      apply: true,
    }),
    /backup does not match/
  );
  assert.deepEqual(await readFile(file.filename), file.original);
  await writeFile(backup, file.original);
  assert.equal(
    (
      await repairCordisSession({
        store: root,
        sessionId: file.sessionId,
        apply: true,
      })
    ).applied,
    true
  );
});

test('a legacy cancel cause alone can be repaired without changing message identity', async () => {
  const file = await fixture({ corrupt: false });
  file.rows.at(-1).data.reason.reason = 'user';
  const original = Buffer.from(
    `${file.rows.map(row => JSON.stringify(row)).join('\n')}\n`
  );
  const plan = planCordisSessionRepair(original, file.sessionId);
  assert.deepEqual(
    plan.changes.map(change => change.type),
    ['turn/end']
  );
  const rows = plan.bytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(
    rows.find(row => row.type === 'user/message').data.id,
    'original-id'
  );
});

test('a live native DSH writer lock prevents both planning and apply', async () => {
  const file = await fixture();
  const held = await open(path.join(file.directory, 'session.lock'), 'r+');
  try {
    await tryLockExclusive(held.fd);
    for (const apply of [false, true]) {
      await assert.rejects(
        repairCordisSession({ store: root, sessionId: file.sessionId, apply }),
        /owned by a running engine/
      );
    }
    assert.deepEqual(await readFile(file.filename), file.original);
  } finally {
    await held.close();
  }
});

test('unrecognized corruption rejects without backups or rewrites', async () => {
  const file = await fixture();
  file.rows.at(-1).seq += 9;
  const corrupt = Buffer.from(
    `${file.rows.map(row => JSON.stringify(row)).join('\n')}\n`
  );
  await writeFile(file.filename, corrupt);
  await assert.rejects(
    repairCordisSession({ store: root, sessionId: file.sessionId, apply: true })
  );
  assert.deepEqual(await readFile(file.filename), corrupt);
  assert.deepEqual((await readdir(file.directory)).sort(), [
    'session.lock',
    'session.v3.jsonl',
  ]);
});

test('torn records, mixed generations and linked files are refused', async () => {
  const torn = await fixture();
  await writeFile(torn.filename, torn.original.subarray(0, -1));
  await assert.rejects(
    repairCordisSession({ store: root, sessionId: torn.sessionId }),
    /torn final record/
  );
  const compressed = await fixture();
  await writeFile(
    path.join(compressed.directory, 'session.v3.jsonl.zstd'),
    'unsupported'
  );
  await assert.rejects(
    repairCordisSession({ store: root, sessionId: compressed.sessionId }),
    /mixed or historical/
  );
  const linked = await fixture();
  const external = path.join(root, 'external-original.jsonl');
  await writeFile(external, linked.original);
  await rm(linked.filename);
  await symlink(external, linked.filename);
  await assert.rejects(
    repairCordisSession({
      store: root,
      sessionId: linked.sessionId,
      apply: true,
    }),
    /linked or non-regular/
  );
  assert.deepEqual(await readFile(external), linked.original);
});

test('CLI requires exact distinct IDs and validates every target before applying', async () => {
  for (const args of [
    [],
    ['--store', root],
    ['--store', root, '--session', '*'],
    ['--store', root, '--session', '../escape'],
    ['--store', 'relative', '--session', 'session-abcd1234-1'],
  ]) {
    await assert.rejects(runRepairCommand(args));
  }
  const first = await fixture();
  await assert.rejects(
    runRepairCommand([
      '--store',
      root,
      '--session',
      first.sessionId,
      '--session',
      'session-abcd1234-0',
      '--apply',
    ]),
    /missing or ambiguous/
  );
  assert.deepEqual(await readFile(first.filename), first.original);
});

test('checksummed compressed repair preserves format and passes the real native persistence reader', async () => {
  const store = path.join(root, 'compressed-fixture');
  const file = await fixture({ compressed: true, inbox: true, store });
  const dryRun = await repairCordisSession({
    store,
    sessionId: file.sessionId,
  });
  assert.equal(dryRun.status, 'repairable');
  assert.equal(dryRun.compression, 'zstd');
  assert.deepEqual(await readFile(file.filename), file.original);
  const repaired = await repairCordisSession({
    store,
    sessionId: file.sessionId,
    apply: true,
  });
  assert.equal(repaired.applied, true);
  assert.ok(repaired.backup.endsWith('.zstd'));
  assert.deepEqual(await readFile(repaired.backup), file.original);
  assert.equal((await stat(repaired.backup)).mode & 0o777, 0o600);
  const ctx = new Context();
  await ctx.plugin(JsonlPersistence, { root: store, compression: 'zstd' });
  try {
    assert.ok(
      (await ctx.sessionPersistence.list()).some(
        entry => entry.header.id === file.sessionId
      ),
      'repaired sessions must remain discoverable in a fresh native catalog'
    );
    const handle = await ctx.sessionPersistence.open(file.sessionId, 'read');
    try {
      const { events } = await handle.read();
      const inserted = events.find(
        event => event.type === 'agent/inbox/spliced'
      ).data.inserted[0];
      const user = events.find(event => event.type === 'user/message').data;
      assert.equal(inserted.id, user.id);
      assert.deepEqual(user.content, rawMessage().content);
      assert.deepEqual(events.at(-1).data.reason, {
        kind: 'aborted',
        reason: { kind: 'user' },
      });
    } finally {
      await handle.close();
    }
  } finally {
    await ctx.fiber.dispose();
  }
  const bytes = await readFile(file.filename);
  assert.equal(
    (
      await repairCordisSession({
        store,
        sessionId: file.sessionId,
        apply: true,
      })
    ).status,
    'valid'
  );
  assert.deepEqual(await readFile(file.filename), bytes);
});

test('compressed checksums, truncation and malformed header framing fail closed', async () => {
  for (const variant of ['checksum', 'truncated', 'header']) {
    const store = path.join(root, `compressed-${variant}`);
    const file = await fixture({ compressed: true, store });
    const corrupted = Buffer.from(file.original);
    if (variant === 'checksum') corrupted[corrupted.length - 1] ^= 0xff;
    const input =
      variant === 'truncated'
        ? corrupted.subarray(0, -3)
        : variant === 'header'
          ? zstdCompressSync(
              `${file.rows.map(row => JSON.stringify(row)).join('\n')}\n`,
              { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } }
            )
          : corrupted;
    await writeFile(file.filename, input);
    await assert.rejects(
      repairCordisSession({ store, sessionId: file.sessionId, apply: true })
    );
    assert.deepEqual(await readFile(file.filename), input);
    assert.deepEqual((await readdir(file.directory)).sort(), [
      'session.lock',
      'session.v3.jsonl.zstd',
    ]);
  }
});

test('repaired long headers and large compressed bodies stay visible to native list', async () => {
  for (const [name, cwd, text] of [
    ['long-header', `/${'workspace'.repeat(45)}`, 'small body'],
    [
      'large-body',
      '/tmp/cordis-workspace',
      randomBytes(40_000).toString('hex'),
    ],
    ['both', `/${'workspace'.repeat(45)}`, randomBytes(40_000).toString('hex')],
  ]) {
    const store = path.join(root, name);
    const file = await fixture({
      compressed: true,
      inbox: true,
      store,
      cwd,
      text,
    });
    await repairCordisSession({
      store,
      sessionId: file.sessionId,
      apply: true,
    });
    const ctx = new Context();
    await ctx.plugin(JsonlPersistence, { root: store, compression: 'zstd' });
    try {
      assert.ok(
        (await ctx.sessionPersistence.list()).some(
          entry => entry.header.id === file.sessionId
        ),
        name
      );
      const handle = await ctx.sessionPersistence.open(file.sessionId, 'read');
      try {
        assert.equal(
          (await handle.read()).events.find(
            event => event.type === 'user/message'
          ).data.content[0].text,
          text
        );
      } finally {
        await handle.close();
      }
    } finally {
      await ctx.fiber.dispose();
    }
  }
});
