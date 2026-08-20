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

import { expect, test, type Page } from '@playwright/test';
import { mockLibreWebUiApi } from './lib/mockApi';
import { openSettingsTab } from './lib/settingsTab';

type MockSkill = {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
};

type MockRevision = {
  version: number;
  instructions: string;
  createdAt: number;
};

const seededSkill: MockSkill = {
  id: 'skill-code-review',
  slug: 'code-review',
  name: 'Code review',
  description: 'Use when asked to review a diff.',
  instructions: 'Read the diff and comment on correctness first.',
  enabled: true,
  version: 1,
  createdAt: 1_770_000_000_000,
  updatedAt: 1_770_000_000_000,
  ownerUserId: 'e2e-user',
};

/**
 * In-memory skill library. Instruction writes accumulate revisions so the
 * history modal and rollback exercise the same contract the backend keeps.
 */
async function mockSkillsApi(page: Page, initialSkills: MockSkill[]) {
  const skills = structuredClone(initialSkills);
  const revisions = new Map<string, MockRevision[]>(
    skills.map(skill => [
      skill.id,
      [
        {
          version: skill.version,
          instructions: skill.instructions,
          createdAt: skill.createdAt,
        },
      ],
    ])
  );
  const createRequests: Array<Record<string, unknown>> = [];
  const updateRequests: Array<{ id: string; body: Record<string, unknown> }> =
    [];
  const rollbackRequests: Array<{ id: string; version: number }> = [];
  const deleteRequests: string[] = [];
  let nextId = skills.length + 1;
  let clock = 1_770_000_100_000;

  const recordRevision = (skill: MockSkill) => {
    const list = revisions.get(skill.id) ?? [];
    list.unshift({
      version: skill.version,
      instructions: skill.instructions,
      createdAt: skill.updatedAt,
    });
    revisions.set(skill.id, list);
  };

  await page.route(/\/api\/skills(?:\/.*)?$/, async route => {
    const request = route.request();
    const method = request.method();
    const path = new URL(request.url()).pathname;

    const fulfill = async (data: unknown) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
    };

    if (path === '/api/skills' && method === 'GET') {
      await fulfill(skills);
      return;
    }

    if (path === '/api/skills' && method === 'POST') {
      const body = request.postDataJSON() as Partial<MockSkill>;
      createRequests.push(body as Record<string, unknown>);
      clock += 1000;
      const created: MockSkill = {
        id: `skill-${nextId++}`,
        slug: body.slug ?? '',
        name: body.name ?? '',
        description: body.description ?? '',
        instructions: body.instructions ?? '',
        enabled: body.enabled !== false,
        version: 1,
        createdAt: clock,
        updatedAt: clock,
        ownerUserId: 'e2e-user',
      };
      skills.push(created);
      recordRevision(created);
      await fulfill(created);
      return;
    }

    const versionsMatch = path.match(/^\/api\/skills\/([^/]+)\/versions$/);
    if (versionsMatch && method === 'GET') {
      await fulfill(revisions.get(versionsMatch[1]) ?? []);
      return;
    }

    const rollbackMatch = path.match(/^\/api\/skills\/([^/]+)\/rollback$/);
    if (rollbackMatch && method === 'POST') {
      const id = rollbackMatch[1];
      const body = request.postDataJSON() as { version: number };
      rollbackRequests.push({ id, version: body.version });
      const skill = skills.find(item => item.id === id);
      const revision = revisions
        .get(id)
        ?.find(item => item.version === body.version);
      if (!skill || !revision) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        });
        return;
      }
      clock += 1000;
      skill.instructions = revision.instructions;
      skill.version += 1;
      skill.updatedAt = clock;
      recordRevision(skill);
      await fulfill(skill);
      return;
    }

    const skillMatch = path.match(/^\/api\/skills\/([^/]+)$/);
    if (skillMatch && method === 'PUT') {
      const id = skillMatch[1];
      const body = request.postDataJSON() as Partial<MockSkill>;
      updateRequests.push({ id, body: body as Record<string, unknown> });
      const skill = skills.find(item => item.id === id);
      if (!skill) {
        await route.fulfill({
          status: 404,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Not found' }),
        });
        return;
      }
      clock += 1000;
      const revised =
        typeof body.instructions === 'string' &&
        body.instructions !== skill.instructions;
      Object.assign(skill, body, { updatedAt: clock });
      if (revised) {
        skill.version += 1;
        recordRevision(skill);
      }
      await fulfill(skill);
      return;
    }

    if (skillMatch && method === 'DELETE') {
      const id = skillMatch[1];
      deleteRequests.push(id);
      const index = skills.findIndex(item => item.id === id);
      if (index >= 0) skills.splice(index, 1);
      await fulfill({ id, deleted: true });
      return;
    }

    await route.fulfill({
      status: 405,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: 'Method not allowed' }),
    });
  });

  return { createRequests, updateRequests, rollbackRequests, deleteRequests };
}

test('the skills page lists the manifest the model would see', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockSkillsApi(page, [seededSkill]);

  await page.goto('/');
  await openSettingsTab(page, 'Skills');
  await expect(page.getByTestId('skills-page')).toBeVisible();

  const row = page.getByTestId('skill-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText(seededSkill.name);
  await expect(row).toContainText(`$${seededSkill.slug}`);
  await expect(row).toContainText(seededSkill.description);
  await expect(row).toContainText('v1');
  await expect(row.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
});

test('the skills page explains itself when nothing is saved yet', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockSkillsApi(page, []);

  await page.goto('/');
  await openSettingsTab(page, 'Skills');
  await expect(page.getByTestId('skills-page')).toBeVisible();
  await expect(page.getByTestId('skill-row')).toHaveCount(0);
  await expect(page.getByText('No skills yet')).toBeVisible();
});

