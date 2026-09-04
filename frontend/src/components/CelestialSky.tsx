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

import React, { useEffect, useMemo, useRef } from 'react';
import { useCelestialStore } from '@/store/celestialStore';
import { formatClock } from '@/utils/celestial';

const STAR_COUNT = 96;

/** Deterministic star field so the sky is the same on every visit. */
const seededStars = () => {
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Array.from({ length: STAR_COUNT }, (_, index) => ({
    id: index,
    x: rand() * 100,
    y: rand() * 72,
    size: 1.4 + rand() * 2.1,
    delay: rand() * 7,
    period: 2.5 + rand() * 4,
  }));
};

/**
 * The celestial backdrop: a sky gradient, a sun or moon on its arc, drifting
 * clouds, stars after dusk, and a lamp that follows the pointer at night and
 * brightens with each keystroke. Pure CSS and a few custom properties: the
 * scene re-renders only when the palette ticks, pointer motion is throttled
 * to one frame, and reduced-motion users get a still sky.
 */
export const CelestialSky: React.FC = () => {
  const palette = useCelestialStore(state => state.palette);
  const scene = useCelestialStore(state => state.scene);
  const previewMinutes = useCelestialStore(state => state.previewMinutes);
  const skyRef = useRef<HTMLDivElement>(null);
  const stars = useMemo(() => seededStars(), []);
  const active = palette !== null && scene !== null;

  // Attach the pointer and keyboard listeners once the sky exists (the
  // component renders nothing until the celestial palette is live).
  useEffect(() => {
    if (!active) return;
    const sky = skyRef.current;
    if (!sky || typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    let frame = 0;
    let px = 0;
    let py = 0;
    let lampX = 50;
    let lampY = 50;
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;

    const root = document.documentElement;
    const paint = () => {
      frame = 0;
      sky.style.setProperty('--sky-px', px.toFixed(3));
      sky.style.setProperty('--sky-py', py.toFixed(3));
      root.style.setProperty('--lamp-x', `${lampX.toFixed(2)}%`);
      root.style.setProperty('--lamp-y', `${lampY.toFixed(2)}%`);
    };
    const onPointerMove = (event: PointerEvent) => {
      const { innerWidth, innerHeight } = window;
      px = (event.clientX / innerWidth - 0.5) * 2;
      py = (event.clientY / innerHeight - 0.5) * 2;
      lampX = (event.clientX / innerWidth) * 100;
      lampY = (event.clientY / innerHeight) * 100;
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const onKeyDown = () => {
      root.style.setProperty('--lamp-pulse', '1');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(
        () => root.style.setProperty('--lamp-pulse', '0'),
        320
      );
    };
    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('keydown', onKeyDown, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      if (frame) window.cancelAnimationFrame(frame);
      if (pulseTimer) clearTimeout(pulseTimer);
      for (const name of ['--lamp-x', '--lamp-y', '--lamp-pulse']) {
        root.style.removeProperty(name);
      }
    };
  }, [active]);

  if (!palette || !scene) return null;

  // Moon phase as a shadow disc sliding across the moon.
  const phase = scene.moon.phase;
  const shadowOffset = (phase < 0.5 ? 1 - phase * 2 : -(phase * 2 - 1)) * 92;

  return (
    <>
      <div
        ref={skyRef}
        data-testid='celestial-sky'
        data-night={palette.night > 0.5 ? 'true' : 'false'}
        data-preview={previewMinutes !== null ? 'true' : 'false'}
        aria-hidden='true'
        className='celestial-sky pointer-events-none fixed inset-0 z-0'
      >
        <div className='celestial-sky__layers absolute inset-0 overflow-hidden'>
          <div className='celestial-sky__gradient' />
          <div
            className='celestial-sky__stars'
            style={{ opacity: scene.stars }}
            data-testid='celestial-stars'
          >
            {stars.map(star => (
              <span
                key={star.id}
                className='celestial-sky__star'
                style={{
                  left: `${star.x}%`,
                  top: `${star.y}%`,
                  width: star.size,
                  height: star.size,
                  animationDelay: `${star.delay}s`,
                  animationDuration: `${star.period}s`,
                }}
              />
            ))}
          </div>
          <div
            className='celestial-sky__sun'
            data-testid='celestial-sun'
            style={{
              left: `${scene.sun.x}%`,
              top: `${scene.sun.y}%`,
              opacity: scene.sun.visible ? 1 : 0,
              ['--sun-warmth' as string]: scene.sun.warmth,
            }}
          />
          <div
            className='celestial-sky__moon'
            data-testid='celestial-moon'
            style={{
              left: `${scene.moon.x}%`,
              top: `${scene.moon.y}%`,
              opacity: scene.moon.visible ? 1 : 0,
            }}
          >
            <span
              className='celestial-sky__moon-shadow'
              style={{ transform: `translateX(${shadowOffset}%)` }}
            />
          </div>
          {['a', 'b', 'c'].map(cloud => (
            <div
              key={cloud}
              className={`celestial-sky__cloud celestial-sky__cloud--${cloud}`}
              style={{
                background: scene.cloudTint,
                opacity: scene.cloudOpacity,
              }}
            />
          ))}
          <div
            className='celestial-sky__haze'
            style={{ opacity: 0.35 + scene.haze * 0.45 }}
          />
          <div className='celestial-sky__clock' data-testid='celestial-clock'>
            {formatClock(palette.solar.minutes)}
          </div>
        </div>
      </div>
      {/* The lamp sits above the interface so it lights the words too. */}
      <div className='celestial-sky__lamp' aria-hidden='true' />
    </>
  );
};

export default CelestialSky;
