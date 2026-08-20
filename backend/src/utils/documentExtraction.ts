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

import type { DocumentFileType } from '../types/index.js';
import { htmlToText } from './webpageFetcher.js';
import { readZipArchive, ZipArchive, ZipArchiveError } from './zipArchive.js';

/**
 * Document extraction for knowledge ingestion.
 *
 * Every supported upload type resolves to one canonical `DocumentFileType`
 * and one extractor that returns plain text plus an optional segment map.
 * Segments record where pages, slides, sheets, and Markdown sections start
 * and end inside the extracted text, so retrieval can cite an exact source
 * location without a second parse of the original file.
 *
 * OOXML formats are unpacked with the in-repo bounded ZIP reader and a
 * narrow text-run scan of the document XML; the goal is faithful text for
 * retrieval, not layout fidelity. Images/OCR and audio transcription are
 * deliberately not extracted here — they are documented boundaries until an
 * OCR engine and a default speech-to-text route exist.
 */

export type { DocumentFileType } from '../types/index.js';

export interface DocumentSegment {
  kind: 'page' | 'slide' | 'sheet' | 'section';
  label: string;
  startChar: number;
  endChar: number;
}

export interface ExtractedDocumentContent {
  content: string;
  segments: DocumentSegment[];
}

export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentExtractionError';
  }
}

interface DocumentTypeSpec {
  fileType: DocumentFileType;
  extensions: readonly string[];
  mimeTypes: readonly string[];
}

const CODE_EXTENSIONS = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'sql',
  'r',
  'scala',
  'lua',
  'pl',
  'json',
  'yaml',
  'yml',
  'toml',
  'ini',
  'css',
  'scss',
  'less',
  'xml',
  'graphql',
  'proto',
  'tf',
  'dockerfile',
] as const;

const DOCUMENT_TYPE_SPECS: readonly DocumentTypeSpec[] = [
  {
    fileType: 'pdf',
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
  },
  {
    fileType: 'md',
    extensions: ['md', 'markdown', 'mdx'],
    mimeTypes: ['text/markdown', 'text/x-markdown'],
  },
  {
    fileType: 'html',
    extensions: ['html', 'htm', 'xhtml'],
    mimeTypes: ['text/html', 'application/xhtml+xml'],
  },
  {
    fileType: 'docx',
    extensions: ['docx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ],
  },
  {
    fileType: 'pptx',
    extensions: ['pptx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ],
  },
  {
    fileType: 'xlsx',
    extensions: ['xlsx'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
  },
  {
    fileType: 'csv',
    extensions: ['csv', 'tsv'],
    mimeTypes: ['text/csv', 'text/tab-separated-values'],
  },
  {
    fileType: 'code',
    extensions: CODE_EXTENSIONS,
    mimeTypes: ['application/json', 'text/css', 'application/xml', 'text/xml'],
  },
  {
    fileType: 'txt',
    extensions: ['txt', 'text', 'log'],
    mimeTypes: ['text/plain'],
  },
] as const;

export const SUPPORTED_DOCUMENT_EXTENSIONS: readonly string[] = Object.freeze(
  DOCUMENT_TYPE_SPECS.flatMap(spec => spec.extensions)
);

export const SUPPORTED_DOCUMENT_MIME_TYPES: readonly string[] = Object.freeze([
  ...new Set(DOCUMENT_TYPE_SPECS.flatMap(spec => spec.mimeTypes)),
]);

const fileExtension = (fileName: string): string => {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  const dot = base.lastIndexOf('.');
  return dot === -1 ? '' : base.slice(dot + 1);
};

/**
 * Resolves the canonical file type for an upload. The extension decides
 * first because browsers report unreliable MIME types for Markdown, code,
 * and OOXML files; the declared MIME type is the fallback for extensionless
 * names. Returns null when neither identifies a supported type.
 */
export const resolveDocumentFileType = (
  fileName: string,
  mimeType: string
): DocumentFileType | null => {
  const extension = fileExtension(fileName);
  if (extension) {
    for (const spec of DOCUMENT_TYPE_SPECS) {
      if (spec.extensions.includes(extension)) return spec.fileType;
    }
  }
  const normalizedMime = mimeType.toLowerCase().split(';')[0].trim();
  for (const spec of DOCUMENT_TYPE_SPECS) {
    if (spec.mimeTypes.includes(normalizedMime)) return spec.fileType;
  }
  // Trust text/* payloads with unknown extensions as plain text so logs and
  // exports with exotic suffixes remain ingestible.
  if (normalizedMime.startsWith('text/')) return 'txt';
  return null;
};

const XML_ENTITY_PATTERN = /&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g;

const decodeXmlEntities = (value: string): string =>
  value.replace(XML_ENTITY_PATTERN, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const codePoint = entity.startsWith('#x')
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
        return Number.isFinite(codePoint) &&
          codePoint >= 0 &&
          codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : '';
      }
    }
  });

