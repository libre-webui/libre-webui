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
import test, { afterEach } from 'node:test';
import type { AppTab } from './tabStore';

const storedTabs = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    clear: () => storedTabs.clear(),
    getItem: (key: string) => storedTabs.get(key) ?? null,
    key: (index: number) => [...storedTabs.keys()][index] ?? null,
    get length() {
      return storedTabs.size;
    },
    removeItem: (key: string) => storedTabs.delete(key),
    setItem: (key: string, value: string) => storedTabs.set(key, value),
  },
});
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: { localStorage: globalThis.localStorage },
});

const { HOME_TAB, tabForPath, useTabStore } = await import('./tabStore');

const chatTab: AppTab = {
  id: 'chat:alpha',
  kind: 'chat',
  path: '/c/alpha',
};
const modelsTab: AppTab = {
  id: 'page:/personas',
  kind: 'page',
  path: '/personas',
};
const workTab: AppTab = {
  id: 'work:beta',
  kind: 'work',
  path: '/work/beta',
};

afterEach(() => {
  useTabStore.setState({ tabs: [HOME_TAB], activeTabId: HOME_TAB.id });
});

test('provider usage participates in the application tab shell', () => {
  assert.deepEqual(tabForPath('/usage'), {
    id: 'page:/usage',
    kind: 'page',
    path: '/usage',
  });
});

test('system diagnostics participate in the application tab shell', () => {
  assert.deepEqual(tabForPath('/system'), {
    id: 'page:/system',
    kind: 'page',
    path: '/system',
  });
});

test('bulk close always preserves Home and can return to it', () => {
  useTabStore.setState({
    tabs: [HOME_TAB, chatTab, modelsTab],
    activeTabId: chatTab.id,
  });

  const fallback = useTabStore
    .getState()
    .closeTabs([HOME_TAB.id, chatTab.id, modelsTab.id], HOME_TAB.id);

  assert.deepEqual(useTabStore.getState().tabs, [HOME_TAB]);
  assert.equal(useTabStore.getState().activeTabId, HOME_TAB.id);
  assert.deepEqual(fallback, HOME_TAB);
});

test('closing other tabs activates the kept context tab when needed', () => {
  useTabStore.setState({
    tabs: [HOME_TAB, chatTab, modelsTab, workTab],
    activeTabId: chatTab.id,
  });

  const fallback = useTabStore
    .getState()
    .closeTabs([chatTab.id, workTab.id], modelsTab.id);

  assert.deepEqual(useTabStore.getState().tabs, [HOME_TAB, modelsTab]);
  assert.equal(useTabStore.getState().activeTabId, modelsTab.id);
  assert.deepEqual(fallback, modelsTab);
});

test('closing tabs to the right preserves tabs to the left', () => {
  useTabStore.setState({
    tabs: [HOME_TAB, chatTab, modelsTab, workTab],
    activeTabId: workTab.id,
  });

  const fallback = useTabStore.getState().closeTabs([workTab.id], modelsTab.id);

  assert.deepEqual(useTabStore.getState().tabs, [HOME_TAB, chatTab, modelsTab]);
  assert.equal(useTabStore.getState().activeTabId, modelsTab.id);
  assert.deepEqual(fallback, modelsTab);
});

test('bulk close does not navigate when the active tab remains open', () => {
  useTabStore.setState({
    tabs: [HOME_TAB, chatTab, modelsTab, workTab],
    activeTabId: chatTab.id,
  });

  const fallback = useTabStore.getState().closeTabs([workTab.id], modelsTab.id);

  assert.deepEqual(useTabStore.getState().tabs, [HOME_TAB, chatTab, modelsTab]);
  assert.equal(useTabStore.getState().activeTabId, chatTab.id);
  assert.equal(fallback, null);
});
