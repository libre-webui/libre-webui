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
 * Deterministic model adapter used by the Cordis bridge tests.
 *
 * The tests must prove that a chat turn streams an assistant response without
 * depending on a live model, a network, or a credential. This adapter answers
 * every request with fixed text, so the assertions can be exact rather than
 * tolerant, and the suite stays offline and reproducible.
 *
 * It is a Cordis plugin row like any other provider adapter, which also makes
 * it a working example of the documented adapter contract: declare `inject`,
 * register with `ctx.llm.registerAdapter`, and return the registration's
 * disposer from `ctx.effect` so unload releases the routes.
 *
 * @module scripts/fixtures/cordis/fake-adapter
 */

import { LlmAdapter } from '@deepseek-ai/dsh-llm';

/** Plugin name reported to Cordis diagnostics. */
export const name = 'test-fake-llm-adapter';

/** The LLM service must exist before this adapter can register a route. */
export const inject = ['llm'];

/** Text every fake response contains. */
export const FAKE_REPLY_TEXT = 'Hello from the fake model.';

/** A provider adapter that answers every request with fixed text. */
class FakeAdapter extends LlmAdapter {
  async *stream() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: FAKE_REPLY_TEXT };
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: FAKE_REPLY_TEXT },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

/**
 * Register the fake adapter for the configured route.
 * @param ctx - the row's context, carrying `llm`.
 * @param config - `route` names the provider route to claim.
 */
export function apply(ctx, config) {
  const adapter = new FakeAdapter();
  // The registration is fiber-owned, so removing the row releases the route
  // instead of leaving a dangling provider behind.
  ctx.effect(() => {
    const registration = ctx.llm.registerAdapter([config.route], adapter);
    return () => registration();
  }, 'fake-adapter.register');
}
