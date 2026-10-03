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
  backgroundWorkAnnouncements,
  hasActiveWorkTask,
  workStatusAnnouncement,
} from './workAnnouncements.ts';
test('finishing a run is polite, needing the user or failing is assertive', () => {
  assert.deepEqual(workStatusAnnouncement('running', 'completed'), {
    key: 'work.announce.completed',
    politeness: 'polite',
  });
  assert.deepEqual(workStatusAnnouncement('preparing', 'needs_input'), {
    key: 'work.announce.needsInput',
    politeness: 'assertive',
  });
  assert.deepEqual(workStatusAnnouncement('running', 'failed'), {
    key: 'work.announce.failed',
    politeness: 'assertive',
  });
  assert.deepEqual(workStatusAnnouncement('running', 'cancelled'), {
    key: 'work.announce.cancelled',
    politeness: 'polite',
  });
});
test('stays silent unless a task leaves preparing or running', () => {
  assert.equal(workStatusAnnouncement('idle', 'completed'), null);
  assert.equal(workStatusAnnouncement('completed', 'completed'), null);
  assert.equal(workStatusAnnouncement('completed', 'running'), null);
  assert.equal(workStatusAnnouncement('preparing', 'running'), null);
  assert.equal(workStatusAnnouncement('running', 'idle'), null);
});

test('background tasks announce their own transitions, never the open one', () => {
  const previous = new Map([
    ['a', 'running' as const],
    ['b', 'running' as const],
    ['c', 'completed' as const],
  ]);
  const { announcements, statuses } = backgroundWorkAnnouncements(
    previous,
    [
      { id: 'a', title: 'Open task', status: 'completed' },
      { id: 'b', title: 'Report', status: 'failed' },
      { id: 'c', title: 'Done earlier', status: 'completed' },
      { id: 'd', title: 'New', status: 'completed' },
    ],
    'a'
  );
  assert.deepEqual(announcements, [
    {
      key: 'work.announce.failed',
      politeness: 'assertive',
      taskId: 'b',
      title: 'Report',
    },
  ]);
  assert.equal(statuses.get('a'), 'completed');
  assert.equal(statuses.get('d'), 'completed');
});

test('the first snapshot only seeds statuses', () => {
  const { announcements } = backgroundWorkAnnouncements(
    new Map(),
    [{ id: 'a', title: 'Task', status: 'completed' }],
    null
  );
  assert.deepEqual(announcements, []);
});

test('only working tasks keep the background poll alive', () => {
  assert.equal(hasActiveWorkTask([{ status: 'completed' }]), false);
  assert.equal(hasActiveWorkTask([{ status: 'running' }]), true);
  assert.equal(hasActiveWorkTask([{ status: 'preparing' }]), true);
});
