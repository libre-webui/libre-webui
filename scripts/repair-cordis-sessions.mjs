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

/** Offline repair of the two malformed record shapes emitted by the original Cordis bridge. */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  constants as zstdConstants,
  zstdCompressSync,
  zstdDecompressSync,
} from 'node:zlib';
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';

const CURRENT_LOG = 'session.v3.jsonl';
const MAX_LOG_BYTES = 128 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');

/** Split complete native frames before decompression; never recover a torn tail. */
function zstdFrames(bytes) {
  const frames = [];
  let cursor = 0;
  const requireBytes = count => {
    if (cursor + count > bytes.length)
      throw new Error('Truncated Zstandard session frame.');
  };
  while (cursor < bytes.length) {
    const start = cursor;
    requireBytes(5);
    if (bytes.readUInt32LE(cursor) !== 0xfd2fb528)
      throw new Error('Invalid Zstandard session frame magic.');
    cursor += 4;
    const descriptor = bytes[cursor++];
    if (descriptor & 0x18)
      throw new Error('Invalid Zstandard frame header flags.');
    const singleSegment = Boolean(descriptor & 0x20);
    const contentSizeFlag = descriptor >>> 6;
    const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
    const contentSizeBytes =
      contentSizeFlag === 0
        ? singleSegment
          ? 1
          : 0
        : [0, 2, 4, 8][contentSizeFlag];
    const headerBytes =
      (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    requireBytes(headerBytes);
    cursor += headerBytes;
    let last = false;
    while (!last) {
      requireBytes(3);
      const block = bytes.readUIntLE(cursor, 3);
      cursor += 3;
      last = Boolean(block & 1);
      const kind = (block >>> 1) & 3;
      if (kind === 3) throw new Error('Invalid Zstandard block type.');
      const size = kind === 1 ? 1 : block >>> 3;
      requireBytes(size);
      cursor += size;
    }
    if (!(descriptor & 4))
      throw new Error(
        'Native session repair requires checksummed Zstandard frames.'
      );
    requireBytes(4);
    cursor += 4;
    frames.push(bytes.subarray(start, cursor));
  }
  if (!frames.length) throw new Error('Empty Zstandard session log.');
  return frames;
}

function decodeStored(bytes, compressed) {
  if (bytes.length > MAX_LOG_BYTES)
    throw new Error('Session exceeds the offline repair size limit.');
  if (!compressed) return bytes;
  const parts = [];
  let total = 0;
  for (const frame of zstdFrames(bytes)) {
    const part = zstdDecompressSync(frame, {
      maxOutputLength: Math.max(1, MAX_LOG_BYTES - total),
    });
    total += part.length;
    if (total > MAX_LOG_BYTES)
      throw new Error(
        'Expanded session exceeds the offline repair size limit.'
      );
    if (
      !parts.length &&
      (part.length === 0 || part.indexOf(10) !== part.length - 1)
    )
      throw new Error(
        'Zstandard first frame must contain exactly one header line.'
      );
    parts.push(part);
  }
  return Buffer.concat(parts, total);
}

function encodeStored(bytes, compressed) {
  if (!compressed) return bytes;
  const boundary = bytes.indexOf(10) + 1;
  const options = { params: { [zstdConstants.ZSTD_c_checksumFlag]: 1 } };
  return Buffer.concat([
    zstdCompressSync(bytes.subarray(0, boundary), options),
    ...(boundary < bytes.length
      ? [zstdCompressSync(bytes.subarray(boundary), options)]
      : []),
  ]);
}

function legacyMessage(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'content,role' &&
    value.role === 'user' &&
    Array.isArray(value.content) &&
    value.content.every(
      block =>
        block &&
        typeof block === 'object' &&
        Object.keys(block).sort().join(',') === 'text,type' &&
        block.type === 'text' &&
        typeof block.text === 'string'
    )
  );
}

function validateRows(rows, sessionId) {
  if (rows[0]?.version !== 3 || sessionFormatCatalog.currentVersion !== 3) {
    throw new Error('Repair supports the pinned plaintext v3 format only.');
  }
  if (rows[0]?.id !== sessionId)
    throw new Error(
      'Session header identity does not match the requested session.'
    );
  const restore = sessionFormatCatalog.createRestore(rows[0], {
    recovery: 'strict',
    validation: 'current',
  });
  rows.slice(1).forEach(row => restore.decodeRow(row));
  return restore.finish();
}

