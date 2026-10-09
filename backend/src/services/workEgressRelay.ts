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

/**
 * Carries a sandbox's proxy connections to the backend over one exec
 * channel, so the egress proxy needs no listening port and works the same
 * on Docker Desktop, a Linux host, a containerized backend, or Kubernetes.
 *
 * Inside the sandbox, RELAY_SCRIPT listens on 127.0.0.1 and turns each TCP
 * connection into frames on its stdout; frames on its stdin go back to the
 * matching connection. On the backend, RelayMultiplexer does the reverse
 * and hands every connection to the egress proxy as a duplex stream.
 *
 * Frame: type (1 byte) | connection id (uint32 BE) | length (uint32 BE) |
 * payload. Everything a sandbox sends is untrusted: frames are size-capped
 * and a malformed stream closes the whole relay rather than throwing.
 */

import { EventEmitter } from 'node:events';
import { Duplex, type Readable, type Writable } from 'node:stream';

export const RELAY_FRAME_READY = 1;
export const RELAY_FRAME_OPEN = 2;
export const RELAY_FRAME_DATA = 3;
export const RELAY_FRAME_END = 4;
export const RELAY_FRAME_CLOSE = 5;

const HEADER_BYTES = 9;
/** Payload chunk size written per frame. */
const CHUNK_BYTES = 64 * 1024;
/** Hard cap on a received frame; the relay never sends more than a chunk. */
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CONNECTIONS = 128;
const READY_TIMEOUT_MS = 20_000;

/**
 * The sandbox side. Plain CommonJS so any Node 18+ can run it with `-e`.
 * It exits when its stdin closes, which is how the backend stops it.
 */
export const RELAY_SCRIPT = String.raw`'use strict';
const net = require('net');
const H = 9, READY = 1, OPEN = 2, DATA = 3, END = 4, CLOSE = 5;
const CHUNK = 65536, MAX = 1048576;
const sockets = new Map();
const waiting = new Set();
let nextId = 1;
let pending = Buffer.alloc(0);
function send(type, id, payload) {
  const body = payload || Buffer.alloc(0);
  const head = Buffer.alloc(H);
  head[0] = type;
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(body.length, 5);
  return process.stdout.write(body.length ? Buffer.concat([head, body]) : head);
}
process.stdout.on('drain', () => {
  for (const socket of waiting) socket.resume();
  waiting.clear();
});
process.stdout.on('error', () => process.exit(0));
const server = net.createServer(socket => {
  const id = nextId++;
  sockets.set(id, socket);
  send(OPEN, id);
  socket.on('data', chunk => {
    for (let offset = 0; offset < chunk.length; offset += CHUNK) {
      if (!send(DATA, id, chunk.subarray(offset, offset + CHUNK))) {
        socket.pause();
        waiting.add(socket);
      }
    }
  });
  socket.on('end', () => { if (sockets.has(id)) send(END, id); });
  socket.on('close', () => { if (sockets.delete(id)) send(CLOSE, id); });
  socket.on('error', () => {});
});
server.on('error', () => process.exit(2));
server.listen(0, '127.0.0.1', () => {
  send(READY, 0, Buffer.from(JSON.stringify({ port: server.address().port })));
});
process.stdin.on('data', chunk => {
  pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
  while (pending.length >= H) {
    const type = pending[0];
    const id = pending.readUInt32BE(1);
    const length = pending.readUInt32BE(5);
    if (length > MAX) process.exit(3);
    if (pending.length < H + length) break;
    const payload = pending.subarray(H, H + length);
    pending = pending.subarray(H + length);
    const socket = sockets.get(id);
    if (!socket) continue;
    if (type === DATA) {
      if (!socket.write(payload)) {
        process.stdin.pause();
        socket.once('drain', () => process.stdin.resume());
      }
    } else if (type === END) {
      socket.end();
    } else if (type === CLOSE) {
      sockets.delete(id);
      socket.destroy();
    }
  }
});
const stop = () => {
  server.close();
  for (const socket of sockets.values()) socket.destroy();
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
`;

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const body = payload ?? Buffer.alloc(0);
  const head = Buffer.alloc(HEADER_BYTES);
  head[0] = type;
  head.writeUInt32BE(id, 1);
  head.writeUInt32BE(body.length, 5);
  return body.length > 0 ? Buffer.concat([head, body]) : head;
}

/** One relayed connection, seen by the proxy as an ordinary socket. */
export class RelayStream extends Duplex {
  remoteClosed = false;
  readonly remoteAddress = '127.0.0.1';
  readonly remotePort = 0;

  constructor(
    readonly id: number,
    private readonly relay: RelayMultiplexer
  ) {
    super({ allowHalfOpen: true });
  }

  // net.Socket surface that HTTP servers call on their connections.
  setTimeout(_ms: number, callback?: () => void): this {
    if (callback) this.once('timeout', callback);
    return this;
  }

  setNoDelay(): this {
    return this;
  }

  setKeepAlive(): this {
    return this;
  }

