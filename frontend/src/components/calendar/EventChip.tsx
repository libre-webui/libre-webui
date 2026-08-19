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

import React from 'react';
import type { CalendarEvent } from '@/types';
import { cn } from '@/utils';

/**
 * What a grid cell can display: user events plus projected automation
 * occurrences and finished runs. Only `event` variants are persisted
 * calendar rows; the rest are computed for display.
 */
export interface CalendarDisplayEvent extends CalendarEvent {
  variant?: 'event' | 'automation' | 'runSucceeded' | 'runFailed';
  /** Set on finished runs so clicking opens the produced chat. */
  sessionId?: string;
}

interface EventChipProps {
  event: CalendarDisplayEvent;
  label: string;
  onClick: () => void;
}

const VARIANT_CLASSES: Record<string, string> = {
  event:
    'bg-primary-500/15 text-primary-700 hover:bg-primary-500/25 dark:text-primary-300',
  automation:
    'bg-amber-500/15 text-amber-700 hover:bg-amber-500/25 dark:text-amber-300',
  runSucceeded:
    'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-300',
  runFailed: 'bg-red-500/15 text-red-700 hover:bg-red-500/25 dark:text-red-300',
};

/**
 * One event pill in a grid cell. Recurring occurrences render slightly
 * translucent so the source event stands out from its projections.
 */
export function EventChip({ event, label, onClick }: EventChipProps) {
  return (
    <button
      type='button'
      data-testid='calendar-event-chip'
      data-variant={event.variant ?? 'event'}
      title={event.title}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'w-full truncate rounded-md px-1.5 py-0.5 text-start text-[11px] leading-4 transition-colors',
        VARIANT_CLASSES[event.variant ?? 'event'],
        event.baseEventId && 'opacity-75'
      )}
    >
      {label}
    </button>
  );
}
