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

import { useLayoutEffect, useRef, type ReactNode } from 'react';

interface SidebarScrollAreaProps {
  children: ReactNode;
  'data-testid': string;
}

export function SidebarScrollArea({
  children,
  'data-testid': testId,
}: SidebarScrollAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scrollArea = scrollRef.current;
    const content = contentRef.current;
    if (!scrollArea || !content) return;

    let frame: number | null = null;
    const updateFade = () => {
      frame = null;
      const { scrollTop, scrollHeight, clientHeight } = scrollArea;
      const remaining = scrollHeight - clientHeight - scrollTop;
      // Shrink the fade near each end so the first and last rows stay clear.
      scrollArea.style.setProperty(
        '--sidebar-fade-top',
        `${Math.min(24, Math.max(0, scrollTop))}px`
      );
      scrollArea.style.setProperty(
        '--sidebar-fade-bottom',
        `${Math.min(24, Math.max(0, remaining))}px`
      );
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(updateFade);
    };

    updateFade();
    scrollArea.addEventListener('scroll', scheduleUpdate, { passive: true });
    // Content changes include loading history and expanding chat folders.
    const observer = new ResizeObserver(scheduleUpdate);
    observer.observe(scrollArea);
    observer.observe(content);

    return () => {
      scrollArea.removeEventListener('scroll', scheduleUpdate);
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div className='flex min-h-0 flex-1 flex-col border-t border-black/[0.05] dark:border-white/[0.05]'>
      <div
        ref={scrollRef}
        data-testid={testId}
        className='sidebar-scroll-fade scroll-region min-h-0 flex-1 scrollbar-thin'
      >
        <div ref={contentRef}>{children}</div>
      </div>
    </div>
  );
}
