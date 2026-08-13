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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  batchTextForTTS,
  createTTSPlaybackSession,
  getTTSAudioUnlockState,
  isTTSPlaybackBlocked,
  splitTTSSentences,
  splitTTSSentencesFallback,
  unlockTTSAudioPlayback,
  type TTSAudioBufferSource,
  type TTSAudioContext,
  type TTSDecodedAudio,
  type TTSHTMLAudioElement,
} from './ttsBatching';

const nextTurn = (): Promise<void> =>
  new Promise(resolve => setImmediate(resolve));

const waitFor = async (predicate: () => boolean): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await nextTurn();
  }
  throw new Error('Timed out waiting for test condition');
};

test('fallback sentence splitting preserves punctuation and skips false stops', () => {
  const input = 'Dr. Rivera measured 3.14 meters. “Really?” Yes! 最後です。';

  assert.deepEqual(splitTTSSentencesFallback(input), [
    'Dr. Rivera measured 3.14 meters.',
    '“Really?”',
    'Yes!',
    '最後です。',
  ]);
});

test('sentence splitting uses an injected segmenter and safely falls back', () => {
  let received = '';
  const segmented = splitTTSSentences('Alpha. Beta.', {
    segmenter: {
      segment(input) {
        received = input;
        return [{ segment: 'Alpha. ' }, { segment: 'Beta.' }];
      },
    },
  });

  assert.equal(received, 'Alpha. Beta.');
  assert.deepEqual(segmented, ['Alpha.', 'Beta.']);
  assert.deepEqual(splitTTSSentences('One. Two?', { segmenter: false }), [
    'One.',
    'Two?',
  ]);
});

test('batch packing respects the hard limit, order, and avoids a tiny tail', () => {
  const input = [
    'The first sentence contains enough words to sound natural.',
    'The second sentence should become another useful speech unit.',
    'This deliberately oversized sentence contains many clauses, with natural phrase boundaries, so the hard maximum is enforced without losing any punctuation or changing the spoken order.',
    'Brief ending.',
  ].join(' ');
  const batches = batchTextForTTS(input, {
    targetChars: 72,
    maxChars: 90,
    minChars: 24,
    segmenter: false,
  });

  assert.ok(batches.length > 2);
  assert.ok(batches.every(batch => batch.length <= 90));
  assert.ok(batches.slice(1).every(batch => batch.length >= 24));
  assert.equal(batches.join(' '), input);
  assert.ok(batches.some(batch => batch.includes(',')));
  assert.ok(batches[batches.length - 1]?.endsWith('Brief ending.'));
});

interface FakeDecodedAudio extends TTSDecodedAudio {
  id: number;
}

class FakeSource implements TTSAudioBufferSource {
  buffer: FakeDecodedAudio | null = null;
  onended: (() => void) | null = null;

  constructor(
    private readonly starts: Array<{ id: number; when: number }>,
    private readonly stops: number[]
  ) {}

  connect(): void {}

  disconnect(): void {}

  start(when = 0): void {
    if (!this.buffer) throw new Error('Missing fake audio buffer');
    this.starts.push({ id: this.buffer.id, when });
    queueMicrotask(() => this.onended?.());
  }

  stop(): void {
    if (this.buffer) this.stops.push(this.buffer.id);
  }
}

class FakeAudioContext implements TTSAudioContext {
  readonly currentTime = 10;
  readonly destination = {};
  state = 'running';
  readonly starts: Array<{ id: number; when: number }> = [];
  readonly stops: number[] = [];
  closed = false;
  resumeCalls = 0;
  resumeFailure: Error | undefined;

  createBufferSource(): TTSAudioBufferSource {
    return new FakeSource(this.starts, this.stops);
  }

  async decodeAudioData(data: ArrayBuffer): Promise<FakeDecodedAudio> {
    return {
      id: Number(new TextDecoder().decode(data)),
      duration: 0.25,
    };
  }

  async resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeFailure) throw this.resumeFailure;
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

