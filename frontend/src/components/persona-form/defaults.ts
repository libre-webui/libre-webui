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

import type { ExtendedFormData } from './types';

export const DEFAULT_FORM_DATA: ExtendedFormData = {
  name: '',
  description: '',
  model: '',
  parameters: {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    context_window: 4096,
    max_tokens: 1024,
    system_prompt: '',
    repeat_penalty: 1.1,
    presence_penalty: 0.0,
    frequency_penalty: 0.0,
  },
  avatar: '',
  background: '',
  embedding_model: '',
  memory_settings: {
    enabled: false,
    max_memories: 1000,
    auto_cleanup: true,
    retention_days: 90,
  },
  mutation_settings: {
    enabled: false,
    sensitivity: 'medium',
    auto_adapt: true,
  },
};
