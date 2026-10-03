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

import { cn } from '@/utils';

// Literal class names so Tailwind keeps them.
const TINTS = [
  'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  'bg-sky-500/15 text-sky-700 dark:text-sky-300',
  'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  'bg-indigo-500/15 text-indigo-700 dark:text-indigo-300',
  'bg-teal-500/15 text-teal-700 dark:text-teal-300',
  'bg-orange-500/15 text-orange-700 dark:text-orange-300',
];

function tintFor(seed: string): string {
  let hash = 0;
  for (const char of seed.toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return TINTS[hash % TINTS.length];
}

interface ModelMarkProps {
  /** Who made or serves the model; picks the letter and the tint. */
  seed: string;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * A lettered tile for a vendor or provider, so a long list can be scanned
 * by maker without shipping third-party logos. The same seed always gets
 * the same tint.
 */
export function ModelMark({ seed, size = 'sm', className }: ModelMarkProps) {
  const letter = (/[\p{L}\p{N}]/u.exec(seed)?.[0] ?? '?').toUpperCase();
  return (
    <span
      aria-hidden='true'
      className={cn(
        'inline-flex shrink-0 select-none items-center justify-center font-semibold leading-none',
        size === 'md'
          ? 'h-6 w-6 rounded-md text-[11px]'
          : 'h-4 w-4 rounded-sm text-[9px]',
        tintFor(seed),
        className
      )}
    >
      {letter}
    </span>
  );
}
