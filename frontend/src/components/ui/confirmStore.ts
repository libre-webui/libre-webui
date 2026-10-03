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
import type React from 'react';

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  /** Defaults to the translated "Confirm" (or "Delete" when destructive). */
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive confirmations use the danger treatment. */
  destructive?: boolean;
}

export interface PendingConfirm extends ConfirmOptions {
  id: number;
  resolve: (confirmed: boolean) => void;
}

// One shared queue so any handler — hook or plain function — can ask, and
// overlapping requests are answered in order instead of stacking dialogs.
let queue: PendingConfirm[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const subscribeToConfirm = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const currentConfirm = () => queue[0] ?? null;

/**
 * Ask the user to confirm an action with an accessible in-app dialog.
 * Resolves `true` only for an explicit confirmation; Escape, the backdrop
 * and Cancel all resolve `false`.
 */
export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { ...options, id: nextId++, resolve }];
    emit();
  });
}

/** Decline every pending prompt, e.g. when its view goes away. */
export const dismissAllConfirms = () => {
  if (queue.length === 0) return;
  const pending = queue;
  queue = [];
  pending.forEach(request => request.resolve(false));
  emit();
};

export const settle = (confirmed: boolean) => {
  const [current, ...rest] = queue;
  if (!current) return;
  queue = rest;
  current.resolve(confirmed);
  emit();
};