/**
 * Collects the character data of every occurrence of one XML tag, in
 * document order. Handles self-closing tags and attributes; OOXML text runs
 * carry no nested markup inside the target elements this module reads.
 */
const collectXmlTagText = (xml: string, tagName: string): string[] => {
  const results: string[] = [];
  const pattern = new RegExp(
    `<${tagName}(?:\\s[^>]*)?(?:/>|>([\\s\\S]*?)</${tagName}>)`,
    'g'
  );
  for (const match of xml.matchAll(pattern)) {
    results.push(match[1] === undefined ? '' : decodeXmlEntities(match[1]));
  }
  return results;
};

const decodeTextBuffer = (buffer: Buffer): string => {
  let text = buffer.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n/g, '\n');
};

const openOoxmlArchive = (buffer: Buffer, label: string): ZipArchive => {
  try {
    return readZipArchive(buffer);
  } catch (error) {
    if (error instanceof ZipArchiveError) {
      throw new DocumentExtractionError(
        `The uploaded ${label} file is not a readable Office document: ${error.message}`
      );
    }
    throw error;
  }
};

const readArchiveXml = (
  archive: ZipArchive,
  path: string,
  label: string
): string => {
  const bytes = archive.read(path);
  if (!bytes) {
    throw new DocumentExtractionError(
      `The uploaded ${label} file is missing its ${path} part`
    );
  }
  return bytes.toString('utf8');
};

/** DOCX: word/document.xml paragraphs, with tabs and line breaks preserved. */
const extractDocx = (buffer: Buffer): ExtractedDocumentContent => {
  const archive = openOoxmlArchive(buffer, 'DOCX');
  const xml = readArchiveXml(archive, 'word/document.xml', 'DOCX');
  const paragraphs: string[] = [];
  const tokenPattern =
    /<w:t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/w:t>)|<w:tab(?:\s[^>]*)?\/>|<w:br(?:\s[^>]*)?\/>/g;
  for (const paragraphMatch of xml.matchAll(
    /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g
  )) {
    const pieces: string[] = [];
    for (const token of paragraphMatch[1].matchAll(tokenPattern)) {
      if (token[0].startsWith('<w:tab')) pieces.push('\t');
      else if (token[0].startsWith('<w:br')) pieces.push('\n');
      else if (token[1] !== undefined) pieces.push(decodeXmlEntities(token[1]));
    }
    const text = pieces.join('').trim();
    if (text) paragraphs.push(text);
  }
  return { content: paragraphs.join('\n\n'), segments: [] };
};

/** PPTX: one segment per slide, in slide-number order. */
const extractPptx = (buffer: Buffer): ExtractedDocumentContent => {
  const archive = openOoxmlArchive(buffer, 'PPTX');
  const slidePaths = archive
    .entryPaths()
    .map(path => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/.exec(path);
      return match ? { path, index: Number.parseInt(match[1], 10) } : null;
    })
    .filter((entry): entry is { path: string; index: number } => entry !== null)
    .sort((a, b) => a.index - b.index);
  if (slidePaths.length === 0) {
    throw new DocumentExtractionError(
      'The uploaded PPTX file contains no slides'
    );
  }
  const segments: DocumentSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const slide of slidePaths) {
    const xml = readArchiveXml(archive, slide.path, 'PPTX');
    const paragraphs: string[] = [];
    for (const paragraphMatch of xml.matchAll(
      /<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/g
    )) {
      const text = collectXmlTagText(paragraphMatch[1], 'a:t').join('').trim();
      if (text) paragraphs.push(text);
    }
    const slideText = paragraphs.join('\n');
    if (!slideText) continue;
    if (parts.length > 0) offset += 2; // joiner between slides
    segments.push({
      kind: 'slide',
      label: `Slide ${slide.index}`,
      startChar: offset,
      endChar: offset + slideText.length,
    });
    parts.push(slideText);
    offset += slideText.length;
  }
  return { content: parts.join('\n\n'), segments };
};