test('a skill is disabled from the row switch and deleted behind a confirmation', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const skillsApi = await mockSkillsApi(page, [seededSkill]);

  await page.goto('/');
  await openSettingsTab(page, 'Skills');
  const row = page.getByTestId('skill-row');
  await expect(row).toBeVisible();

  await row.getByRole('switch').click();
  await expect(row.getByRole('switch')).toHaveAttribute(
    'aria-checked',
    'false'
  );
  await expect.poll(() => skillsApi.updateRequests.length).toBe(1);
  expect(skillsApi.updateRequests[0]).toEqual({
    id: seededSkill.id,
    body: { enabled: false },
  });

  // Deleting always asks first, and cancelling leaves the skill alone.
  await row.getByTestId('skill-delete').click();
  await expect(page.getByTestId('skill-delete-modal')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('skill-delete-modal')).toHaveCount(0);
  expect(skillsApi.deleteRequests).toHaveLength(0);

  await row.getByTestId('skill-delete').click();
  await page.getByTestId('skill-delete-confirm').click();
  await expect(page.getByTestId('skill-delete-modal')).toHaveCount(0);
  await expect(page.getByTestId('skill-row')).toHaveCount(0);
  expect(skillsApi.deleteRequests).toEqual([seededSkill.id]);
});

test('skills manage manifest fields and version history through the UI', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  const skillsApi = await mockSkillsApi(page, []);

  await page.goto('/');
  await openSettingsTab(page, 'Skills');
  await expect(page.getByTestId('skills-page')).toBeVisible();

  // The manifest fields are what the model sees before it loads anything.
  await page.getByTestId('skill-new').click();
  await expect(page.getByTestId('skill-modal')).toBeVisible();
  await page.getByTestId('skill-slug').fill('release-notes');
  await page.getByTestId('skill-name').fill('Release notes');
  await page
    .getByTestId('skill-description')
    .fill('Use when writing a changelog entry.');
  await page
    .getByTestId('skill-instructions')
    .fill('Group changes by feature, then fixes.');
  await page.getByTestId('skill-save').click();
  await expect(page.getByTestId('skill-modal')).toHaveCount(0);

  expect(skillsApi.createRequests).toHaveLength(1);
  expect(skillsApi.createRequests[0]).toEqual({
    slug: 'release-notes',
    name: 'Release notes',
    description: 'Use when writing a changelog entry.',
    instructions: 'Group changes by feature, then fixes.',
    enabled: true,
  });

  const row = page
    .getByTestId('skill-row')
    .filter({ hasText: 'Release notes' });
  await expect(row).toContainText('$release-notes');
  await expect(row).toContainText('Use when writing a changelog entry.');
  await expect(row).toContainText('v1');

  // Rewriting the instructions cuts a new version.
  await row.getByTestId('skill-edit').click();
  await expect(page.getByTestId('skill-modal')).toBeVisible();
  await page
    .getByTestId('skill-instructions')
    .fill('Group changes by feature, then fixes, then chores.');
  await page.getByTestId('skill-save').click();
  await expect(page.getByTestId('skill-modal')).toHaveCount(0);
  await expect(row).toContainText('v2');

  await row.getByTestId('skill-history').click();
  const history = page.getByTestId('skill-history-modal');
  await expect(history).toBeVisible();
  const entries = history.getByTestId('version-history-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.first()).toContainText('Current');
  await expect(entries.first()).toContainText(
    'Group changes by feature, then fixes, then chores.'
  );
  await expect(entries.first().getByTestId('version-rollback')).toBeDisabled();

  await entries.last().getByTestId('version-rollback').click();
  await expect(history).toHaveCount(0);
  expect(skillsApi.rollbackRequests).toHaveLength(1);
  expect(skillsApi.rollbackRequests[0].version).toBe(1);
  await expect(row).toContainText('v3');
});

test('a skill imports from a remote store URL through the modal', async ({
  page,
}) => {
  await mockLibreWebUiApi(page);
  await mockSkillsApi(page, []);

  const importUrlBodies: Array<{ source?: string; overwriteSlug?: boolean }> =
    [];
  await page.route(/\/api\/skills\/import-url$/, async route => {
    importUrlBodies.push(route.request().postDataJSON());
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          id: 'skill-remote',
          slug: 'remote-style',
          name: 'remote-style',
          description: 'Imported from a remote store.',
          instructions: '# Remote style',
          enabled: true,
          version: 1,
          createdAt: 1_770_000_000_000,
          updatedAt: 1_770_000_000_000,
          ownerUserId: 'e2e-user',
        },
      }),
    });
  });

  await page.goto('/');
  await openSettingsTab(page, 'Skills');
  await page.getByTestId('skill-import-url').click();

  const modal = page.getByTestId('skill-import-url-modal');
  await expect(modal).toBeVisible();
  await page
    .getByTestId('skill-import-url-source')
    .fill('https://skills.sh/acme/repo/remote-style');
  await page.getByTestId('skill-import-url-submit').click();

  await expect(modal).toHaveCount(0);
  expect(importUrlBodies).toHaveLength(1);
  expect(importUrlBodies[0]).toMatchObject({
    source: 'https://skills.sh/acme/repo/remote-style',
    overwriteSlug: false,
  });
});
