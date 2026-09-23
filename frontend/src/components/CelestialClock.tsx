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

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Moon, Sun, X } from 'lucide-react';
import { useAppStore } from '@/store/appStore';
import { useCelestialStore } from '@/store/celestialStore';
import { formatClock } from '@/utils/celestial';
import { previewCelestialMinutes } from '@/utils/theme';
import { CelestialDayPreview } from './CelestialDayPreview';

type Placement = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  paddingBlock: number;
};

function placeClockPanel(rect: DOMRect, naturalHeight: number): Placement {
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width ?? window.innerWidth;
  const viewportHeight = viewport?.height ?? window.innerHeight;
  const margin = Math.min(8, Math.max(0, (viewportHeight - 44) / 2));
  const gap = 8;
  const width = Math.min(336, Math.max(0, viewportWidth - 24));
  const alignLeft =
    document.documentElement.dir === 'rtl' ? rect.left : rect.right - width;
  const left = Math.max(
    viewportLeft + 8,
    Math.min(alignLeft, viewportLeft + viewportWidth - width - 8)
  );
  const availableHeight = Math.max(0, viewportHeight - 2 * margin);
  const wantedHeight = Math.min(naturalHeight, availableHeight);
  const spaceBelow = Math.max(
    0,
    Math.min(
      availableHeight,
      viewportTop + viewportHeight - margin - rect.bottom - gap
    )
  );
  const spaceAbove = Math.max(
    0,
    Math.min(availableHeight, rect.top - gap - viewportTop - margin)
  );
  let top: number;
  let maxHeight: number;
  if (Math.max(spaceAbove, spaceBelow) < Math.min(wantedHeight, 160)) {
    // When neither side has useful space, overlap the trigger rather than
    // leaving only the panel's padding visible in a very short viewport.
    top = viewportTop + margin;
    maxHeight = availableHeight;
  } else if (
    spaceBelow >= wantedHeight ||
    (spaceAbove < wantedHeight && spaceBelow >= spaceAbove)
  ) {
    top = rect.bottom + gap;
    maxHeight = spaceBelow;
  } else {
    maxHeight = spaceAbove;
    top = rect.top - gap - Math.min(naturalHeight, maxHeight);
  }
  return {
    top,
    left,
    width,
    maxHeight,
    // Retain room for a focused control when the whole viewport is tiny.
    paddingBlock: Math.max(0, Math.min(16, (maxHeight - 42) / 2)),
  };
}

export function CelestialClock() {
  const { t } = useTranslation();
  const location = useLocation();
  const isCelestial = useAppStore(state => state.theme.mode === 'celestial');
  const palette = useCelestialStore(state => state.palette);
  const previewMinutes = useCelestialStore(state => state.previewMinutes);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const openedRef = useRef(false);
  const panelId = useId();
  const statusId = useId();
  const [placement, setPlacement] = useState<Placement | null>(null);
  const isOpen = placement !== null;
  const available = isCelestial && palette !== null;

  const close = useCallback((restoreFocus = false) => {
    if (!openedRef.current) return;
    openedRef.current = false;
    setPlacement(null);
    previewCelestialMinutes(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    close();
  }, [available, location.key, close]);

  useEffect(
    () => () => {
      // A closed clock must not clear a preview owned by Settings.
      if (openedRef.current) previewCelestialMinutes(null);
    },
    []
  );

  useLayoutEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!panel || !trigger) return;
    const position = () => {
      if (!openedRef.current) return;
      const style = getComputedStyle(panel);
      const naturalHeight =
        panel.scrollHeight +
        parseFloat(style.borderTopWidth) +
        parseFloat(style.borderBottomWidth);
      const next = placeClockPanel(
        trigger.getBoundingClientRect(),
        naturalHeight
      );
      setPlacement(current =>
        !current ||
        (current.top === next.top &&
          current.left === next.left &&
          current.width === next.width &&
          current.maxHeight === next.maxHeight &&
          current.paddingBlock === next.paddingBlock)
          ? current
          : next
      );
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panel);
    if (panel.lastElementChild) observer.observe(panel.lastElementChild);
    return () => observer.disconnect();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const contains = (target: EventTarget | null) =>
      target instanceof Node &&
      (triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target));
    const dismissOutside = (event: PointerEvent | FocusEvent) => {
      if (!contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      } else if (
        (event.ctrlKey || event.metaKey) &&
        event.key === ',' &&
        !event.shiftKey &&
        !event.altKey &&
        target.tagName !== 'INPUT' &&
        target.tagName !== 'TEXTAREA' &&
        target.contentEditable !== 'true' &&
        !target.isContentEditable
      ) {
        // Match the app's Settings shortcut; focused inputs ignore it.
        close();
      }
    };
    const onResize = () => close();
    const focusFrame = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLInputElement>('input[type="range"]')
        ?.focus();
    });
    document.addEventListener('pointerdown', dismissOutside, true);
    document.addEventListener('focusin', dismissOutside);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('scroll', onResize);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('scroll', onResize);
    };
  }, [isOpen, close]);

  if (!available || !palette) return null;

  const clock = formatClock(palette.solar.minutes);
  const label = t('settings.appearance.celestial.title');
  const status = t(
    previewMinutes === null
      ? 'settings.appearance.celestial.live'
      : 'settings.appearance.celestial.preview'
  );
  const Icon = palette.solar.isDay ? Sun : Moon;
  const toggle = () => {
    if (isOpen) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    openedRef.current = true;
    setPlacement(placeClockPanel(rect, Infinity));
  };

  return (
    <>
      <button
        ref={triggerRef}
        type='button'
        className='celestial-clock-trigger'
        data-testid='celestial-clock-trigger'
        aria-label={`${label}: ${clock}`}
        aria-describedby={statusId}
        title={`${label}: ${clock} · ${status}`}
        aria-haspopup='dialog'
        aria-expanded={isOpen}
        aria-controls={panelId}
        onClick={toggle}
      >
        <span
          dir='ltr'
          data-testid='celestial-clock-time'
          className='inline-flex items-center gap-1.5'
        >
          <Icon className='h-4 w-4' strokeWidth={1.75} aria-hidden='true' />
          <span className='hidden tabular-nums sm:inline'>{clock}</span>
        </span>
      </button>
      <span id={statusId} className='sr-only'>
        {status}
      </span>
      {placement &&
        createPortal(
          <div
            ref={panelRef}
            id={panelId}
            role='dialog'
            aria-label={label}
            className='celestial-day-popover'
            data-testid='celestial-day-popover'
            data-scroll-fade=''
            style={{ position: 'fixed', overflowY: 'auto', ...placement }}
          >
            <button
              type='button'
              aria-label={t('common.close')}
              title={t('common.close')}
              onClick={() => close(true)}
              className='absolute end-2 top-2 flex h-8 w-8 items-center justify-center rounded-full text-ink-muted hover:bg-interactive-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40'
            >
              <X className='h-4 w-4' aria-hidden='true' />
            </button>
            <CelestialDayPreview />
          </div>,
          document.body
        )}
    </>
  );
}
