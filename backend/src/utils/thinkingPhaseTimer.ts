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

const OPENERS: Array<[open: string, close: string]> = [
  ['[thinking:', ']'],
  ['<thinking>', '</thinking>'],
  ['<think>', '</think>'],
];

const MAX_OPENER_LENGTH = Math.max(...OPENERS.map(([open]) => open.length));

/**
 * Times the reasoning phase of a streaming assistant response by watching the
 * accumulated content for the thinking markers the frontend renders
 * ([Thinking: ...], <thinking>...</thinking>, <think>...</think>, at the very
 * start of the message). Each observation only scans the newly appended tail,
 * so cost stays linear in total content length.
 */
export class ThinkingPhaseTimer {
  private state: 'unknown' | 'none' | 'open' | 'done' = 'unknown';
  private closeMarker = '';
  private startedAt = 0;
  private searchFrom = 0;
  private measuredMs: number | undefined;

  observeReasoning() {
    if (this.state === 'unknown') {
      this.state = 'open';
      this.startedAt = Date.now();
    }
  }

  observeAnswer() {
    if (this.state === 'open') {
      this.state = 'done';
      this.measuredMs = Date.now() - this.startedAt;
    }
  }

  observe(content: string) {
    if (this.state === 'none' || this.state === 'done') {
      return;
    }

    if (this.state === 'unknown') {
      const head = content.slice(0, MAX_OPENER_LENGTH).toLowerCase();
      const match = OPENERS.find(([open]) => head.startsWith(open));
      if (match) {
        this.state = 'open';
        this.closeMarker = match[1];
        this.startedAt = Date.now();
        this.searchFrom = match[0].length;
      } else if (!OPENERS.some(([open]) => open.startsWith(head))) {
        // The head can no longer grow into any opener.
        this.state = 'none';
        return;
      } else {
        return; // Too little content to decide yet.
      }
    }

    const scanStart = Math.max(
      this.searchFrom - (this.closeMarker.length - 1),
      0
    );
    const index = content
      .slice(scanStart)
      .toLowerCase()
      .indexOf(this.closeMarker);
    if (index >= 0) {
      this.state = 'done';
      this.measuredMs = Date.now() - this.startedAt;
    } else {
      this.searchFrom = content.length;
    }
  }

  /**
   * Duration of the thinking phase, if one was observed. A phase still open at
   * end of stream (the whole response was reasoning) counts up to now.
   */
  get durationMs(): number | undefined {
    if (this.state === 'done') return this.measuredMs;
    if (this.state === 'open') return Date.now() - this.startedAt;
    return undefined;
  }
}
