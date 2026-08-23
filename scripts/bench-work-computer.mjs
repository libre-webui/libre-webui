/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

/**
 * Work Computer replay benchmark: replays the adversarial edge-lab
 * scenarios against the REAL GUI sandbox image and scores the runtime
 * guards — did the focus assertion block unsafe typing, did the fence stop
 * stale actions, did receipts flag dead clicks, did adaptive predicate
 * polling catch late async completion, did semantic scroll actually reach
 * its target — plus wall-clock per scenario. Deterministic scripted
 * batches, no model in the loop: this scores the runtime layer, and its
 * scorecard is the regression baseline for future loop changes.
 *
 *   node scripts/bench-work-computer.mjs [--runs N]
 *
 * Requires Docker and a locally built libre-work-computer:latest image
 * (`docker pull ghcr.io/libre-webui/libre-work-computer:dev` + tag works).
 * Exits 0 with a scorecard, 1 on any scenario failure, 2 when the image is
 * unavailable.
 */

import { guiImageAvailable, startEdgeLab } from './lib/edge-lab-harness.mjs';

const runsArg = process.argv.indexOf('--runs');
const RUNS =
  runsArg >= 0 ? Math.max(1, Number(process.argv[runsArg + 1]) || 1) : 2;

if (!guiImageAvailable()) {
  console.error(
    'bench-work-computer: docker or libre-work-computer:latest unavailable.'
  );
  process.exit(2);
}

const lab = await startEdgeLab('lwui-edge-lab-bench');

/**
 * Each scenario returns { pass, guard, detail } and is measured. `guard`
 * names the protection being scored so the aggregate counts what actually
 * fired, not just green checkmarks.
 */
const SCENARIOS = [
  {
    id: 'A-stale-geometry',
    guard: 'receiptCaughtDeadClick',
    run: () => {
      const arm = lab.coords('#armShift');
      const target = lab.coordsNoScroll('#shiftTarget');
      lab.act([
        { type: 'click', x: arm.x, y: arm.y },
        { type: 'wait', ms: 1500 },
      ]);
      // The target moved 310px right at +900ms; the old coordinate is now
      // empty space. The click receipt must say nothing changed nearby.
      const replay = lab.act([{ type: 'click', x: target.x, y: target.y }]);
      const receipt = replay.clickReceipts?.[0];
      const fired = String(
        lab.cdpEval("document.querySelector('#shiftLog').textContent")
      ).includes('ARCHIVE ACTION FIRED');
      return {
        pass: receipt?.changed === false && !fired,
        detail: `receipt.changed=${receipt?.changed} archiveFired=${fired}`,
      };
    },
  },
  {
    id: 'B-modal-boundary',
    guard: 'predicateVerifiedModal',
    run: () => {
      const open = lab.coords('#openModal');
      const opened = lab.act([{ type: 'click', x: open.x, y: open.y }], {
        regionChanged: { x: 440, y: 250, width: 400, height: 250 },
        withinMs: 4000,
      });
      const cancel = lab.coords('#cancel');
      lab.act([{ type: 'click', x: cancel.x, y: cancel.y }]);
      return {
        pass: opened.expect?.outcome === 'passed',
        detail: `expect=${opened.expect?.outcome}`,
      };
    },
  },
  {
    id: 'D-focus-drift',
    guard: 'unsafeInputBlocked',
    run: () => {
      const field = lab.coords('#focusInput');
      lab.act([
        { type: 'click', x: field.x, y: field.y },
        { type: 'wait', ms: 300 },
      ]);
      const fenced = lab.act([
        { type: 'key', keys: 'ctrl+l' },
        { type: 'wait', ms: 300 },
        { type: 'type', text: 'must-not-leak', focus: 'focusInput' },
      ]);
      lab.act([{ type: 'key', keys: 'Escape' }]);
      const value = String(
        lab.cdpEval("document.querySelector('#focusInput').value")
      );
      return {
        pass:
          fenced.fence?.reason === 'focus_assertion_failed' &&
          !value.includes('must-not-leak'),
        detail: `fence=${fenced.fence?.reason} field=${JSON.stringify(value)}`,
      };
    },
  },
  {
    id: 'E-async-completion',
    guard: 'adaptiveWaitVerified',
    run: () => {
      const button = lab.coords('#delay');
      const log = lab.coordsNoScroll('#delayLog');
      lab.act([{ type: 'click', x: button.x, y: button.y }]);
      const late = lab.act([{ type: 'move', x: 12, y: 12 }], {
        regionChanged: {
          x: Math.max(0, log.left),
          y: Math.max(0, log.top),
          width: 300,
          height: 40,
        },
        withinMs: 8000,
      });
      const text = String(
        lab.cdpEval("document.querySelector('#delayLog').textContent")
      );
      return {
        pass: late.expect?.outcome === 'passed' && text === 'EXPORT COMPLETE',
        detail: `expect=${late.expect?.outcome} log=${JSON.stringify(text)}`,
      };
    },
  },
  {
    id: 'F-semantic-scroll',
    guard: 'scrollTargetReached',
    run: () => {
      lab.act([
        {
          type: 'scroll_until',
          direction: 'up',
          target: { edge: 'top' },
          maxAmount: 30,
          x: 640,
          y: 400,
        },
      ]);
      const deep = lab.act([
        {
          type: 'scroll_until',
          direction: 'down',
          target: { text: 'FINALIZE REPORT' },
          maxAmount: 30,
          x: 640,
          y: 400,
        },
      ]);
      const receipt = deep.scrollReceipts?.[0];
      return {
        pass: receipt?.found === true && receipt?.visible === true,
        detail: `found=${receipt?.found} visible=${receipt?.visible} units=${receipt?.scrolledUnits}`,
      };
    },
  },
  {
    id: 'G-new-context',
    guard: 'staleActionsPrevented',
    run: () => {
      const link = lab.coords('#newTab');
      const fenced = lab.act([
        { type: 'click', x: link.x, y: link.y },
        { type: 'wait', ms: 2000 },
        { type: 'click', x: 10, y: 10 },
        { type: 'click', x: 20, y: 20 },
      ]);
      lab.act([{ type: 'key', keys: 'ctrl+w' }]);
      lab.settle(1);
      const prevented = fenced.fence ? 4 - fenced.fence.afterAction : 0;
      return {
        pass: fenced.fence?.reason === 'context_changed' && prevented >= 2,
        detail: `fence=${fenced.fence?.reason} prevented=${prevented}`,
      };
    },
  },
];

