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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useCelestialStore } from '@/store/celestialStore';
import { useAppStore } from '@/store/appStore';
import { formatClock } from '@/utils/celestial';

const STAR_COUNT = 110;
const SNOW_COUNT = 48;
const COMPOSING_IDLE_MS = 5_000;

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
    y: rand() * 78,
    size: 1.2 + rand() * 2.2,
    delay: rand() * 7,
    period: 2.5 + rand() * 4.5,
    bright: rand() > 0.82,
  }));
};

const CLOUDS = [
  {
    id: 'a',
    top: 16,
    left: -14,
    width: 46,
    height: 20,
    depth: 22,
    drift: 120,
    delay: 0,
  },
  {
    id: 'b',
    top: 30,
    left: 38,
    width: 40,
    height: 16,
    depth: 16,
    drift: 150,
    delay: -50,
  },
  {
    id: 'c',
    top: 9,
    left: 66,
    width: 32,
    height: 14,
    depth: 28,
    drift: 95,
    delay: -70,
  },
  {
    id: 'd',
    top: 46,
    left: 8,
    width: 30,
    height: 12,
    depth: 12,
    drift: 170,
    delay: -20,
  },
  {
    id: 'e',
    top: 22,
    left: 84,
    width: 26,
    height: 12,
    depth: 34,
    drift: 80,
    delay: -110,
  },
] as const;

type Meteor = {
  id: number;
  x: number;
  y: number;
  angle: number;
  length: number;
};

const seededSnow = () => {
  let seed = 21;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  return Array.from({ length: SNOW_COUNT }, (_, index) => ({
    id: index,
    x: rand() * 100,
    size: 2 + rand() * 4,
    delay: -rand() * 14,
    period: 9 + rand() * 9,
    sway: 10 + rand() * 30,
  }));
};

/**
 * The celestial backdrop: a sky gradient, a sun or moon on its arc, drifting
 * clouds, stars after dusk (with the odd meteor), an aurora while a reply is
 * streaming at night, and a lamp that follows the pointer at night and
 * brightens with each keystroke. The whole scene parallaxes with the pointer
 * and with chat scrolling, and while the user is typing the surrounding
 * chrome fades so the words sit in the landscape. Pure CSS plus a handful of
 * custom properties; pointer work is throttled to one frame, and users who
 * prefer reduced motion get a still sky.
 */
