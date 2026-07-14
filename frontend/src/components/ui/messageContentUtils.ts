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
  /^ {0,3}(?:`{3,}|~{3,})/m,
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

export interface StreamingMarkdownTextSegment {
  type: 'text';
  content: string;
}

export interface StreamingMarkdownCodeSegment {
  type: 'code';
  content: string;
  language: string | null;
  complete: boolean;
}

export type StreamingMarkdownSegment =
  StreamingMarkdownTextSegment | StreamingMarkdownCodeSegment;

interface StreamingCodeBlockRange {
  start: number;
  end: number;
  codeStart: number;
  codeEnd: number;
  indent: number;
  language: string | null;
  complete: boolean;
}

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function getFencedCodeBlockRanges(content: string): StreamingCodeBlockRange[] {
  const ranges: StreamingCodeBlockRange[] = [];
  const openingFencePattern = /^( {0,3})(`{3,}|~{3,})([^\n\r]*)(?:\r?\n|$)/gm;

  let openingFence: RegExpExecArray | null;
  while ((openingFence = openingFencePattern.exec(content))) {
    const indent = openingFence[1].length;
    const fence = openingFence[2];
    const marker = fence[0];
    const info = openingFence[3].trim();

    // Backtick info strings containing a backtick are not valid CommonMark.
    if (marker === '`' && info.includes('`')) continue;

    const codeStart = openingFencePattern.lastIndex;
    const closingFencePattern = new RegExp(
      `^ {0,3}${escapeRegExp(marker)}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
      'gm'
    );
    closingFencePattern.lastIndex = codeStart;
    const closingFence = closingFencePattern.exec(content);
    const language = info.split(/\s+/)[0] || null;

    if (!closingFence) {
      ranges.push({
        start: openingFence.index,
        end: content.length,
        codeStart,
        codeEnd: content.length,
        indent,
        language,
        complete: false,
      });
      break;
    }

    ranges.push({
      start: openingFence.index,
      end: closingFencePattern.lastIndex,
      codeStart,
      codeEnd: closingFence.index,
      indent,
      language,
      complete: true,
    });
    openingFencePattern.lastIndex = closingFencePattern.lastIndex;
  }

  return ranges;
}

function hasStructuralHtmlEvidence(content: string): boolean {
  return /<(?:html|head|body)(?:\s|>)|<\/(?:head|body|html)\s*>/i.test(content);
}

function rangesOverlap(
  first: StreamingCodeBlockRange,
  second: StreamingCodeBlockRange
): boolean {
  return first.start < second.end && second.start < first.end;
}

function getBareHtmlBlockRange(
  content: string,
  fencedCodeBlocks: StreamingCodeBlockRange[]
): StreamingCodeBlockRange | null {
  const htmlStartPattern =
    /^( {0,3})(<!doctype\s+html(?:\s|>|$)|<html(?:\s[^>\n\r]*)?>)/gim;
  let htmlStart: RegExpExecArray | null;

  while ((htmlStart = htmlStartPattern.exec(content))) {
    const codeStart = htmlStart.index + htmlStart[1].length;
    const isInsideFence = fencedCodeBlocks.some(
      range => codeStart >= range.start && codeStart < range.end
    );
    if (isInsideFence) continue;

    const htmlContent = content.slice(codeStart);
    const contentAfterStartTag = htmlContent.slice(htmlStart[2].length);
    if (!hasStructuralHtmlEvidence(contentAfterStartTag)) continue;

    const closingTag = /<\/html\s*>/i.exec(htmlContent);
    const codeEnd = closingTag
      ? codeStart + closingTag.index + closingTag[0].length
      : content.length;

    return {
      start: htmlStart.index,
      end: codeEnd,
      codeStart,
      codeEnd,
      indent: 0,
      language: 'html',
      complete: Boolean(closingTag),
    };
  }

  return null;
}

function getStreamingCodeBlockRanges(
  content: string
): StreamingCodeBlockRange[] {
  const fencedCodeBlocks = getFencedCodeBlockRanges(content);
  const htmlBlock = getBareHtmlBlockRange(content, fencedCodeBlocks);

  if (!htmlBlock) return fencedCodeBlocks;

  return [
    ...fencedCodeBlocks.filter(range => !rangesOverlap(range, htmlBlock)),
    htmlBlock,
  ].sort((first, second) => first.start - second.start);
}

function normalizeFencedCodeIndent(content: string, indent: number): string {
  if (indent === 0) return content;

  return content.replace(new RegExp(`^ {1,${indent}}`, 'gm'), '');
}

export function shouldUseRichMarkdown(content: string): boolean {
  return richMarkdownPatterns.some(pattern => pattern.test(content));
}

export function shouldUseStreamingCodeRenderer(content: string): boolean {
  return getStreamingCodeBlockRanges(content).length > 0;
}

export function getStreamingMarkdownSegments(
  content: string
): StreamingMarkdownSegment[] {
  const segments: StreamingMarkdownSegment[] = [];
  const codeBlocks = getStreamingCodeBlockRanges(content);

  let cursor = 0;

  for (const codeBlock of codeBlocks) {
    const textBeforeFence = content.slice(cursor, codeBlock.start);
    if (textBeforeFence) {
      segments.push({ type: 'text', content: textBeforeFence });
    }

    segments.push({
      type: 'code',
      language: codeBlock.language,
      content: normalizeFencedCodeIndent(
        content.slice(codeBlock.codeStart, codeBlock.codeEnd),
        codeBlock.indent
      ),
      complete: codeBlock.complete,
    });

    cursor = codeBlock.end;
  }

  const textAfterLastFence = content.slice(cursor);
  if (textAfterLastFence || segments.length === 0) {
    segments.push({ type: 'text', content: textAfterLastFence });
  }

  return segments;
}

export function preprocessLaTeX(content: string): string {
  const convertLaTeX = (text: string) =>
    text
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, value) => `$$${value}$$`)
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, value) => `$${value}$`);
  const processText = (text: string) => {
    const inlineCodePattern = /`[^`\n]+`/g;
    let result = '';
    let cursor = 0;
    let inlineCode: RegExpExecArray | null;

    while ((inlineCode = inlineCodePattern.exec(text))) {
      result += convertLaTeX(text.slice(cursor, inlineCode.index));
      result += inlineCode[0];
      cursor = inlineCodePattern.lastIndex;
    }

    return result + convertLaTeX(text.slice(cursor));
  };
  const fencedCodeBlocks = getFencedCodeBlockRanges(content);
  let processed = '';
  let cursor = 0;

  for (const fencedCodeBlock of fencedCodeBlocks) {
    processed += processText(content.slice(cursor, fencedCodeBlock.start));
    processed += content.slice(fencedCodeBlock.start, fencedCodeBlock.end);
    cursor = fencedCodeBlock.end;
  }
  processed += processText(content.slice(cursor));

  return processed;
}
