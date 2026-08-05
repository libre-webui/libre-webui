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
 * Renders a Mermaid artifact inside the sandbox frame. The diagram source
 * arrives in an inert script tag; a syntax error is shown in place rather than
 * left as an empty frame.
 */

import mermaid from 'mermaid';

const SOURCE_ELEMENT_ID = 'libre-artifact-source';
const ROOT_ELEMENT_ID = 'root';

const run = async () => {
  const source =
    document.getElementById(SOURCE_ELEMENT_ID)?.textContent?.trim() ?? '';
  const root = document.getElementById(ROOT_ELEMENT_ID);
  if (!root) return;

  const dark = document.documentElement.dataset.colorScheme === 'dark';
  mermaid.initialize({
    startOnLoad: false,
    theme: dark ? 'dark' : 'default',
    securityLevel: 'strict',
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  });

  try {
    const { svg } = await mermaid.render('libre-artifact-diagram', source);
    root.innerHTML = svg;
  } catch (error) {
    const panel = document.createElement('pre');
    panel.setAttribute('data-testid', 'artifact-runtime-error');
    panel.style.cssText =
      'margin:16px;padding:16px;border:1px solid #f0a5a5;border-radius:12px;' +
      'background:#fff5f5;color:#7f1d1d;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'white-space:pre-wrap;word-break:break-word;';
    panel.textContent = `This diagram could not be drawn.\n\n${
      error instanceof Error ? error.message : String(error)
    }`;
    root.replaceChildren(panel);
  }
};

void run();
