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
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test, { afterEach, beforeEach } from 'node:test';
import type { ApiResponse, UserPreferences } from '@/types';
import { DEFAULT_BACKGROUND_SETTINGS } from '@/utils/backgroundSettings';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    localStorage: globalThis.localStorage,
    location: { hostname: 'localhost' },
  },
});

type Response = ApiResponse<UserPreferences>;
const success = (): Response => ({ success: true });
const requests: Partial<UserPreferences>[] = [];
let readPreferences: () => Promise<Response> = async () => success();
let savePreferences: (
  updates: Partial<UserPreferences>
) => Promise<Response> = async () => success();
const api = {
  getPreferences: () => readPreferences(),
  updatePreferences: (updates: Partial<UserPreferences>) => {
    requests.push(structuredClone(updates));
    return savePreferences(updates);
  },
};
Object.defineProperty(globalThis, '__wallpaperStoreTestApi', { value: api });
// Isolate the store from the browser API bundle while retaining its real
// persistence logic. Every request is controlled in this test process.
const mockModule = `data:text/javascript,${encodeURIComponent(
  'export const preferencesApi = globalThis.__wallpaperStoreTestApi;'
)}`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === '@/utils/api'
      ? { url: mockModule, shortCircuit: true }
      : nextResolve(specifier, context);
  },
});

class ControlledFileReader {
  static instances: ControlledFileReader[] = [];
  result: string | null = null;
  error: Error | null = null;
  readyState = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  constructor() {
    ControlledFileReader.instances.push(this);
  }
  readAsDataURL() {
    this.readyState = 1;
  }
  abort() {
    if (this.readyState === 1) {
      this.readyState = 2;
      this.onabort?.();
    }
  }
  complete(image: string) {
    this.result = image;
    this.readyState = 2;
    this.onload?.();
  }
}
Object.defineProperty(globalThis, 'FileReader', {
  configurable: true,
  value: ControlledFileReader,
});

class ControlledImage {
  static instances: ControlledImage[] = [];
  static autoComplete = true;
  naturalWidth = 16;
  naturalHeight = 16;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private source = '';
  constructor() {
    ControlledImage.instances.push(this);
  }
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    if (!value || !ControlledImage.autoComplete) return;
    queueMicrotask(() => {
      if (value.includes('corrupt')) this.onerror?.();
      else this.onload?.();
    });
  }
}
Object.defineProperty(globalThis, 'Image', {
  configurable: true,
  value: ControlledImage,
});

const { useAppStore } = await import('./appStore');
const store = () => useAppStore.getState();
const initial = {
  ...DEFAULT_BACKGROUND_SETTINGS,
  enabled: true,
  imageUrl: 'data:image/png;base64,original',
  blurAmount: 0,
  opacity: 0,
  effect: 'original' as const,
};
const savedResponse = (imageUrl: string): Response => ({
  success: true,
  data: {
    ...store().preferences,
    backgroundSettings: { ...initial, imageUrl },
  },
});
const deferred = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>(done => {
    resolve = done;
  });
  return { promise, resolve };
};
const drain = async () => {
  for (let turn = 0; turn < 6; turn++) await setImmediate();
};
const sourceFile = () =>
  new File(['image'], 'wallpaper.png', { type: 'image/png' });
const isAbort = (error: unknown) =>
  error instanceof Error && error.name === 'AbortError';
const hydrateWallpaper = async (settings: typeof initial) => {
  const previousRead = readPreferences;
  readPreferences = async () => ({
    success: true,
    data: { ...store().preferences, backgroundSettings: settings },
  });
  try {
    await store().loadPreferences();
  } finally {
    readPreferences = previousRead;
  }
};

beforeEach(async () => {
  store().clearUserState();
  storage.set('auth-token', 'account-a');
  requests.length = 0;
  ControlledFileReader.instances = [];
  ControlledImage.instances = [];
  ControlledImage.autoComplete = true;
  readPreferences = async () => success();
  savePreferences = async () => success();
  await hydrateWallpaper(initial);
});
afterEach(() => store().clearUserState());

test('slider edits preview immediately and coalesce into one save without losing zero values or effect', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const first = store().updateBackgroundSettings({ blurAmount: 12 });
  const second = store().updateBackgroundSettings({ opacity: 0.7 });
  const last = store().updateBackgroundSettings({ blurAmount: 0, opacity: 0 });
  assert.equal(store().preferences.backgroundSettings?.blurAmount, 0);
  assert.equal(store().preferences.backgroundSettings?.opacity, 0);
  assert.equal(requests.length, 0);
  context.mock.timers.tick(250);
  await Promise.all([first, second, last]);
  assert.deepEqual(requests, [{ backgroundSettings: initial }]);
  const persisted = JSON.parse(storage.get('libre-webui-app-state')!);
  assert.equal(persisted.state.backgroundImage, undefined);
  assert.equal(persisted.state.preferences.backgroundSettings, undefined);
});

