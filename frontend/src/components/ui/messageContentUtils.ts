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

const richMarkdownPatterns = [
  /```/,
  /`[^`\n]+`/,
  /^\s{0,3}#{1,6}\s/m,
  /^\s{0,3}[-*+]\s/m,
  /^\s{0,3}\d+\.\s/m,
  /^\s{0,3}>\s/m,
  /\[[^\]]+\]\([^)]+\)/,
  /!\[[^\]]*]\([^)]+\)/,
  /\|.*\|/,
  /\*\*[^*]+\*\*/,
  /__[^_]+__/,
  /~~[^~]+~~/,
  /\\\[[\s\S]*?\\\]/,
  /\\\([\s\S]*?\\\)/,
  /\$\$[\s\S]*?\$\$/,
  /(^|[^$])\$[^$\n]+\$/,
];

export function shouldUseRichMarkdown(content: string): boolean {
  return richMarkdownPatterns.some(pattern => pattern.test(content));
}

export function preprocessLaTeX(content: string): string {
  const codeBlocks: string[] = [];
  let processed = content.replace(/```[\s\S]*?```|`[^`\n]+`/g, match => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  processed = processed.replace(/\\\[([\s\S]*?)\\\]/g, (_, p1) => `$$${p1}$$`);
  processed = processed.replace(/\\\(([\s\S]*?)\\\)/g, (_, p1) => `$${p1}$`);

  codeBlocks.forEach((block, index) => {
    processed = processed.replace(`__CODE_BLOCK_${index}__`, block);
  });

  return processed;
}
