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

import { useEffect } from 'react';

// Include responsive overflow utilities and explicitly marked custom panels.
// Embedded apps and terminal/editor internals own their own scroll surfaces.
const scrollSelector =
  '.scroll-region, [class*="overflow-y-auto"], [class*="overflow-x-auto"], [class*="overflow-auto"], [data-scroll-fade]';
const excludedSelector =
  'input, textarea, [contenteditable="true"], [data-scroll-fade="off"], .sidebar-scroll-fade, .tab-scroll-fade';
const edges = ['top', 'bottom', 'left', 'right'] as const;

/** Decorate application scrollports, including lazy panels and portal dialogs. */
export function useScrollFades() {
  useEffect(() => {
    const entries = new Map<
      HTMLElement,
      { observer: ResizeObserver; children: Set<Element> }
    >();
    const pending = new Set<HTMLElement>();
    const focusProtected = new Set<HTMLElement>();
    let frame: number | null = null;
    let keyboardNavigation = false;

    const updateFade = (element: HTMLElement) => {
      const style = getComputedStyle(element);
      const scrolls = (overflow: string) => /^(auto|scroll)$/.test(overflow);
      const maxY = scrolls(style.overflowY)
        ? Math.max(0, element.scrollHeight - element.clientHeight)
        : 0;
      const maxX = scrolls(style.overflowX)
        ? Math.max(0, element.scrollWidth - element.clientWidth)
        : 0;
      const top = Math.max(0, Math.min(maxY, element.scrollTop));
      const left = Math.max(
        0,
        Math.min(
          maxX,
          style.direction === 'rtl'
            ? maxX + element.scrollLeft
            : element.scrollLeft
        )
      );
      const distances = [top, maxY - top, left, maxX - left];
      edges.forEach((edge, index) => {
        const distance = distances[index];
        const requestedSize = Number.parseFloat(
          element.getAttribute(`data-scroll-fade-${edge}`) ?? ''
        );
        const size =
          Number.isFinite(requestedSize) && requestedSize >= 0
            ? requestedSize
            : 24;
        // Native scroll positions can end within a fractional pixel of zero.
        const value = `${distance <= 1 ? 0 : Math.min(size, distance)}px`;
        const property = `--scroll-fade-${edge}`;
        if (element.style.getPropertyValue(property) !== value) {
          element.style.setProperty(property, value);
        }
      });
      element.toggleAttribute(
        'data-scroll-fade-active',
        element.clientWidth > 0 &&
          element.clientHeight > 0 &&
          (maxY > 1 || maxX > 1)
      );
    };

    const untrack = (element: HTMLElement) => {
      entries.get(element)?.observer.disconnect();
      entries.delete(element);
      pending.delete(element);
      focusProtected.delete(element);
      element.removeAttribute('data-scroll-fade-active');
      element.removeAttribute('data-scroll-fade-keyboard');
      edges.forEach(edge =>
        element.style.removeProperty(`--scroll-fade-${edge}`)
      );
    };

    const flush = () => {
      frame = null;
      for (const element of entries.keys()) {
        if (!element.isConnected) untrack(element);
      }
      for (const element of pending) updateFade(element);
      pending.clear();
    };
    const schedule = (element: HTMLElement) => {
      if (!entries.has(element)) return;
      pending.add(element);
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const refreshChildren = (element: HTMLElement) => {
      const entry = entries.get(element);
      if (!entry) return;
      const children = new Set(element.children);
      for (const child of entry.children) {
        if (!children.has(child)) entry.observer.unobserve(child);
      }
      for (const child of children) {
        if (!entry.children.has(child)) entry.observer.observe(child);
      }
      entry.children = children;
    };
    const track = (element: Element) => {
      if (!(element instanceof HTMLElement)) return;
      if (
        element.matches(excludedSelector) ||
        element.closest('[contenteditable="true"], [data-scroll-fade="off"]') ||
        !element.matches(scrollSelector)
      ) {
        if (entries.has(element)) untrack(element);
        return;
      }
      if (!entries.has(element)) {
        const observer = new ResizeObserver(() => schedule(element));
        entries.set(element, { observer, children: new Set() });
        observer.observe(element);
      }
      refreshChildren(element);
      schedule(element);
    };
    const scan = (element: Element) => {
      track(element);
      element.querySelectorAll(scrollSelector).forEach(track);
    };
    const scheduleAncestors = (node: Node) => {
      let element = node instanceof HTMLElement ? node : node.parentElement;
      while (element) {
        if (entries.has(element)) {
          refreshChildren(element);
          schedule(element);
        }
        element = element.parentElement;
      }
    };
    const scheduleAll = () =>
      entries.forEach((_entry, element) => schedule(element));

    const syncFocus = () => {
      for (const element of focusProtected) {
        element.removeAttribute('data-scroll-fade-keyboard');
      }
      focusProtected.clear();
      if (!keyboardNavigation) return;
      let element = document.activeElement;
      while (element instanceof HTMLElement) {
        if (entries.has(element)) {
          element.setAttribute('data-scroll-fade-keyboard', '');
          focusProtected.add(element);
        }
        element = element.parentElement;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        ![
          'Tab',
          'ArrowUp',
          'ArrowDown',
          'ArrowLeft',
          'ArrowRight',
          'Home',
          'End',
          'PageUp',
          'PageDown',
        ].includes(event.key)
      )
        return;
      keyboardNavigation = true;
      syncFocus();
    };
    const onPointer = () => {
      keyboardNavigation = false;
      syncFocus();
    };
    const onScroll = (event: Event) => {
      if (event.target instanceof HTMLElement && entries.has(event.target)) {
        schedule(event.target);
      }
    };

    scan(document.body);
    const mutations = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target instanceof Element) {
          track(record.target);
          // Theme, direction, and responsive ancestor classes can change axes.
          record.target.querySelectorAll(scrollSelector).forEach(track);
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) scan(node);
        }
        scheduleAncestors(record.target);
      }
      // Prune observers even when an entire page or portal was removed.
      if (frame === null) frame = requestAnimationFrame(flush);
      syncFocus();
    });
    mutations.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: [
        'class',
        'dir',
        'data-scroll-fade',
        ...edges.map(edge => `data-scroll-fade-${edge}`),
      ],
    });
    document.addEventListener('scroll', onScroll, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', syncFocus);
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('wheel', onPointer, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', scheduleAll);

    return () => {
      mutations.disconnect();
      entries.forEach((_entry, element) => untrack(element));
      if (frame !== null) cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, true);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', syncFocus);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('wheel', onPointer, true);
      window.removeEventListener('resize', scheduleAll);
    };
  }, []);
}
