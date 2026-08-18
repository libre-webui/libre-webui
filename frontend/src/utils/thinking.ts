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

import type { ThinkingPreference } from '@/types';

/**
 * The thinking setting as a select shows it. `default` is the absence of a
 * setting, which is not the same as `off`: one leaves the model's own habit
 * alone, the other asks it to stop reasoning.
 */
export const THINKING_CHOICES = [
  'default',
  'off',
  'on',
  'low',
  'medium',
  'high',
] as const;

export type ThinkingChoice = (typeof THINKING_CHOICES)[number];

export function thinkingChoiceOf(
  think: ThinkingPreference | null | undefined
): ThinkingChoice {
  if (think === undefined || think === null) return 'default';
  if (think === true) return 'on';
  if (think === false) return 'off';
  return think;
}

/**
 * `null` rather than `undefined` for "default": a key left out of a saved
 * settings object merges into whatever was stored before it, so clearing a
 * choice has to be something the request can actually carry.
 */
export function thinkingPreferenceOf(
  choice: string
): ThinkingPreference | null {
  switch (choice) {
    case 'on':
      return true;
    case 'off':
      return false;
    case 'low':
    case 'medium':
    case 'high':
      return choice;
    default:
      return null;
  }
}

/** Whether a setting asks the model to reason. Unset defers to the model. */
export function isThinkingEnabled(
  think: ThinkingPreference | null | undefined
): boolean {
  return think !== undefined && think !== null && think !== false;
}
