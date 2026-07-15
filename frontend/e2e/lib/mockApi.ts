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

type MockTTSModel = {
  model: string;
  plugin: string;
  config?: {
    voices?: string[];
    default_voice?: string;
    formats?: Array<'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm'>;
    default_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
    max_characters?: number;
    supports_streaming?: boolean;
  };
};

type MockTTSPlugin = {
  id: string;
  name: string;
  models: string[];
  config?: MockTTSModel['config'];
};

type MockTTSGenerationRequest = {
  model: string;
  pluginId?: string;
  input: string;
  voice?: string;
  response_format?: string;
  speed?: number;
};

type MockMessage = {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  model?: string;
  artifacts?: MockArtifact[];
  parentId?: string;
  branchIndex?: number;
  isActive?: boolean;
  siblingCount?: number;
};

type MockArtifact = {
  id: string;
  type:
    'html' | 'react' | 'svg' | 'mermaid' | 'chart' | 'code' | 'text' | 'json';
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

type MockChatStream = {
  chunks: string[];
  finalChunk?: string;
  chunkDelayMs?: number;
  completionDelayMs?: number;
};

type MockOptions = {
  systemInfo?: MockSystemInfo;
  sessions?: MockSession[];
  models?: MockModel[];
  libraryModels?: MockLibraryModel[];
  cloudLibraryModels?: MockLibraryModel[];
  ttsModels?: MockTTSModel[];
  ttsPlugins?: MockTTSPlugin[];
  preferences?: Partial<typeof defaultPreferences>;
  preferenceUpdateFailures?: number;
  generatedTitle?: {
    title: string;
    source?: 'plugin' | 'ollama' | 'fallback';
  };
  chatStream?: MockChatStream;
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
  theme: {
    mode: 'dark',
    adaptToAccent: false,
    accent: 'blue',
    customAccent: '#2563eb',
  },
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
  ttsSettings: {
    enabled: false,
    autoPlay: false,
    model: '',
    voice: '',
    speed: 1,
    pluginId: '',
    streamSentences: false,
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
  const sessions = structuredClone(options.sessions ?? []);
  const models = options.models ?? defaultModels;
  const libraryModels = options.libraryModels ?? defaultLibraryModels;
  const cloudLibraryModels =
    options.cloudLibraryModels ?? defaultCloudLibraryModels;
  const ttsModels = options.ttsModels ?? [];
  const ttsPlugins = options.ttsPlugins ?? [];
  const preferences = {
    ...structuredClone(defaultPreferences),
    ...options.preferences,
    theme: {
      ...defaultPreferences.theme,
      ...options.preferences?.theme,
    },
  };
  let preferenceUpdateFailures = options.preferenceUpdateFailures ?? 0;
  const chatStream = options.chatStream
    ? {
        chunks: options.chatStream.chunks,
        finalChunk: options.chatStream.finalChunk,
        chunkDelayMs: options.chatStream.chunkDelayMs ?? 40,
        completionDelayMs: options.chatStream.completionDelayMs ?? 40,
      }
    : null;
  const pullStreamUrls: string[] = [];
  const ttsGenerationRequests: MockTTSGenerationRequest[] = [];
  const titleGenerationRequests: Array<{
    sessionId: string;
    model: string;
    message: string;
  }> = [];
  const sessionUpdateRequests: Array<{
    sessionId: string;
    updates: Partial<MockSession>;
  }> = [];

  await page.addInitScript(streamConfig => {
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

      send(rawMessage: string) {
        let message: {
          type?: string;
          data?: { assistantMessageId?: string };
        };

        try {
          message = JSON.parse(rawMessage);
        } catch {
          return;
        }

        if (message.type !== 'chat_stream') return;

        const messageId = message.data?.assistantMessageId;
        if (!messageId) return;

        const dispatch = (type: string, data: unknown) => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({ type, data }),
            })
          );
        };

        if (!streamConfig) {
          window.setTimeout(() => {
            dispatch('assistant_complete', {
              content: 'Mock assistant response',
              role: 'assistant',
              timestamp: Date.now(),
              messageId,
            });
          }, 0);
          return;
        }

        const pieces = [...streamConfig.chunks];
        if (streamConfig.finalChunk !== undefined) {
          pieces.push(streamConfig.finalChunk);
        }
        if (pieces.length === 0) return;

        let total = '';
        const cumulativeChunks = pieces.map(content => {
          total += content;
          return { content, total };
        });

        cumulativeChunks.forEach((chunk, index) => {
          window.setTimeout(
            () => {
              dispatch('assistant_chunk', {
                ...chunk,
                done: index === cumulativeChunks.length - 1,
                messageId,
              });
            },
            streamConfig.chunkDelayMs * (index + 1)
          );
        });

        window.setTimeout(
          () => {
            dispatch('assistant_complete', {
              content: cumulativeChunks[cumulativeChunks.length - 1].total,
              role: 'assistant',
              timestamp: Date.now(),
              messageId,
            });
          },
          streamConfig.chunkDelayMs * cumulativeChunks.length +
            streamConfig.completionDelayMs
        );
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
  }, chatStream);

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
        await fulfillJson(route, preferences);
        return;
      }

      if (path === '/preferences' && method === 'PUT') {
        if (preferenceUpdateFailures > 0) {
          preferenceUpdateFailures -= 1;
          await fulfillJson(route, {}, false);
          return;
        }

        const updates = route.request().postDataJSON() as Partial<
          typeof defaultPreferences
        >;
        Object.assign(preferences, updates);
        if (updates.theme) {
          preferences.theme = {
            ...preferences.theme,
            ...updates.theme,
          };
        }
        await fulfillJson(route, preferences);
        return;
      }

      if (path.startsWith('/preferences') && method !== 'GET') {
        await fulfillJson(route, preferences);
        return;
      }

      if (path === '/chat/sessions' && method === 'GET') {
        await fulfillJson(route, sessions);
        return;
      }

      const generatedTitleMatch = path.match(
        /^\/chat\/sessions\/([^/]+)\/generate-title$/
      );
      if (generatedTitleMatch && method === 'POST') {
        const sessionId = generatedTitleMatch[1];
        const request = route.request().postDataJSON() as {
          model: string;
          message: string;
        };
        const generatedTitle = options.generatedTitle ?? {
          title: 'Generated Conversation Summary',
          source: 'ollama' as const,
        };
        const updatedAt = Date.now();
        const session = sessions.find(item => item.id === sessionId);

        titleGenerationRequests.push({ sessionId, ...request });
        if (session) {
          session.title = generatedTitle.title;
          session.updatedAt = updatedAt;
        }

        await fulfillJson(route, {
          title: generatedTitle.title,
          source: generatedTitle.source ?? 'ollama',
          updatedAt,
        });
        return;
      }

      const sessionMatch = path.match(/^\/chat\/sessions\/([^/]+)$/);
      if (sessionMatch && method === 'PUT') {
        const sessionId = sessionMatch[1];
        const updates = route.request().postDataJSON() as Partial<MockSession>;
        const session = sessions.find(item => item.id === sessionId);
        const updatedAt = Date.now();

        sessionUpdateRequests.push({ sessionId, updates });
        if (!session) {
          await fulfillJson(route, {}, false);
          return;
        }

        Object.assign(session, updates, { updatedAt });
        await fulfillJson(route, session);
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

      if (path === '/tts/models' && method === 'GET') {
        await fulfillJson(route, ttsModels);
        return;
      }

      if (path === '/tts/plugins' && method === 'GET') {
        await fulfillJson(route, ttsPlugins);
        return;
      }

      if (path === '/tts/generate-base64' && method === 'POST') {
        ttsGenerationRequests.push(
          route.request().postDataJSON() as MockTTSGenerationRequest
        );
        await fulfillJson(route, {
          audio: 'UklGRg==',
          format: 'wav',
          mimeType: 'audio/wav',
          size: 4,
        });
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
    ttsGenerationRequests,
    titleGenerationRequests,
    sessionUpdateRequests,
  };
}