/** Pure repair planner. Native codecs must accept the complete candidate before it is offered. */
export function planCordisSessionRepair(bytes, sessionId) {
  if (bytes.length > MAX_LOG_BYTES)
    throw new Error('Session exceeds the offline repair size limit.');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!text.endsWith('\n'))
    throw new Error('Refusing a session with a torn final record.');
  const lines = text.slice(0, -1).split('\n');
  const rows = lines.map(line => JSON.parse(line));
  if (rows[0]?.version !== 3 || rows[0]?.id !== sessionId)
    throw new Error('Repair requires a matching current v3 session header.');
  const hasLegacy = rows.some(
    row =>
      (row.type === 'user/message' && legacyMessage(row.data)) ||
      (row.type === 'agent/inbox/spliced' &&
        Array.isArray(row.data?.inserted) &&
        row.data.inserted.some(legacyMessage)) ||
      (row.type === 'turn/end' &&
        row.data?.reason?.kind === 'aborted' &&
        row.data.reason.reason === 'user')
  );
  if (!hasLegacy) {
    validateRows(rows, sessionId);
    return { status: 'valid', changes: [], bytes };
  }
  const changes = [];
  const inboxes = { 'next-turn': [], 'next-step': [] };
  const claimed = [];
  const messageKey = message =>
    JSON.stringify({ role: message.role, content: message.content });
  const identified = (message, seq, index) => ({
    ...message,
    id: `libre-cordis-repair-${digest(JSON.stringify([sessionId, seq, index])).slice(0, 32)}`,
    source: { kind: 'user' },
  });

  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    let changed = false;
    if (row.type === 'agent/inbox/spliced') {
      const data = row.data;
      const inbox = inboxes[data?.target];
      const count = data?.removedCount ?? 0;
      if (
        !inbox ||
        !Number.isSafeInteger(data.start) ||
        data.start < 0 ||
        data.start > inbox.length ||
        !Number.isSafeInteger(count) ||
        count < 0 ||
        data.start + count > inbox.length ||
        !Array.isArray(data.inserted)
      ) {
        throw new Error(`Refusing an invalid inbox splice at seq ${row.seq}.`);
      }
      data.inserted = data.inserted.map((message, position) => {
        if (!legacyMessage(message)) return message;
        changed = true;
        return identified(message, row.seq, position);
      });
      const removed = inbox.splice(data.start, count, ...data.inserted);
      if (data.outcome !== 'canceled') claimed.push(...removed);
    } else if (row.type === 'user/message' && legacyMessage(row.data)) {
      const candidate = claimed.findIndex(
        message => messageKey(message) === messageKey(row.data)
      );
      row.data =
        candidate < 0
          ? identified(row.data, row.seq, 0)
          : claimed.splice(candidate, 1)[0];
      changed = true;
    } else if (row.type === 'user/message') {
      const candidate = claimed.findIndex(
        message => message.id === row.data?.id
      );
      if (candidate >= 0) claimed.splice(candidate, 1);
    } else if (
      row.type === 'turn/end' &&
      row.data?.reason?.kind === 'aborted' &&
      row.data.reason.reason === 'user' &&
      Object.keys(row.data.reason).sort().join(',') === 'kind,reason'
    ) {
      row.data.reason.reason = { kind: 'user' };
      changed = true;
    }
    if (changed) {
      changes.push({ seq: row.seq, type: row.type });
      lines[index] = JSON.stringify(row);
    }
  }
  if (!changes.length)
    throw new Error('No recognized legacy Cordis corruption was found.');
  validateRows(rows, sessionId);
  return {
    status: 'repairable',
    changes,
    bytes: Buffer.from(`${lines.join('\n')}\n`),
  };
}

async function physicalDirectory(directory) {
  const absolute = path.resolve(directory);
  const info = await lstat(absolute);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (await realpath(absolute)) !== absolute
  ) {
    throw new Error('Refusing a linked or non-directory session path.');
  }
  return absolute;
}

async function regularHandle(filename, flags) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error('Refusing a linked or non-regular session artifact.');
  const handle = await open(filename, flags | constants.O_NOFOLLOW);
  const opened = await handle.stat();
  if (opened.ino !== info.ino || opened.dev !== info.dev) {
    await handle.close();
    throw new Error('Session artifact changed while opening it.');
  }
  return handle;
}

async function findSessionDirectory(root, sessionId) {
  // Bridge-generated IDs are safe physical segments; arbitrary harness IDs
  // need its private path codec and are deliberately outside this repair.
  if (!/^session-[a-f0-9]{8}-\d+$/.test(sessionId))
    throw new Error(
      'Supply an exact session ID created by the original Libre WebUI bridge.'
    );
  const matches = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink())
      throw new Error(
        'Refusing a session store containing linked project directories.'
      );
    if (!entry.isDirectory()) continue;
    const parent = await physicalDirectory(path.join(root, entry.name));
    const directory = path.join(parent, sessionId);
    const info = await lstat(directory).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (info) matches.push(await physicalDirectory(directory));
  }
  if (matches.length !== 1)
    throw new Error('Requested session is missing or ambiguous in this store.');
  return matches[0];
}

