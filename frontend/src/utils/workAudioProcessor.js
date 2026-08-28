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

/* global AudioWorkletProcessor, registerProcessor, sampleRate */

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
      right[frame] = (r0 ?? l0) + ((r1 ?? r0 ?? l0) - (r0 ?? l0)) * fraction;
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