export const CelestialSky: React.FC = () => {
  const palette = useCelestialStore(state => state.palette);
  const scene = useCelestialStore(state => state.scene);
  const previewMinutes = useCelestialStore(state => state.previewMinutes);
  const isGenerating = useAppStore(state => state.isGenerating);
  const skyRef = useRef<HTMLDivElement>(null);
  const stars = useMemo(() => seededStars(), []);
  const snow = useMemo(() => seededSnow(), []);
  const [meteors, setMeteors] = useState<Meteor[]>([]);
  const [flash, setFlash] = useState(false);
  const active = palette !== null && scene !== null;
  const night = palette?.night ?? 0;

  // Pointer parallax, lamp, chat-scroll parallax, and the composing state.
  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    const sky = skyRef.current;
    if (!sky) return;
    const root = document.documentElement;
    const reduceMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)'
    ).matches;

    let frame = 0;
    let px = 0;
    let py = 0;
    let scrollShift = 0;
    let lampX = 50;
    let lampY = 50;
    let pulseTimer: ReturnType<typeof setTimeout> | undefined;
    let composingTimer: ReturnType<typeof setTimeout> | undefined;

    const paint = () => {
      frame = 0;
      sky.style.setProperty('--sky-px', px.toFixed(3));
      sky.style.setProperty('--sky-py', py.toFixed(3));
      sky.style.setProperty('--sky-scroll', scrollShift.toFixed(2));
      root.style.setProperty('--lamp-x', `${lampX.toFixed(2)}%`);
      root.style.setProperty('--lamp-y', `${lampY.toFixed(2)}%`);
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(paint);
    };
    const onPointerMove = (event: PointerEvent) => {
      const { innerWidth, innerHeight } = window;
      if (!reduceMotion) {
        px = (event.clientX / innerWidth - 0.5) * 2;
        py = (event.clientY / innerHeight - 0.5) * 2;
      }
      lampX = (event.clientX / innerWidth) * 100;
      lampY = (event.clientY / innerHeight) * 100;
      schedule();
    };
    // Scrolling the conversation tilts the sky a little, as if looking up.
    const onScroll = (event: Event) => {
      if (reduceMotion) return;
      const target = event.target as HTMLElement | null;
      if (!target || typeof target.scrollTop !== 'number') return;
      scrollShift = Math.max(-1, Math.min(1, (target.scrollTop % 2400) / 2400));
      schedule();
    };
    const stopComposing = () => {
      root.removeAttribute('data-composing');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      root.style.setProperty('--lamp-pulse', '1');
      if (pulseTimer) clearTimeout(pulseTimer);
      pulseTimer = setTimeout(
        () => root.style.setProperty('--lamp-pulse', '0'),
        320
      );
      const target = event.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') {
        root.setAttribute('data-composing', 'true');
        if (composingTimer) clearTimeout(composingTimer);
        composingTimer = setTimeout(stopComposing, COMPOSING_IDLE_MS);
      }
    };
    const onFocusOut = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.tagName === 'TEXTAREA') stopComposing();
    };

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    window.addEventListener('keydown', onKeyDown, { passive: true });
    window.addEventListener('scroll', onScroll, {
      passive: true,
      capture: true,
    });
    document.addEventListener('focusout', onFocusOut);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, { capture: true });
      document.removeEventListener('focusout', onFocusOut);
      if (frame) window.cancelAnimationFrame(frame);
      if (pulseTimer) clearTimeout(pulseTimer);
      if (composingTimer) clearTimeout(composingTimer);
      stopComposing();
      for (const name of ['--lamp-x', '--lamp-y', '--lamp-pulse']) {
        root.style.removeProperty(name);
      }
    };
  }, [active]);

  // The odd meteor after dark: one every 20 to 50 seconds, more while a reply
  // streams. Each one lives for a second and a half.
  useEffect(() => {
    if (!active || night < 0.4 || typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let counter = 0;
    const spawn = () => {
      const meteor: Meteor = {
        id: (counter += 1),
        x: 10 + Math.random() * 70,
        y: 4 + Math.random() * 36,
        angle: 20 + Math.random() * 30,
        length: 120 + Math.random() * 140,
      };
      setMeteors(current => [...current.slice(-2), meteor]);
      setTimeout(
        () => setMeteors(current => current.filter(m => m.id !== meteor.id)),
        1600
      );
      const base = isGenerating ? 6_000 : 20_000;
      timer = setTimeout(spawn, base + Math.random() * 30_000);
    };
    timer = setTimeout(spawn, 4_000 + Math.random() * 8_000);
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active, night, isGenerating]);

  // Thunder: an occasional flash while a storm is reported.
  const thunder = scene?.thunder ?? false;
  useEffect(() => {
    if (!active || !thunder || typeof window === 'undefined') return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const strike = () => {
      setFlash(true);
      setTimeout(() => setFlash(false), 180 + Math.random() * 160);
      timer = setTimeout(strike, 9_000 + Math.random() * 25_000);
    };
    timer = setTimeout(strike, 3_000 + Math.random() * 6_000);
    return () => {
      if (timer) clearTimeout(timer);
      setFlash(false);
    };
  }, [active, thunder]);

  if (!palette || !scene) return null;

  // Moon phase as a shadow disc sliding across the moon.
  const phase = scene.moon.phase;
  const shadowOffset = (phase < 0.5 ? 1 - phase * 2 : -(phase * 2 - 1)) * 92;
  const lowSun = scene.sun.visible ? scene.sun.warmth : 0;

  return (
    <>
      <div
        ref={skyRef}
        data-testid='celestial-sky'
        data-night={night > 0.5 ? 'true' : 'false'}
        data-preview={previewMinutes !== null ? 'true' : 'false'}
        data-generating={isGenerating ? 'true' : 'false'}
        data-weather={scene.weatherKind}
        data-flash={flash ? 'true' : 'false'}
        aria-hidden='true'
        className='celestial-sky pointer-events-none fixed inset-0 z-0'
        style={{ ['--wind' as string]: scene.wind }}
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
                className={
                  star.bright
                    ? 'celestial-sky__star celestial-sky__star--bright'
                    : 'celestial-sky__star'
                }
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
          {meteors.map(meteor => (
            <span
              key={meteor.id}
              className='celestial-sky__meteor'
              style={{
                left: `${meteor.x}%`,
                top: `${meteor.y}%`,
                width: meteor.length,
                transform: `rotate(${meteor.angle}deg)`,
              }}
            />
          ))}
          <div className='celestial-sky__aurora' />
          <div
            className='celestial-sky__sun'
            data-testid='celestial-sun'
            style={{
              opacity: scene.sun.visible ? scene.sun.dim : 0,
              ['--body-x' as string]: scene.sun.x,
              ['--body-y' as string]: scene.sun.y,
              ['--sun-warmth' as string]: scene.sun.warmth,
            }}
          />
          <div
            className='celestial-sky__moon'
            data-testid='celestial-moon'
            style={{
              opacity: scene.moon.visible ? scene.moon.dim : 0,
              ['--body-x' as string]: scene.moon.x,
              ['--body-y' as string]: scene.moon.y,
            }}
          >
            <span
              className='celestial-sky__moon-shadow'
              style={{ transform: `translateX(${shadowOffset}%)` }}
            />
          </div>
          {CLOUDS.map(cloud => (
            <div
              key={cloud.id}
              className='celestial-sky__cloud'
              style={{
                top: `${cloud.top}%`,
                left: `${cloud.left}%`,
                width: `${cloud.width}vw`,
                height: `${cloud.height}vh`,
                background: scene.cloudTint,
                opacity: scene.cloudOpacity,
                animationDuration: `${cloud.drift / scene.wind}s`,
                animationDelay: `${cloud.delay}s`,
                ['--cloud-depth' as string]: `${cloud.depth}px`,
              }}
            />
          ))}
          <div
            className='celestial-sky__horizon-glow'
            style={{
              ['--body-x' as string]: scene.sun.x,
              opacity: lowSun,
              background: `radial-gradient(60vw 34vh at 50% 100%, ${palette.sky.horizon} 0%, transparent 70%)`,
            }}
          />
          <div
            className='celestial-sky__haze'
            style={{ opacity: Math.min(1, 0.3 + scene.haze * 0.45) }}
          />
          {scene.fog > 0 && (
            <div
              className='celestial-sky__fog'
              style={{ opacity: scene.fog }}
            />
          )}
          {scene.rain > 0 && (
            <div
              className='celestial-sky__rain'
              data-testid='celestial-rain'
              style={{ opacity: 0.25 + scene.rain * 0.5 }}
            />
          )}
          {scene.snow > 0 && (
            <div
              className='celestial-sky__snow'
              data-testid='celestial-snow'
              style={{ opacity: scene.snow }}
            >
              {snow.map(flake => (
                <span
                  key={flake.id}
                  className='celestial-sky__flake'
                  style={{
                    left: `${flake.x}%`,
                    width: flake.size,
                    height: flake.size,
                    animationDelay: `${flake.delay}s`,
                    animationDuration: `${flake.period / scene.wind}s`,
                    ['--sway' as string]: `${flake.sway}px`,
                  }}
                />
              ))}
            </div>
          )}
          <div className='celestial-sky__flash' />
          <div className='celestial-sky__grain' />
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
