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

import { create } from 'zustand';
import {
  getCelestialPalette,
  getCelestialScene,
  type CelestialPalette,
  type CelestialScene,
} from '@/utils/celestial';

interface CelestialState {
  /** Latest palette while the celestial theme is active, else null. */
  palette: CelestialPalette | null;
  scene: CelestialScene | null;
  /** A minute of the day being previewed from Settings, else null. */
  previewMinutes: number | null;
  refresh: () => void;
  setPreviewMinutes: (minutes: number | null) => void;
  clear: () => void;
}

export const useCelestialStore = create<CelestialState>((set, get) => ({
  palette: null,
  scene: null,
  previewMinutes: null,
  refresh: () => {
    const palette = getCelestialPalette(
      new Date(),
      get().previewMinutes ?? undefined
    );
    set({ palette, scene: getCelestialScene(palette) });
  },
  setPreviewMinutes: minutes => {
    set({ previewMinutes: minutes });
    get().refresh();
  },
  clear: () => set({ palette: null, scene: null, previewMinutes: null }),
}));
