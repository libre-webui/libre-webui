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

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { isRTL } from '@/i18n';
import { cn } from '@/utils';

export type WorkSplitSurface = 'conversation' | 'workspace';

interface WorkSplitPaneProps {
  conversation: ReactNode;
  workspace: ReactNode;
  userId?: string | null;
  mobileSurface?: WorkSplitSurface;
  className?: string;
}

interface SplitBounds {
  min: number;
  max: number;
}

const DEFAULT_CONVERSATION_PERCENT = 45;
const HARD_MIN_PERCENT = 30;
const HARD_MAX_PERCENT = 70;
const MIN_CONVERSATION_PX = 360;
const MIN_WORKSPACE_PX = 480;
const RESIZER_TRACK_PX = 9;
const KEYBOARD_STEP_PERCENT = 2;
const KEYBOARD_COARSE_STEP_PERCENT = 10;

export const WORK_SPLIT_STORAGE_PREFIX = 'libre-webui-work-split:';

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const storageKeyForUser = (userId?: string | null): string =>
  `${WORK_SPLIT_STORAGE_PREFIX}${encodeURIComponent(userId || 'local')}`;

const readStoredPercent = (storageKey: string): number => {
  if (typeof window === 'undefined') return DEFAULT_CONVERSATION_PERCENT;

  try {
    const value = window.localStorage.getItem(storageKey);
    if (value === null || value.trim() === '')
      return DEFAULT_CONVERSATION_PERCENT;
    const stored = Number(value);
    return Number.isFinite(stored)
      ? clamp(stored, HARD_MIN_PERCENT, HARD_MAX_PERCENT)
      : DEFAULT_CONVERSATION_PERCENT;
  } catch {
    return DEFAULT_CONVERSATION_PERCENT;
  }
};

const writeStoredPercent = (storageKey: string, percent: number): void => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(storageKey, percent.toFixed(2));
  } catch {
    // Resizing remains available when storage is disabled or full.
  }
};

const splitBounds = (containerWidth: number): SplitBounds => {
  const availableWidth = Math.max(0, containerWidth - RESIZER_TRACK_PX);
  if (availableWidth === 0) {
    return { min: HARD_MIN_PERCENT, max: HARD_MAX_PERCENT };
  }

  const min = Math.max(
    HARD_MIN_PERCENT,
    (MIN_CONVERSATION_PX / availableWidth) * 100
  );
  const max = Math.min(
    HARD_MAX_PERCENT,
    ((availableWidth - MIN_WORKSPACE_PX) / availableWidth) * 100
  );

  if (min <= max) return { min, max };

  // If both pixel minimums cannot fit, preserve their relative proportions.
  const proportionalFallback = clamp(
    (MIN_CONVERSATION_PX / (MIN_CONVERSATION_PX + MIN_WORKSPACE_PX)) * 100,
    HARD_MIN_PERCENT,
    HARD_MAX_PERCENT
  );
  return { min: proportionalFallback, max: proportionalFallback };
};

const clampToBounds = (percent: number, bounds: SplitBounds): number =>
  clamp(percent, bounds.min, bounds.max);

/**
 * Responsive Conversation/Workspace split used by Work tasks.
 *
 * Below the `xl` breakpoint only `mobileSurface` is shown. On desktop the
 * preferred ratio is shared by all tasks for the current user and is clamped
 * against the actual content width, so opening or collapsing the app sidebar
 * cannot make either panel unusable.
 */
