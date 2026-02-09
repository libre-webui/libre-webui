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
import {
  Wrench,
  Search,
  Terminal,
  Globe,
  Database,
  FileText,
  Image,
} from 'lucide-react';
import { cn } from '@/utils';
import { ToolActivity } from '@/types';

interface ToolActivityIndicatorProps {
  tools: ToolActivity[];
  className?: string;
}

const TOOL_ICONS: Record<string, React.ElementType> = {
  web_search: Search,
  web_fetch: Globe,
  exec: Terminal,
  browser: Globe,
  Read: FileText,
  Write: FileText,
  Edit: FileText,
  image: Image,
  memory_search: Database,
  memory_get: Database,
  working: Wrench,
  thinking: Wrench,
  default: Wrench,
};

const TOOL_LABELS: Record<string, string> = {
  web_search: 'Searching the web',
  web_fetch: 'Fetching page',
  exec: 'Running command',
  browser: 'Using browser',
  Read: 'Reading file',
  Write: 'Writing file',
  Edit: 'Editing file',
  image: 'Analyzing image',
  memory_search: 'Searching memory',
  memory_get: 'Reading memory',
  cron: 'Managing schedule',
  message: 'Sending message',
  tts: 'Generating speech',
  nodes: 'Checking devices',
  sessions_spawn: 'Spawning agent',
  canvas: 'Rendering canvas',
  process: 'Managing process',
  working: 'Using tools',
  thinking: 'Thinking',
};

export const ToolActivityIndicator: React.FC<ToolActivityIndicatorProps> = ({
  tools,
  className,
}) => {
  if (tools.length === 0) return null;

  // Show only active tools (not yet completed)
  const activeTools = tools.filter(t => t.phase !== 'result');
  // Show completed tools briefly
  const recentlyCompleted = tools.filter(
    t => t.phase === 'result' && Date.now() - t.startedAt < 2000
  );

  const visibleTools = [...activeTools, ...recentlyCompleted];
  if (visibleTools.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-1 py-2 px-1', className)}>
      {visibleTools.map(tool => {
        const Icon = TOOL_ICONS[tool.name] || TOOL_ICONS.default;
        const label = TOOL_LABELS[tool.name] || `Using ${tool.name}`;
        const isComplete = tool.phase === 'result';

        return (
          <div
            key={tool.toolCallId}
            className={cn(
              'flex items-center gap-2 text-sm transition-all duration-300',
              isComplete
                ? 'text-green-600 dark:text-green-400 ophelia:text-[#22c55e] opacity-60'
                : 'text-gray-500 dark:text-gray-400 ophelia:text-[#a3a3a3]'
            )}
          >
            <div
              className={cn(
                'flex items-center justify-center w-5 h-5',
                !isComplete && 'animate-spin-slow'
              )}
            >
              <Icon className='h-3.5 w-3.5' />
            </div>
            <span className='text-xs font-medium'>
              {isComplete ? `✓ ${label}` : `${label}…`}
            </span>
            {!isComplete && (
              <div className='flex gap-0.5'>
                <div
                  className='w-1 h-1 bg-current rounded-full animate-bounce'
                  style={{ animationDelay: '0ms' }}
                />
                <div
                  className='w-1 h-1 bg-current rounded-full animate-bounce'
                  style={{ animationDelay: '150ms' }}
                />
                <div
                  className='w-1 h-1 bg-current rounded-full animate-bounce'
                  style={{ animationDelay: '300ms' }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
