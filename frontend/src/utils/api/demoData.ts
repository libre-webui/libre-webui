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

import type { ChatSession, OllamaModel, UserPreferences } from '@/types';

export const DEMO_MODELS: OllamaModel[] = [
  {
    name: 'llama3.2:3b',
    size: 2048000000,
    digest: 'demo-digest-1',
    modified_at: new Date().toISOString(),
    details: {
      format: 'gguf',
      family: 'llama',
      families: ['llama'],
      parameter_size: '3B',
      quantization_level: 'Q4_0',
    },
  },
  {
    name: 'qwen2.5:7b',
    size: 4096000000,
    digest: 'demo-digest-2',
    modified_at: new Date().toISOString(),
    details: {
      format: 'gguf',
      family: 'qwen',
      families: ['qwen'],
      parameter_size: '7B',
      quantization_level: 'Q4_0',
    },
  },
];

export const getDemoSessions = (): ChatSession[] => {
  return [
    {
      id: 'demo-session-1',
      title: 'Demo Chat Session',
      model: DEMO_MODELS[0].name,
      providerType: 'ollama',
      providerId: null,
      messages: [
        {
          id: 'demo-msg-1',
          role: 'user',
          content: 'Hello! Can you tell me about this demo?',
          timestamp: Date.now(),
        },
        {
          id: 'demo-msg-2',
          role: 'assistant',
          content:
            'This is a demo of Libre WebUI! In a real deployment, I would be powered by Ollama running locally on your machine. This demo shows the beautiful interface and features without the backend connection.',
          timestamp: Date.now(),
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ];
};

export const DEMO_SESSIONS: ChatSession[] = getDemoSessions();

export const DEFAULT_DEMO_PREFERENCES: UserPreferences = {
  theme: {
    mode: 'dark',
    adaptToAccent: false,
    accent: 'blue',
    customAccent: '#2563eb',
  },
  defaultModel: 'llama3.2:3b',
  defaultProviderType: 'ollama',
  defaultProviderId: null,
  visionModel: '',
  visionProviderType: null,
  visionProviderId: null,
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
    taskProviderType: null,
    taskProviderId: null,
  },
  showUsername: false,
  hapticFeedbackEnabled: false,
  workRemoteProviderDisclosureDismissed: false,
  backgroundSettings: {
    enabled: false,
    imageUrl: '',
    blurAmount: 10,
    opacity: 0.6,
  },
};

let DEMO_PREFERENCES: UserPreferences = {
  ...DEFAULT_DEMO_PREFERENCES,
  theme: { ...DEFAULT_DEMO_PREFERENCES.theme },
  generationOptions: { ...DEFAULT_DEMO_PREFERENCES.generationOptions },
  embeddingSettings: { ...DEFAULT_DEMO_PREFERENCES.embeddingSettings },
  titleSettings: { ...DEFAULT_DEMO_PREFERENCES.titleSettings! },
  backgroundSettings: { ...DEFAULT_DEMO_PREFERENCES.backgroundSettings! },
};

type DemoPreferenceUpdates = Partial<
  Omit<
    UserPreferences,
    'theme' | 'generationOptions' | 'embeddingSettings' | 'backgroundSettings'
  >
> & {
  theme?: Partial<UserPreferences['theme']>;
  generationOptions?: Partial<UserPreferences['generationOptions']>;
  embeddingSettings?: Partial<UserPreferences['embeddingSettings']>;
  backgroundSettings?: Partial<
    NonNullable<UserPreferences['backgroundSettings']>
  >;
};

export const getDemoPreferences = (): UserPreferences => DEMO_PREFERENCES;

export const updateDemoPreferences = (
  updates: DemoPreferenceUpdates
): UserPreferences => {
  const currentBackgroundSettings =
    DEMO_PREFERENCES.backgroundSettings ||
    DEFAULT_DEMO_PREFERENCES.backgroundSettings!;

  DEMO_PREFERENCES = {
    ...DEMO_PREFERENCES,
    ...updates,
    theme: {
      ...DEMO_PREFERENCES.theme,
      ...updates.theme,
    },
    generationOptions: {
      ...DEMO_PREFERENCES.generationOptions,
      ...updates.generationOptions,
    },
    embeddingSettings: {
      ...DEMO_PREFERENCES.embeddingSettings,
      ...updates.embeddingSettings,
    },
    titleSettings: updates.titleSettings
      ? {
          ...(DEMO_PREFERENCES.titleSettings ||
            DEFAULT_DEMO_PREFERENCES.titleSettings!),
          ...updates.titleSettings,
        }
      : DEMO_PREFERENCES.titleSettings,
    backgroundSettings: updates.backgroundSettings
      ? {
          ...currentBackgroundSettings,
          ...updates.backgroundSettings,
        }
      : DEMO_PREFERENCES.backgroundSettings,
  };

  return DEMO_PREFERENCES;
};
