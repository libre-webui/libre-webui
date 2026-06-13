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

import { Artifact } from '@/types';
import {
  isFullHtmlDocument,
  mergeHtmlArtifactFiles,
} from '@/utils/artifactHtml';

export interface ArtifactParseResult {
  content: string; // Message content with artifacts removed
  artifacts: Artifact[];
}

interface ContentRange {
  start: number;
  end: number;
}

interface CodeFence extends ContentRange {
  raw: string;
  info: string;
  content: string;
  language?: string;
  fileName?: string;
}

interface FenceArtifactDefinition {
  type: Artifact['type'];
  title: string;
  language?: string;
}

interface ParsedBundle {
  artifact: Artifact;
  ranges: ContentRange[];
}

const CODE_FENCE_REGEX = /```([^\n`]*)\n([\s\S]*?)\n```/g;
const FILE_NAME_PATTERN =
  /[\w@./-]+\.(?:html?|css|mjs|js|jsx|ts|tsx|svg|json|py)/i;
const VALID_ARTIFACT_TYPES: Artifact['type'][] = [
  'html',
  'react',
  'svg',
  'mermaid',
  'chart',
  'code',
  'text',
  'json',
];

// Artifact marker patterns (explicit artifact declarations)
const ARTIFACT_MARKERS = [
  // <artifact type="html" title="My Page">content</artifact>
  {
    regex:
      /<artifact\s+type="([^"]+)"\s+title="([^"]+)"[^>]*>([\s\S]*?)<\/artifact>/gi,
    extract: (match: RegExpExecArray) => ({
      type: normalizeArtifactType(match[1]),
      title: sanitizeHtmlText(match[2]).trim() || 'Artifact',
      content: match[3].trim(),
    }),
  },

  // <artifact type="html">content</artifact>
  {
    regex: /<artifact\s+type="([^"]+)"[^>]*>([\s\S]*?)<\/artifact>/gi,
    extract: (match: RegExpExecArray) => {
      const type = normalizeArtifactType(match[1]);
      return {
        type,
        title: `${type.toUpperCase()} Artifact`,
        content: match[2].trim(),
      };
    },
  },
];

/**
 * Safely extract and sanitize text content from HTML.
 */
function sanitizeHtmlText(text: string): string {
  if (typeof document !== 'undefined') {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = text;
    return tempDiv.textContent || tempDiv.innerText || '';
  }

  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Extract title from HTML content.
 */
function extractTitle(htmlContent: string): string | null {
  const titleMatch = htmlContent.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const title = sanitizeHtmlText(titleMatch[1]).trim();
    return title || null;
  }

  const h1Match = htmlContent.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const title = sanitizeHtmlText(h1Match[1]).trim();
    return title || null;
  }

  return null;
}

/**
 * Extract component name from React/JSX content.
 */
function extractComponentName(jsxContent: string): string | null {
  const functionMatch = jsxContent.match(/(?:function|const)\s+(\w+)/);
  if (functionMatch) {
    return functionMatch[1];
  }

  const classMatch = jsxContent.match(/class\s+(\w+)/);
  if (classMatch) {
    return classMatch[1];
  }

  return null;
}

/**
 * Extract title from Python code.
 */
function extractPythonTitle(pythonContent: string): string | null {
  if (pythonContent.includes('def main(')) {
    return 'Python Script';
  }

  const classMatch = pythonContent.match(/class\s+(\w+)/);
  if (classMatch) {
    return `${classMatch[1]} Class`;
  }

  const funcMatch = pythonContent.match(/def\s+(\w+)/);
  if (funcMatch && funcMatch[1] !== '__init__') {
    return `${funcMatch[1]} Function`;
  }

  return null;
}

/**
 * Extract title from JavaScript code.
 */
function extractJSTitle(jsContent: string): string | null {
  const funcMatch = jsContent.match(/function\s+(\w+)/);
  if (funcMatch) {
    return `${funcMatch[1]} Function`;
  }

  const constMatch = jsContent.match(/(?:const|let)\s+(\w+)\s*=/);
  if (constMatch) {
    return constMatch[1];
  }

  return null;
}

function normalizeArtifactType(type: string): Artifact['type'] {
  const normalized = type.trim().toLowerCase() as Artifact['type'];
  return VALID_ARTIFACT_TYPES.includes(normalized) ? normalized : 'text';
}

function normalizeLanguage(language?: string): string | undefined {
  if (!language) return undefined;

  const normalized = language
    .trim()
    .toLowerCase()
    .replace(/^\./, '')
    .replace(/[,:;]+$/, '');

  switch (normalized) {
    case 'htm':
    case 'html':
      return 'html';
    case 'js':
    case 'mjs':
    case 'javascript':
      return 'javascript';
    case 'jsx':
    case 'tsx':
    case 'react':
      return 'react';
    case 'ts':
    case 'typescript':
      return 'typescript';
    case 'py':
    case 'python':
      return 'python';
    case 'css':
    case 'svg':
    case 'json':
      return normalized;
    default:
      return normalized || undefined;
  }
}

function extractCodeFences(source: string): CodeFence[] {
  const fences: CodeFence[] = [];
  const regex = new RegExp(CODE_FENCE_REGEX);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(source)) !== null) {
    const info = match[1].trim();
    const nearbyFileName = findNearbyFileName(source, match.index);
    const metadata = parseFenceInfo(info, nearbyFileName);

    fences.push({
      raw: match[0],
      info,
      content: match[2].trim(),
      start: match.index,
      end: match.index + match[0].length,
      language: metadata.language,
      fileName: metadata.fileName,
    });
  }

  return fences;
}

function parseFenceInfo(
  info: string,
  nearbyFileName?: string
): Pick<CodeFence, 'language' | 'fileName'> {
  const fileName = extractFileName(info) || nearbyFileName;
  const tokens = info.split(/\s+/).filter(Boolean);
  const firstToken = tokens[0]?.replace(/[{}[\]()]/g, '');
  const directLanguage =
    firstToken &&
    !FILE_NAME_PATTERN.test(firstToken) &&
    !firstToken.includes('=')
      ? normalizeLanguage(firstToken)
      : undefined;
  const language = directLanguage || normalizeLanguage(extensionOf(fileName));

  return {
    language,
    fileName,
  };
}

function extractFileName(value: string): string | undefined {
  const attrMatch = value.match(
    /(?:file(?:name)?|path|name)\s*=\s*["']?([^"'\s]+)["']?/i
  );
  if (attrMatch && FILE_NAME_PATTERN.test(attrMatch[1])) {
    return cleanFileName(attrMatch[1]);
  }

  const fileMatch = value.match(FILE_NAME_PATTERN);
  return fileMatch ? cleanFileName(fileMatch[0]) : undefined;
}

function findNearbyFileName(source: string, index: number): string | undefined {
  const before = source.slice(Math.max(0, index - 180), index);
  const lines = before.split('\n').slice(-3).reverse();

  for (const line of lines) {
    const cleaned = line
      .trim()
      .replace(/^#{1,6}\s*/, '')
      .replace(/^[-*]\s*/, '')
      .replace(/[:：]\s*$/, '');
    const match = cleaned.match(FILE_NAME_PATTERN);

    if (match) {
      return cleanFileName(match[0]);
    }
  }

  return undefined;
}

function cleanFileName(fileName: string): string {
  return fileName.replace(/^["'`]+|["'`:]+$/g, '');
}