interface Deferred {
  promise: Promise<Blob>;
  resolve(blob: Blob): void;
}

const deferredBlob = (): Deferred => {
  let resolvePromise: ((blob: Blob) => void) | undefined;
  const promise = new Promise<Blob>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(blob) {
      resolvePromise?.(blob);
    },
  };
};

test('generation is bounded to three while playback stays ordered and buffered', async () => {
  const batches = ['zero', 'one', 'two', 'three', 'four'];
  const pending = new Map<number, Deferred>();
  const started: number[] = [];
  const completed: number[] = [];
  let active = 0;
  let maximumActive = 0;
  const context = new FakeAudioContext();
  const lifecycle: string[] = [];
  const states: string[] = [];

  const session = createTTSPlaybackSession({
    concurrency: 99,
    initialBufferSize: 2,
    scheduleLeadSeconds: 0,
    audioContextFactory: () => context,
    generate: (_text, { index }) => {
      const deferred = deferredBlob();
      pending.set(index, deferred);
      started.push(index);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return deferred.promise.then(blob => {
        active -= 1;
        completed.push(index);
        return blob;
      });
    },
    onStart: () => lifecycle.push('start'),
    onEnd: () => lifecycle.push('end'),
    onError: () => lifecycle.push('error'),
    onStateChange: state => states.push(state),
  });

  const playback = session.play(batches);
  await waitFor(() => pending.size === 3);
  assert.equal(maximumActive, 3);

  pending.get(2)?.resolve(new Blob(['2']));
  await nextTurn();
  assert.deepEqual(started, [0, 1, 2]);

  // Finishing a later batch does not start more provider work until the
  // ordered consumer advances the bounded look-ahead window.
  pending.get(0)?.resolve(new Blob(['0']));
  await waitFor(() => pending.has(3));
  pending.get(3)?.resolve(new Blob(['3']));
  await nextTurn();

  // The second ordered result still gates playback and the final generation.
  assert.equal(context.starts.length, 0);
  pending.get(1)?.resolve(new Blob(['1']));
  await waitFor(() => pending.has(4));
  pending.get(4)?.resolve(new Blob(['4']));

  await playback;

  assert.deepEqual(completed, [2, 0, 3, 1, 4]);
  assert.deepEqual(
    context.starts.map(item => item.id),
    [0, 1, 2, 3, 4]
  );
  assert.deepEqual(
    context.starts.map(item => item.when),
    [10, 10.25, 10.5, 10.75, 11]
  );
  assert.deepEqual(lifecycle, ['start', 'end']);
  assert.deepEqual(states, [
    'loading',
    'generating',
    'buffering',
    'playing',
    'ended',
  ]);
  assert.equal(context.closed, true);
  assert.equal(session.state, 'ended');
});

test('a suspended context that rejects resume is blocked before generation', async () => {
  const context = new FakeAudioContext();
  context.state = 'suspended';
  context.resumeFailure = Object.assign(
    new Error('Playback requires user activation'),
    { name: 'NotAllowedError' }
  );
  const states: string[] = [];
  let generateCalls = 0;
  let blockedCalls = 0;
  let errorCalls = 0;

  const session = createTTSPlaybackSession({
    audioContextFactory: () => context,
    generate: async () => {
      generateCalls += 1;
      return new Blob(['audio']);
    },
    onStateChange: state => states.push(state),
    onBlocked: () => {
      blockedCalls += 1;
    },
    onError: () => {
      errorCalls += 1;
    },
  });

  await assert.rejects(session.play(['one', 'two']), error => {
    assert.equal(isTTSPlaybackBlocked(error), true);
    return true;
  });

  assert.deepEqual(states, ['loading', 'blocked']);
  assert.equal(context.resumeCalls, 1);
  assert.equal(generateCalls, 0);
  assert.equal(blockedCalls, 1);
  assert.equal(errorCalls, 0);
  assert.equal(context.closed, true);
  assert.equal(session.state, 'blocked');
});

