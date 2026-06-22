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

import { Page, Route } from '@playwright/test';

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type MockSystemInfo = {
  requiresAuth: boolean;
  hasUsers: boolean;
  userCount: number;
  allowUserModelPull: boolean;
  version: string;
  turnstile?: { enabled: boolean; siteKey?: string };
};

type MockModel = {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  details: {
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
};

type MockLibraryModel = {
  name: string;
  description: string;
  category: string;
  sizes: string[];
  pulls?: string;
  tags?: string[];
};

type MockMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string;
  artifacts?: MockArtifact[];
};

type MockArtifact = {
  id: string;
  type:
    | 'html'
    | 'react'
    | 'svg'
    | 'mermaid'
    | 'chart'
    | 'code'
    | 'text'
    | 'json';
  title: string;
  content: string;
  language?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
};

type MockSession = {
  id: string;
  title: string;
  model: string;
  messages: MockMessage[];
  createdAt: number;
  updatedAt: number;
};

type MockOptions = {
  systemInfo?: MockSystemInfo;
  sessions?: MockSession[];
  models?: MockModel[];
  libraryModels?: MockLibraryModel[];
  cloudLibraryModels?: MockLibraryModel[];
};

const defaultSystemInfo: MockSystemInfo = {
  requiresAuth: false,
  hasUsers: true,
  userCount: 1,
  allowUserModelPull: true,
  version: '0.10.0-e2e',
  turnstile: { enabled: false },
};

const defaultModels: MockModel[] = [
  {
    name: 'llama3.2:3b',
    size: 2_048_000_000,
    digest: 'e2e-demo-digest',
    modified_at: new Date('2026-06-21T00:00:00.000Z').toISOString(),
    details: {
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '3B',
      quantization_level: 'Q4_0',
    },
  },
];

const defaultPreferences = {
  theme: { mode: 'dark', accent: 'blue', customAccent: '#2563eb' },
  defaultModel: 'llama3.2:3b',
  systemMessage: 'You are a helpful assistant.',
  generationOptions: {
    temperature: 0.7,
    top_p: 0.9,
    top_k: 40,
    num_predict: 1024,
  },
  embeddingSettings: {
    enabled: false,
    model: 'nomic-embed-text',
    chunkSize: 1000,
    chunkOverlap: 200,
    similarityThreshold: 0.7,
  },
  titleSettings: {
    autoTitle: false,
    taskModel: '',
  },
  showUsername: false,
  backgroundSettings: {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
  },
};

const defaultLibraryModels: MockLibraryModel[] = [
  {
    name: 'llama3.2',
    description: 'General local chat model',
    category: 'general',
    sizes: ['3b'],
    pulls: '50M+',
    tags: ['general'],
  },
];

const defaultCloudLibraryModels: MockLibraryModel[] = [
  {
    name: 'gpt-oss',
    description: 'Cloud model returned without the required pull suffix',
    category: 'cloud',
    sizes: ['cloud'],
    pulls: 'Cloud',
    tags: ['cloud'],
  },
];

const json = <T>(data: T, success = true): ApiEnvelope<T> => ({
  success,
  data,
});

const fulfillJson = async <T>(route: Route, data: T, success = true) => {
  await route.fulfill({
    status: success ? 200 : 500,
    contentType: 'application/json',
    body: JSON.stringify(json(data, success)),
  });
};

export async function mockLibreWebUiApi(page: Page, options: MockOptions = {}) {
  const systemInfo = options.systemInfo ?? defaultSystemInfo;
  const sessions = options.sessions ?? [];
  const models = options.models ?? defaultModels;
  const libraryModels = options.libraryModels ?? defaultLibraryModels;
  const cloudLibraryModels =
    options.cloudLibraryModels ?? defaultCloudLibraryModels;
  const pullStreamUrls: string[] = [];

  await page.addInitScript(() => {
    class MockWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      readyState = MockWebSocket.OPEN;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor() {
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }

      send() {
        // Messages are intentionally ignored in mocked e2e runs.
      }

      close() {
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close'));
      }
    }

    Object.defineProperty(window, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
  });

  await page.route(
    /^http:\/\/(?:127\.0\.0\.1|localhost|demo\.localhost):3001\/api\/.*$/,
    async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = route.request().method();

      if (path === '/auth/system-info' && method === 'GET') {
        await fulfillJson(route, systemInfo);
        return;
      }

      if (path === '/auth/verify' && method === 'GET') {
        await fulfillJson(route, {
          id: 'e2e-user',
          username: 'e2e',
          email: 'e2e@example.test',
          role: 'admin',
          createdAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
          updatedAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
        });
        return;
      }

      if (path === '/auth/login' && method === 'POST') {
        await fulfillJson(route, {
          user: {
            id: 'e2e-user',
            username: 'e2e',
            email: 'e2e@example.test',
            role: 'admin',
            createdAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
            updatedAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
          },
          token: 'e2e-token',
          systemInfo,
        });
        return;
      }

      if (path === '/ollama/health' && method === 'GET') {
        await fulfillJson(route, { status: 'ok' });
        return;
      }

      if (path === '/ollama/models' && method === 'GET') {
        await fulfillJson(route, models);
        return;
      }

      if (path === '/ollama/running' && method === 'GET') {
        await fulfillJson(route, []);
        return;
      }

      if (path === '/ollama/version' && method === 'GET') {
        await fulfillJson(route, { version: '0.10.0-e2e' });
        return;
      }

      if (path === '/ollama/library' && method === 'GET') {
        await fulfillJson(
          route,
          url.searchParams.get('category') === 'cloud'
            ? cloudLibraryModels
            : libraryModels
        );
        return;
      }

      if (path === '/ollama/pull/stream' && method === 'GET') {
        pullStreamUrls.push(route.request().url());
        await route.fulfill({
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
          body: 'data: {"type":"complete"}\n\n',
        });
        return;
      }

      if (path === '/preferences' && method === 'GET') {
        await fulfillJson(route, defaultPreferences);
        return;
      }

      if (path.startsWith('/preferences') && method !== 'GET') {
        await fulfillJson(route, defaultPreferences);
        return;
      }

      if (path === '/chat/sessions' && method === 'GET') {
        await fulfillJson(route, sessions);
        return;
      }

      if (path === '/personas' && method === 'GET') {
        await fulfillJson(route, []);
        return;
      }

      if (
        (path === '/documents' || path.startsWith('/documents/session/')) &&
        method === 'GET'
      ) {
        await fulfillJson(route, []);
        return;
      }

      if (path === '/plugins' && method === 'GET') {
        await fulfillJson(route, []);
        return;
      }

      if (
        (path === '/plugins/active' ||
          path === '/plugins/status' ||
          path === '/plugins/credentials/all') &&
        method === 'GET'
      ) {
        await fulfillJson(route, path === '/plugins/active' ? null : []);
        return;
      }

      if (path === '/image-gen/plugins' && method === 'GET') {
        await fulfillJson(route, []);
        return;
      }

      await route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          error: `Unhandled e2e mock route: ${method} ${path}`,
        }),
      });
    }
  );

  return {
    pullStreamUrls,
  };
}