interface XlsxSheetRef {
  name: string;
  relationshipId: string;
}

const excelColumnIndex = (cellRef: string): number => {
  let column = 0;
  for (const char of cellRef) {
    if (char >= 'A' && char <= 'Z') {
      column = column * 26 + (char.charCodeAt(0) - 64);
    } else {
      break;
    }
  }
  return column === 0 ? 1 : column;
};

/** XLSX: rows rendered as tab-separated lines, one segment per sheet. */
const extractXlsx = (buffer: Buffer): ExtractedDocumentContent => {
  const archive = openOoxmlArchive(buffer, 'XLSX');
  const workbookXml = readArchiveXml(archive, 'xl/workbook.xml', 'XLSX');
  const relsXml = readArchiveXml(archive, 'xl/_rels/workbook.xml.rels', 'XLSX');
  const relationshipTargets = new Map<string, string>();
  for (const match of relsXml.matchAll(
    /<Relationship\s[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/?>/g
  )) {
    relationshipTargets.set(match[1], match[2].replace(/^\//, ''));
  }
  const sheets: XlsxSheetRef[] = [];
  for (const match of workbookXml.matchAll(/<sheet\s[^>]*\/?>/g)) {
    const nameMatch = /name="([^"]*)"/.exec(match[0]);
    const idMatch = /r:id="([^"]*)"/.exec(match[0]);
    if (nameMatch && idMatch) {
      sheets.push({
        name: decodeXmlEntities(nameMatch[1]),
        relationshipId: idMatch[1],
      });
    }
  }
  if (sheets.length === 0) {
    throw new DocumentExtractionError(
      'The uploaded XLSX file contains no worksheets'
    );
  }
  const sharedStrings: string[] = [];
  const sharedXmlBytes = archive.read('xl/sharedStrings.xml');
  if (sharedXmlBytes) {
    const sharedXml = sharedXmlBytes.toString('utf8');
    for (const item of sharedXml.matchAll(
      /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g
    )) {
      sharedStrings.push(collectXmlTagText(item[1], 't').join(''));
    }
  }
  const segments: DocumentSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (const sheet of sheets) {
    const target = relationshipTargets.get(sheet.relationshipId);
    if (!target) continue;
    const sheetPath = target.startsWith('xl/') ? target : `xl/${target}`;
    const sheetBytes = archive.read(sheetPath);
    if (!sheetBytes) continue;
    const sheetXml = sheetBytes.toString('utf8');
    const lines: string[] = [];
    for (const rowMatch of sheetXml.matchAll(
      /<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g
    )) {
      const cells: string[] = [];
      for (const cellMatch of rowMatch[1].matchAll(
        /<c(?:\s([^>]*))?(?:\/>|>([\s\S]*?)<\/c>)/g
      )) {
        const attributes = cellMatch[1] ?? '';
        const body = cellMatch[2] ?? '';
        const refMatch = /r="([A-Z]+)\d+"/.exec(attributes);
        const columnIndex = refMatch
          ? excelColumnIndex(refMatch[1])
          : cells.length + 1;
        while (cells.length < columnIndex - 1) cells.push('');
        const typeMatch = /t="([^"]+)"/.exec(attributes);
        const type = typeMatch ? typeMatch[1] : 'n';
        let value = '';
        if (type === 'inlineStr') {
          value = collectXmlTagText(body, 't').join('');
        } else {
          const rawValue = collectXmlTagText(body, 'v').join('');
          if (type === 's') {
            const index = Number.parseInt(rawValue, 10);
            value = Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
          } else if (type === 'b') {
            value = rawValue === '1' ? 'TRUE' : 'FALSE';
          } else {
            value = rawValue;
          }
        }
        cells.push(value);
      }
      const line = cells.join('\t').replace(/\t+$/, '');
      if (line.trim()) lines.push(line);
    }
    const header = `Sheet: ${sheet.name}`;
    const sheetText = lines.length > 0 ? `${header}\n${lines.join('\n')}` : '';
    if (!sheetText) continue;
    if (parts.length > 0) offset += 2;
    segments.push({
      kind: 'sheet',
      label: sheet.name,
      startChar: offset,
      endChar: offset + sheetText.length,
    });
    parts.push(sheetText);
    offset += sheetText.length;
  }
  return { content: parts.join('\n\n'), segments };
};

