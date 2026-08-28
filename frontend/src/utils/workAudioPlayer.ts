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
 * Plays the Work Computer's audio stream: raw interleaved s16le PCM frames
 * over an authenticated WebSocket, fed into an AudioWorklet ring buffer.
 * The worklet resamples linearly when the AudioContext refuses the source
 * rate, and starting requires a user gesture (the browser autoplay rule —
 * which is also why the screen is muted by default).
 */

import workAudioProcessorUrl from './workAudioProcessor.js?url&no-inline';

const SOURCE_RATE = 44_100;
const SOURCE_CHANNELS = 2;

export interface WorkAudioPlayer {
  stop: () => void;
}

export async function startWorkAudioPlayer(
  url: string,
  onEnd: () => void
): Promise<WorkAudioPlayer> {
  const context = new AudioContext();
  let node: AudioWorkletNode;
  try {
    await context.audioWorklet.addModule(workAudioProcessorUrl);
    node = new AudioWorkletNode(context, 'libre-work-audio', {
      outputChannelCount: [2],
      processorOptions: { sourceRate: SOURCE_RATE },
    });
    node.connect(context.destination);
    await context.resume();
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(url);
  } catch (error) {
    node.disconnect();
    await context.close().catch(() => undefined);
    throw error;
  }
  socket.binaryType = 'arraybuffer';
  // PCM frames may split anywhere; carry the odd byte to the next chunk.
  let carry = new Uint8Array(0);
  socket.onmessage = event => {
    if (!(event.data instanceof ArrayBuffer)) return;
    const incoming = new Uint8Array(event.data);
    const merged = new Uint8Array(carry.length + incoming.length);
    merged.set(carry, 0);
    merged.set(incoming, carry.length);
    const frameBytes = 2 * SOURCE_CHANNELS;
    const usable = merged.length - (merged.length % frameBytes);
    carry = merged.slice(usable);
    if (usable === 0) return;
    const samples = new Int16Array(merged.buffer, 0, usable / 2);
    const frames = samples.length / SOURCE_CHANNELS;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    for (let frame = 0; frame < frames; frame++) {
      left[frame] = samples[frame * SOURCE_CHANNELS] / 32768;
      right[frame] = samples[frame * SOURCE_CHANNELS + 1] / 32768;
    }
    node.port.postMessage({ left, right }, [left.buffer, right.buffer]);
  };
  const stop = (): void => {
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
    node.disconnect();
    void context.close().catch(() => undefined);
  };
  socket.onclose = () => {
    stop();
    onEnd();
  };
  socket.onerror = () => {
    stop();
    onEnd();
  };
  return { stop };
}
