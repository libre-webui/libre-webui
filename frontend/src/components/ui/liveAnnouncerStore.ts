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
export type AnnouncementPoliteness = 'polite' | 'assertive';
export interface Announcement {
  /** Changes on every call so an identical repeat is still a new event. */
  id: number;
  message: string;
}
export interface AnnouncerSnapshot {
  polite: Announcement;
  assertive: Announcement;
}
const empty: Announcement = { id: 0, message: '' };
// One shared snapshot so any handler, hook or plain function can speak
// without owning a DOM node. Only the latest message per politeness matters:
// a screen reader cannot usefully queue stale status updates.
let snapshot: AnnouncerSnapshot = { polite: empty, assertive: empty };
let nextId = 1;
const listeners = new Set<() => void>();
export const subscribeToAnnouncer = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const currentAnnouncements = () => snapshot;
/**
 * Ask assistive technology to read `message`. Use `polite` for completed
 * work and `assertive` only for failures or anything needing a decision.
 * Never call this per streamed token; announce once when a state settles.
 */
export function announce(
  message: string,
  politeness: AnnouncementPoliteness = 'polite'
): void {
  const text = message.trim();
  if (!text) return;
  snapshot = {
    ...snapshot,
    [politeness]: { id: nextId++, message: text },
  };
  listeners.forEach(listener => listener());
}
