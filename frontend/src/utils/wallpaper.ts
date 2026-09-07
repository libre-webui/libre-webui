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

/** Wallpaper belongs to creation surfaces, never to navigation or libraries. */
export const isWallpaperRoute = (pathname: string): boolean =>
  /^\/(?:chat\/?|c\/[^/]+\/?|work(?:\/[^/]+)?\/?)$/.test(pathname);

const MAX_SAMPLE_PIXELS = 524_288;
const MAX_SAMPLE_EDGE = 1024;

/** One source sample becomes roughly two CSS pixels, bounded on large screens. */
export function wallpaperSampleSize(
  width: number,
  height: number,
  pixelSize = 2
) {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(
    1 / Math.max(1, pixelSize),
    MAX_SAMPLE_EDGE / Math.max(width, height),
    Math.sqrt(MAX_SAMPLE_PIXELS / (width * height))
  );
  return {
    width: Math.max(1, Math.floor(width * scale)),
    height: Math.max(1, Math.floor(height * scale)),
  };
}

/** Centered cover crop shared by the sampled canvas and CSS photo modes. */
export function wallpaperCoverCrop(
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number
) {
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const cropWidth = width / scale;
  const cropHeight = height / scale;
  return {
    x: (sourceWidth - cropWidth) / 2,
    y: (sourceHeight - cropHeight) / 2,
    width: cropWidth,
    height: cropHeight,
  };
}

const BAYER_8 = [
  0, 48, 12, 60, 3, 51, 15, 63, 32, 16, 44, 28, 35, 19, 47, 31, 8, 56, 4, 52,
  11, 59, 7, 55, 40, 24, 36, 20, 43, 27, 39, 23, 2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29, 10, 58, 6, 54, 9, 57, 5, 53, 42, 26, 38, 22,
  41, 25, 37, 21,
] as const;

/** Keep highlights below a full dither step without flattening their detail. */
export function prepareWallpaperDither(
  pixels: Uint8ClampedArray
): Float32Array {
  // Keep fractional color ratios until the final dots are written. Rounding
  // dim colors here would shift their hue when the quantizer brightens them.
  const output = new Float32Array(pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    const peak = Math.max(
      pixels[offset],
      pixels[offset + 1],
      pixels[offset + 2]
    );
    if (peak === 0) continue;
    const luminance =
      LINEAR_CHANNELS[pixels[offset]] * 0.2126 +
      LINEAR_CHANNELS[pixels[offset + 1]] * 0.7152 +
      LINEAR_CHANNELS[pixels[offset + 2]] * 0.0722;
    const brightness = SRGB_CHANNELS[Math.round(luminance * 4096)];
    // Reserve gaps even in white skies. A monotonic shoulder keeps exposure
    // differences that a hard cap after quantization would erase completely.
    // Density follows perceived brightness, not the largest color channel:
    // blue sky and white clouds can share a peak while having different tones.
    const mappedPeak =
      brightness <= 64
        ? brightness
        : 64 + ((brightness - 64) * (112 - 64)) / (255 - 64);
    const scale = mappedPeak / peak;
    for (let channel = 0; channel < 3; channel += 1)
      output[offset + channel] = pixels[offset + channel] * scale;
  }
  return output;
}

/** Coarse color steps leave distinct square dots and open shadows. */
export function ditherWallpaper(
  pixels: Uint8ClampedArray | Float32Array,
  width: number,
  height: number
): Uint8ClampedArray {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 0 ||
    height < 0 ||
    width * height * 4 !== pixels.length
  ) {
    throw new RangeError('Wallpaper pixel dimensions do not match the buffer');
  }
  const output = new Uint8ClampedArray(pixels);
  const levels = 1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const threshold = (BAYER_8[(y % 8) * 8 + (x % 8)] + 0.5) / 64 - 0.5;
      const peak = Math.max(
        pixels[offset],
        pixels[offset + 1],
        pixels[offset + 2]
      );
      if (peak === 0) continue;
      // Quantize brightness together so shadow dots retain the source hue
      // instead of splitting into unrelated white or primary-color pixels.
      const step = Math.round((peak / 255) * levels + threshold);
      const scale = (Math.max(0, Math.min(levels, step)) * 255) / levels / peak;
      for (let channel = 0; channel < 3; channel += 1) {
        output[offset + channel] = pixels[offset + channel] * scale;
      }
    }
  }
  return output;
}

const LINEAR_CHANNELS = Array.from({ length: 256 }, (_, value) => {
  const channel = value / 255;
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
});
const SRGB_CHANNELS = Uint8ClampedArray.from({ length: 4097 }, (_, value) => {
  const channel = value / 4096;
  return (
    255 *
    (channel <= 0.0031308
      ? channel * 12.92
      : 1.055 * channel ** (1 / 2.4) - 0.055)
  );
});

/** Preserve dark artwork and hue while bounding highlights behind light text. */
export function limitWallpaperHighlights(
  pixels: Uint8ClampedArray
): Uint8ClampedArray {
  const output = new Uint8ClampedArray(pixels);
  for (let offset = 0; offset < output.length; offset += 4) {
    const red = LINEAR_CHANNELS[output[offset]];
    const green = LINEAR_CHANNELS[output[offset + 1]];
    const blue = LINEAR_CHANNELS[output[offset + 2]];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    if (luminance <= 0.16) continue;
    const scale = 0.16 / luminance;
    output[offset] = SRGB_CHANNELS[Math.round(red * scale * 4096)];
    output[offset + 1] = SRGB_CHANNELS[Math.round(green * scale * 4096)];
    output[offset + 2] = SRGB_CHANNELS[Math.round(blue * scale * 4096)];
  }
  return output;
}

/** Colored dots sit on the theme canvas; empty cells must not paint a wash. */
export function renderWallpaperDither(
  pixels: Uint8ClampedArray,
  width: number,
  height: number
): Uint8ClampedArray {
  const output = limitWallpaperHighlights(
    ditherWallpaper(prepareWallpaperDither(pixels), width, height)
  );
  for (let offset = 0; offset < output.length; offset += 4) {
    if (
      output[offset] === 0 &&
      output[offset + 1] === 0 &&
      output[offset + 2] === 0
    )
      output[offset + 3] = 0;
  }
  return output;
}
