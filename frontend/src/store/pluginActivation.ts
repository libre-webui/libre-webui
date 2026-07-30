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

import type { ApiResponse } from '@/types';

export const activatePluginAndRefresh = async (
  id: string,
  activatePlugin: (id: string) => Promise<ApiResponse<boolean>>,
  refreshPlugins: () => Promise<void>
): Promise<ApiResponse<boolean>> => {
  const response = await activatePlugin(id);
  if (response.success) {
    await refreshPlugins();
  }
  return response;
};
