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
 * Lazy loader for the Strands harness.
 *
 * Importing the harness pulls in the SDK's bash tool, which installs SIGINT
 * and SIGTERM handlers that call process.exit(0), plus exit hooks for shell
 * sessions this server never starts. Those would cut Libre WebUI's graceful
 * shutdown short, so any process listeners added during the import are
 * removed again. The import is deferred until the engine is first used, so
 * servers with Strands disabled never load it.
 */

type HarnessModule = typeof import('@strands-agents/harness');

const WATCHED_EVENTS = ['SIGINT', 'SIGTERM', 'exit', 'beforeExit'] as const;

let harness: Promise<HarnessModule> | undefined;

export function loadHarness(): Promise<HarnessModule> {
  harness ??= (async () => {
    const before = new Map(
      WATCHED_EVENTS.map(event => [event, new Set(process.listeners(event))])
    );
    try {
      return await import('@strands-agents/harness');
    } finally {
      for (const event of WATCHED_EVENTS) {
        const existing = before.get(event)!;
        for (const listener of process.listeners(event)) {
          if (!existing.has(listener)) {
            process.removeListener(
              event,
              listener as (...args: unknown[]) => void
            );
          }
        }
      }
    }
  })();
  harness.catch(() => {
    harness = undefined;
  });
  return harness;
}
