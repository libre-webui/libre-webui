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
  'allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads';

export const SVG_ARTIFACT_SANDBOX = '';

export const HTML_ARTIFACT_ALLOW =
  'clipboard-read; clipboard-write; fullscreen; gamepad';

/**
 * Handshake with the backend-served sandbox host. The host announces itself
 * once it is listening, and artifact markup is delivered as a message rather
 * than as `srcdoc`, which would inherit the application's Content Security
 * Policy and block the inline scripts artifacts are made of.
 */
export const ARTIFACT_SANDBOX_READY = 'libre-artifact:ready';
export const ARTIFACT_SANDBOX_RENDER = 'libre-artifact:render';

/**
 * The sandbox host has an opaque origin, so its messages arrive with a `null`
 * origin and can only be attributed by window identity.
 */
export function isArtifactSandboxReady(
  event: MessageEvent,
  frame: HTMLIFrameElement | null
): boolean {
  if (!frame || event.source !== frame.contentWindow) return false;
  const data = event.data as { type?: unknown } | null;
  return Boolean(data) && data?.type === ARTIFACT_SANDBOX_READY;
}

export function postArtifactDocument(
  frame: HTMLIFrameElement | null,
  html: string
): void {
  frame?.contentWindow?.postMessage(
    { type: ARTIFACT_SANDBOX_RENDER, html },
    '*'
  );
}

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

export function buildSvgArtifactDocument(
  content: string,
  title = 'SVG Artifact'
): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
      html, body { width: 100%; height: 100%; margin: 0; }
      body { display: flex; align-items: center; justify-content: center; overflow: auto; }
      svg { max-width: 100%; max-height: 100%; }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

export function openHtmlArtifactPreview(
  content: string,
  sandboxUrl: string,
  title = 'HTML Artifact'
): Window | null {
  const previewWindow = window.open('', '_blank');
  if (!previewWindow) return null;

  // Keep untrusted artifact markup out of the same-origin popup document. The
  // popup only hosts an opaque-origin sandboxed iframe built with DOM APIs.
  previewWindow.opener = null;
  const { document } = previewWindow;
  document.title = title;
  document.documentElement.style.width = '100%';
  document.documentElement.style.height = '100%';
  document.body.style.width = '100%';
  document.body.style.height = '100%';
  document.body.style.margin = '0';
  document.body.replaceChildren();

  const html = buildHtmlArtifactDocument(content, title);
  const iframe = document.createElement('iframe');
  iframe.title = title;
  iframe.src = sandboxUrl;
  iframe.setAttribute('sandbox', HTML_ARTIFACT_SANDBOX);
  iframe.setAttribute('allow', HTML_ARTIFACT_ALLOW);
  iframe.style.width = '100%';
  iframe.style.height = '100%';
  iframe.style.border = '0';

  previewWindow.addEventListener('message', (event: MessageEvent) => {
    if (!isArtifactSandboxReady(event, iframe)) return;
    postArtifactDocument(iframe, html);
  });
  document.body.appendChild(iframe);

  return previewWindow;
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
