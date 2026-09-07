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

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ditherWallpaper,
  isWallpaperRoute,
  limitWallpaperHighlights,
  prepareWallpaperDither,
  renderWallpaperDither,
  wallpaperCoverCrop,
  wallpaperSampleSize,
} from './wallpaper';

test('only Chat and Work routes receive account wallpaper', () => {
  for (const route of [
    '/chat',
    '/chat/',
    '/c/a-session',
    '/c/a-session/',
    '/work',
    '/work/',
    '/work/a-task',
  ])
    assert.equal(isWallpaperRoute(route), true, route);
  for (const route of [
    '/',
    '/login',
    '/notes',
    '/calendar',
    '/settings',
    '/workflows',
    '/chat/other',
    '/work/task/file',
    '/channels/a',
  ])
    assert.equal(isWallpaperRoute(route), false, route);
});

test('wallpaper samples stay bounded across large and narrow canvases', () => {
  assert.deepEqual(wallpaperSampleSize(1200, 800), { width: 600, height: 400 });
  for (const [w, h] of [
    [7680, 4320],
    [50000, 50000],
    [1, 20000],
    [20000, 1],
  ]) {
    const size = wallpaperSampleSize(w, h);
    assert.ok(size.width > 0 && size.height > 0);
    assert.ok(size.width <= 1024 && size.height <= 1024);
    assert.ok(size.width * size.height <= 524288);
  }
  for (const invalid of [0, -1, NaN, Infinity])
    assert.deepEqual(wallpaperSampleSize(invalid, 800), {
      width: 0,
      height: 0,
    });
});

test('cover crops preserve aspect ratio and center the source', () => {
  assert.deepEqual(wallpaperCoverCrop(200, 100, 100, 100), {
    x: 50,
    y: 0,
    width: 100,
    height: 100,
  });
  assert.deepEqual(wallpaperCoverCrop(100, 200, 100, 100), {
    x: 0,
    y: 50,
    width: 100,
    height: 100,
  });
  assert.deepEqual(wallpaperCoverCrop(200, 100, 400, 200), {
    x: 0,
    y: 0,
    width: 200,
    height: 100,
  });
});

test('dithering is deterministic, preserves alpha and never mutates the source', () => {
  const source = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < source.length; i += 4)
    source.set([100, 100, 100, i % 256], i);
  const saved = source.slice();
  const first = ditherWallpaper(source, 8, 8);
  assert.deepEqual(source, saved);
  assert.deepEqual(first, ditherWallpaper(source, 8, 8));
  const shades = new Set<number>();
  let sum = 0;
  for (let i = 0; i < source.length; i += 4) {
    shades.add(first[i]);
    sum += first[i];
    assert.equal(first[i], first[i + 1]);
    assert.equal(first[i], first[i + 2]);
    assert.equal(first[i + 3], source[i + 3]);
  }
  assert.equal(shades.size, 2);
  assert.ok(Math.abs(sum / 64 - 100) < 1);
});

test('dithering retains black and white and rejects mismatched buffers', () => {
  const source = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 128]);
  assert.deepEqual(ditherWallpaper(source, 2, 1), source);
  assert.throws(() => ditherWallpaper(source, 2, 2), RangeError);
  assert.throws(() => ditherWallpaper(source, 0.5, 4), RangeError);
});

test('dithering opens deep shadows into sparse colored square pixels', () => {
  const source = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < source.length; i += 4) source.set([10, 12, 28, 255], i);
  const output = ditherWallpaper(source, 8, 8);
  let openShadows = 0;
  let bluePixels = 0;
  let blueTotal = 0;
  for (let i = 0; i < output.length; i += 4) {
    if (output[i] === 0 && output[i + 1] === 0 && output[i + 2] === 0)
      openShadows += 1;
    if (output[i + 2] > output[i]) bluePixels += 1;
    blueTotal += output[i + 2];
    assert.equal(output[i + 3], 255);
  }
  assert.ok(openShadows / 64 >= 0.7);
  assert.ok(bluePixels > 0);
  assert.ok(Math.abs(blueTotal / 64 - 28) < 2);
});

test('colored shadow dots preserve hue instead of introducing gray pixels', () => {
  const source = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < source.length; i += 4) source.set([10, 12, 28, 255], i);
  const output = ditherWallpaper(source, 8, 8);
  for (let i = 0; i < output.length; i += 4) {
    const blue = output[i + 2];
    if (blue === 0) continue;
    assert.ok(output[i] < output[i + 1]);
    assert.ok(output[i + 1] < blue);
    assert.ok(Math.abs(output[i] - (blue * 10) / 28) <= 1);
    assert.ok(Math.abs(output[i + 1] - (blue * 12) / 28) <= 1);
  }
});

