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

import type { ChangeEvent, ReactNode } from 'react';
import type { OllamaModel, Persona } from '@/types';

export interface ModelGroup {
  type: 'personas' | 'ollama' | 'plugins';
  label: string;
  icon: ReactNode;
  models: OllamaModel[];
  color: string;
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
}

export interface PullProgress {
  status: string;
  percent?: number;
}

export type TabType = 'installed' | 'ollama' | 'huggingface';
