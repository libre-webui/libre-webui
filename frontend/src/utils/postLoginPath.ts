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

interface RedirectState {
  from?: { pathname?: unknown; search?: unknown; hash?: unknown };
}

const isSameAppPath = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.startsWith('/') &&
  !value.startsWith('//') &&
  !value.includes('\\');

// A deliberate sign-out ends the visit: the next person to sign in on this
// device must not be sent to the page the previous account had open. Expired
// sessions keep the remembered destination.
let endedByUser = false;

/** Record that the user signed out on purpose. */
export const noteExplicitLogout = () => {
  endedByUser = true;
};

/** Whether the last session ended with a deliberate sign-out. */
export const endedByExplicitLogout = () => endedByUser;

/** Clear the sign-out marker once a new session has started. */
export const clearExplicitLogout = () => {
  endedByUser = false;
};

/**
 * Where to land after signing in: the page a guarded route bounced the user
 * away from, when it is a same-app relative path, otherwise the home route.
 * The state can be forged through history, so it is validated here.
 */
export const resolvePostLoginPath = (state: unknown): string => {
  if (endedByUser) return '/';
  const from = (state as RedirectState | null | undefined)?.from;
  if (!from || !isSameAppPath(from.pathname) || from.pathname === '/login') {
    return '/';
  }
  // Appended after a validated pathname, so these cannot change the origin.
  const search = typeof from.search === 'string' ? from.search : '';
  const hash = typeof from.hash === 'string' ? from.hash : '';
  return `${from.pathname}${search}${hash}`;
};
