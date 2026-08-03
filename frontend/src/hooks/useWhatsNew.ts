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

import { useState } from 'react';

const SEEN_STORAGE_KEY = 'libre-webui:whats-new-seen';

export function useWhatsNew() {
  const notes = __LATEST_RELEASE_NOTES__;
  const [open, setOpen] = useState(() => {
    if (!notes || typeof window === 'undefined') return false;

    try {
      return window.localStorage.getItem(SEEN_STORAGE_KEY) !== notes.version;
    } catch {
      // Storage unavailable (private mode) — skip rather than nag every load.
      return false;
    }
  });

  const dismiss = () => {
    setOpen(false);
    if (!notes) return;
    try {
      window.localStorage.setItem(SEEN_STORAGE_KEY, notes.version);
    } catch {
      // Ignore storage failures.
    }
  };

  return { open, dismiss, notes };
}