  override _read(): void {
    this.relay.resumeFor(this);
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.relay.sendData(this.id, chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.relay.sendControl(RELAY_FRAME_END, this.id);
    callback();
  }

  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void
  ): void {
    this.relay.forget(this);
    if (!this.remoteClosed) this.relay.sendControl(RELAY_FRAME_CLOSE, this.id);
    callback(error);
  }
}

/**
 * The backend side of one sandbox relay. Emits `connection` for every
 * stream the sandbox opens and `close` once the channel is gone.
 */
export class RelayMultiplexer extends EventEmitter {
  private readonly streams = new Map<number, RelayStream>();
  private readonly paused = new Set<RelayStream>();
  private buffered: Buffer = Buffer.alloc(0);
  private closed = false;
  readonly ready: Promise<number>;
  private resolveReady!: (port: number) => void;
  private rejectReady!: (error: Error) => void;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable
  ) {
    super();
    this.ready = new Promise<number>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Callers may never await `ready`; a failure is also reported as close.
    this.ready.catch(() => undefined);
    const readyTimer = setTimeout(
      () => this.fail(new Error('The sandbox egress relay did not start.')),
      READY_TIMEOUT_MS
    );
    readyTimer.unref?.();
    void this.ready.then(
      () => clearTimeout(readyTimer),
      () => clearTimeout(readyTimer)
    );
    input.on('data', (chunk: Buffer) => this.receive(chunk));
    input.on('error', error => this.fail(error));
    input.on('close', () =>
      this.fail(new Error('The sandbox egress relay stopped.'))
    );
    output.on('error', error => this.fail(error));
  }

  /** Stop the relay: the sandbox side exits when its stdin ends. */
  close(): void {
    this.fail(new Error('The sandbox egress relay was closed.'));
  }

  sendData(
    id: number,
    chunk: Buffer,
    callback: (error?: Error | null) => void
  ): void {
    if (this.closed) {
      callback(new Error('The sandbox egress relay is closed.'));
      return;
    }
    let flushed = true;
    for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
      flushed = this.output.write(
        frame(
          RELAY_FRAME_DATA,
          id,
          chunk.subarray(offset, offset + CHUNK_BYTES)
        )
      );
    }
    if (flushed) {
      callback();
      return;
    }
    this.output.once('drain', () => callback());
  }

  sendControl(type: number, id: number): void {
    if (this.closed) return;
    this.output.write(frame(type, id));
  }

  forget(stream: RelayStream): void {
    this.streams.delete(stream.id);
    this.paused.delete(stream);
    if (this.paused.size === 0) this.input.resume();
  }

  resumeFor(stream: RelayStream): void {
    if (!this.paused.delete(stream)) return;
    if (this.paused.size === 0 && !this.closed) this.input.resume();
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffered =
      this.buffered.length > 0 ? Buffer.concat([this.buffered, chunk]) : chunk;
    while (this.buffered.length >= HEADER_BYTES) {
      const type = this.buffered[0];
      const id = this.buffered.readUInt32BE(1);
      const length = this.buffered.readUInt32BE(5);
      if (length > MAX_FRAME_BYTES) {
        this.fail(
          new Error('The sandbox egress relay sent an oversized frame.')
        );
        return;
      }
      if (this.buffered.length < HEADER_BYTES + length) return;
      const payload = this.buffered.subarray(
        HEADER_BYTES,
        HEADER_BYTES + length
      );
      this.buffered = this.buffered.subarray(HEADER_BYTES + length);
      this.dispatch(type, id, payload);
      if (this.closed) return;
    }
  }

  private dispatch(type: number, id: number, payload: Buffer): void {
    if (type === RELAY_FRAME_READY) {
      let port: unknown;
      try {
        port = (JSON.parse(payload.toString('utf8')) as { port?: unknown })
          .port;
      } catch {
        port = undefined;
      }
      if (typeof port === 'number' && Number.isInteger(port) && port > 0) {
        this.resolveReady(port);
      } else {
        this.fail(new Error('The sandbox egress relay reported no port.'));
      }
      return;
    }
    if (type === RELAY_FRAME_OPEN) {
      if (this.streams.has(id) || this.streams.size >= MAX_CONNECTIONS) {
        this.sendControl(RELAY_FRAME_CLOSE, id);
        return;
      }
      const stream = new RelayStream(id, this);
      this.streams.set(id, stream);
      this.emit('connection', stream);
      return;
    }
    const stream = this.streams.get(id);
    if (!stream) return;
    if (type === RELAY_FRAME_DATA) {
      if (!stream.push(payload)) {
        this.paused.add(stream);
        this.input.pause();
      }
    } else if (type === RELAY_FRAME_END) {
      stream.push(null);
    } else if (type === RELAY_FRAME_CLOSE) {
      stream.remoteClosed = true;
      stream.destroy();
    }
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectReady(error);
    for (const stream of this.streams.values()) {
      stream.remoteClosed = true;
      stream.destroy();
    }
    this.streams.clear();
    this.paused.clear();
    this.output.end();
    this.emit('close', error);
  }
}
