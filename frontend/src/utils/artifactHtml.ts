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

export const HTML_ARTIFACT_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-pointer-lock allow-downloads';

export const HTML_ARTIFACT_ALLOW =
  'clipboard-read; clipboard-write; fullscreen; gamepad';

const DEFAULT_FRAGMENT_STYLE = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    margin: 0;
    padding: 16px;
    background: white;
    color: #333;
  }
  * { box-sizing: border-box; }
`;

export function isFullHtmlDocument(content: string): boolean {
  const trimmed = content.trim();

  return (
    /^<!doctype\s+html/i.test(trimmed) ||
    /<html[\s>]/i.test(trimmed) ||
    (/<head[\s>]/i.test(trimmed) && /<body[\s>]/i.test(trimmed))
  );
}

export function mergeHtmlArtifactFiles(
  htmlContent: string,
  styleBlocks: string[],
  scriptBlocks: string[]
): string {
  let merged = htmlContent.trim();

  if (styleBlocks.length > 0) {
    const styles = `\n<style>\n${styleBlocks.join('\n\n')}\n</style>\n`;
    merged = injectIntoHead(merged, styles);
  }

  if (scriptBlocks.length > 0) {
    const scripts = `\n<script>\n${scriptBlocks.join('\n\n')}\n</script>\n`;
    merged = injectBeforeBodyClose(merged, scripts);
  }

  return merged;
}

export function buildHtmlArtifactDocument(
  content: string,
  title = 'HTML Artifact'
): string {
  const trimmed = content.trim();

  if (isFullHtmlDocument(trimmed)) {
    return ensurePreviewHeadTags(trimmed, title);
  }

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <base target="_blank">
    <title>${escapeHtml(title)}</title>
    <style>${DEFAULT_FRAGMENT_STYLE}</style>
  </head>
  <body>
    ${trimmed}
  </body>
</html>`;
}

function ensurePreviewHeadTags(htmlContent: string, title: string): string {
  let html = htmlContent;

  if (!/<head[\s>]/i.test(html)) {
    html = html.replace(/<html([^>]*)>/i, '<html$1><head></head>');
  }

  const tags: string[] = [];
  if (!/<meta\s+charset=/i.test(html)) {
    tags.push('<meta charset="UTF-8">');
  }
  if (!/<meta\s+name=["']viewport["']/i.test(html)) {
    tags.push(
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">'
    );
  }
  if (!/<base\s/i.test(html)) {
    tags.push('<base target="_blank">');
  }
  if (!/<title[\s>]/i.test(html)) {
    tags.push(`<title>${escapeHtml(title)}</title>`);
  }

  if (tags.length === 0) {
    return html;
  }

  return injectAfterHeadOpen(html, `\n    ${tags.join('\n    ')}`);
}

function injectAfterHeadOpen(htmlContent: string, payload: string): string {
  if (/<head[^>]*>/i.test(htmlContent)) {
    return htmlContent.replace(/<head([^>]*)>/i, `<head$1>${payload}`);
  }

  return `${payload}\n${htmlContent}`;
}

function injectIntoHead(htmlContent: string, payload: string): string {
  if (/<\/head>/i.test(htmlContent)) {
    return htmlContent.replace(/<\/head>/i, `${payload}</head>`);
  }

  if (/<html[^>]*>/i.test(htmlContent)) {
    return htmlContent.replace(
      /<html([^>]*)>/i,
      `<html$1><head>${payload}</head>`
    );
  }

  return `${payload}${htmlContent}`;
}

function injectBeforeBodyClose(htmlContent: string, payload: string): string {
  if (/<\/body>/i.test(htmlContent)) {
    return htmlContent.replace(/<\/body>/i, `${payload}</body>`);
  }

  return `${htmlContent}${payload}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
