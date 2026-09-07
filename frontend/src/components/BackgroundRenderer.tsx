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

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useAppStore } from '@/store/appStore';
import { useAuthStore } from '@/store/authStore';
import { useCelestialStore } from '@/store/celestialStore';
import {
  normalizeBackgroundSettings,
  type NormalizedBackgroundSettings,
} from '@/utils/backgroundSettings';
import {
  limitWallpaperHighlights,
  renderWallpaperDither,
  wallpaperCoverCrop,
  wallpaperSampleSize,
} from '@/utils/wallpaper';

interface WallpaperLayerProps {
  settings: NormalizedBackgroundSettings;
  testId?: string;
}

/** Reused by the account preview; the uploaded source is never rewritten. */
export function WallpaperLayer({
  settings,
  testId = 'wallpaper-layer',
}: WallpaperLayerProps) {
  if (!settings.enabled || !settings.imageUrl || settings.opacity === 0)
    return null;
  return <WallpaperMedia settings={settings} testId={testId} />;
}

function WallpaperMedia({ settings, testId }: WallpaperLayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [rendered, setRendered] = useState<{
    source: string;
    effect: NormalizedBackgroundSettings['effect'];
    state: 'ready' | 'fallback';
    dark: boolean;
  } | null>(null);
  const { imageUrl, effect } = settings;
  const mode = useAppStore(state => state.theme.mode);
  const celestialDark = useCelestialStore(state => state.palette?.isDark);
  const dark =
    mode === 'dark' ||
    mode === 'amoled' ||
    (mode === 'celestial' && celestialDark === true);
  // Hide the previous source synchronously, including before passive cleanup.
  const state =
    rendered?.source === imageUrl &&
    rendered.effect === effect &&
    rendered.dark === dark
      ? rendered.state
      : 'loading';

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const image = new Image();
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    if (effect === 'dither' || dark) image.crossOrigin = 'anonymous';

    const finish = (next: 'ready' | 'fallback') => {
      if (!cancelled)
        setRendered({ source: imageUrl, effect, state: next, dark });
    };
    const paint = () => {
      if (cancelled || !image.naturalWidth || !image.naturalHeight) return;
      const canvas = canvasRef.current;
      const { width, height } = container.getBoundingClientRect();
      const size = wallpaperSampleSize(
        width,
        height,
        effect === 'dither' ? 3 : 1
      );
      if (!canvas || !size.width || !size.height) return;
      try {
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas unavailable');
        const crop = wallpaperCoverCrop(
          image.naturalWidth,
          image.naturalHeight,
          size.width,
          size.height
        );
        context.drawImage(
          image,
          crop.x,
          crop.y,
          crop.width,
          crop.height,
          0,
          0,
          size.width,
          size.height
        );
        if (effect === 'dither' || dark) {
          const pixels = context.getImageData(0, 0, size.width, size.height);
          const output =
            effect === 'dither'
              ? renderWallpaperDither(pixels.data, size.width, size.height)
              : limitWallpaperHighlights(pixels.data);
          pixels.data.set(output);
          context.putImageData(pixels, 0, 0);
        }
        finish('ready');
      } catch {
        // External images may disallow pixel access. Keep a local CSS texture
        // fallback; never send the image to a processor or a proxy.
        finish('fallback');
      }
    };
    const observer = new ResizeObserver(() => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(paint, 100);
    });
    observer.observe(container);
    image.onload = paint;
    image.onerror = () => finish('fallback');
    image.src = imageUrl;
    return () => {
      cancelled = true;
      observer.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      image.onload = null;
      image.onerror = null;
      image.removeAttribute('src');
    };
  }, [imageUrl, effect, dark]);

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      data-effect={effect}
      data-state={state}
      data-tone={rendered?.dark ? 'dark' : 'light'}
      className='account-wallpaper'
      aria-hidden='true'
      style={
        {
          '--wallpaper-intensity': settings.opacity,
          '--wallpaper-blur': `${settings.blurAmount}px`,
        } as CSSProperties
      }
    >
      <div className='account-wallpaper__art'>
        <canvas
          ref={canvasRef}
          data-testid='wallpaper-canvas'
          className='account-wallpaper__canvas'
        />
        {state === 'fallback' && (
          <img
            src={imageUrl}
            alt=''
            draggable={false}
            referrerPolicy='no-referrer'
            className='account-wallpaper__photo'
          />
        )}
      </div>
      <div className='account-wallpaper__veil' />
    </div>
  );
}

export function BackgroundRenderer({ active = true }: { active?: boolean }) {
  const preferences = useAppStore(
    state => state.preferences.backgroundSettings
  );
  const backgroundImage = useAppStore(state => state.backgroundImage);
  const userId = useAuthStore(state => state.user?.id);
  const requiresAuth = useAuthStore(state => state.systemInfo?.requiresAuth);
  const settings = normalizeBackgroundSettings(preferences);
  settings.imageUrl = backgroundImage ?? settings.imageUrl;
  if (
    !active ||
    (requiresAuth !== false && !userId) ||
    !settings.enabled ||
    !settings.imageUrl
  )
    return null;
  // Account changes remount the canvas instead of exposing the previous bitmap.
  return (
    <WallpaperLayer
      key={userId ?? 'solo'}
      settings={settings}
      testId='app-background'
    />
  );
}
