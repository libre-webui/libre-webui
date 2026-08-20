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
import test from 'node:test';
import {
  initialVoiceModeState,
  reduceVoiceMode,
  type VoiceModeEvent,
  type VoiceModeState,
} from './voiceMode';

const run = (
  events: VoiceModeEvent[],
  from: VoiceModeState = initialVoiceModeState
): VoiceModeState => events.reduce(reduceVoiceMode, from);

test('a full turn loops listening → transcribing → generating → speaking → listening', () => {
  let state = run([{ type: 'start' }]);
  assert.equal(state.phase, 'listening');
  assert.equal(state.turn, 1);

  state = run(
    [
      { type: 'captured' },
      { type: 'transcript', text: 'hello there' },
      { type: 'reply', speak: true },
      { type: 'spoken' },
    ],
    state
  );
  assert.equal(state.phase, 'listening');
  assert.equal(state.turn, 2, 'a new capture turn begins after speaking');
});

test('an empty transcript returns to listening without generating', () => {
  const state = run([
    { type: 'start' },
    { type: 'captured' },
    { type: 'transcript', text: '   ' },
  ]);
  assert.equal(state.phase, 'listening');
  assert.equal(state.turn, 2);
});

test('a reply without speech output skips the speaking phase', () => {
  const state = run([
    { type: 'start' },
    { type: 'captured' },
    { type: 'transcript', text: 'no tts configured' },
    { type: 'reply', speak: false },
  ]);
  assert.equal(state.phase, 'listening');
});

test('barge-in interrupts speaking and starts a fresh capture turn', () => {
  const speaking = run([
    { type: 'start' },
    { type: 'captured' },
    { type: 'transcript', text: 'question' },
    { type: 'reply', speak: true },
  ]);
  assert.equal(speaking.phase, 'speaking');
  const interrupted = reduceVoiceMode(speaking, { type: 'barge-in' });
  assert.equal(interrupted.phase, 'listening');
  assert.equal(interrupted.turn, speaking.turn + 1);
});

test('mute blocks capture completion; unmute restores it', () => {
  const muted = run([{ type: 'start' }, { type: 'mute' }]);
  assert.equal(muted.muted, true);
  assert.equal(
    reduceVoiceMode(muted, { type: 'captured' }).phase,
    'listening',
    'a muted microphone cannot complete a capture'
  );
  const unmuted = reduceVoiceMode(muted, { type: 'unmute' });
  assert.equal(
    reduceVoiceMode(unmuted, { type: 'captured' }).phase,
    'transcribing'
  );
});

test('failures at every active phase recover to listening with the error surfaced', () => {
  for (const events of [
    [{ type: 'start' }, { type: 'captured' }],
    [
      { type: 'start' },
      { type: 'captured' },
      { type: 'transcript', text: 'x' },
    ],
    [
      { type: 'start' },
      { type: 'captured' },
      { type: 'transcript', text: 'x' },
      { type: 'reply', speak: true },
    ],
  ] as VoiceModeEvent[][]) {
    const failed = reduceVoiceMode(run(events), {
      type: 'fail',
      message: 'boom',
    });
    assert.equal(failed.phase, 'listening');
    assert.equal(failed.error, 'boom');
  }
});

test('stale events outside their phase are ignored (one active turn)', () => {
  const listening = run([{ type: 'start' }]);
  assert.equal(
    reduceVoiceMode(listening, { type: 'transcript', text: 'late' }),
    listening
  );
  assert.equal(
    reduceVoiceMode(listening, { type: 'reply', speak: true }),
    listening
  );
  assert.equal(reduceVoiceMode(listening, { type: 'spoken' }), listening);

  const generating = run([
    { type: 'start' },
    { type: 'captured' },
    { type: 'transcript', text: 'x' },
  ]);
  assert.equal(
    reduceVoiceMode(generating, { type: 'captured' }),
    generating,
    'capture cannot restart while a reply is pending'
  );
});

test('stop returns to idle from any phase and start requires idle', () => {
  const speaking = run([
    { type: 'start' },
    { type: 'captured' },
    { type: 'transcript', text: 'x' },
    { type: 'reply', speak: true },
  ]);
  const stopped = reduceVoiceMode(speaking, { type: 'stop' });
  assert.equal(stopped.phase, 'idle');
  assert.equal(reduceVoiceMode(speaking, { type: 'start' }), speaking);
  const restarted = reduceVoiceMode(stopped, { type: 'start' });
  assert.equal(restarted.phase, 'listening');
  assert.equal(restarted.error, null);
});

test('errors clear when the next capture completes', () => {
  const failed = reduceVoiceMode(
    run([{ type: 'start' }, { type: 'captured' }]),
    {
      type: 'fail',
      message: 'transcription failed',
    }
  );
  const recovered = reduceVoiceMode(failed, { type: 'captured' });
  assert.equal(recovered.phase, 'transcribing');
  assert.equal(recovered.error, null);
});