const results = [];
try {
  for (let run = 1; run <= RUNS; run++) {
    for (const scenario of SCENARIOS) {
      lab.reloadFixture();
      const startedAt = Date.now();
      let outcome;
      try {
        outcome = scenario.run();
      } catch (error) {
        outcome = {
          pass: false,
          detail: `error: ${error instanceof Error ? error.message : error}`,
        };
      }
      const ms = Date.now() - startedAt;
      results.push({
        run,
        id: scenario.id,
        guard: scenario.guard,
        ms,
        ...outcome,
      });
      console.log(
        `run ${run}  ${outcome.pass ? 'PASS' : 'FAIL'}  ${scenario.id.padEnd(20)} ${String(ms).padStart(6)}ms  ${outcome.detail}`
      );
    }
  }
} finally {
  lab.stop();
}

const passed = results.filter(result => result.pass);
const guards = {};
for (const result of passed) {
  guards[result.guard] = (guards[result.guard] ?? 0) + 1;
}
const meanMs = {};
for (const scenario of SCENARIOS) {
  const samples = results.filter(result => result.id === scenario.id);
  meanMs[scenario.id] = Math.round(
    samples.reduce((total, sample) => total + sample.ms, 0) / samples.length
  );
}
const scorecard = {
  runs: RUNS,
  scenarios: SCENARIOS.length,
  passRate: Number((passed.length / results.length).toFixed(3)),
  guardsFired: guards,
  meanMs,
  failures: results
    .filter(result => !result.pass)
    .map(result => ({ run: result.run, id: result.id, detail: result.detail })),
};
console.log('\nSCORECARD ' + JSON.stringify(scorecard));
process.exit(scorecard.passRate === 1 ? 0 : 1);
