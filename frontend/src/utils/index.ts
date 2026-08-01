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

import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function isMac(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    /Mac|iPhone|iPad/.test(navigator.platform)
  );
}

// Export demo mode utilities
export * from './demoMode';

const relativeTimeFormatters = new Map<string, Intl.RelativeTimeFormat>();
const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

const getRelativeTimeFormatter = (locale: string): Intl.RelativeTimeFormat => {
  let formatter = relativeTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.RelativeTimeFormat(locale, {
      numeric: 'auto',
      style: 'narrow',
    });
    relativeTimeFormatters.set(locale, formatter);
  }
  return formatter;
};

const getDateTimeFormatter = (locale: string): Intl.DateTimeFormat => {
  let formatter = dateTimeFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale);
    dateTimeFormatters.set(locale, formatter);
  }
  return formatter;
};

export function formatTimestamp(timestamp: number, locale = 'en'): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffInMs = Math.max(0, now.getTime() - date.getTime());
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
  const language = locale.toLowerCase().split('-')[0];

  // Preserve the established compact English labels while localizing other UIs.
  if (language === 'en') {
    if (diffInMinutes < 1) return 'Just now';
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInHours < 24) return `${diffInHours}h ago`;
    if (diffInDays < 7) return `${diffInDays}d ago`;
    return getDateTimeFormatter(locale).format(date);
  }

  const relativeTime = getRelativeTimeFormatter(locale);

  if (diffInMinutes < 1) {
    return relativeTime.format(0, 'second');
  } else if (diffInMinutes < 60) {
    return relativeTime.format(-diffInMinutes, 'minute');
  } else if (diffInHours < 24) {
    return relativeTime.format(-diffInHours, 'hour');
  } else if (diffInDays < 7) {
    return relativeTime.format(-diffInDays, 'day');
  } else {
    return getDateTimeFormatter(locale).format(date);
  }
}

export function formatFileSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)} ${units[unitIndex]}`;
}

export function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export function debounce<T extends (...args: unknown[]) => unknown>(
  func: T,
  delay: number
): (...args: Parameters<T>) => void {
  let timeoutId: NodeJS.Timeout;
  return (...args: Parameters<T>) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => func(...args), delay);
  };
}

/**
 * Parse thinking/chain-of-thought content from assistant messages.
 * Supports [Thinking: ...], <thinking>...</thinking>, and <think>...</think>.
 * While a message is still streaming, an opening marker without its closing
 * counterpart yields the partial thought with `thinkingComplete: false` so the
 * raw chain of thought never renders as answer text.
 */
export interface ParsedThinking {
  thinking: string | null;
  content: string;
  thinkingComplete: boolean;
}

export function parseThinkingContent(content: string): ParsedThinking {
  // Pattern 1: [Thinking: ...]  - matches content between [Thinking: and ]
  // Need to handle nested brackets and multi-line content
  const bracketPattern = /^\[Thinking:\s*([\s\S]*?)\]\s*/i;

  // Patterns 2 and 3: <thinking>...</thinking> and <think>...</think>
  const xmlPattern = /^<thinking>([\s\S]*?)<\/thinking>\s*/i;
  const shortXmlPattern = /^<think>([\s\S]*?)<\/think>\s*/i;

  for (const pattern of [bracketPattern, xmlPattern, shortXmlPattern]) {
    const match = content.match(pattern);
    if (match) {
      return {
        thinking: match[1].trim(),
        content: content.slice(match[0].length).trim(),
        thinkingComplete: true,
      };
    }
  }

  // An opening marker whose closing counterpart has not streamed in yet:
  // everything so far is chain of thought, not answer text.
  const openMarkers: Array<[RegExp, string]> = [
    [/^\[Thinking:\s*/i, ']'],
    [/^<thinking>\s*/i, '</thinking>'],
    [/^<think>\s*/i, '</think>'],
  ];
  for (const [openPattern, closeMarker] of openMarkers) {
    const openMatch = content.match(openPattern);
    if (openMatch && !content.toLowerCase().includes(closeMarker)) {
      return {
        thinking: content.slice(openMatch[0].length).trim() || null,
        content: '',
        thinkingComplete: false,
      };
    }
  }

  // No thinking content found
  return {
    thinking: null,
    content,
    thinkingComplete: true,
  };
}