test('a later edit waits for the active save and never restores an older preview', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const firstReply = deferred();
  const secondReply = deferred();
  savePreferences = () =>
    requests.length === 1 ? firstReply.promise : secondReply.promise;
  const first = store().updateBackgroundSettings({ opacity: 0.2 });
  context.mock.timers.tick(250);
  await drain();
  assert.equal(requests.length, 1);
  const last = store().updateBackgroundSettings({ opacity: 0.9 });
  context.mock.timers.tick(250);
  await drain();
  assert.equal(requests.length, 1);
  firstReply.resolve(success());
  await first;
  await drain();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].backgroundSettings?.opacity, 0.9);
  assert.equal(store().preferences.backgroundSettings?.opacity, 0.9);
  secondReply.resolve(success());
  await last;
});

test('failed upload and removal reject while restoring the last saved wallpaper', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  savePreferences = async () => ({ success: false, error: 'Save unavailable' });
  const upload = store().uploadBackgroundImage(sourceFile());
  const uploadFailure = assert.rejects(upload, /Save unavailable/);
  ControlledFileReader.instances[0].complete(
    'data:image/png;base64,replacement'
  );
  await drain();
  assert.notEqual(store().backgroundImage, initial.imageUrl);
  context.mock.timers.tick(250);
  await uploadFailure;
  assert.deepEqual(store().preferences.backgroundSettings, initial);
  assert.equal(store().backgroundImage, initial.imageUrl);
  const removal = store().removeBackgroundImage();
  const removalFailure = assert.rejects(removal, /Save unavailable/);
  assert.equal(store().backgroundImage, null);
  context.mock.timers.tick(250);
  await removalFailure;
  assert.deepEqual(store().preferences.backgroundSettings, initial);
});

test('logout cancels queued writes and delayed file reads before another account can save them', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const update = store().updateBackgroundSettings({ opacity: 0.8 });
  const updateCancelled = assert.rejects(update, isAbort);
  const upload = store().uploadBackgroundImage(sourceFile());
  const uploadCancelled = assert.rejects(upload, isAbort);
  const reader = ControlledFileReader.instances[0];
  store().clearUserState();
  storage.set('auth-token', 'account-b');
  await hydrateWallpaper({ ...initial, imageUrl: 'account-b-image' });
  reader.complete('account-a-image');
  context.mock.timers.tick(500);
  await Promise.all([updateCancelled, uploadCancelled]);
  await drain();
  assert.equal(requests.length, 0);
  assert.equal(store().backgroundImage, 'account-b-image');
});

test('removal and newer uploads invalidate an earlier file read', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const oldUpload = store().uploadBackgroundImage(sourceFile());
  const cancelledUpload = assert.rejects(oldUpload, isAbort);
  const oldReader = ControlledFileReader.instances[0];
  const removal = store().removeBackgroundImage();
  oldReader.complete('stale-image');
  context.mock.timers.tick(250);
  await Promise.all([cancelledUpload, removal]);
  assert.equal(store().backgroundImage, null);
  assert.equal(requests[0].backgroundSettings?.imageUrl, '');

  const replacedUpload = store().uploadBackgroundImage(sourceFile());
  const replaced = assert.rejects(replacedUpload, isAbort);
  const currentUpload = store().uploadBackgroundImage(sourceFile());
  ControlledFileReader.instances[1].complete('stale-again');
  ControlledFileReader.instances[2].complete('current-image');
  await drain();
  context.mock.timers.tick(250);
  await Promise.all([replaced, currentUpload]);
  assert.equal(store().backgroundImage, 'current-image');
  assert.equal(requests[1].backgroundSettings?.imageUrl, 'current-image');
});

test('late preferences cannot restore the previous account or beat a newer read', async () => {
  const oldReply = deferred();
  readPreferences = () => oldReply.promise;
  const oldLoad = store().loadPreferences();
  await drain();
  const oldData = savedResponse('account-a-image');
  store().clearUserState();
  storage.set('auth-token', 'account-b');
  readPreferences = async () => savedResponse('account-b-image');
  await store().loadPreferences();
  oldReply.resolve(oldData);
  await oldLoad;
  assert.equal(store().backgroundImage, 'account-b-image');

  const firstReply = deferred();
  readPreferences = () => firstReply.promise;
  const firstLoad = store().loadPreferences();
  await drain();
  readPreferences = async () => savedResponse('newest-image');
  await store().loadPreferences();
  firstReply.resolve(savedResponse('older-image'));
  await firstLoad;
  assert.equal(store().backgroundImage, 'newest-image');
});

test('a late preference read cannot undo a wallpaper replacement or removal', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  for (const image of ['replacement-image', null]) {
    const reply = deferred();
    readPreferences = () => reply.promise;
    const load = store().loadPreferences();
    await drain();
    const update = store().setBackgroundImage(image);
    context.mock.timers.tick(250);
    await update;
    reply.resolve(savedResponse('stale-loaded-image'));
    await load;
    assert.equal(store().backgroundImage, image);
  }
});

