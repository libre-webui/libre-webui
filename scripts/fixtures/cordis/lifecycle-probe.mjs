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
 * A lifecycle probe mounted as a Cordis row.
 *
 * The bridge's rollback guarantee is a claim about effects, not about a status
 * field, so the tests need a plugin whose service, event listener, and cleanup
 * are each independently observable. This fixture reports every lifecycle
 * transition through an injected recorder, letting a test assert that unloading
 * the row really withdrew the service and released the listener rather than
 * merely hiding them.
 *
 * @module scripts/fixtures/cordis/lifecycle-probe
 */

import { Service } from '@deepseek-ai/cordis';

/** Plugin name reported to Cordis diagnostics. */
export const name = 'test-lifecycle-probe';

/** Name of the service this probe publishes. */
export const PROBE_SERVICE = 'testLifecycleProbe';

/** Event the probe listens for and re-emits, to prove listener ownership. */
export const PROBE_EVENT = 'test/probe-ping';

/** The probe's own service, so its withdrawal is observable. */
class LifecycleProbe extends Service {
  static provide = PROBE_SERVICE;

  /** How many times the probe's listener observed {@link PROBE_EVENT}. */
  pings = 0;

  constructor(ctx) {
    super(ctx, PROBE_SERVICE);
    ctx.on(PROBE_EVENT, () => {
      this.pings += 1;
    });
  }
}

/**
 * Mount the probe.
 * @param ctx - the row's context.
 * @param config - `recorder` names a global array receiving lifecycle strings.
 */
export function apply(ctx, config = {}) {
  const record = entry => {
    const recorder = globalThis[config.recorder ?? '__cordisProbeLog'];
    if (Array.isArray(recorder)) recorder.push(entry);
  };
  record('apply');
  ctx.plugin(LifecycleProbe);
  ctx.effect(
    () => () => {
      record('dispose');
    },
    'test-lifecycle-probe.teardown'
  );
}
