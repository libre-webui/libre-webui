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

import type { ChangeEvent, ReactNode, Ref } from 'react';
import type { OllamaModel, Persona } from '@/types';
import type { ModelSourceKind } from '@/utils/modelSelectorGroups';

/** One source as the list renders it, after search and any preview cut. */
export interface ModelGroup {
  key: string;
  kind: ModelSourceKind;
  label: string;
  icon: ReactNode;
  models: OllamaModel[];
  /** Matching models in the source, including any the preview hides. */
  total: number;
  /** Matching models left out of a combined-view preview. */
  hidden: number;
  /** False when a single source is shown and its chip already names it. */
  showHeader: boolean;
}

export interface LibraryModel {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
}

export interface ModelSelectorProps {
  models: OllamaModel[];
  selectedModel: string;
  onModelChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  currentPersona?: Persona | null;
  className?: string;
  disabled?: boolean;
  compact?: boolean;
  showImageGen?: boolean;
  onModelsRefresh?: () => void;
  getModelValue?: (model: OllamaModel) => string;
  getModelLabel?: (model: OllamaModel) => string;
  getModelTitle?: (model: OllamaModel) => string;
  triggerRef?: Ref<HTMLButtonElement>;
  triggerTestId?: string;
  selectTestId?: string;
  ariaLabel?: string;
}

export interface PullProgress {
  status: string;
  percent?: number;
}

export type TabType = 'installed' | 'ollama' | 'huggingface';
