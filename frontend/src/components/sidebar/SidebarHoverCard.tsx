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

import React from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { formatTimestamp } from '@/utils';

interface SidebarHoverCardProps {
  top: number;
  left: number;
  title: string;
  timestamp: number;
  children?: React.ReactNode;
}

/**
 * The floating preview card shown when hovering a sidebar list row.
 * Shared between the chat and Work lists so both read as one surface.
 */
export function SidebarHoverCard({
  top,
  left,
  title,
  timestamp,
  children,
}: SidebarHoverCardProps) {
  const { i18n } = useTranslation();

  return createPortal(
    <div
      role='tooltip'
      className='pointer-events-none fixed z-[70] hidden w-72 rounded-2xl border border-black/[0.07] bg-surface/95 p-3.5 shadow-[0_16px_48px_rgba(15,23,42,0.18)] backdrop-blur-xl animate-scale-in dark:border-white/[0.09] dark:bg-dark-100/95 md:block'
      style={{
        top: Math.max(8, Math.min(top, window.innerHeight - 220)),
        left,
      }}
    >
      <p className='mb-1 truncate text-[13px] font-semibold text-gray-900 dark:text-dark-900'>
        {title}
      </p>
      <p className='mb-2 text-[10px] tabular-nums text-gray-400 dark:text-dark-500'>
        {formatTimestamp(timestamp, i18n.language)}
      </p>
      {children}
    </div>,
    document.body
  );
}
