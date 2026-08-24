/*
 * Live Work Computer regression: drives the real GUI sandbox image through
 * the deterministic edge-lab fixtures (scripts/fixtures/computer-edge-lab)
 * that first exposed the loop's uncertainty gaps — keyboard focus drift,
 * mid-batch context changes, and unverified outcomes — and asserts the
 * runtime guards that now close them.
 *
 * Requires Docker and a locally built libre-work-computer:latest image;
 * skips cleanly (never fails) when either is missing, so it is safe in the
 * package chain and exercised on GUI-capable machines.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const FIXTURES = path.join(repoRoot, 'scripts', 'fixtures', 'computer-edge-lab');
const IMAGE = 'libre-work-computer:latest';
const NAME = 'lwui-edge-lab-test';

const docker = (args, options = {}) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });

const guiImageAvailable = (() => {
  try {
    docker(['image', 'inspect', IMAGE]);
    return true;
  } catch {
    return false;
  }
})();

// Evaluate a JS expression in the sandbox browser's active edge-lab page
// through the container-loopback DevTools endpoint. No page content beyond
// the requested expression result ever leaves the container.
const CDP_EVAL_SCRIPT = [
  "const expression = process.argv[1];",
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

test(
  'live GUI sandbox: focus assertions, batch fences, and outcome predicates hold on the edge-lab fixtures',
  { skip: guiImageAvailable ? false : 'docker or libre-work-computer:latest unavailable' },
  async () => {
    const { COMPUTER_OBSERVE_SCRIPT, COMPUTER_ACT_SCRIPT, COMPUTER_ANCHOR_SCRIPT } = await import(
      pathToFileURL(
        path.join(repoRoot, 'backend', 'dist', 'services', 'workRuntimeService.js')
      ).href
    );
    const exec = (args, timeout = 120_000) =>
      docker(['exec', '-u', '1000:1000', NAME, ...args], { timeout });
    const observe = () => JSON.parse(exec(['node', '-e', COMPUTER_OBSERVE_SCRIPT]));
    const act = (actions, expect) =>
      JSON.parse(
        exec([
          'node',
          '-e',
          COMPUTER_ACT_SCRIPT,
          '--',
          JSON.stringify(actions),
          JSON.stringify(expect ?? null),
        ])
      );
    const cdpEval = expression =>
      JSON.parse(exec(['node', '-e', CDP_EVAL_SCRIPT, '--', expression]));
    // Screen coordinates of an element's center: page rect plus the browser
    // window's position and chrome offsets.
    const coordsExpression = (selector, scroll) =>
      '(() => { const el = document.querySelector(' +
      JSON.stringify(selector) +
      '); ' +
      (scroll ? "el.scrollIntoView({block: 'center', behavior: 'instant'}); " : '') +
      'const r = el.getBoundingClientRect(); ' +
      'const ox = window.screenX + (window.outerWidth - window.innerWidth) / 2; ' +
      'const oy = window.screenY + (window.outerHeight - window.innerHeight); return {' +
      'x: Math.round(ox + r.x + r.width / 2), y: Math.round(oy + r.y + r.height / 2), ' +
      'left: Math.round(ox + r.x), top: Math.round(oy + r.y) }; })()';
    const coords = selector => cdpEval(coordsExpression(selector, true));
    // Same viewport as the previous coords() call — measuring without
    // scrolling keeps earlier measurements valid.
    const coordsNoScroll = selector =>
      cdpEval(coordsExpression(selector, false));
    const settle = seconds => execFileSync('sleep', [String(seconds)]);

    try {
      docker(['rm', '-f', NAME]);
    } catch {
      /* not running */
    }
    docker(['run', '-d', '--name', NAME, '--memory', '2g', IMAGE, 'sleep', 'infinity']);
    try {
      docker(['exec', '-u', 'root', NAME, 'sh', '-c', 'mkdir -p /workspace/edge-lab && chown -R 1000:1000 /workspace']);
      docker(['cp', path.join(FIXTURES, 'edge-lab.html'), `${NAME}:/workspace/edge-lab/edge-lab.html`]);
      docker(['cp', path.join(FIXTURES, 'edge-lab.js'), `${NAME}:/workspace/edge-lab/edge-lab.js`]);
      exec(['/usr/local/bin/start-computer'], 90_000);
      settle(8);
      cdpEval("location.href = 'file:///workspace/edge-lab/edge-lab.html'");
      // The Sunset Valley start page renders a full procedural scene under
      // SwiftShader; navigating away from it can take beyond 2s cold.
      settle(4);

      // Semantic observation reflects the loaded fixture.
      const loaded = observe();
      assert.match(loaded.url ?? '', /edge-lab\.html$/);
      assert.match(loaded.screenshotSha256 ?? '', /^[0-9a-f]{64}$/);
      assert.ok(Number.isFinite(loaded.windowId));

      // Case D, honest path: click the page field, then type under a focus
      // assertion the real context satisfies. The text must land in the page.
      const field = coords('#focusInput');
      const typed = act([
        { type: 'click', x: field.x, y: field.y },
        { type: 'wait', ms: 400 },
        { type: 'type', text: 'loop check', focus: 'focusInput' },
      ]);
      assert.equal(typed.fence, undefined, JSON.stringify(typed.fence));
      assert.match(
        String(cdpEval("document.querySelector('#focusLog').textContent")),
        /loop check/
      );

      // Case D, the omnibox trap: ctrl+l moves keyboard focus to browser
      // chrome; the asserted type must fence instead of typing there.
      const fencedFocus = act([
        { type: 'key', keys: 'ctrl+l' },
        { type: 'wait', ms: 400 },
        { type: 'type', text: 'must-not-be-typed', focus: 'focusInput' },
      ]);
      assert.equal(fencedFocus.fence?.reason, 'focus_assertion_failed');
      assert.equal(
        cdpEval("document.querySelector('#focusInput').value"),
        'loop check'
      );
      act([{ type: 'key', keys: 'Escape' }]);

      // Case B: an in-page modal is invisible to window-level fences (a
      // documented v1 boundary) but an outcome predicate proves it opened.
      const openModal = coords('#openModal');
      const modal = act(
        [{ type: 'click', x: openModal.x, y: openModal.y }],
        { regionChanged: { x: 440, y: 250, width: 400, height: 250 }, withinMs: 4000 }
      );
      assert.equal(modal.fence, undefined);
      assert.equal(modal.expect?.outcome, 'passed', JSON.stringify(modal.expect));
      const cancel = coords('#cancel');
      act([{ type: 'click', x: cancel.x, y: cancel.y }]);

      // Case G: a new browsing context mid-batch stops the batch before the
      // stale trailing clicks run.
      const newTab = coords('#newTab');
      const fencedTab = act([
        { type: 'click', x: newTab.x, y: newTab.y },
        { type: 'wait', ms: 2000 },
        { type: 'click', x: 10, y: 10 },
        { type: 'click', x: 20, y: 20 },
      ]);
      assert.equal(fencedTab.fence?.reason, 'context_changed');
      assert.ok(fencedTab.fence.afterAction <= 2);
      act([{ type: 'key', keys: 'ctrl+w' }]);

      // An impossible predicate stays honest: pending, never passed.
      const pending = act(
        [{ type: 'move', x: 640, y: 400 }],
        { urlContains: 'no-such-destination.example', withinMs: 1500 }
      );
      assert.equal(pending.expect?.outcome, 'pending');
      assert.deepEqual(pending.expect?.unmet, ['urlContains']);

      // The teach recorder's anchor probe names the element under a screen
      // coordinate — and the page URL — without injecting any input.
      const modalButton = coords('#openModal');
      const anchored = JSON.parse(
        exec([
          'node',
          '-e',
          COMPUTER_ANCHOR_SCRIPT,
          '--',
          String(modalButton.x),
          String(modalButton.y),
        ])
      );
      assert.match(anchored.anchor ?? '', /button#openModal \(OPEN REVIEW\)/);
      assert.match(anchored.url ?? '', /edge-lab\.html$/);
      // Outside the browser viewport the probe degrades to URL-only.
      const offscreen = JSON.parse(
        exec(['node', '-e', COMPUTER_ANCHOR_SCRIPT, '--', '5', '795'])
      );
      assert.equal(offscreen.anchor, undefined);

      // Case F: goal-directed scrolling finds the below-the-fold target and
      // reports a visibility receipt instead of a blind wheel count.
      act([
        {
          type: 'scroll_until',
          direction: 'up',
          target: { edge: 'top' },
          maxAmount: 30,
          x: 640,
          y: 400,
        },
      ]);
      const deep = act([
        {
          type: 'scroll_until',
          direction: 'down',
          target: { text: 'FINALIZE REPORT' },
          maxAmount: 30,
          x: 640,
          y: 400,
        },
      ]);
      const deepReceipt = deep.scrollReceipts?.[0];
      assert.equal(deepReceipt?.found, true, JSON.stringify(deep.scrollReceipts));
      assert.equal(deepReceipt?.visible, true);
      assert.ok(deepReceipt.scrolledUnits > 0);
      const finalize = coords('#deep');
      act([{ type: 'click', x: finalize.x, y: finalize.y }]);
      assert.match(
        String(cdpEval("document.querySelector('#deepLog').textContent")),
        /FINALIZE ACTION FIRED/
      );

      // A click on inert background earns a receipt saying nothing changed.
      const spacer = coords('.spacer');
      const inert = act([{ type: 'click', x: spacer.x, y: spacer.y }]);
      assert.equal(inert.clickReceipts?.[0]?.changed, false);

      // Case E: the export completes 6s after the click. Batch one shows
      // "working…"; batch two starts well before completion, so its region
      // predicate only passes once the late change lands — proving the
      // adaptive polling, not a lucky delay. Coordinates are captured before
      // the click so no exec time is spent mid-window.
      const delayButton = coords('#delay');
      const delayLog = coordsNoScroll('#delayLog');
      act([{ type: 'click', x: delayButton.x, y: delayButton.y }]);
      // The log text is left-aligned in a wide element: anchor the region at
      // its left edge, where the change actually renders.
      const late = act(
        [{ type: 'move', x: 12, y: 12 }],
        {
          regionChanged: {
            x: Math.max(0, delayLog.left),
            y: Math.max(0, delayLog.top),
            width: 300,
            height: 40,
          },
          withinMs: 8000,
        }
      );
      assert.equal(late.expect?.outcome, 'passed', JSON.stringify(late.expect));
      assert.match(
        String(cdpEval("document.querySelector('#delayLog').textContent")),
        /EXPORT COMPLETE/
      );
    } finally {
      try {
        docker(['rm', '-f', NAME]);
      } catch {
        /* already gone */
      }
    }
  }
);