export function WorkSplitPane({
  conversation,
  workspace,
  userId,
  mobileSurface = 'conversation',
  className,
}: WorkSplitPaneProps) {
  const { t, i18n } = useTranslation();
  const rtl = isRTL(i18n.language);
  const storageKey = storageKeyForUser(userId);
  const [splitState, setSplitState] = useState(() => ({
    storageKey,
    percent: readStoredPercent(storageKey),
  }));
  const [containerWidth, setContainerWidth] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const resizerRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const activeStorageKeyRef = useRef(storageKey);
  const pendingPercentRef = useRef(splitState.percent);
  const resizeFrameRef = useRef<number | null>(null);

  const preferredPercent =
    splitState.storageKey === storageKey
      ? splitState.percent
      : readStoredPercent(storageKey);
  const bounds = useMemo(() => splitBounds(containerWidth), [containerWidth]);
  const effectivePercent = clampToBounds(preferredPercent, bounds);
  const roundedConversationPercent = Math.round(effectivePercent);
  const roundedWorkspacePercent = 100 - roundedConversationPercent;

  const setPreferredPercent = useCallback(
    (percent: number) => {
      setSplitState({ storageKey, percent });
    },
    [storageKey]
  );

  const schedulePercent = useCallback(
    (percent: number) => {
      const width = rootRef.current?.getBoundingClientRect().width ?? 0;
      const nextPercent = clampToBounds(percent, splitBounds(width));
      pendingPercentRef.current = nextPercent;

      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        setPreferredPercent(pendingPercentRef.current);
      });
    },
    [setPreferredPercent]
  );

  const finishResize = useCallback(() => {
    if (pointerIdRef.current === null && !isResizing) return;

    if (resizeFrameRef.current !== null) {
      window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    }

    const width = rootRef.current?.getBoundingClientRect().width ?? 0;
    const finalPercent = clampToBounds(
      pendingPercentRef.current,
      splitBounds(width)
    );
    pendingPercentRef.current = finalPercent;
    setPreferredPercent(finalPercent);
    writeStoredPercent(activeStorageKeyRef.current, finalPercent);

    const pointerId = pointerIdRef.current;
    pointerIdRef.current = null;
    if (
      pointerId !== null &&
      resizerRef.current?.hasPointerCapture(pointerId)
    ) {
      resizerRef.current.releasePointerCapture(pointerId);
    }
    setIsResizing(false);
  }, [isResizing, setPreferredPercent]);

  const percentAtClientX = useCallback(
    (clientX: number): number => {
      const boundsRect = rootRef.current?.getBoundingClientRect();
      if (!boundsRect) return pendingPercentRef.current;

      const availableWidth = Math.max(1, boundsRect.width - RESIZER_TRACK_PX);
      const inlineOffset = rtl
        ? boundsRect.right - clientX
        : clientX - boundsRect.left;
      const conversationWidth = inlineOffset - RESIZER_TRACK_PX / 2;
      return (conversationWidth / availableWidth) * 100;
    },
    [rtl]
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;

    event.preventDefault();
    event.stopPropagation();
    pointerIdRef.current = event.pointerId;
    activeStorageKeyRef.current = storageKey;
    pendingPercentRef.current = effectivePercent;
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
  };

  const commitPercent = useCallback(
    (percent: number) => {
      const nextPercent = clampToBounds(percent, bounds);
      pendingPercentRef.current = nextPercent;
      setPreferredPercent(nextPercent);
      writeStoredPercent(storageKey, nextPercent);
    },
    [bounds, setPreferredPercent, storageKey]
  );

  const resetSplit = useCallback(() => {
    commitPercent(DEFAULT_CONVERSATION_PERCENT);
  }, [commitPercent]);

  const handleResizerKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey
      ? KEYBOARD_COARSE_STEP_PERCENT
      : KEYBOARD_STEP_PERCENT;
    let nextPercent: number | null = null;

    if (event.key === 'ArrowLeft') {
      nextPercent = effectivePercent + (rtl ? step : -step);
    } else if (event.key === 'ArrowRight') {
      nextPercent = effectivePercent + (rtl ? -step : step);
    } else if (event.key === 'Home') {
      nextPercent = bounds.min;
    } else if (event.key === 'End') {
      nextPercent = bounds.max;
    } else if (event.key === 'Enter') {
      nextPercent = DEFAULT_CONVERSATION_PERCENT;
    }

    if (nextPercent === null) return;
    event.preventDefault();
    commitPercent(nextPercent);
  };

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;

    if (typeof ResizeObserver === 'undefined') {
      const updateWidth = () =>
        setContainerWidth(root.getBoundingClientRect().width);
      updateWidth();
      window.addEventListener('resize', updateWidth);
      return () => window.removeEventListener('resize', updateWidth);
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isResizing) return undefined;

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerIdRef.current) return;
      event.preventDefault();
      schedulePercent(percentAtClientX(event.clientX));
    };
    const handlePointerEnd = (event: PointerEvent) => {
      if (event.pointerId === pointerIdRef.current) finishResize();
    };

    window.addEventListener('pointermove', handlePointerMove, {
      passive: false,
    });
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    window.addEventListener('blur', finishResize);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
      window.removeEventListener('blur', finishResize);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [finishResize, isResizing, percentAtClientX, schedulePercent]);

  useEffect(
    () => () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }
      if (pointerIdRef.current !== null) {
        writeStoredPercent(
          activeStorageKeyRef.current,
          pendingPercentRef.current
        );
      }
    },
    []
  );

  const gridStyle = {
    gridTemplateColumns: `minmax(0, ${effectivePercent}fr) ${RESIZER_TRACK_PX}px minmax(0, ${
      100 - effectivePercent
    }fr)`,
  } satisfies CSSProperties;

  return (
    <div
      ref={rootRef}
      data-testid='work-split-pane'
      data-split-percent={effectivePercent.toFixed(2)}
      data-resizing={isResizing ? 'true' : 'false'}
      className={cn(
        'relative flex min-h-0 min-w-0 flex-1 overflow-hidden xl:grid',
        className
      )}
      style={gridStyle}
    >
      <section
        id='work-conversation-panel'
        data-testid='work-conversation-panel'
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col bg-transparent xl:flex',
          mobileSurface === 'conversation' ? 'flex' : 'hidden'
        )}
      >
        {conversation}
      </section>

      <div
        ref={resizerRef}
        role='separator'
        aria-orientation='vertical'
        aria-controls='work-conversation-panel work-workspace-panel'
        aria-label={t('work.workspace.resize', {
          defaultValue: 'Resize conversation and workspace',
        })}
        aria-valuemin={Math.round(bounds.min)}
        aria-valuemax={Math.round(bounds.max)}
        aria-valuenow={roundedConversationPercent}
        aria-valuetext={t('work.workspace.splitSize', {
          conversation: roundedConversationPercent,
          workspace: roundedWorkspacePercent,
          defaultValue:
            'Conversation {{conversation}}%, workspace {{workspace}}%',
        })}
        title={t('work.workspace.resizeHint', {
          defaultValue:
            'Drag to resize. Use arrow keys for precise control. Double-click or press Enter to reset.',
        })}
        tabIndex={0}
        data-testid='work-split-resizer'
        onPointerDown={handlePointerDown}
        onDoubleClick={resetSplit}
        onKeyDown={handleResizerKeyDown}
        className={cn(
          'group relative z-40 hidden h-full cursor-col-resize touch-none select-none items-center justify-center outline-none xl:flex',
          'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff7b52]'
        )}
      >
        <span
          aria-hidden='true'
          className={cn(
            'pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line transition-colors',
            'group-hover:bg-[#ff7b52] group-focus-visible:bg-[#ff7b52]',
            isResizing && 'bg-[#ff7b52]'
          )}
        />
        <span
          aria-hidden='true'
          className={cn(
            'pointer-events-none relative h-14 w-1 rounded-full bg-ink-subtle/50 opacity-60 transition-[height,background-color,opacity]',
            'group-hover:h-20 group-hover:bg-[#ff7b52] group-hover:opacity-100',
            'group-focus-visible:h-20 group-focus-visible:bg-[#ff7b52] group-focus-visible:opacity-100',
            isResizing && 'h-20 bg-[#ff7b52] opacity-100'
          )}
        />
      </div>

      <section
        id='work-workspace-panel'
        data-testid='work-workspace-panel'
        className={cn(
          'min-h-0 min-w-0 flex-1 flex-col bg-surface-raised/85 backdrop-blur-xl xl:flex',
          mobileSurface === 'workspace' ? 'flex' : 'hidden'
        )}
      >
        {workspace}
      </section>

      {isResizing && (
        <div
          data-testid='work-split-drag-shield'
          aria-hidden='true'
          className='absolute inset-0 z-30 hidden cursor-col-resize select-none xl:block'
        />
      )}
    </div>
  );
}
