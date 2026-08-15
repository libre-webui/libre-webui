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

import { getPersistence } from '../persistence/index.js';
import { encryptionService } from './encryptionService.js';

const repository = () =>
  getPersistence(encryptionService).repositories.resources.systemSettings;

export const getSystemSetting = (key: string): Promise<string | null> =>
  repository().get(key);

export const getSystemSettings = (
  keys: readonly string[]
): Promise<Record<string, string>> => repository().getMany(keys);

export const setSystemSetting = (key: string, value: string): Promise<void> =>
  repository().upsert(key, value, Date.now());

export const setSystemSettings = (
  values: Readonly<Record<string, string>>
): Promise<void> => repository().upsertMany(values, Date.now());
