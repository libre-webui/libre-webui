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

import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
};

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
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener('pointerdown', dismissOutside, true);
      document.removeEventListener('focusin', dismissOutside);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onResize);
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
    const width = Math.min(336, Math.max(0, window.innerWidth - 24));
    const alignLeft =
      document.documentElement.dir === 'rtl' ? rect.left : rect.right - width;
    const left = Math.max(
      8,
      Math.min(alignLeft, window.innerWidth - width - 8)
    );
    const top = Math.min(rect.bottom + 8, window.innerHeight - 8);
    openedRef.current = true;
    setPlacement({
      top,
      left,
      width,
      maxHeight: Math.max(0, window.innerHeight - top - 8),
    });
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
