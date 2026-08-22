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

const SOURCE_RATE = 44_100;
const SOURCE_CHANNELS = 2;

// The processor runs inside the AudioWorklet scope; it receives Float32
// stereo chunks and plays them out with linear resampling. Kept as source
// text so no separate worklet asset has to be served.
const WORKLET_SOURCE = `
class LibreWorkAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sourceRate = options.processorOptions.sourceRate;
    this.left = [];
    this.right = [];
    this.position = 0;
    this.port.onmessage = event => {
      this.left.push(event.data.left);
      this.right.push(event.data.right);
      // Bound live buffering to roughly one second to cap drift/latency.
      let queued = 0;
      for (const chunk of this.left) queued += chunk.length;
      while (queued > this.sourceRate && this.left.length > 1) {
        queued -= this.left[0].length;
        this.left.shift();
        this.right.shift();
        this.position = 0;
      }
    };
  }

  read(channelQueue, offset) {
    let index = 0;
    let remaining = offset;
    while (index < channelQueue.length) {
      if (remaining < channelQueue[index].length) {
        return channelQueue[index][remaining];
      }
      remaining -= channelQueue[index].length;
      index += 1;
    }
    return undefined;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    const step = this.sourceRate / sampleRate;
    const left = output[0];
    const right = output[1] ?? output[0];
    for (let frame = 0; frame < left.length; frame++) {
      const at = this.position + frame * step;
      const base = Math.floor(at);
      const fraction = at - base;
      const l0 = this.read(this.left, base);
      const l1 = this.read(this.left, base + 1) ?? l0;
      const r0 = this.read(this.right, base);
      const r1 = this.read(this.right, base + 1) ?? r0;
      if (l0 === undefined) {
        left[frame] = 0;
        right[frame] = 0;
        continue;
      }
      left[frame] = l0 + ((l1 ?? l0) - l0) * fraction;
      right[frame] = (r0 ?? l0) + (((r1 ?? r0 ?? l0) - (r0 ?? l0)) * fraction);
    }
    let consumed = this.position + left.length * step;
    while (this.left.length > 0 && consumed >= this.left[0].length) {
      consumed -= this.left[0].length;
      this.left.shift();
      this.right.shift();
    }
    this.position = consumed;
    return true;
  }
}
registerProcessor('libre-work-audio', LibreWorkAudioProcessor);
`;

export interface WorkAudioPlayer {
  stop: () => void;
}

export async function startWorkAudioPlayer(
  url: string,
  onEnd: () => void
): Promise<WorkAudioPlayer> {
  const context = new AudioContext();
  const workletUrl = URL.createObjectURL(
    new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  );
  try {
    await context.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }
  const node = new AudioWorkletNode(context, 'libre-work-audio', {
    outputChannelCount: [2],
    processorOptions: { sourceRate: SOURCE_RATE },
  });
  node.connect(context.destination);
  await context.resume();

  const socket = new WebSocket(url);
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
