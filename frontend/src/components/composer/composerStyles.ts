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

export const composerSurfaceClass =
  'relative rounded-[24px] border border-line bg-surface p-2.5 shadow-subtle transition-[border-color,box-shadow,background-color] duration-150 ease-out focus-within:border-primary-500/50 focus-within:ring-2 focus-within:ring-primary-500/10 dark:bg-surface-subtle dark:focus-within:border-primary-400/50 dark:focus-within:ring-primary-400/10 motion-reduce:transition-none';

// The global narrow-screen button minimum retains the 44px touch target.
export const composerSendButtonClass =
  'h-9 w-9 shrink-0 rounded-full border-transparent bg-ink p-0 text-ink-inverse shadow-none hover:bg-ink hover:text-ink-inverse hover:opacity-90 disabled:border-line disabled:bg-surface-subtle disabled:text-ink-subtle disabled:opacity-100 disabled:hover:bg-surface-subtle disabled:hover:text-ink-subtle disabled:hover:opacity-100 dark:disabled:bg-surface-raised dark:disabled:hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface dark:focus-visible:ring-primary-400/40 transition-[background-color,color,opacity,box-shadow] duration-150 ease-out motion-reduce:transition-none touch-manipulation';