test('cancellation aborts generation, closes audio resources, and skips callbacks', async () => {
  const context = new FakeAudioContext();
  let generatorSignal: AbortSignal | undefined;
  let onEndCalls = 0;
  let onErrorCalls = 0;

  const session = createTTSPlaybackSession({
    audioContextFactory: () => context,
    generate: (_text, { signal }) => {
      generatorSignal = signal;
      return new Promise<Blob>((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => reject(new Error('request aborted')),
          { once: true }
        );
      });
    },
    onEnd: () => {
      onEndCalls += 1;
    },
    onError: () => {
      onErrorCalls += 1;
    },
  });

  const playback = session.play(['one', 'two']);
  await waitFor(() => Boolean(generatorSignal));
  session.cancel('user stopped playback');

  await assert.rejects(playback, error => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, 'AbortError');
    return true;
  });
  assert.equal(generatorSignal?.aborted, true);
  assert.equal(context.closed, true);
  assert.equal(session.state, 'cancelled');
  assert.equal(onEndCalls, 0);
  assert.equal(onErrorCalls, 0);
});

test('HTML audio fallback plays every batch in order and revokes object URLs', async () => {
  const createdUrls: string[] = [];
  const playedUrls: string[] = [];
  const revokedUrls: string[] = [];
  let nextUrl = 0;

  const session = createTTSPlaybackSession({
    audioContextFactory: () => null,
    generate: async text => new Blob([text]),
    objectUrlFactory: {
      create() {
        const url = `blob:tts-${nextUrl}`;
        nextUrl += 1;
        createdUrls.push(url);
        return url;
      },
      revoke(url) {
        revokedUrls.push(url);
      },
    },
    audioElementFactory: url => {
      const audio: TTSHTMLAudioElement = {
        currentTime: 0,
        onended: null,
        onerror: null,
        pause() {},
        async play() {
          playedUrls.push(url);
          queueMicrotask(() => audio.onended?.());
        },
        removeAttribute() {},
        load() {},
      };
      return audio;
    },
  });

  await session.play(['first', 'second', 'third']);

  assert.deepEqual(playedUrls, createdUrls);
  assert.deepEqual(revokedUrls, createdUrls);
  assert.equal(session.state, 'ended');
});

test('the shared audio context unlocks in the gesture stack and survives sessions', async () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    'AudioContext'
  );
  let constructorCalls = 0;
  let inGestureStack = true;
  let resumedInGestureStack = false;
  let closeCalls = 0;
  const sharedStarts: Array<{ id: number; when: number }> = [];
  const sharedStops: number[] = [];

  class SharedFakeAudioContext extends FakeAudioContext {
    constructor() {
      super();
      constructorCalls += 1;
      this.state = 'suspended';
    }

    override createBufferSource(): TTSAudioBufferSource {
      return new FakeSource(sharedStarts, sharedStops);
    }

    override resume(): Promise<void> {
      this.resumeCalls += 1;
      resumedInGestureStack = inGestureStack;
      this.state = 'running';
      return Promise.resolve();
    }

    override async close(): Promise<void> {
      closeCalls += 1;
      await super.close();
    }
  }

  Object.defineProperty(globalThis, 'AudioContext', {
    configurable: true,
    value: SharedFakeAudioContext,
  });

  try {
    const unlocked = unlockTTSAudioPlayback();
    inGestureStack = false;
    assert.equal(await unlocked, 'ready');
    assert.equal(resumedInGestureStack, true);
    assert.equal(getTTSAudioUnlockState(), 'ready');

    const session = createTTSPlaybackSession({
      scheduleLeadSeconds: 0,
      generate: async () => new Blob(['7']),
    });
    await session.play(['shared output']);

    assert.equal(constructorCalls, 1);
    assert.deepEqual(
      sharedStarts.map(item => item.id),
      [7]
    );
    assert.equal(closeCalls, 0);
    assert.equal(session.state, 'ended');
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'AudioContext', originalDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, 'AudioContext');
    }
  }
});