function extensionOf(fileName?: string): string | undefined {
  const match = fileName?.match(/\.([a-z0-9]+)$/i);
  return match?.[1];
}

function baseName(fileName?: string): string | undefined {
  return fileName?.split(/[\\/]/).pop();
}

function titleFromFileName(fileName?: string): string | null {
  const base = baseName(fileName);
  if (!base) return null;

  const withoutExtension = base.replace(/\.[^.]+$/, '');
  if (/^(index|main|app)$/i.test(withoutExtension)) {
    return null;
  }

  return withoutExtension
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function createArtifact(
  definition: Omit<Artifact, 'id' | 'createdAt' | 'updatedAt'>
): Artifact {
  const now = Date.now();

  return {
    ...definition,
    id: `artifact-${now}-${Math.random().toString(36).slice(2, 11)}`,
    createdAt: now,
    updatedAt: now,
  };
}

function getFenceArtifactDefinition(
  fence: CodeFence
): FenceArtifactDefinition | null {
  const language =
    normalizeLanguage(fence.language) ||
    normalizeLanguage(extensionOf(fence.fileName));

  switch (language) {
    case 'html':
      return {
        type: 'html',
        title:
          extractTitle(fence.content) ||
          titleFromFileName(fence.fileName) ||
          'HTML Document',
      };
    case 'svg':
      return {
        type: 'svg',
        title: titleFromFileName(fence.fileName) || 'SVG Image',
      };
    case 'react':
      return {
        type: 'react',
        title:
          extractComponentName(fence.content) ||
          titleFromFileName(fence.fileName) ||
          'React Component',
        language: 'jsx',
      };
    case 'json':
      return {
        type: 'json',
        title: titleFromFileName(fence.fileName) || 'JSON Data',
      };
    case 'python':
      return {
        type: 'code',
        title:
          extractPythonTitle(fence.content) ||
          titleFromFileName(fence.fileName) ||
          'Python Code',
        language: 'python',
      };
    case 'css':
      return {
        type: 'code',
        title: titleFromFileName(fence.fileName) || 'CSS Styles',
        language: 'css',
      };
    case 'javascript':
      return {
        type: 'code',
        title:
          extractJSTitle(fence.content) ||
          titleFromFileName(fence.fileName) ||
          'JavaScript Code',
        language: 'javascript',
      };
    case 'typescript':
      return {
        type: 'code',
        title: titleFromFileName(fence.fileName) || 'TypeScript Code',
        language: 'typescript',
      };
    default:
      if (language) {
        return {
          type: 'code',
          title:
            titleFromFileName(fence.fileName) ||
            `${language.toUpperCase()} Code`,
          language,
        };
      }

      return null;
  }
}

function isHtmlFence(fence: CodeFence): boolean {
  const language =
    normalizeLanguage(fence.language) ||
    normalizeLanguage(extensionOf(fence.fileName));
  return language === 'html';
}

function isStyleFence(fence: CodeFence): boolean {
  const language =
    normalizeLanguage(fence.language) ||
    normalizeLanguage(extensionOf(fence.fileName));
  return language === 'css';
}

function isScriptFence(fence: CodeFence): boolean {
  const language =
    normalizeLanguage(fence.language) ||
    normalizeLanguage(extensionOf(fence.fileName));
  return language === 'javascript';
}

function extractBundledHtmlArtifact(source: string): ParsedBundle | null {
  const fences = extractCodeFences(source);
  const htmlFences = fences.filter(isHtmlFence);

  if (htmlFences.length === 0) {
    return null;
  }

  const styleFences = fences.filter(isStyleFence);
  const scriptFences = fences.filter(isScriptFence);

  if (styleFences.length === 0 && scriptFences.length === 0) {
    return null;
  }

  const entryHtml =
    htmlFences.find(fence =>
      /(^|[/\\])index\.html?$/i.test(fence.fileName || '')
    ) || htmlFences[0];

  const htmlWithoutLocalLinks = removeLocalFileReferences(
    entryHtml.content,
    styleFences,
    scriptFences
  );
  const bundledContent = mergeHtmlArtifactFiles(
    htmlWithoutLocalLinks,
    styleFences.map(fence => fence.content),
    scriptFences.map(fence => fence.content)
  );

  if (!shouldBeArtifact(bundledContent, 'html')) {
    return null;
  }

  return {
    artifact: createArtifact({
      type: 'html',
      title:
        extractTitle(bundledContent) ||
        titleFromFileName(entryHtml.fileName) ||
        'Interactive HTML App',
      description:
        'Bundled generated HTML, CSS, and JavaScript files into one runnable artifact.',
      content: bundledContent,
    }),
    ranges: [entryHtml, ...styleFences, ...scriptFences],
  };
}

function removeLocalFileReferences(
  htmlContent: string,
  styleFences: CodeFence[],
  scriptFences: CodeFence[]
): string {
  let cleaned = htmlContent;

  for (const fence of styleFences) {
    const name = baseName(fence.fileName);
    if (!name) continue;

    cleaned = cleaned.replace(
      new RegExp(
        `<link\\b[^>]*href=["'][^"']*${escapeRegExp(name)}["'][^>]*>`,
        'gi'
      ),
      ''
    );
  }

  for (const fence of scriptFences) {
    const name = baseName(fence.fileName);
    if (!name) continue;

    cleaned = cleaned.replace(
      new RegExp(
        `<script\\b[^>]*src=["'][^"']*${escapeRegExp(name)}["'][^>]*>\\s*<\\/script>`,
        'gi'
      ),
      ''
    );
  }

  return cleaned;
}

function extractStandaloneHtmlDocument(source: string): ParsedBundle | null {
  const startMatch = /<!doctype\s+html|<html[\s>]/i.exec(source);
  if (!startMatch || startMatch.index === undefined) {
    return null;
  }

  const fences = extractCodeFences(source);
  if (isInsideAnyRange(startMatch.index, fences)) {
    return null;
  }

  const start = startMatch.index;
  const closeRegex = /<\/html>/gi;
  closeRegex.lastIndex = start;
  const closeMatch = closeRegex.exec(source);
  const end = closeMatch
    ? closeMatch.index + closeMatch[0].length
    : source.length;
  const rawHtml = source.slice(start, end).trim();

  if (!shouldBeArtifact(rawHtml, 'html')) {
    return null;
  }

  return {
    artifact: createArtifact({
      type: 'html',
      title: extractTitle(rawHtml) || 'HTML Document',
      content: rawHtml,
    }),
    ranges: [{ start, end }],
  };
}

function isInsideAnyRange(index: number, ranges: ContentRange[]): boolean {
  return ranges.some(range => index >= range.start && index <= range.end);
}

function removeRanges(source: string, ranges: ContentRange[]): string {
  return [...ranges]
    .sort((a, b) => b.start - a.start)
    .reduce(
      (result, range) =>
        `${result.slice(0, range.start)}${result.slice(range.end)}`,
      source
    );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check if content should be treated as an artifact.
 */
function shouldBeArtifact(content: string, type: Artifact['type']): boolean {
  if (type === 'html') {
    const trimmed = content.trim();
    const hasHtml = /<[^>]+>/.test(trimmed);
    const hasInteractiveHtml =
      /<(canvas|script|style|button|form|input|select|textarea|video|audio)\b/i.test(
        trimmed
      ) || /\bon(?:click|input|submit|keydown|keyup|mousemove)=/i.test(trimmed);

    return (
      hasHtml &&
      (isFullHtmlDocument(trimmed) ||
        trimmed.length > 160 ||
        hasInteractiveHtml)
    );
  }

  if (type === 'svg') {
    return /<svg[^>]*>/.test(content);
  }

  if (type === 'react') {
    return /<[A-Z][^>]*>/.test(content) || /return\s*\(/.test(content);
  }

  if (type === 'json') {
    try {
      JSON.parse(content);
      return content.trim().length > 100;
    } catch {
      return false;
    }
  }

  if (type === 'code') {
    const lines = content.split('\n').length;
    const chars = content.trim().length;
    const hasComplexity =
      /function|class|def |import |from |const |let |var |if |for |while |try |catch/.test(
        content
      );

    return (chars > 500 || lines > 15) && hasComplexity;
  }

  return content.trim().length > 200;
}

/**
 * Parse message content and extract artifacts.
 */
export function parseArtifacts(content: string): ArtifactParseResult {
  const artifacts: Artifact[] = [];
  let processedContent = content;

  for (const marker of ARTIFACT_MARKERS) {
    marker.regex.lastIndex = 0;
    const ranges: ContentRange[] = [];
    let match: RegExpExecArray | null;

    while ((match = marker.regex.exec(processedContent)) !== null) {
      const extracted = marker.extract(match);

      if (shouldBeArtifact(extracted.content, extracted.type)) {
        artifacts.push(
          createArtifact({
            type: extracted.type,
            title: extracted.title,
            content: extracted.content,
          })
        );
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }

    processedContent = removeRanges(processedContent, ranges);
  }

  let bundledHtml = extractBundledHtmlArtifact(processedContent);
  while (bundledHtml) {
    artifacts.push(bundledHtml.artifact);
    processedContent = removeRanges(processedContent, bundledHtml.ranges);
    bundledHtml = extractBundledHtmlArtifact(processedContent);
  }

  const standaloneHtml = extractStandaloneHtmlDocument(processedContent);
  if (standaloneHtml) {
    artifacts.push(standaloneHtml.artifact);
    processedContent = removeRanges(processedContent, standaloneHtml.ranges);
  }

  const fences = extractCodeFences(processedContent);
  const consumedFenceRanges: ContentRange[] = [];

  for (const fence of fences) {
    const definition = getFenceArtifactDefinition(fence);
    if (!definition || !shouldBeArtifact(fence.content, definition.type)) {
      continue;
    }

    artifacts.push(
      createArtifact({
        type: definition.type,
        title: definition.title,
        content: fence.content,
        language: definition.language,
      })
    );
    consumedFenceRanges.push(fence);
  }

  processedContent = removeRanges(processedContent, consumedFenceRanges);

  return {
    content: processedContent.trim(),
    artifacts,
  };
}

/**
 * Check if a message might contain artifacts.
 */
export function hasArtifacts(content: string): boolean {
  for (const marker of ARTIFACT_MARKERS) {
    marker.regex.lastIndex = 0;
    if (marker.regex.test(content)) {
      return true;
    }
  }

  if (
    extractBundledHtmlArtifact(content) ||
    extractStandaloneHtmlDocument(content)
  ) {
    return true;
  }

  const fences = extractCodeFences(content);
  return fences.some(fence => {
    const definition = getFenceArtifactDefinition(fence);
    return definition
      ? shouldBeArtifact(fence.content, definition.type)
      : false;
  });
}
