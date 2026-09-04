import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const { createCloseCodeSanitizer, isReservedCloseCode } = await import(
  pathToFileURL(path.resolve('backend/dist/utils/websocketCloseCodes.js')).href
);

// Unmasked server-to-client frame with the given opcode and payload.
const frame = (opcode, payload) => {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length < 65_536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
};
const closeFrame = (code, reason = '') => {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return frame(0x8, body);
};

const run = async chunks => {
  const sanitizer = createCloseCodeSanitizer();
  const out = [];
  sanitizer.on('data', chunk => out.push(chunk));
  for (const chunk of chunks) sanitizer.write(chunk);
  sanitizer.end();
  await new Promise(resolve => sanitizer.on('end', resolve));
  return Buffer.concat(out);
};

test('reserved codes are recognised and legal ones are not', () => {
  for (const code of [999, 1004, 1005, 1006, 1015, 1016, 2999]) {
    assert.ok(isReservedCloseCode(code), String(code));
  }
  for (const code of [1000, 1001, 1002, 1003, 1011, 3000, 4000, 4999]) {
    assert.ok(!isReservedCloseCode(code), String(code));
  }
});

test('a close frame with a reserved code is rewritten to 1011, reason kept', async () => {
  const out = await run([closeFrame(1006, 'target closed')]);
  const expected = closeFrame(1011, 'target closed');
  assert.deepEqual(out, expected);
});

test('legal close frames and every other frame pass through unchanged', async () => {
  const input = Buffer.concat([
    frame(0x2, Buffer.alloc(300, 7)), // binary, 16-bit length
    frame(0x1, 'hello'),
    frame(0x9, ''), // ping
    frame(0x2, Buffer.alloc(70_000, 3)), // binary, 64-bit length
    closeFrame(1000, 'bye'),
  ]);
  const out = await run([input]);
  assert.deepEqual(out, input);
});

test('frames split across TCP chunks, even mid-code, are still rewritten', async () => {
  const stream = Buffer.concat([
    frame(0x2, Buffer.alloc(50, 1)),
    closeFrame(1005, 'no status'),
  ]);
  const expected = Buffer.concat([
    frame(0x2, Buffer.alloc(50, 1)),
    closeFrame(1011, 'no status'),
  ]);
  // Split at every possible point and stitch the pieces two at a time.
  for (let split = 1; split < stream.length; split += 1) {
    const out = await run([stream.subarray(0, split), stream.subarray(split)]);
    assert.deepEqual(out, expected, `split at ${split}`);
  }
  // Byte-at-a-time.
  const bytes = [...stream].map(byte => Buffer.from([byte]));
  assert.deepEqual(await run(bytes), expected);
});

test('a masked (client-style) frame is passed through with its mask intact', async () => {
  const masked = Buffer.from([
    0x81, 0x85, 1, 2, 3, 4, 0x68, 0x67, 0x6f, 0x68, 0x6e,
  ]);
  assert.deepEqual(await run([masked]), masked);
});