/** Acquire the same native writer lock as DSH, then plan or apply one offline repair. */
export async function repairCordisSession({ store, sessionId, apply = false }) {
  const root = await physicalDirectory(store);
  const directory = await findSessionDirectory(root, sessionId);
  const entries = await readdir(directory);
  const generations = entries.filter(name =>
    /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(name)
  );
  if (
    generations.length !== 1 ||
    ![CURRENT_LOG, `${CURRENT_LOG}.zstd`].includes(generations[0])
  ) {
    throw new Error(
      'Repair requires one current v3 generation; mixed or historical stores are unsupported.'
    );
  }
  const compressed = generations[0].endsWith('.zstd');
  // Existing materialized DSH logs already have this file. Dry runs never
  // create a lock file, backup, temporary file, or replacement artifact.
  const lockPath = path.join(directory, 'session.lock');
  const lock = await regularHandle(lockPath, constants.O_RDWR);
  try {
    try {
      await tryLockExclusive(lock.fd);
    } catch (error) {
      if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK')
        throw new Error(
          'Session is owned by a running engine. Stop the engine before repair.'
        );
      throw error;
    }
    const lockInfo = await lock.stat();
    const currentLock = await lstat(lockPath);
    if (lockInfo.ino !== currentLock.ino || lockInfo.dev !== currentLock.dev)
      throw new Error('Session lock changed while acquiring ownership.');
    const filename = path.join(directory, generations[0]);
    const file = await regularHandle(filename, constants.O_RDONLY);
    let original;
    try {
      if ((await file.stat()).size > MAX_LOG_BYTES)
        throw new Error('Session exceeds the offline repair size limit.');
      original = await file.readFile();
    } finally {
      await file.close();
    }
    const plan = planCordisSessionRepair(
      decodeStored(original, compressed),
      sessionId
    );
    const report = {
      sessionId,
      status: plan.status,
      changes: plan.changes,
      applied: false,
      compression: compressed ? 'zstd' : 'none',
    };
    if (!apply || plan.status === 'valid') return report;
    const repaired = encodeStored(plan.bytes, compressed);
    if (!decodeStored(repaired, compressed).equals(plan.bytes))
      throw new Error('Encoded repair did not round-trip.');
    const backup = path.join(
      directory,
      `repair-backup-${digest(original)}.jsonl${compressed ? '.zstd' : ''}`
    );
    let saved;
    try {
      saved = await open(
        backup,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A previous attempt may have stopped after its durable backup and
      // before replacement. Reuse only the identical, private regular file.
      const existing = await regularHandle(backup, constants.O_RDONLY);
      try {
        if (
          ((await existing.stat()).mode & 0o777) !== 0o600 ||
          !(await existing.readFile()).equals(original)
        ) {
          throw new Error(
            'An existing repair backup does not match the original.'
          );
        }
      } finally {
        await existing.close();
      }
    }
    if (saved) {
      try {
        await saved.writeFile(original);
        await saved.sync();
      } finally {
        await saved.close();
      }
    }
    const temporary = path.join(directory, `.repair-${randomUUID()}.tmp`);
    try {
      const replacement = await open(
        temporary,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600
      );
      try {
        await replacement.writeFile(repaired);
        await replacement.sync();
      } finally {
        await replacement.close();
      }
      const unchanged = await regularHandle(filename, constants.O_RDONLY);
      try {
        if (!(await unchanged.readFile()).equals(original))
          throw new Error('Session changed after the repair was planned.');
      } finally {
        await unchanged.close();
      }
      await rename(temporary, filename);
      const installed = await regularHandle(filename, constants.O_RDONLY);
      try {
        const bytes = await installed.readFile();
        if (
          !bytes.equals(repaired) ||
          planCordisSessionRepair(decodeStored(bytes, compressed), sessionId)
            .status !== 'valid'
        )
          throw new Error('Installed repair did not verify.');
      } finally {
        await installed.close();
      }
      const folder = await open(directory, constants.O_RDONLY);
      try {
        await folder.sync();
      } finally {
        await folder.close();
      }
      return { ...report, applied: true, backup };
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await lock.close();
  }
}

export async function runRepairCommand(args) {
  let store;
  let apply = false;
  const sessions = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === '--store' && args[index + 1] && !store) store = args[++index];
    else if (value === '--session' && args[index + 1])
      sessions.push(args[++index]);
    else if (value === '--apply' && !apply) apply = true;
    else
      throw new Error(
        'Usage: node scripts/repair-cordis-sessions.mjs --store /absolute/store --session exact-id [--session exact-id] [--apply]'
      );
  }
  if (
    !store ||
    !path.isAbsolute(store) ||
    !sessions.length ||
    new Set(sessions).size !== sessions.length
  ) {
    throw new Error(
      'An absolute --store and one or more distinct exact --session IDs are required.'
    );
  }
  // Validate every requested candidate before starting any mutation.
  const plans = [];
  for (const sessionId of sessions)
    plans.push(await repairCordisSession({ store, sessionId }));
  if (!apply) return plans;
  const results = [];
  for (const sessionId of sessions)
    results.push(await repairCordisSession({ store, sessionId, apply: true }));
  return results;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    console.log(
      JSON.stringify(await runRepairCommand(process.argv.slice(2)), null, 2)
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