/** Markdown: passthrough text with one segment per top-level heading. */
const extractMarkdown = (buffer: Buffer): ExtractedDocumentContent => {
  const content = decodeTextBuffer(buffer);
  const segments: DocumentSegment[] = [];
  const headingPattern = /^#{1,3}\s+(.+)$/gm;
  const headings: Array<{ label: string; startChar: number }> = [];
  for (const match of content.matchAll(headingPattern)) {
    headings.push({
      label: match[1].trim().slice(0, 120),
      startChar: match.index ?? 0,
    });
  }
  for (let index = 0; index < headings.length; index += 1) {
    segments.push({
      kind: 'section',
      label: headings[index].label,
      startChar: headings[index].startChar,
      endChar:
        index + 1 < headings.length
          ? headings[index + 1].startChar
          : content.length,
    });
  }
  return { content, segments };
};

const extractHtml = (buffer: Buffer): ExtractedDocumentContent => {
  const { title, text } = htmlToText(decodeTextBuffer(buffer));
  const content =
    title && !text.startsWith(title) ? `${title}\n\n${text}` : text;
  return { content, segments: [] };
};

export interface PdfExtractionApi {
  getDocument(options: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
    }>;
  };
}

/** PDF: pdfjs text content with one segment per page. */
const extractPdf = async (
  buffer: Buffer,
  pdfLib: PdfExtractionApi,
  signal?: AbortSignal
): Promise<ExtractedDocumentContent> => {
  const pdfDocument = await pdfLib.getDocument({
    data: new Uint8Array(buffer),
  }).promise;
  const segments: DocumentSegment[] = [];
  const parts: string[] = [];
  let offset = 0;
  for (
    let pageNumber = 1;
    pageNumber <= pdfDocument.numPages;
    pageNumber += 1
  ) {
    if (signal?.aborted) throw signal.reason;
    const page = await pdfDocument.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map(item =>
        item !== null &&
        typeof item === 'object' &&
        'str' in item &&
        typeof (item as { str?: unknown }).str === 'string'
          ? (item as { str: string }).str
          : ''
      )
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!pageText) continue;
    if (parts.length > 0) offset += 2;
    segments.push({
      kind: 'page',
      label: `Page ${pageNumber}`,
      startChar: offset,
      endChar: offset + pageText.length,
    });
    parts.push(pageText);
    offset += pageText.length;
  }
  return { content: parts.join('\n\n'), segments };
};

export interface DocumentExtractionOptions {
  signal?: AbortSignal;
  /** Lazily loaded pdfjs module; required only for PDF extraction. */
  pdfLib?: PdfExtractionApi;
}

export const extractDocumentContentByType = async (
  buffer: Buffer,
  fileType: DocumentFileType,
  options: DocumentExtractionOptions = {}
): Promise<ExtractedDocumentContent> => {
  if (options.signal?.aborted) throw options.signal.reason;
  switch (fileType) {
    case 'pdf': {
      if (!options.pdfLib) {
        throw new DocumentExtractionError('PDF parsing is not available');
      }
      return extractPdf(buffer, options.pdfLib, options.signal);
    }
    case 'docx':
      return extractDocx(buffer);
    case 'pptx':
      return extractPptx(buffer);
    case 'xlsx':
      return extractXlsx(buffer);
    case 'md':
      return extractMarkdown(buffer);
    case 'html':
      return extractHtml(buffer);
    case 'csv':
    case 'code':
    case 'txt':
      return { content: decodeTextBuffer(buffer), segments: [] };
    default: {
      const exhausted: never = fileType;
      throw new DocumentExtractionError(`Unsupported file type: ${exhausted}`);
    }
  }
};
