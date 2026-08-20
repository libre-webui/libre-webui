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
 * The upload contract every document picker shares. Mirrors the backend's
 * supported extraction types (backend/src/utils/documentExtraction.ts); a
 * picker must never advertise a type the extractor rejects.
 */

export const SUPPORTED_UPLOAD_EXTENSIONS = [
  'pdf',
  'txt',
  'text',
  'log',
  'md',
  'markdown',
  'mdx',
  'html',
  'htm',
  'xhtml',
  'docx',
  'pptx',
  'xlsx',
  'csv',
  'tsv',
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
];

export const UPLOAD_ACCEPT_ATTRIBUTE = SUPPORTED_UPLOAD_EXTENSIONS.map(
  extension => `.${extension}`
).join(',');

export const isSupportedUploadFile = (file: File): boolean => {
  const name = file.name.toLowerCase();
  if (name === 'dockerfile') return true;
  const dot = name.lastIndexOf('.');
  if (dot !== -1 && SUPPORTED_UPLOAD_EXTENSIONS.includes(name.slice(dot + 1))) {
    return true;
  }
  return file.type.startsWith('text/') || file.type === 'application/pdf';
};
