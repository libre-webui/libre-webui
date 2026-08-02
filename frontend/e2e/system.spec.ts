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

import { expect, test } from '@playwright/test';
import type { SystemDiagnostics } from '../src/utils/api/systemApi';
import { mockLibreWebUiApi } from './lib/mockApi';

const now = Date.now();
const systemInfo = {
  requiresAuth: true,
  hasUsers: true,
  userCount: 2,
  signupEnabled: true,
  allowUserModelPull: true,
  version: '0.17.0-e2e',
  turnstile: { enabled: false },
};

const diagnostics: SystemDiagnostics = {
  generatedAt: now,
  host: {
    hostname: 'libre-prod-01',
    platform: 'linux',
    release: '6.8.0-64-generic',
    architecture: 'x64',
    uptimeSeconds: 266_400,
    bootedAt: now - 266_400_000,
    logicalCpus: 8,
    cpuModel: 'AMD EPYC 7B13',
    loadAverage: [0.24, 0.31, 0.29],
    containerized: true,
  },
  runtime: {
    appVersion: '0.17.0',
    nodeVersion: 'v24.5.0',
    processId: 42,
    processUptimeSeconds: 14_420,
    workingDirectory: '/app',
  },
  memory: {
    totalBytes: 16 * 1024 ** 3,
    freeBytes: 5.12 * 1024 ** 3,
    usedBytes: 10.88 * 1024 ** 3,
    usedPercent: 68,
    processRssBytes: 412 * 1024 ** 2,
    heapUsedBytes: 188 * 1024 ** 2,
    heapTotalBytes: 260 * 1024 ** 2,
    externalBytes: 22 * 1024 ** 2,
  },
  filesystems: [
    {
      label: 'Runtime filesystem',
      path: '/',
      totalBytes: 160 * 1024 ** 3,
      freeBytes: 82 * 1024 ** 3,
      usedBytes: 78 * 1024 ** 3,
      usedPercent: 48.8,
    },
    {
      label: 'Data directory',
      path: '/app/backend/data',
      totalBytes: 320 * 1024 ** 3,
      freeBytes: 214 * 1024 ** 3,
      usedBytes: 106 * 1024 ** 3,
      usedPercent: 33.1,
    },
  ],
  network: {
    interfaces: [
      {
        name: 'eth0',
        addresses: [
          {
            address: '172.18.0.4',
            family: 'IPv4',
            cidr: '172.18.0.4/16',
            internal: false,
          },
        ],
        receivedBytes: 4.8 * 1024 ** 3,
        transmittedBytes: 1.7 * 1024 ** 3,
      },
      {
        name: 'lo',
        addresses: [
          {
            address: '127.0.0.1',
            family: 'IPv4',
            cidr: '127.0.0.1/8',
            internal: true,
          },
        ],
        receivedBytes: 220 * 1024 ** 2,
        transmittedBytes: 220 * 1024 ** 2,
      },
    ],
  },
  docker: {
    available: true,
    socketMounted: true,
    serverVersion: '28.3.0',
    operatingSystem: 'Ubuntu 24.04.2 LTS',
    architecture: 'x86_64',
    kernelVersion: '6.8.0-64-generic',
    logicalCpus: 8,
    memoryBytes: 16 * 1024 ** 3,
    totalContainers: 3,
    runningContainers: 2,
    stoppedContainers: 1,
    pausedContainers: 0,
    containers: [
      {
        id: 'aabbccddeeff',
        name: 'libre-webui',
        image: 'libre-webui/libre-webui:dev',
        state: 'running',
        status: 'Up 3 days',
        createdAt: now - 3 * 86_400_000,
      },
      {
        id: '001122334455',
        name: 'ollama',
        image: 'ollama/ollama:latest',
        state: 'running',
        status: 'Up 3 days',
        createdAt: now - 3 * 86_400_000,
      },
      {
        id: '66778899aabb',
        name: 'old-worker',
        image: 'libre-webui/work-runtime:0.1.0',
        state: 'exited',
        status: 'Exited (0) 2 days ago',
        createdAt: now - 5 * 86_400_000,
      },
    ],
  },
};

test('administrators open machine and Docker diagnostics from the user menu', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    systemDiagnostics: diagnostics,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/');
  await page.getByRole('button', { name: /admin/i }).last().click();
  await page.getByRole('link', { name: 'System', exact: true }).click();

  await expect(page).toHaveURL(/\/system$/);
  await expect(
    page.getByRole('heading', { name: 'System', exact: true })
  ).toBeVisible();
  await expect(page.getByTestId('system-dashboard')).toBeVisible();
  await expect(page.getByText('3d 2h', { exact: true })).toBeVisible();
  await expect(page.getByText('68%', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('libre-prod-01')).toBeVisible();
  await expect(page.getByTestId('system-docker-table')).toBeVisible();
  await expect(page.getByText('libre-webui', { exact: true })).toBeVisible();
  await expect(page.getByText('ollama', { exact: true })).toBeVisible();
  await expect(page.getByText('172.18.0.4/16')).toBeVisible();
});

test('regular users cannot navigate to or directly open system diagnostics', async ({
  page,
}) => {
  await mockLibreWebUiApi(page, {
    systemInfo,
    systemDiagnostics: diagnostics,
    authUsers: [
      {
        id: 'regular-user',
        username: 'member',
        email: 'member@example.test',
        role: 'user',
        status: 'active',
        token: 'member-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'member-token');
  });

  await page.goto('/');
  await page
    .getByRole('button', { name: /member/i })
    .last()
    .click();
  await expect(
    page.getByRole('link', { name: 'System', exact: true })
  ).toHaveCount(0);

  await page.goto('/system');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId('system-dashboard')).toHaveCount(0);
});

test('system diagnostics remain contained on a mobile viewport', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockLibreWebUiApi(page, {
    systemInfo,
    systemDiagnostics: diagnostics,
    authUsers: [
      {
        id: 'admin-user',
        username: 'admin',
        email: 'admin@example.test',
        role: 'admin',
        status: 'active',
        token: 'admin-token',
      },
    ],
  });
  await page.addInitScript(() => {
    localStorage.setItem('auth-token', 'admin-token');
  });

  await page.goto('/system');
  await expect(page.getByTestId('system-dashboard')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  expect(overflow).toBeLessThanOrEqual(1);
});
