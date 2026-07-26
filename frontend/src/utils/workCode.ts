/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the 'License');
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at:
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an 'AS IS' BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Plugin } from 'prettier';

type FormatterFamily =
  'babel' | 'typescript' | 'postcss' | 'html' | 'markdown' | 'yaml';

interface FormatterConfig {
  family: FormatterFamily;
  parser: string;
}

export const WORK_FORMAT_MAX_CHARACTERS = 100_000;
export const WORK_FORMAT_MAX_LINES = 4_000;

const languageByExtension: Record<string, string> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  csh: 'bash',
  css: 'css',
  cts: 'typescript',
  cxx: 'cpp',
  diff: 'diff',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  htm: 'markup',
  html: 'markup',
  java: 'java',
  js: 'javascript',
  json: 'json',
  json5: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  less: 'css',
  md: 'markdown',
  mdx: 'markdown',
  mjs: 'javascript',
  mts: 'typescript',
  patch: 'diff',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  scss: 'css',
  sh: 'bash',
  sql: 'sql',
  svg: 'markup',
  swift: 'swift',
  ts: 'typescript',
  tsx: 'tsx',
  xml: 'markup',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
};

const languageByFilename: Record<string, string> = {
  '.bashrc': 'bash',
  '.zshrc': 'bash',
};

const formatterByExtension: Record<string, FormatterConfig> = {
  cjs: { family: 'babel', parser: 'babel' },
  css: { family: 'postcss', parser: 'css' },
  cts: { family: 'typescript', parser: 'typescript' },
  htm: { family: 'html', parser: 'html' },
  html: { family: 'html', parser: 'html' },
  js: { family: 'babel', parser: 'babel' },
  json: { family: 'babel', parser: 'json' },
  json5: { family: 'babel', parser: 'json5' },
  jsonc: { family: 'babel', parser: 'json' },
  jsx: { family: 'babel', parser: 'babel' },
  less: { family: 'postcss', parser: 'less' },
  md: { family: 'markdown', parser: 'markdown' },
  mdx: { family: 'markdown', parser: 'mdx' },
  mjs: { family: 'babel', parser: 'babel' },
  mts: { family: 'typescript', parser: 'typescript' },
  scss: { family: 'postcss', parser: 'scss' },
  ts: { family: 'typescript', parser: 'typescript' },
  tsx: { family: 'typescript', parser: 'typescript' },
  yaml: { family: 'yaml', parser: 'yaml' },
  yml: { family: 'yaml', parser: 'yaml' },
};

const filename = (path: string): string =>
  path.split(/[\\/]/).pop()?.toLowerCase() ?? '';

const extension = (path: string): string => {
  const name = filename(path);
  const dot = name.lastIndexOf('.');
  return dot > -1 ? name.slice(dot + 1) : '';
};

export const detectWorkLanguage = (path: string): string => {
  const name = filename(path);
  return (
    languageByFilename[name] ?? languageByExtension[extension(path)] ?? 'text'
  );
};

const formatterConfig = (path: string): FormatterConfig | undefined =>
  formatterByExtension[extension(path)];

export const canFormatWorkFile = (path: string): boolean =>
  formatterConfig(path) !== undefined;

export const isWorkCodeFormatSizeSupported = (source: string): boolean => {
  if (source.length > WORK_FORMAT_MAX_CHARACTERS) return false;
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) !== 10) continue;
    lines += 1;
    if (lines > WORK_FORMAT_MAX_LINES) return false;
  }
  return true;
};

const plugin = async (module: Promise<{ default: Plugin }>): Promise<Plugin> =>
  (await module).default;

const loadFormatterPlugins = async (
  config: FormatterConfig,
  source: string
): Promise<Plugin[]> => {
  switch (config.family) {
    case 'babel':
      return Promise.all([
        plugin(import('prettier/plugins/babel')),
        plugin(import('prettier/plugins/estree')),
      ]);
    case 'typescript':
      return Promise.all([
        plugin(import('prettier/plugins/typescript')),
        plugin(import('prettier/plugins/estree')),
      ]);
    case 'postcss':
      return [await plugin(import('prettier/plugins/postcss'))];
    case 'html': {
      const plugins = [await plugin(import('prettier/plugins/html'))];
      if (/<script\b/i.test(source)) {
        plugins.push(
          await plugin(import('prettier/plugins/babel')),
          await plugin(import('prettier/plugins/estree'))
        );
      }
      if (/<script\b[^>]*\blang\s*=\s*["']?(?:ts|typescript)/i.test(source)) {
        plugins.push(await plugin(import('prettier/plugins/typescript')));
      }
      if (/<style\b/i.test(source)) {
        plugins.push(await plugin(import('prettier/plugins/postcss')));
      }
      return [...new Set(plugins)];
    }
    case 'markdown': {
      const plugins = [await plugin(import('prettier/plugins/markdown'))];
      const fence = (languages: string) =>
        new RegExp(
          `^(?: {0,3})(?:\`{3,}|~{3,})\\s*(?:${languages})(?:\\s|$)`,
          'im'
        ).test(source);

      if (config.parser === 'mdx') {
        plugins.push(
          await plugin(import('prettier/plugins/babel')),
          await plugin(import('prettier/plugins/estree'))
        );
      }
      if (fence('js|jsx|javascript|json|json5|jsonc')) {
        plugins.push(
          await plugin(import('prettier/plugins/babel')),
          await plugin(import('prettier/plugins/estree'))
        );
      }
      if (fence('ts|tsx|typescript')) {
        plugins.push(
          await plugin(import('prettier/plugins/typescript')),
          await plugin(import('prettier/plugins/estree'))
        );
      }
      if (fence('css|scss|less')) {
        plugins.push(await plugin(import('prettier/plugins/postcss')));
      }
      if (fence('html')) {
        plugins.push(
          await plugin(import('prettier/plugins/html')),
          await plugin(import('prettier/plugins/babel')),
          await plugin(import('prettier/plugins/estree')),
          await plugin(import('prettier/plugins/typescript')),
          await plugin(import('prettier/plugins/postcss'))
        );
      }
      if (fence('yaml|yml')) {
        plugins.push(await plugin(import('prettier/plugins/yaml')));
      }
      return [...new Set(plugins)];
    }
    case 'yaml':
      return [await plugin(import('prettier/plugins/yaml'))];
  }
};

export const formatWorkCode = async (
  path: string,
  source: string
): Promise<string> => {
  const config = formatterConfig(path);
  if (!config) {
    throw new Error(
      `Formatting is not supported for “${filename(path) || path}”.`
    );
  }
  if (!isWorkCodeFormatSizeSupported(source)) {
    throw new Error(
      `Could not format “${filename(path) || path}”: files are limited to ${WORK_FORMAT_MAX_CHARACTERS.toLocaleString()} characters and ${WORK_FORMAT_MAX_LINES.toLocaleString()} lines.`
    );
  }

  try {
    const [{ format }, plugins] = await Promise.all([
      import('prettier/standalone'),
      loadFormatterPlugins(config, source),
    ]);
    return await format(source, {
      parser: config.parser,
      plugins,
      tabWidth: 2,
      useTabs: false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not format “${filename(path) || path}”: ${detail}`);
  }
};