test('dark wallpaper highlights are bounded without recoloring dark pixels or alpha', () => {
  const source = new Uint8ClampedArray([
    255, 255, 255, 255, 255, 0, 0, 128, 50, 30, 70, 0,
  ]);
  const output = limitWallpaperHighlights(source);
  assert.deepEqual(
    source,
    new Uint8ClampedArray([255, 255, 255, 255, 255, 0, 0, 128, 50, 30, 70, 0])
  );
  assert.deepEqual(output.slice(8), source.slice(8));
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  for (let i = 0; i < output.length; i += 4) {
    const luminance =
      0.2126 * linear(output[i]) +
      0.7152 * linear(output[i + 1]) +
      0.0722 * linear(output[i + 2]);
    assert.ok(luminance <= 0.162);
    assert.equal(output[i + 3], source[i + 3]);
  }
});

test('highlight preparation preserves dim grays, hue, alpha, and the uploaded source', () => {
  const source = new Uint8ClampedArray([
    28, 28, 28, 128, 220, 180, 140, 255, 10, 12, 28, 128, 255, 255, 255, 0,
  ]);
  const saved = source.slice();
  const prepared = prepareWallpaperDither(source);
  assert.deepEqual(source, saved);
  assert.deepEqual(
    Array.from(prepared.slice(0, 4)),
    Array.from(source.slice(0, 4))
  );
  assert.deepEqual(prepared, prepareWallpaperDither(source));
  assert.ok(Math.abs(prepared[5] / prepared[4] - 180 / 220) < 0.01);
  assert.ok(Math.abs(prepared[6] / prepared[4] - 140 / 220) < 0.01);
  assert.ok(Math.abs(prepared[8] / prepared[10] - 10 / 28) < 0.01);
  assert.ok(Math.abs(prepared[9] / prepared[10] - 12 / 28) < 0.01);
  for (let i = 3; i < source.length; i += 4)
    assert.equal(prepared[i], source[i]);
});

test('equally high color peaks retain different perceived tones in the final dither', () => {
  let previousDensity = 0;
  for (const color of [
    [160, 190, 255],
    [190, 215, 255],
    [255, 255, 255],
  ]) {
    const source = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < source.length; i += 4) source.set([...color, 255], i);
    const output = limitWallpaperHighlights(
      ditherWallpaper(prepareWallpaperDither(source), 8, 8)
    );
    let density = 0;
    for (let i = 0; i < output.length; i += 4)
      if (output[i + 2] > 0) density += 1;
    assert.ok(density > previousDensity, `tonal detail at ${color}`);
    previousDensity = density;
  }
});

test('dithering retains bright gradients before and after the readability bound', () => {
  let previousLightMean = 0;
  let previousDarkMean = 0;
  for (const shade of [144, 176, 208, 240, 255]) {
    const source = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < source.length; i += 4)
      source.set([shade, shade, shade, 255], i);
    const light = ditherWallpaper(prepareWallpaperDither(source), 8, 8);
    const dark = limitWallpaperHighlights(light);
    let gaps = 0;
    let lightTotal = 0;
    let darkTotal = 0;
    for (let i = 0; i < source.length; i += 4) {
      if (light[i] === 0) gaps += 1;
      assert.equal(light[i] === 0, dark[i] === 0);
      assert.equal(light[i + 3], source[i + 3]);
      assert.equal(dark[i + 3], source[i + 3]);
      lightTotal += light[i];
      darkTotal += dark[i];
    }
    assert.ok(gaps > 32 && gaps < 64, `open texture retained at ${shade}`);
    assert.ok(lightTotal / 64 > previousLightMean, `light gradient ${shade}`);
    assert.ok(darkTotal / 64 > previousDarkMean, `dark gradient ${shade}`);
    previousLightMean = lightTotal / 64;
    previousDarkMean = darkTotal / 64;
  }
});

test('composited dither leaves the theme visible through gaps and preserves lit alpha', () => {
  const source = new Uint8ClampedArray(8 * 8 * 4);
  for (let i = 0; i < source.length; i += 4)
    source.set([255, 240, 220, 128], i);
  const saved = source.slice();
  const rendered = renderWallpaperDither(source, 8, 8);
  let visible = 0;
  let gaps = 0;
  for (let i = 0; i < rendered.length; i += 4) {
    if (rendered[i] === 0) {
      assert.equal(rendered[i + 3], 0);
      gaps += 1;
    } else {
      assert.equal(rendered[i + 3], 128);
      assert.ok(rendered[i] >= rendered[i + 1]);
      assert.ok(rendered[i + 1] >= rendered[i + 2]);
      visible += 1;
    }
  }
  assert.ok(gaps > visible && visible > 0);
  assert.deepEqual(source, saved);
  assert.deepEqual(rendered, renderWallpaperDither(source, 8, 8));
});
