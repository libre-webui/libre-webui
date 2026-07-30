/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApiResponse } from '@/types';
import { activatePluginAndRefresh } from './pluginActivation';

test('activation reloads the catalog only after server-side discovery completes', async () => {
  let resolveActivation: ((response: ApiResponse<boolean>) => void) | undefined;
  let catalogRequests = 0;
  let visibleModels: string[] = [];

  const activation = activatePluginAndRefresh(
    'custom-provider',
    () =>
      new Promise(resolve => {
        resolveActivation = resolve;
      }),
    async () => {
      catalogRequests += 1;
      visibleModels = ['discovered-model'];
    }
  );
  await Promise.resolve();

  assert.equal(catalogRequests, 0);
  assert.deepEqual(visibleModels, []);

  assert.ok(resolveActivation);
  resolveActivation({ success: true, data: true });
  assert.deepEqual(await activation, { success: true, data: true });

  assert.equal(catalogRequests, 1);
  assert.deepEqual(visibleModels, ['discovered-model']);
});
