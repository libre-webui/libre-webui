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
 * Entry points the rest of the server uses for the Strands engine. Keeping
 * them here, behind dynamic imports, means the SDK loads only when a turn
 * actually needs it.
 */

let loaded: Promise<typeof import('./engine.js')> | undefined;

export function getStrandsEngine(): Promise<
  import('./engine.js').StrandsEngine
> {
  loaded ??= import('./engine.js');
  return loaded.then(module => module.strandsEngine);
}

/** Cancel live turns during shutdown. A never-loaded engine has none. */
export async function stopStrandsEngine(): Promise<void> {
  if (!loaded) return;
  const engine = await loaded.then(module => module.strandsEngine);
  await engine.stop();
}
