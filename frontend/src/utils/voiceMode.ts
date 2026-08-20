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
 * Hands-free voice mode state machine (AUDIO-02).
 *
 * One conversation loop: listening → transcribing → generating → speaking →
 * listening. The reducer is pure so every transition — including barge-in,
 * mute, recoverable failures, and the one-active-turn guarantee — is unit
 * testable without media APIs. The `turn` counter increments whenever a new
 * capture turn begins; async callbacks compare it to ignore stale work.
 */

export type VoiceModePhase =
  'idle' | 'listening' | 'transcribing' | 'generating' | 'speaking';

export interface VoiceModeState {
  phase: VoiceModePhase;
  muted: boolean;
  /** Monotonic capture-turn id; stale async work compares against it. */
  turn: number;
  /** Last recoverable failure, surfaced inline and cleared on activity. */
  error: string | null;
}

export type VoiceModeEvent =
  | { type: 'start' }
  | { type: 'stop' }
  | { type: 'captured' }
  | { type: 'transcript'; text: string }
  | { type: 'reply'; speak: boolean }
  | { type: 'spoken' }
  | { type: 'barge-in' }
  | { type: 'mute' }
  | { type: 'unmute' }
  | { type: 'fail'; message: string };

export const initialVoiceModeState: VoiceModeState = {
  phase: 'idle',
  muted: false,
  turn: 0,
  error: null,
};

const nextTurn = (state: VoiceModeState): VoiceModeState => ({
  ...state,
  phase: 'listening',
  turn: state.turn + 1,
});

export function reduceVoiceMode(
  state: VoiceModeState,
  event: VoiceModeEvent
): VoiceModeState {
  switch (event.type) {
    case 'start':
      return state.phase === 'idle'
        ? {
            phase: 'listening',
            muted: false,
            turn: state.turn + 1,
            error: null,
          }
        : state;
    case 'stop':
      return { ...state, phase: 'idle', error: null };
    case 'mute':
      return { ...state, muted: true };
    case 'unmute':
      return { ...state, muted: false };
    case 'captured':
      return state.phase === 'listening' && !state.muted
        ? { ...state, phase: 'transcribing', error: null }
        : state;
    case 'transcript':
      if (state.phase !== 'transcribing') return state;
      return event.text.trim()
        ? { ...state, phase: 'generating' }
        : nextTurn(state);
    case 'reply':
      if (state.phase !== 'generating') return state;
      return event.speak ? { ...state, phase: 'speaking' } : nextTurn(state);
    case 'spoken':
    case 'barge-in':
      return state.phase === 'speaking' ? nextTurn(state) : state;
    case 'fail':
      if (state.phase === 'idle') return state;
      return { ...nextTurn(state), error: event.message };
  }
}