test('an old account save cannot roll back or release the new account queue', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const oldReply = deferred();
  savePreferences = () =>
    requests.length === 1 ? oldReply.promise : Promise.resolve(success());
  const oldUpdate = store().setBackgroundImage('account-a-new-image');
  const oldCancelled = assert.rejects(oldUpdate, isAbort);
  context.mock.timers.tick(250);
  await drain();
  store().clearUserState();
  storage.set('auth-token', 'account-b');
  await hydrateWallpaper({ ...initial, imageUrl: 'account-b-image' });
  const current = store().updateBackgroundSettings({ opacity: 0.5 });
  context.mock.timers.tick(250);
  await current;
  oldReply.resolve({ success: false, error: 'Old request failed' });
  await oldCancelled;
  await drain();
  assert.equal(store().backgroundImage, 'account-b-image');
  assert.equal(store().preferences.backgroundSettings?.opacity, 0.5);
  assert.equal(requests.length, 2);
});

test('a preference read started during a pending save cannot restore the pre-save wallpaper', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const reply = deferred();
  readPreferences = () => reply.promise;
  const update = store().setBackgroundImage('new-image');
  const load = store().loadPreferences();
  await drain();
  context.mock.timers.tick(250);
  await update;
  reply.resolve(savedResponse(initial.imageUrl));
  await load;
  assert.equal(store().backgroundImage, 'new-image');
});

test('a corrupt file rejects before replacing or saving the existing wallpaper', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const upload = store().uploadBackgroundImage(
    new File(['not an image'], 'renamed.png', { type: 'image/png' })
  );
  const failure = assert.rejects(upload, /not a valid image/);
  ControlledFileReader.instances[0].complete('data:image/png;base64,corrupt');
  await failure;
  context.mock.timers.tick(500);
  await drain();
  assert.deepEqual(store().preferences.backgroundSettings, initial);
  assert.equal(store().backgroundImage, initial.imageUrl);
  assert.equal(requests.length, 0);
  assert.equal(ControlledImage.instances[0].src, '');
  assert.equal(ControlledImage.instances[0].onload, null);
  assert.equal(ControlledImage.instances[0].onerror, null);
});

test('an account change cancels image decoding and discards a late decoder callback', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  ControlledImage.autoComplete = false;
  const upload = store().uploadBackgroundImage(sourceFile());
  const aborted = assert.rejects(upload, isAbort);
  ControlledFileReader.instances[0].complete('account-a-image');
  const image = ControlledImage.instances[0];
  const lateLoad = image.onload;
  store().clearUserState();
  storage.set('auth-token', 'account-b');
  await hydrateWallpaper({ ...initial, imageUrl: 'account-b-image' });
  await aborted;
  lateLoad?.();
  context.mock.timers.tick(500);
  await drain();
  assert.equal(store().backgroundImage, 'account-b-image');
  assert.equal(requests.length, 0);
  assert.equal(image.src, '');
  assert.equal(image.onload, null);
  assert.equal(image.onerror, null);
});

test('disabling wallpaper during image decoding cannot be undone by the pending upload', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  ControlledImage.autoComplete = false;
  const upload = store().uploadBackgroundImage(sourceFile());
  const aborted = assert.rejects(upload, isAbort);
  ControlledFileReader.instances[0].complete('replacement-image');
  const image = ControlledImage.instances[0];
  const lateLoad = image.onload;
  const disabled = store().updateBackgroundSettings({ enabled: false });
  await aborted;
  lateLoad?.();
  context.mock.timers.tick(250);
  await disabled;
  await drain();
  assert.deepEqual(store().preferences.backgroundSettings, {
    ...initial,
    enabled: false,
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].backgroundSettings?.imageUrl, initial.imageUrl);
  assert.equal(image.src, '');
});

test('an unrelated full-preference response cannot overwrite a wallpaper edit or poison rollback', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const staleResponse = savedResponse('old-snapshot-image');
  const update = store().setBackgroundImage('newly-saved-image');
  store().setPreferences({ ...staleResponse.data, showUsername: true });
  assert.equal(store().backgroundImage, 'newly-saved-image');
  assert.equal(store().preferences.showUsername, true);
  context.mock.timers.tick(250);
  await update;

  store().setPreferences({ ...staleResponse.data, showUsername: false });
  assert.equal(store().backgroundImage, 'newly-saved-image');
  assert.equal(
    store().preferences.backgroundSettings?.imageUrl,
    'newly-saved-image'
  );
  assert.equal(store().preferences.showUsername, false);

  savePreferences = async () => ({ success: false, error: 'Save failed' });
  const removal = store().removeBackgroundImage();
  const failure = assert.rejects(removal, /Save failed/);
  context.mock.timers.tick(250);
  await failure;
  assert.equal(store().backgroundImage, 'newly-saved-image');
  assert.deepEqual(store().preferences.backgroundSettings, {
    ...initial,
    imageUrl: 'newly-saved-image',
  });
});

test('a previous account full-preference save response cannot change the current wallpaper', async () => {
  const staleResponse = savedResponse('account-a-image');
  store().clearUserState();
  storage.set('auth-token', 'account-b');
  await hydrateWallpaper({ ...initial, imageUrl: 'account-b-image' });
  store().setPreferences(staleResponse.data!);
  assert.equal(store().backgroundImage, 'account-b-image');
  assert.equal(
    store().preferences.backgroundSettings?.imageUrl,
    'account-b-image'
  );
});
