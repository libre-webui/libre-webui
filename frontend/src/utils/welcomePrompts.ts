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

const WELCOME_PROMPT_STORAGE_KEY = 'welcomePromptIndex';

export const WELCOME_PROMPT_CHANGE_EVENT = 'libre:welcome-prompt-change';

export const WELCOME_PROMPT_IDS = [
  'time',
  'create',
  'explore',
  'imagine',
  'focus',
  'untangle',
  'momentum',
  'open',
  'challenge',
  'draft',
  'possibility',
  'unexpected',
] as const;

export type WelcomePromptId = (typeof WELCOME_PROMPT_IDS)[number];

let inMemoryPromptIndex = 0;

const isValidPromptIndex = (value: number) =>
  Number.isInteger(value) && value >= 0 && value < WELCOME_PROMPT_IDS.length;

export const getWelcomePromptIndex = (): number => {
  if (typeof window === 'undefined') {
    return inMemoryPromptIndex;
  }

  try {
    const storedValue = window.sessionStorage.getItem(
      WELCOME_PROMPT_STORAGE_KEY
    );
    const parsedValue = Number(storedValue);

    if (storedValue !== null && isValidPromptIndex(parsedValue)) {
      inMemoryPromptIndex = parsedValue;
    }
  } catch {
    // Session storage can be unavailable in privacy-restricted contexts.
  }

  return inMemoryPromptIndex;
};

export const advanceWelcomePrompt = (): number => {
  const nextIndex = (getWelcomePromptIndex() + 1) % WELCOME_PROMPT_IDS.length;
  inMemoryPromptIndex = nextIndex;

  if (typeof window !== 'undefined') {
    try {
      window.sessionStorage.setItem(
        WELCOME_PROMPT_STORAGE_KEY,
        String(nextIndex)
      );
    } catch {
      // The in-memory value still keeps the interaction working.
    }

    window.dispatchEvent(new Event(WELCOME_PROMPT_CHANGE_EVENT));
  }

  return nextIndex;
};

export const getWelcomePromptId = (index: number): WelcomePromptId =>
  WELCOME_PROMPT_IDS[index] ?? 'time';
