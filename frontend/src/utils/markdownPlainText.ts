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
export interface PlainTextOptions {
  /** Spoken in place of each fenced code block, e.g. "code block". */
  codeBlockLabel: string;
  /** Upper bound in characters, ellipsis included. */
  maxLength?: number;
}
const ELLIPSIS = '…';
const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Walk line by line so a fence closes only on a run of the same character at
// least as long as the opener, and an unterminated fence runs to the end
// (a reply cut off mid-block is still code).
const replaceCodeFences = (text: string, label: string): string => {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open) {
        fence = open[1];
        out.push(`${label}.`);
      } else {
        out.push(line);
      }
    } else {
      const close = new RegExp(
        `^[ \\t]{0,3}${fence[0]}{${fence.length},}[ \\t]*$`
      );
      if (close.test(line)) fence = null;
    }
  }
  return out.join('\n');
};
const truncate = (text: string, maxLength: number): string => {
  const chars = Array.from(text);
  if (chars.length <= maxLength) return text;
  const room = Math.max(1, maxLength - 1);
  let cut = chars.slice(0, room).join('');
  // Prefer ending on a word boundary unless that would discard most of it.
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > room * 0.6) cut = cut.slice(0, lastSpace);
  return `${cut.replace(/[\s.,;:!?-]+$/, '')}${ELLIPSIS}`;
};
/**
 * Reduce a markdown reply to the sentence a screen reader should speak:
 * syntax removed, code blocks replaced by a short phrase, whitespace
 * collapsed, and the result capped so a long answer cannot monopolize the
 * reader. The full message stays available in the chat log.
 */
export function markdownToPlainText(
  markdown: string,
  { codeBlockLabel, maxLength = 600 }: PlainTextOptions
): string {
  const text = replaceCodeFences(
    markdown.replace(/\r\n?/g, '\n'),
    codeBlockLabel
  )
    // Images speak their alt text; links speak their label, never the URL.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/^[ \t]*\[[^\]]+\]:\s+\S+.*$/gm, '')
    // Raw HTML and comments carry no spoken content of their own.
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][^>\n]*>/g, ' ')
    .replace(/`+([^`\n]+)`+/g, '$1')
    .replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, ' ')
    .replace(
      /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/gm,
      ' '
    )
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/[ \t]+#+[ \t]*$/gm, '')
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, '')
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?:\[[ xX]\][ \t]+)?/gm, '')
    .replace(/^\|/gm, '')
    .replace(/\|[ \t]*$/gm, '')
    .replace(/[ \t]*\|[ \t]*/g, ', ')
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
    .replace(/(?<!\w)__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1')
    .replace(/\*(?=\S)([^*\n]*?\S)\*/g, '$1')
    .replace(/(?<!\w)_(?=\S)([^_\n]*?\S)_(?!\w)/g, '$1')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return truncate(text, maxLength);
}
