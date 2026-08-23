/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Shared harness for driving a real libre-work-computer container through
 * the deterministic edge-lab fixtures: container lifecycle, the production
 * observe/act/anchor scripts, a CDP evaluator, and screen-coordinate
 * helpers. Used by the replay benchmark; the live regression test keeps its
 * own inline copy so a harness change can never silently weaken it.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(
  repoRoot,
  'scripts',
  'fixtures',
  'computer-edge-lab'
);
export const GUI_IMAGE = 'libre-work-computer:latest';

const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

export function guiImageAvailable() {
  try {
    docker(['image', 'inspect', GUI_IMAGE]);
    return true;
  } catch {
    return false;
  }
}

const CDP_EVAL_SCRIPT = [
  'const expression = process.argv[1];',
  'const main = async () => {',
  "  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();",
  "  const page = targets.find(t => t.type === 'page' && String(t.url).includes('edge-lab')) ||",
  "    targets.find(t => t.type === 'page');",
  "  if (!page) throw new Error('no page target');",
  '  const value = await new Promise((resolve, reject) => {',
  '    const socket = new WebSocket(page.webSocketDebuggerUrl);',
  "    const timer = setTimeout(() => reject(new Error('cdp timeout')), 5000);",
  '    socket.onopen = () => socket.send(JSON.stringify({',
  "      id: 1, method: 'Runtime.evaluate',",
  '      params: {expression, returnByValue: true},',
  '    }));',
  '    socket.onmessage = event => {',
  '      clearTimeout(timer);',
  '      try { socket.close(); } catch {}',
  '      resolve(JSON.parse(event.data).result.result.value);',
  '    };',
  "    socket.onerror = () => { clearTimeout(timer); reject(new Error('cdp error')); };",
  '  });',
  '  process.stdout.write(JSON.stringify(value === undefined ? null : value));',
  '};',
  'main().catch(error => { console.error(error.message); process.exit(1); });',
].join('\n');

/**
 * Start a disposable GUI container with the edge-lab fixtures loaded in its
 * browser. Returns the production-script drivers plus a stop() that removes
 * the container.
 */
export async function startEdgeLab(name) {
  const {
    COMPUTER_OBSERVE_SCRIPT,
    COMPUTER_ACT_SCRIPT,
    COMPUTER_ANCHOR_SCRIPT,
  } = await import(
    pathToFileURL(
      path.join(
        repoRoot,
        'backend',
        'dist',
        'services',
        'workRuntimeService.js'
      )
    ).href
  );
  const exec = (args, timeout = 120_000) =>
    docker(['exec', '-u', '1000:1000', name, ...args], { timeout });
  const settle = seconds => execFileSync('sleep', [String(seconds)]);
  const cdpEval = expression =>
    JSON.parse(exec(['node', '-e', CDP_EVAL_SCRIPT, '--', expression]));
  const coordsExpression = (selector, scroll) =>
    '(() => { const el = document.querySelector(' +
    JSON.stringify(selector) +
    '); ' +
    (scroll
      ? "el.scrollIntoView({block: 'center', behavior: 'instant'}); "
      : '') +
    'const r = el.getBoundingClientRect(); ' +
    'const ox = window.screenX + (window.outerWidth - window.innerWidth) / 2; ' +
    'const oy = window.screenY + (window.outerHeight - window.innerHeight); return {' +
    'x: Math.round(ox + r.x + r.width / 2), y: Math.round(oy + r.y + r.height / 2), ' +
    'left: Math.round(ox + r.x), top: Math.round(oy + r.y) }; })()';

  try {
    docker(['rm', '-f', name]);
  } catch {
    /* not running */
  }
  docker([
    'run',
    '-d',
    '--name',
    name,
    '--memory',
    '2g',
    GUI_IMAGE,
    'sleep',
    'infinity',
  ]);
  docker([
    'exec',
    '-u',
    'root',
    name,
    'sh',
    '-c',
    'mkdir -p /workspace/edge-lab && chown -R 1000:1000 /workspace',
  ]);
  docker([
    'cp',
    path.join(FIXTURES, 'edge-lab.html'),
    `${name}:/workspace/edge-lab/edge-lab.html`,
  ]);
  docker([
    'cp',
    path.join(FIXTURES, 'edge-lab.js'),
    `${name}:/workspace/edge-lab/edge-lab.js`,
  ]);
  exec(['/usr/local/bin/start-computer'], 90_000);
  settle(8);
  cdpEval("location.href = 'file:///workspace/edge-lab/edge-lab.html'");
  settle(2);

  return {
    exec,
    settle,
    cdpEval,
    observe: () => JSON.parse(exec(['node', '-e', COMPUTER_OBSERVE_SCRIPT])),
    act: (actions, expect) =>
      JSON.parse(
        exec([
          'node',
          '-e',
          COMPUTER_ACT_SCRIPT,
          '--',
          JSON.stringify(actions),
          JSON.stringify(expect ?? null),
        ])
      ),
    anchorAt: (x, y) =>
      JSON.parse(
        exec(['node', '-e', COMPUTER_ANCHOR_SCRIPT, '--', String(x), String(y)])
      ),
    coords: selector => cdpEval(coordsExpression(selector, true)),
    coordsNoScroll: selector => cdpEval(coordsExpression(selector, false)),
    reloadFixture: () => {
      cdpEval("location.href = 'file:///workspace/edge-lab/edge-lab.html'");
      settle(1.5);
    },
    stop: () => {
      try {
        docker(['rm', '-f', name]);
      } catch {
        /* already gone */
      }
    },
  };
}
