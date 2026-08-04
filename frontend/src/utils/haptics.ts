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

import { useAppStore } from '@/store/appStore';

export type HapticFeedback = 'selection' | 'impact' | 'success' | 'warning';

const HAPTIC_PATTERNS: Record<HapticFeedback, number | number[]> = {
  selection: 8,
  impact: 14,
  success: [10, 28, 12],
  warning: [18, 42, 18],
};

const hasCoarsePointer = () => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.('(pointer: coarse)').matches === true
  );
};

export const canUseHapticFeedback = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.vibrate === 'function' &&
  hasCoarsePointer();

/**
 * Android browsers implement the Vibration API. Unsupported platforms,
 * including iOS Safari, intentionally fall through without an error.
 */
export const triggerHapticFeedback = (
  feedback: HapticFeedback = 'selection'
) => {
  if (
    useAppStore.getState().preferences.hapticFeedbackEnabled !== true ||
    !canUseHapticFeedback()
  ) {
    return false;
  }

  return navigator.vibrate(HAPTIC_PATTERNS[feedback]);
};
