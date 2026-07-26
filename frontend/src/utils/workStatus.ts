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

import type { WorkTaskStatus } from '@/types/work';

export interface WorkStatusPresentation {
  labelKey: string;
  label: string;
  color: string;
  animated: boolean;
}

export const workStatusPresentation: Record<
  WorkTaskStatus,
  WorkStatusPresentation
> = {
  idle: {
    labelKey: 'work.statusLabels.idle',
    label: 'Idle',
    color: 'rgb(255, 255, 255)',
    animated: false,
  },
  preparing: {
    labelKey: 'work.statusLabels.thinking',
    label: 'Thinking',
    color: 'rgb(48, 121, 255)',
    animated: true,
  },
  running: {
    labelKey: 'work.statusLabels.thinking',
    label: 'Thinking',
    color: 'rgb(48, 121, 255)',
    animated: true,
  },
  completed: {
    labelKey: 'work.statusLabels.complete',
    label: 'Complete',
    color: 'rgb(76, 212, 117)',
    animated: false,
  },
  cancelled: {
    labelKey: 'work.statusLabels.needsInput',
    label: 'Needs input',
    color: 'rgb(255, 204, 0)',
    animated: false,
  },
  failed: {
    labelKey: 'work.statusLabels.error',
    label: 'Error',
    color: 'rgb(255, 61, 129)',
    animated: false,
  },
};
