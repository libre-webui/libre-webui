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

interface EventChipProps {
  event: CalendarEvent;
  label: string;
  onClick: () => void;
}

/**
 * One event pill in a grid cell. Recurring occurrences render slightly
 * translucent so the source event stands out from its projections.
 */
export function EventChip({ event, label, onClick }: EventChipProps) {
  return (
    <button
      type='button'
      data-testid='calendar-event-chip'
      title={event.title}
      onClick={e => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        'w-full truncate rounded-md bg-primary-500/15 px-1.5 py-0.5 text-start text-[11px] leading-4 text-primary-700 transition-colors hover:bg-primary-500/25 dark:text-primary-300',
        event.baseEventId && 'opacity-75'
      )}
    >
      {label}
    </button>
  );
}
