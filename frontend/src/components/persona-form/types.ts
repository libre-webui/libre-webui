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

import type { CreatePersonaRequest, PersonaParameters, Persona } from '@/types';

export interface PersonaFormProps {
  persona: Persona | null;
  onSubmit: () => void;
  onCancel: () => void;
}

export interface ExtendedFormData extends CreatePersonaRequest {
  embedding_model?: string;
  memory_settings?: {
    enabled: boolean;
    max_memories: number;
    auto_cleanup: boolean;
    retention_days: number;
  };
  mutation_settings?: {
    enabled: boolean;
    sensitivity: 'low' | 'medium' | 'high';
    auto_adapt: boolean;
  };
}

export type PersonaFormTab =
  'basic' | 'parameters' | 'memory' | 'bindings' | 'advanced';

export interface MemoryStatus {
  status: 'active' | 'wiped' | 'backed_up';
  memory_count: number;
  last_backup?: number;
  size_mb: number;
}

export interface ParameterSliderConfig {
  key: keyof PersonaParameters;
  label: string;
  min: number;
  max: number;
  step: number;
  hint: string;
  format: (value: number) => string;
}

export type UpdatePersonaSettings = <
  T extends 'memory_settings' | 'mutation_settings',
>(
  settingsKey: T,
  updates: Partial<NonNullable<ExtendedFormData[T]>>
) => void;
