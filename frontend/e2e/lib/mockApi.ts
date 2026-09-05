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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginUsageAnalytics } from '../../src/utils/api/pluginApi';
import type { SystemDiagnostics } from '../../src/utils/api/systemApi';

const latestReleaseVersion = readFileSync(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    'CHANGELOG.md'
  ),
  'utf8'
).match(/^## \[(\d+\.\d+\.\d+)\] - /m)?.[1];

type ApiEnvelope<T> = {
  success: boolean;
  data?: T;
  error?: string;
};

type MockSystemInfo = {
  requiresAuth: boolean;
  hasUsers: boolean;
  userCount: number;
  signupEnabled?: boolean;
  passkeysInUse?: boolean;
  version: string;
  turnstile?: { enabled: boolean; siteKey?: string };
  defaultTheme?: {
    mode: 'light' | 'dark' | 'amoled' | 'celestial';
    accent?: string;
  };
};

type MockModel = {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
  isPlugin?: boolean;
  pluginId?: string;
  pluginName?: string;
  details: {
    format: string;
    family: string;
    families: string[];
    parameter_size: string;
    quantization_level: string;
  };
};

type MockModelCatalog = {
  hidden: string[];
  order: string[];
  starred: string[];
  metadata: Record<
    string,
    {
      label?: string;
      avatar?: string;
    }
  >;
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
    supports_voice_cloning?: boolean;
    clone_requires_transcript?: boolean;
  };
};

type MockTTSPlugin = {
  id: string;
  name: string;
  models: string[];
  config?: MockTTSModel['config'];
};

type MockSTTModel = {
  model: string;
  plugin: string;
  config?: {
    formats?: string[];
    max_audio_bytes?: number;
    max_duration_seconds?: number;
    languages?: string[];
  };
};

type MockImageGenModel = {
  model: string;
  plugin: string;
  config?: {
    sizes?: string[];
    default_size?: string;
    qualities?: string[];
    default_quality?: string;
    styles?: string[];
    default_style?: string;
    max_prompt_length?: number;
  };
};

type MockImageGenPlugin = {
  id: string;
  name: string;
  models: string[];
  config?: MockImageGenModel['config'];
};

type MockImageGenerationRequest = {
  model: string;
  pluginId: string;
  prompt: string;
  size?: string;
  quality?: string;
  style?: string;
  n?: number;
};

type MockMediaModels = {
  video: Array<{
    model: string;
    plugin: string;
    config?: Record<string, unknown>;
  }>;
  audio: Array<{
    model: string;
    plugin: string;
    mode: 'speech' | 'sound';
    config?: Record<string, unknown>;
  }>;
};

type MockSoundGenerationRequest = {
  model: string;
  pluginId: string;
  prompt: string;
  voice?: string;
  format?: string;
};

type MockVideoGenerationRequest = {
  model: string;
  pluginId: string;
  prompt: string;
  duration?: number;
  resolution?: string;
  aspect_ratio?: string;
  generate_audio?: boolean;
};

type MockVideoGenerationJob = {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  model: string;
  pluginId: string;
  prompt?: string;
  cancellable: boolean;
  galleryId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  media?: Record<string, unknown>;
};

type MockPlugin = {
  id: string;
  name: string;
  type: 'completion' | 'chat';
  endpoint: string;
  api_mode?: 'chat_completions' | 'responses';
  base_url?: string;
  api_path?: string;
  auth: {
    header: string;
    key_env: string;
    prefix?: string;
  };
  model_map: string[];
  active: boolean;
  capabilities?: Record<
    string,
    {
      endpoint?: string;
      endpoint_variable?: string;
      config?: { endpoint_variable?: string };
    }
  >;
  variables?: Array<{
    name: string;
    type: 'string' | 'number' | 'boolean' | 'select';
    label: string;
    description?: string;
    default?: string | number | boolean;
    required?: boolean;
    sensitive?: boolean;
    options?: string[];
    min?: number;
    max?: number;
  }>;
};

type MockPluginVariableValue = {
  name: string;
  value: string | number | boolean;
  is_sensitive: boolean;
  has_value: boolean;
};

type MockTTSGenerationRequest = {
  model: string;
  pluginId?: string;
  input: string;
  voice?: string;
  voiceProfileId?: string;
  response_format?: string;
  speed?: number;
};

type MockTTSVoiceProfile = {
  id: string;
  name: string;
  pluginId: string;
  model: string;
  mimeType: string;
  createdAt: number;
  updatedAt: number;
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
  folderId?: string | null;
  pinned?: boolean;
};

type MockFolder = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

type MockChatStream = {
  chunks: string[];
  finalChunk?: string;
  chunkDelayMs?: number;
  completionDelayMs?: number;
  duplicateCompletion?: boolean;
};

type MockWorkCapabilities = {
  available: boolean;
  runtime: 'docker' | 'kubernetes';
  image: string;
  reason?: string;
  runtimeAvailable?: boolean;
  ollamaAvailable?: boolean;
  pluginAvailable?: boolean;
  runtimeImage?: string;
  limits?: {
    maxRounds: number;
    commandTimeoutMs: number;
    maxOutputChars: number;
  };
  terminal?: {
    available: boolean;
    reason?: string;
    maxSessionsPerTask: number;
    idleTimeoutMs: number;
  };
};

type MockWorkMessage = {
  id: string;
  taskId: string;
  runId?: string;
  messageIndex?: number;
  role: 'user' | 'assistant' | 'tool';
  kind: 'message' | 'tool_call' | 'tool_result' | 'error';
  content: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
};

type MockWorkRun = {
  id: string;
  taskId: string;
  model: string;
  providerType: 'ollama' | 'plugin';
  providerId?: string;
  status:
    'queued' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
  error?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
};

type MockWorkTask = {
  id: string;
  title: string;
  model: string;
  providerType: 'ollama' | 'plugin';
  providerId?: string;
  status:
    'idle' | 'preparing' | 'running' | 'completed' | 'failed' | 'cancelled';
  networkEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  messages: MockWorkMessage[];
  activeRun?: MockWorkRun | null;
  previewUrl?: string | null;
  previewStatus: 'stopped' | 'starting' | 'running' | 'failed';
  workspacePath: '/workspace';
  personaId?: string | null;
  statusBlurb?: string | null;
  isAgent?: boolean;
  computerAvailable?: boolean;
  lastSeenAt?: number | null;
};

type MockPersona = {
  id: string;
  name: string;
  description?: string;
  model: string;
  parameters: Record<string, unknown>;
  avatar?: string;
  user_id: string;
  created_at: number;
  updated_at: number;
};

type MockWorkFile = {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  updatedAt?: number;
};

type MockWorkGitStatus = {
  initialized: boolean;
  branch?: string;
  detached: boolean;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  changes: Array<{
    path: string;
    originalPath?: string;
    indexStatus: string;
    workingTreeStatus: string;
    staged: boolean;
  }>;
  branches: string[];
  commits: Array<{
    hash: string;
    shortHash: string;
    author: string;
    authoredAt: string;
    subject: string;
  }>;
};

type MockWorkRunResult = {
  assistantMessage?: string;
  messages?: MockWorkMessage[];
  files?: Array<MockWorkFile & { content?: string }>;
  stayRunning?: boolean;
};

type MockWorkTaskTransition = {
  taskId: string;
  status: MockWorkTask['status'];
  afterListRequests: number;
  messages?: MockWorkMessage[];
};

type MockOptions = {
  showWhatsNew?: boolean;
  systemInfo?: MockSystemInfo;
  authRole?: 'admin' | 'user';
  authUsers?: Array<{
    id: string;
    username: string;
    email: string | null;
    role: 'admin' | 'user';
    status?: 'pending' | 'active';
    token: string;
    avatar?: string | null;
    preferences?: Partial<typeof defaultPreferences>;
  }>;
  sessions?: MockSession[];
  folders?: MockFolder[];
  models?: MockModel[];
  modelCatalog?: MockModelCatalog;
  ollamaHealthy?: boolean;
  plugins?: MockPlugin[];
  pluginVariables?: Record<string, Record<string, MockPluginVariableValue>>;
  pluginDiscoveryResults?: Record<string, string[]>;
  pluginDiscoveryDelayMs?: number;
  pluginDiscoveryFailures?: Record<string, string>;
  pluginVariableResetFailures?: number;
  pluginMutationRefreshDelayMs?: number;
  pluginUsage?: PluginUsageAnalytics;
  systemDiagnostics?: SystemDiagnostics;
  libraryModels?: MockLibraryModel[];
  cloudLibraryModels?: MockLibraryModel[];
  ttsModels?: MockTTSModel[];
  ttsPlugins?: MockTTSPlugin[];
  ttsVoiceProfiles?: MockTTSVoiceProfile[];
  sttModels?: MockSTTModel[];
  sttTranscript?: string;
  sttTranscriptionDelayMs?: number;
  imageGenModels?: MockImageGenModel[];
  imageGenPlugins?: MockImageGenPlugin[];
  mediaModels?: MockMediaModels;
  mediaVideoJobs?: MockVideoGenerationJob[];
  preferences?: Partial<typeof defaultPreferences>;
  preferenceUpdateFailures?: number;
  deferPreferenceUpdates?: boolean;
  generatedTitle?: {
    title: string;
    source?: 'plugin' | 'ollama' | 'fallback';
  };
  chatStream?: MockChatStream;
  workCapabilities?: MockWorkCapabilities;
  workTasks?: MockWorkTask[];
  workTaskListDelaysMs?: number[];
  workTaskListFailures?: Array<string | undefined>;
  workTaskDetailUpdates?: Record<string, Partial<MockWorkTask>>;
  workFiles?: Record<string, MockWorkFile[]>;
  workFileContents?: Record<string, string>;
  workGitStatuses?: Record<string, MockWorkGitStatus>;
  workGitDiffs?: Record<string, string>;
  deferWorkFileUpdates?: boolean;
  workFileUpdateFailure?: string;
  workRunResult?: MockWorkRunResult;
  workTaskTransition?: MockWorkTaskTransition;
  personas?: MockPersona[];
};

export const defaultSystemInfo: MockSystemInfo = {
  requiresAuth: false,
  hasUsers: true,
  userCount: 1,
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
  ttsSettings: {
    enabled: false,
    autoPlay: false,
    model: '',
    voice: '',
    voiceProfileId: '',
    speed: 1,
    pluginId: '',
    streamSentences: false,
  },
  imageGenSettings: {
    enabled: false,
    model: '',
    size: '1024x1024',
    quality: 'standard',
    style: 'vivid',
    pluginId: '',
  },
  titleSettings: {
    autoTitle: false,
    taskModel: '',
  },
  showUsername: false,
  workRemoteProviderDisclosureDismissed: false,
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

const defaultWorkCapabilities: MockWorkCapabilities = {
  available: true,
  runtime: 'docker',
  image: 'ghcr.io/libre-webui/work-runtime:0.1.0-e2e',
  runtimeAvailable: true,
  ollamaAvailable: true,
  runtimeImage: 'ghcr.io/libre-webui/work-runtime:0.1.0-e2e',
  limits: {
    maxRounds: 48,
    commandTimeoutMs: 120_000,
    maxOutputChars: 50_000,
  },
  terminal: {
    available: true,
    maxSessionsPerTask: 2,
    idleTimeoutMs: 900_000,
  },
};

const json = <T>(data: T, success = true): ApiEnvelope<T> => ({
  success,
  data,
});

/** Origins the suite serves the application (and the artifact runtime) from. */
const APP_ORIGINS = "'self' http://127.0.0.1:4173 http://localhost:4173";

const fulfillJson = async <T>(route: Route, data: T, success = true) => {
  await route.fulfill({
    status: success ? 200 : 500,
    contentType: 'application/json',
    body: JSON.stringify(json(data, success)),
  });
};

const fulfillApiError = async (route: Route, status: number, error: string) => {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({ success: false, error }),
  });
};

export async function mockLibreWebUiApi(page: Page, options: MockOptions = {}) {
  if (!options.showWhatsNew && latestReleaseVersion) {
    await page.addInitScript(version => {
      // Init scripts run in every frame, including the sandboxed artifact
      // frame, where touching storage throws and would surface as a page error.
      try {
        localStorage.setItem('libre-webui:whats-new-seen', version);
      } catch {
        // No storage in an opaque origin; nothing to remember there anyway.
      }
    }, latestReleaseVersion);
  }

  const systemInfo = options.systemInfo ?? defaultSystemInfo;
  let instanceDefaultTheme: Record<string, unknown> = {
    mode: 'dark',
    adaptToAccent: false,
    accent: 'blue',
    customAccent: '#4176e6',
    ...(systemInfo.defaultTheme ?? {}),
  };
  const authRole = options.authRole ?? 'admin';
  const authUsers = options.authUsers ?? [];
  const sessions = structuredClone(options.sessions ?? []);
  const folders = structuredClone(options.folders ?? []);
  let models = options.models ?? defaultModels;
  let modelCatalog = structuredClone(
    options.modelCatalog ?? {
      hidden: [],
      order: [],
      starred: [],
      metadata: {},
    }
  );
  const ollamaHealthy = options.ollamaHealthy ?? true;
  const plugins = structuredClone(options.plugins ?? []);
  const pluginVariables = structuredClone(options.pluginVariables ?? {});
  const libraryModels = options.libraryModels ?? defaultLibraryModels;
  const cloudLibraryModels =
    options.cloudLibraryModels ?? defaultCloudLibraryModels;
  const ttsModels = options.ttsModels ?? [];
  const ttsPlugins = options.ttsPlugins ?? [];
  let ttsVoiceProfiles = structuredClone(options.ttsVoiceProfiles ?? []);
  const sttModels = options.sttModels ?? [];
  const sttTranscript = options.sttTranscript ?? 'Transcribed speech';
  const imageGenModels = options.imageGenModels ?? [];
  const imageGenPlugins = options.imageGenPlugins ?? [];
  const mediaModels = options.mediaModels ?? { video: [], audio: [] };
  let mediaVideoJobs = structuredClone(options.mediaVideoJobs ?? []);
  const workCapabilities = options.workCapabilities ?? defaultWorkCapabilities;
  const workTaskTransition = options.workTaskTransition;
  const workTasks = structuredClone(options.workTasks ?? []);
  const workFiles = structuredClone(options.workFiles ?? {});
  const workFileContents = {
    ...(options.workFileContents ?? {}),
  };
  const workGitStatuses = structuredClone(options.workGitStatuses ?? {});
  const workGitDiffs = { ...(options.workGitDiffs ?? {}) };
  const createPreferences = (
    overrides: Partial<typeof defaultPreferences> | undefined
  ) => ({
    ...structuredClone(defaultPreferences),
    ...overrides,
    theme: {
      ...defaultPreferences.theme,
      ...overrides?.theme,
    },
  });
  const preferences = createPreferences(options.preferences);
  const preferencesByUserId = new Map(
    authUsers.map(user => [user.id, createPreferences(user.preferences)])
  );
  const preferenceUpdateRequests: Array<Partial<typeof defaultPreferences>> =
    [];
  const modelCatalogUpdateRequests: Array<Partial<MockModelCatalog>> = [];
  const pluginVariableUpdateRequests: Array<{
    pluginId: string;
    variables: Record<string, string | number | boolean>;
    unset: string[];
  }> = [];
  const pluginCredentialUpdateRequests: Array<{
    pluginId: string;
    apiKey: string;
  }> = [];
  const pluginDiscoveryRequests: string[] = [];
  let pluginVariableResetFailures = options.pluginVariableResetFailures ?? 0;
  let pluginVariableResetRequests = 0;
  let pendingPluginListDelayMs = 0;
  const preferenceScopedWrites: Array<{
    path: string;
    body: Record<string, unknown>;
  }> = [];
  const preferenceUpdateUserIds: Array<string | null> = [];
  const pendingPreferenceUpdateReleases: Array<() => void> = [];
  let preferenceUpdateFailures = options.preferenceUpdateFailures ?? 0;
  const chatStream = options.chatStream
    ? {
        chunks: options.chatStream.chunks,
        finalChunk: options.chatStream.finalChunk,
        chunkDelayMs: options.chatStream.chunkDelayMs ?? 40,
        completionDelayMs: options.chatStream.completionDelayMs ?? 40,
        duplicateCompletion: options.chatStream.duplicateCompletion ?? false,
      }
    : null;
  const pullStreamUrls: string[] = [];
  const ttsGenerationRequests: MockTTSGenerationRequest[] = [];
  const sttTranscriptionRequests: Array<{
    body: string;
    contentType: string;
  }> = [];
  const ttsVoiceProfileDeleteRequests: string[] = [];
  const imageGenerationRequests: MockImageGenerationRequest[] = [];
  const soundGenerationRequests: MockSoundGenerationRequest[] = [];
  const videoGenerationRequests: MockVideoGenerationRequest[] = [];
  const videoResumeRequests: string[] = [];
  const videoCancelRequests: string[] = [];
  const voiceCloneRequests: Array<{
    body: string;
    contentType: string;
  }> = [];
  const titleGenerationRequests: Array<{
    sessionId: string;
    model: string;
    message: string;
  }> = [];
  const sessionUpdateRequests: Array<{
    sessionId: string;
    updates: Partial<MockSession>;
  }> = [];
  const folderCreateRequests: Array<{ name: string }> = [];
  const folderRenameRequests: Array<{ folderId: string; name: string }> = [];
  const folderDeleteRequests: string[] = [];
  const workTaskCreateRequests: Array<{
    message: string;
    model: string;
    providerType: 'ollama' | 'plugin';
    providerId?: string;
    networkEnabled: boolean;
    personaId?: string;
    isAgent?: boolean;
  }> = [];
  const workTaskDetailRequests: string[] = [];
  const workTaskSeenRequests: string[] = [];
  const workTaskListRequests: number[] = [];
  const workTaskDeleteRequests: string[] = [];
  const workMessagePageRequests: Array<{
    taskId: string;
    before: number;
    limit: number;
  }> = [];
  const workRunRequests: Array<{
    taskId: string;
    message: string;
    model?: string;
    providerType?: 'ollama' | 'plugin';
    providerId?: string;
  }> = [];
  const workCancelRequests: string[] = [];
  const workFileUpdateRequests: Array<{
    taskId: string;
    path: string;
    content: string;
    expectedUpdatedAt?: number;
  }> = [];
  const pendingWorkFileUpdateReleases: Array<() => void> = [];
  const workPreviewRequests: Array<{
    taskId: string;
    action: 'start' | 'stop';
    command?: string;
  }> = [];
  const workGitRequests: Array<{
    taskId: string;
    action:
      'status' | 'diff' | 'init' | 'stage' | 'commit' | 'branch' | 'switch';
    paths?: string[];
    message?: string;
    name?: string;
  }> = [];
  let nextWorkTaskId = workTasks.length + 1;
  let nextWorkMessageId = 1;
  let nextFolderId = folders.length + 1;

  const authUserForRoute = (route: Route) => {
    const authorization = route.request().headers().authorization;
    const token = authorization?.replace(/^Bearer\s+/i, '');
    return authUsers.find(user => user.token === token);
  };

  const publicAuthUser = (
    user:
      | (typeof authUsers)[number]
      | {
          id: string;
          username: string;
          email: string | null;
          role: 'admin' | 'user';
          status?: 'pending' | 'active';
          avatar?: string | null;
        }
  ) => ({
    id: user.id,
    username: user.username,
    email: user.email,
    role: user.role,
    status: user.status ?? 'active',
    avatar: user.avatar ?? null,
    createdAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
    updatedAt: new Date('2026-06-21T00:00:00.000Z').toISOString(),
  });
  let managedUsers = authUsers.map(publicAuthUser);

  const preferencesForRoute = (route: Route) => {
    const user = authUserForRoute(route);
    return user ? preferencesByUserId.get(user.id)! : preferences;
  };

  const indexedWorkMessages = (task: MockWorkTask): MockWorkMessage[] =>
    task.messages.map((message, messageIndex) => ({
      ...message,
      messageIndex: message.messageIndex ?? messageIndex,
    }));

  const workMessagePage = (
    task: MockWorkTask,
    before?: number,
    limit = 200
  ) => {
    const eligible = indexedWorkMessages(task).filter(
      message => before === undefined || (message.messageIndex ?? 0) < before
    );
    const messages = eligible.slice(-limit);
    const hasMore = eligible.length > messages.length;
    return {
      messages,
      cursor: hasMore ? messages[0]?.messageIndex : undefined,
      hasMore,
    };
  };

  const workTaskDetail = (task: MockWorkTask) => {
    const page = workMessagePage(task);
    return {
      ...task,
      messages: page.messages,
      messageCursor: page.cursor,
      hasMoreMessages: page.hasMore,
    };
  };

  const workGitStatus = (taskId: string): MockWorkGitStatus =>
    (workGitStatuses[taskId] ??= {
      initialized: false,
      detached: false,
      ahead: 0,
      behind: 0,
      changes: [],
      branches: [],
      commits: [],
    });

  let workTaskTransitionApplied = false;
  const applyWorkTaskTransition = () => {
    if (!workTaskTransition || workTaskTransitionApplied) return;
    const task = workTasks.find(item => item.id === workTaskTransition.taskId);
    if (!task) return;
    workTaskTransitionApplied = true;
    task.status = workTaskTransition.status;
    task.updatedAt = Date.now();
    if (
      workTaskTransition.status !== 'preparing' &&
      workTaskTransition.status !== 'running'
    ) {
      task.activeRun = null;
    }
    if (workTaskTransition.messages) {
      task.messages.push(...structuredClone(workTaskTransition.messages));
    }
  };

  const appendMockWorkRun = (
    task: MockWorkTask,
    message: string,
    model?: string,
    providerType?: 'ollama' | 'plugin',
    providerId?: string
  ) => {
    const now = Date.now();
    const runId = `work-run-${task.id}-${now}`;
    const userMessage: MockWorkMessage = {
      id: `work-message-${nextWorkMessageId++}`,
      taskId: task.id,
      runId,
      role: 'user',
      kind: 'message',
      content: message,
      createdAt: now,
    };
    const result = options.workRunResult;
    const generatedMessages: MockWorkMessage[] = result?.messages ?? [
      {
        id: `work-message-${nextWorkMessageId++}`,
        taskId: task.id,
        runId,
        role: 'assistant',
        kind: 'tool_call',
        content: 'Writing index.html',
        createdAt: now + 1,
        metadata: {
          toolCallId: `tool-${now}`,
          toolName: 'write_file',
          path: 'index.html',
        },
      },
      {
        id: `work-message-${nextWorkMessageId++}`,
        taskId: task.id,
        runId,
        role: 'tool',
        kind: 'tool_result',
        content: 'Created /workspace/index.html',
        createdAt: now + 2,
        metadata: {
          toolCallId: `tool-${now}`,
          toolName: 'write_file',
          path: 'index.html',
        },
      },
      {
        id: `work-message-${nextWorkMessageId++}`,
        taskId: task.id,
        runId,
        role: 'assistant',
        kind: 'message',
        content:
          result?.assistantMessage ??
          'Finished the requested changes in this task workspace.',
        createdAt: now + 3,
      },
    ];

    const nextIndex = task.messages.length;
    task.messages.push(
      { ...userMessage, messageIndex: nextIndex },
      ...structuredClone(generatedMessages).map((message, index) => ({
        ...message,
        messageIndex: nextIndex + index + 1,
      }))
    );
    task.model = model || task.model;
    task.providerType = providerType || task.providerType;
    task.providerId =
      task.providerType === 'plugin'
        ? providerId || task.providerId
        : undefined;
    task.updatedAt = now;
    task.status = result?.stayRunning ? 'running' : 'completed';
    task.activeRun = result?.stayRunning
      ? {
          id: runId,
          taskId: task.id,
          model: task.model,
          providerType: task.providerType,
          providerId: task.providerId,
          status: 'running',
          createdAt: now,
          startedAt: now,
        }
      : null;

    if (result?.files) {
      workFiles[task.id] = result.files.map(
        ({ content: _content, ...file }) => file
      );
      for (const file of result.files) {
        if (file.type === 'file' && file.content !== undefined) {
          workFileContents[`${task.id}:${file.path}`] = file.content;
        }
      }
    }

    return {
      id: runId,
      taskId: task.id,
      model: task.model,
      status: result?.stayRunning
        ? ('running' as const)
        : ('completed' as const),
      createdAt: now,
      startedAt: now,
      finishedAt: result?.stayRunning ? undefined : now + 3,
    };
  };

  await page.addInitScript(streamConfig => {
    const originalFetch = window.fetch.bind(window);
    let nextDurableJobId = 1;
    const durableGenerations = new Map<
      string,
      {
        assistantMessageId: string;
        jobId: string;
        cancelled: boolean;
      }
    >();
    const requestUrl = (input: RequestInfo | URL): URL =>
      new URL(
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
        window.location.href
      );
    const requestMethod = (
      input: RequestInfo | URL,
      init?: RequestInit
    ): string =>
      (init?.method ?? (input instanceof Request ? input.method : 'GET'))
        .toUpperCase()
        .trim();
    const requestSignal = (
      input: RequestInfo | URL,
      init?: RequestInit
    ): AbortSignal | undefined =>
      init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const jsonResponse = (data: unknown): Response =>
      new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    window.fetch = async (input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(input, init);
      const generationMatch = url.pathname.match(
        /^\/api\/chat\/sessions\/([^/]+)\/generations$/
      );
      if (generationMatch && method === 'POST') {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          assistantMessageId?: string;
          options?: Record<string, unknown>;
        };
        if (!body.assistantMessageId) {
          return new Response(
            JSON.stringify({ success: false, error: 'Missing message ID' }),
            { status: 400, headers: { 'content-type': 'application/json' } }
          );
        }
        const sent = window as unknown as Record<string, unknown>;
        ((sent.__libreChatStreams ||= []) as unknown[]).push(body);
        const jobId = `e2e-chat-job-${nextDurableJobId++}`;
        durableGenerations.set(body.assistantMessageId, {
          assistantMessageId: body.assistantMessageId,
          jobId,
          cancelled: false,
        });
        return jsonResponse({
          jobId,
          assistantMessageId: body.assistantMessageId,
        });
      }

      const eventsMatch = url.pathname.match(
        /^\/api\/chat\/sessions\/([^/]+)\/events$/
      );
      if (eventsMatch && method === 'GET') {
        const assistantMessageId = url.searchParams.get('generation') || '';
        const generation = durableGenerations.get(assistantMessageId);
        if (!generation) {
          return new Response(
            JSON.stringify({ success: false, error: 'Generation not found' }),
            { status: 404, headers: { 'content-type': 'application/json' } }
          );
        }
        const pieces = streamConfig
          ? [
              ...streamConfig.chunks,
              ...(streamConfig.finalChunk === undefined
                ? []
                : [streamConfig.finalChunk]),
            ]
          : ['Mock assistant response'];
        const chunkDelayMs = streamConfig?.chunkDelayMs ?? 0;
        const completionDelayMs = streamConfig?.completionDelayMs ?? 0;
        const signal = requestSignal(input, init);
        const timers: number[] = [];
        let settled = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            let total = '';
            const abort = () => {
              if (settled) return;
              settled = true;
              timers.splice(0).forEach(timer => window.clearTimeout(timer));
              controller.error(
                signal?.reason ?? new DOMException('Aborted', 'AbortError')
              );
            };
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener('abort', abort, { once: true });
            pieces.forEach((content, index) => {
              total += content;
              const payload = {
                type: 'chunk',
                messageId: assistantMessageId,
                content,
                total,
                done: false,
              };
              const timer = window.setTimeout(
                () => {
                  if (settled || generation.cancelled) return;
                  controller.enqueue(
                    encoder.encode(
                      `id: ${index + 1}\ndata: ${JSON.stringify(payload)}\n\n`
                    )
                  );
                },
                chunkDelayMs * (index + 1)
              );
              timers.push(timer);
            });
            const finalContent = total;
            const completionTimer = window.setTimeout(
              () => {
                if (settled || generation.cancelled) return;
                settled = true;
                signal?.removeEventListener('abort', abort);
                const completion = {
                  type: 'done',
                  messageId: assistantMessageId,
                  content: finalContent,
                  role: 'assistant',
                  timestamp: Date.now(),
                };
                const block = `id: ${pieces.length + 1}\ndata: ${JSON.stringify(completion)}\n\n`;
                controller.enqueue(
                  encoder.encode(
                    streamConfig?.duplicateCompletion ? block + block : block
                  )
                );
                controller.close();
              },
              chunkDelayMs * pieces.length + completionDelayMs
            );
            timers.push(completionTimer);
          },
          cancel() {
            settled = true;
            timers.splice(0).forEach(timer => window.clearTimeout(timer));
          },
        });
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
          },
        });
      }

      const cancelMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (cancelMatch && method === 'POST') {
        const jobId = decodeURIComponent(cancelMatch[1]);
        const generation = [...durableGenerations.values()].find(
          candidate => candidate.jobId === jobId
        );
        if (generation) generation.cancelled = true;
        const sent = window as unknown as Record<string, unknown>;
        ((sent.__libreChatCancels ||= []) as unknown[]).push({ jobId });
        return jsonResponse({ cancelled: true });
      }

      return originalFetch(input, init);
    };

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
          data?: {
            assistantMessageId?: string;
            sessionId?: string;
            options?: Record<string, unknown>;
          };
        };

        try {
          message = JSON.parse(rawMessage);
        } catch {
          return;
        }

        if (message.type === 'chat_cancel') {
          const sent = window as unknown as Record<string, unknown>;
          ((sent.__libreChatCancels ||= []) as unknown[]).push(message.data);
          this.onmessage?.(
            new MessageEvent('message', {
              data: JSON.stringify({
                type: 'assistant_cancelled',
                data: {
                  assistantMessageId: message.data?.assistantMessageId,
                  sessionId: message.data?.sessionId,
                  cancelled: true,
                },
              }),
            })
          );
          return;
        }

        if (message.type !== 'chat_stream') return;

        // Recorded so a test can assert what the client actually sends.
        const sent = window as unknown as Record<string, unknown>;
        ((sent.__libreChatStreams ||= []) as unknown[]).push(message.data);

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
            const completion = {
              content: cumulativeChunks[cumulativeChunks.length - 1].total,
              role: 'assistant',
              timestamp: Date.now(),
              messageId,
            };
            dispatch('assistant_complete', completion);
            if (streamConfig.duplicateCompletion) {
              queueMicrotask(() => dispatch('assistant_complete', completion));
            }
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

  // Dev traffic rides Vite's same-origin proxy, so API calls arrive on the
  // dev-server port; Electron and explicit configurations still target :3001.
  // Match the path on any local origin rather than pinning one port.
  await page.route(
    /^http:\/\/(?:127\.0\.0\.1|localhost|demo\.localhost)(?::\d+)?\/api\/.*$/,
    async route => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace(/^\/api/, '');
      const method = route.request().method();

      if (
        method === 'GET' &&
        /^\/work\/previews\/preview-workspace\/49173\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\//.test(
          path
        )
      ) {
        if (path.endsWith('/preview-module.js')) {
          await route.fulfill({
            status: 200,
            contentType: 'text/javascript',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: `document.querySelector('[data-testid="mock-work-preview"]').dataset.moduleLoaded = 'true';`,
          });
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'text/html',
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Content-Security-Policy':
              "sandbox allow-scripts allow-forms allow-modals allow-downloads; frame-ancestors 'self' http://127.0.0.1:4173",
          },
          body: `<!doctype html>
<html>
  <head><title>Work preview</title><script type="module" src="preview-module.js"></script></head>
  <body><main data-testid="mock-work-preview">Isolated Work preview</main></body>
</html>`,
        });
        return;
      }

      // Mirrors backend/src/routes/artifacts.ts: the host document that HTML
      // artifact previews load instead of inheriting the page's CSP through
      // srcdoc. Keep the messaging contract in step with the real route.
      if (path === '/artifacts/sandbox' && method === 'GET') {
        await route.fulfill({
          status: 200,
          contentType: 'text/html; charset=utf-8',
          headers: {
            'Content-Security-Policy': [
              "default-src 'none'",
              // Mirrors the real route: the frame loads nothing over the
              // network, so no origin appears in the policy at all.
              "script-src 'unsafe-inline' 'unsafe-eval' blob:",
              "style-src 'unsafe-inline' blob:",
              'img-src data: blob:',
              'font-src data:',
              'connect-src data: blob:',
              'frame-src blob: data:',
              'worker-src blob:',
              `frame-ancestors ${APP_ORIGINS}`,
              'sandbox allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads',
            ].join('; '),
          },
          body: `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8" /><title>Artifact preview</title>
    <style>html, body { height: 100%; margin: 0; } iframe { display: block; width: 100%; height: 100%; border: 0; }</style>
  </head>
  <body>
    <script>
      (function () {
        var host = window.parent;
        if (!host || host === window) return;
        var frame = null;
        window.addEventListener('message', function (event) {
          if (event.source !== host) return;
          var data = event.data;
          if (!data || data.type !== 'libre-artifact:render') return;
          if (typeof data.html !== 'string') return;
          if (!frame) {
            frame = document.createElement('iframe');
            frame.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen; gamepad');
            frame.setAttribute('allowfullscreen', '');
            frame.setAttribute('title', 'Artifact');
            document.body.appendChild(frame);
          }
          frame.srcdoc = data.html;
        });
        host.postMessage({ type: 'libre-artifact:ready' }, '*');
      })();
    </script>
  </body>
</html>`,
        });
        return;
      }

      if (path === '/auth/system-info' && method === 'GET') {
        await fulfillJson(route, systemInfo);
        return;
      }

      if (
        method === 'GET' &&
        /^\/auth\/oauth\/(github|huggingface|oidc)\/status$/.test(path)
      ) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ configured: false }),
        });
        return;
      }

      if (path === '/auth/websocket-ticket' && method === 'POST') {
        await fulfillJson(route, {
          ticket: 'e2e-websocket-ticket',
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        });
        return;
      }

      if (path === '/plugins/usage' && method === 'GET') {
        const days = Number(url.searchParams.get('days') || 30);
        const to = Date.now();
        const from = to - Math.max(0, days - 1) * 86_400_000;
        await fulfillJson(
          route,
          options.pluginUsage ?? {
            range: { from, to, days },
            totals: {
              calls: 0,
              successfulCalls: 0,
              failedCalls: 0,
              cancelledCalls: 0,
              meteredCalls: 0,
              promptTokens: 0,
              completionTokens: 0,
              reportedTokens: 0,
              averageLatencyMs: 0,
              uniqueUsers: 0,
            },
            series: [],
            plugins: [],
            models: [],
            capabilities: [],
          }
        );
        return;
      }

      // Passive default: the composer reads the tool catalog on mount, and an
      // empty one keeps the tool controls off exactly as they were before the
      // route existed. Specs that care about tools route this themselves.
      if (path === '/tools/catalog' && method === 'GET') {
        await fulfillJson(route, { available: false, tools: [] });
        return;
      }

      if (path === '/system' && method === 'GET') {
        if (!options.systemDiagnostics) {
          await fulfillApiError(route, 503, 'System diagnostics unavailable');
          return;
        }
        await fulfillJson(route, options.systemDiagnostics);
        return;
      }

      if (path === '/auth/verify' && method === 'GET') {
        const authenticatedUser = authUserForRoute(route);
        await fulfillJson(
          route,
          publicAuthUser(
            authenticatedUser ?? {
              id: 'e2e-user',
              username: 'e2e',
              email: 'e2e@example.test',
              role: authRole,
            }
          )
        );
        return;
      }

      if (path === '/auth/login' && method === 'POST') {
        const credentials = route.request().postDataJSON() as {
          username: string;
        };
        const authenticatedUser = authUsers.find(
          user => user.username === credentials.username
        );
        if (authenticatedUser?.status === 'pending') {
          await route.fulfill({
            status: 403,
            contentType: 'application/json',
            body: JSON.stringify({
              success: false,
              code: 'ACCOUNT_PENDING',
              message: 'Your account is waiting for administrator approval',
            }),
          });
          return;
        }
        const user = publicAuthUser(
          authenticatedUser ?? {
            id: 'e2e-user',
            username: 'e2e',
            email: 'e2e@example.test',
            role: authRole,
          }
        );
        await fulfillJson(route, {
          user,
          token: authenticatedUser?.token ?? 'e2e-token',
          systemInfo,
        });
        return;
      }

      if (path === '/auth/signup' && method === 'POST') {
        const credentials = route.request().postDataJSON() as {
          username: string;
          email?: string;
        };
        const approvalRequired = systemInfo.userCount > 0;
        const user = {
          id: `signup-${credentials.username}`,
          username: credentials.username,
          email: credentials.email || null,
          role: approvalRequired ? ('user' as const) : ('admin' as const),
          status: approvalRequired ? ('pending' as const) : ('active' as const),
          avatar: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        authUsers.push({
          id: user.id,
          username: user.username,
          email: user.email,
          role: user.role,
          status: user.status,
          token: 'signup-token',
        });
        managedUsers = [user, ...managedUsers];
        await fulfillJson(
          route,
          approvalRequired
            ? { user, approvalRequired: true, systemInfo }
            : { user, token: 'signup-token', systemInfo }
        );
        return;
      }

      if (path === '/auth/logout' && method === 'POST') {
        await fulfillJson(route, undefined);
        return;
      }

      if (path === '/users' && method === 'GET') {
        await fulfillJson(route, managedUsers);
        return;
      }

      if (path === '/users/pending-approvals' && method === 'GET') {
        const pendingUsers = managedUsers.filter(
          user => user.status === 'pending'
        );
        await fulfillJson(route, {
          count: pendingUsers.length,
          latestCreatedAt: pendingUsers[0]?.createdAt ?? null,
        });
        return;
      }

      const approveUserMatch = path.match(/^\/users\/([^/]+)\/approve$/);
      if (approveUserMatch && method === 'PATCH') {
        const user = managedUsers.find(item => item.id === approveUserMatch[1]);
        if (!user) {
          await fulfillApiError(route, 404, 'User not found');
          return;
        }
        user.status = 'active';
        user.updatedAt = new Date().toISOString();
        await fulfillJson(route, user);
        return;
      }

      const deleteUserMatch = path.match(/^\/users\/([^/]+)$/);
      if (deleteUserMatch && method === 'DELETE') {
        managedUsers = managedUsers.filter(
          user => user.id !== deleteUserMatch[1]
        );
        await fulfillJson(route, undefined);
        return;
      }

      if (path === '/work/capabilities' && method === 'GET') {
        await fulfillJson(route, workCapabilities);
        return;
      }

      const workSeenMatch = path.match(/^\/work\/tasks\/([^/]+)\/seen$/);
      if (workSeenMatch && method === 'POST') {
        const taskId = decodeURIComponent(workSeenMatch[1]);
        const task = workTasks.find(item => item.id === taskId);
        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        workTaskSeenRequests.push(taskId);
        task.lastSeenAt = Date.now();
        await fulfillJson(route, { seen: true });
        return;
      }

      if (path === '/work/tasks' && method === 'GET') {
        const requestIndex = workTaskListRequests.length;
        workTaskListRequests.push(Date.now());
        if (
          workTaskTransition &&
          workTaskListRequests.length === workTaskTransition.afterListRequests
        ) {
          applyWorkTaskTransition();
        }
        const summaries = workTasks.map(
          ({ messages: _messages, ...summary }) => summary
        );
        const delayMs = options.workTaskListDelaysMs?.[requestIndex] ?? 0;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        const failure = options.workTaskListFailures?.[requestIndex];
        if (failure) {
          await fulfillApiError(route, 500, failure);
          return;
        }
        await fulfillJson(route, summaries);
        return;
      }

      if (path === '/work/tasks' && method === 'POST') {
        if (!workCapabilities.available) {
          await fulfillApiError(
            route,
            503,
            workCapabilities.reason || 'Docker runtime is unavailable'
          );
          return;
        }

        const request = route.request().postDataJSON() as {
          message: string;
          model: string;
          providerType: 'ollama' | 'plugin';
          providerId?: string;
          networkEnabled: boolean;
          personaId?: string;
          isAgent?: boolean;
        };
        const now = Date.now();
        const task: MockWorkTask = {
          id: `work-task-${nextWorkTaskId++}`,
          title:
            request.message.trim().replace(/\s+/g, ' ').slice(0, 80) ||
            'New Work task',
          model: request.model,
          providerType: request.providerType,
          providerId: request.providerId,
          status: 'preparing',
          networkEnabled: request.networkEnabled === true,
          createdAt: now,
          updatedAt: now,
          messages: [],
          activeRun: null,
          previewUrl: null,
          previewStatus: 'stopped',
          workspacePath: '/workspace',
          ...(request.personaId ? { personaId: request.personaId } : {}),
          ...(request.isAgent === true || request.personaId
            ? { isAgent: true }
            : {}),
        };

        workTaskCreateRequests.push(request);
        workTasks.unshift(task);
        workFiles[task.id] ??= [];
        appendMockWorkRun(
          task,
          request.message,
          request.model,
          request.providerType,
          request.providerId
        );
        await fulfillJson(route, workTaskDetail(task));
        return;
      }

      const workTaskMatch = path.match(/^\/work\/tasks\/([^/]+)$/);
      if (workTaskMatch) {
        const taskId = decodeURIComponent(workTaskMatch[1]);
        const taskIndex = workTasks.findIndex(item => item.id === taskId);
        const task = workTasks[taskIndex];

        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }

        if (method === 'GET') {
          workTaskDetailRequests.push(taskId);
          Object.assign(task, options.workTaskDetailUpdates?.[taskId]);
          await fulfillJson(route, workTaskDetail(task));
          return;
        }

        if (method === 'PATCH') {
          const updates = route.request().postDataJSON() as Partial<
            Pick<
              MockWorkTask,
              | 'title'
              | 'model'
              | 'providerType'
              | 'providerId'
              | 'networkEnabled'
            >
          >;
          Object.assign(task, updates, { updatedAt: Date.now() });
          if (updates.providerType === 'ollama') {
            task.providerId = undefined;
          }
          await fulfillJson(route, workTaskDetail(task));
          return;
        }

        if (method === 'DELETE') {
          workTaskDeleteRequests.push(taskId);
          workTasks.splice(taskIndex, 1);
          delete workFiles[taskId];
          for (const key of Object.keys(workFileContents)) {
            if (key.startsWith(`${taskId}:`)) delete workFileContents[key];
          }
          await fulfillJson(route, { id: taskId, deleted: true });
          return;
        }
      }

      const workMessagesMatch = path.match(
        /^\/work\/tasks\/([^/]+)\/messages$/
      );
      if (workMessagesMatch && method === 'GET') {
        const taskId = decodeURIComponent(workMessagesMatch[1]);
        const task = workTasks.find(item => item.id === taskId);
        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        const before = Number(url.searchParams.get('before'));
        const limit = Number(url.searchParams.get('limit') || 200);
        workMessagePageRequests.push({ taskId, before, limit });
        await fulfillJson(route, workMessagePage(task, before, limit));
        return;
      }

      const workRunMatch = path.match(/^\/work\/tasks\/([^/]+)\/runs$/);
      if (workRunMatch && method === 'POST') {
        const taskId = decodeURIComponent(workRunMatch[1]);
        const task = workTasks.find(item => item.id === taskId);
        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        const request = route.request().postDataJSON() as {
          message: string;
          model?: string;
          providerType?: 'ollama' | 'plugin';
          providerId?: string;
        };
        workRunRequests.push({ taskId, ...request });
        appendMockWorkRun(
          task,
          request.message,
          request.model,
          request.providerType,
          request.providerId
        );
        await fulfillJson(route, workTaskDetail(task));
        return;
      }

      const workCancelMatch = path.match(/^\/work\/tasks\/([^/]+)\/cancel$/);
      if (workCancelMatch && method === 'POST') {
        const taskId = decodeURIComponent(workCancelMatch[1]);
        const task = workTasks.find(item => item.id === taskId);
        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        const now = Date.now();
        workCancelRequests.push(taskId);
        task.status = 'cancelled';
        task.updatedAt = now;
        if (task.activeRun) {
          task.activeRun.status = 'cancelled';
          task.activeRun.finishedAt = now;
        }
        await fulfillJson(route, workTaskDetail(task));
        return;
      }

      const workFilesMatch = path.match(/^\/work\/tasks\/([^/]+)\/files$/);
      if (workFilesMatch && method === 'GET') {
        const taskId = decodeURIComponent(workFilesMatch[1]);
        if (!workTasks.some(item => item.id === taskId)) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        await fulfillJson(route, {
          path: url.searchParams.get('path') || '',
          entries: workFiles[taskId] ?? [],
        });
        return;
      }

      const workFileMatch = path.match(/^\/work\/tasks\/([^/]+)\/file$/);
      if (workFileMatch) {
        const taskId = decodeURIComponent(workFileMatch[1]);
        if (!workTasks.some(item => item.id === taskId)) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }

        if (method === 'GET') {
          const filePath = url.searchParams.get('path') || '';
          const content = workFileContents[`${taskId}:${filePath}`];
          const file = (workFiles[taskId] ?? []).find(
            item => item.path === filePath && item.type === 'file'
          );
          if (content === undefined || !file) {
            await fulfillApiError(route, 404, 'Work file not found');
            return;
          }
          await fulfillJson(route, {
            path: filePath,
            content,
            size: file.size,
            modifiedAt: file.modifiedAt,
            updatedAt: file.updatedAt ?? file.modifiedAt,
          });
          return;
        }

        if (method === 'PUT') {
          const request = route.request().postDataJSON() as {
            content: string;
            expectedUpdatedAt?: number;
          };
          const filePath = url.searchParams.get('path') || '';
          if (!filePath) {
            await fulfillApiError(route, 400, 'A workspace path is required');
            return;
          }
          workFileUpdateRequests.push({
            taskId,
            path: filePath,
            content: request.content,
            expectedUpdatedAt: request.expectedUpdatedAt,
          });
          if (options.deferWorkFileUpdates) {
            await new Promise<void>(resolve => {
              pendingWorkFileUpdateReleases.push(resolve);
            });
          }
          if (options.workFileUpdateFailure) {
            await fulfillApiError(route, 500, options.workFileUpdateFailure);
            return;
          }
          const now = Date.now();
          const files = (workFiles[taskId] ??= []);
          const existing = files.find(item => item.path === filePath);
          if (existing) {
            existing.size = request.content.length;
            existing.modifiedAt = now;
          } else {
            files.push({
              path: filePath,
              name: filePath.split('/').pop() || filePath,
              type: 'file',
              size: request.content.length,
              modifiedAt: now,
            });
          }
          workFileContents[`${taskId}:${filePath}`] = request.content;
          await fulfillJson(route, {
            path: filePath,
            content: request.content,
            size: request.content.length,
            modifiedAt: now,
          });
          return;
        }
      }

      const workGitDiffMatch = path.match(
        /^\/work\/tasks\/([^/]+)\/git\/diff$/
      );
      if (workGitDiffMatch && method === 'GET') {
        const taskId = decodeURIComponent(workGitDiffMatch[1]);
        if (!workTasks.some(item => item.id === taskId)) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        const filePath = url.searchParams.get('path') || undefined;
        workGitRequests.push({ taskId, action: 'diff' });
        await fulfillJson(route, {
          ...(filePath ? { path: filePath } : {}),
          patch:
            workGitDiffs[`${taskId}:${filePath || ''}`] ||
            (filePath
              ? `diff --git a/${filePath} b/${filePath}\n+mock change\n`
              : ''),
          truncated: false,
        });
        return;
      }

      const workGitStatusMatch = path.match(/^\/work\/tasks\/([^/]+)\/git$/);
      if (workGitStatusMatch && method === 'GET') {
        const taskId = decodeURIComponent(workGitStatusMatch[1]);
        if (!workTasks.some(item => item.id === taskId)) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        workGitRequests.push({ taskId, action: 'status' });
        await fulfillJson(route, workGitStatus(taskId));
        return;
      }

      const workGitMutationMatch = path.match(
        /^\/work\/tasks\/([^/]+)\/git\/(init|stage|commit|branches|switch)$/
      );
      if (workGitMutationMatch && method === 'POST') {
        const taskId = decodeURIComponent(workGitMutationMatch[1]);
        if (!workTasks.some(item => item.id === taskId)) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }
        const action = workGitMutationMatch[2];
        const request = (route.request().postDataJSON() || {}) as {
          paths?: string[];
          message?: string;
          name?: string;
        };
        const status = workGitStatus(taskId);

        if (action === 'init') {
          workGitRequests.push({ taskId, action: 'init' });
          Object.assign(status, {
            initialized: true,
            branch: 'main',
            detached: false,
            branches: ['main'],
          });
        } else if (action === 'stage') {
          const paths = request.paths ?? [];
          workGitRequests.push({ taskId, action: 'stage', paths });
          status.changes = status.changes.map(change =>
            paths.includes(change.path)
              ? {
                  ...change,
                  indexStatus:
                    change.indexStatus === '?'
                      ? 'A'
                      : change.workingTreeStatus === '.'
                        ? change.indexStatus
                        : change.workingTreeStatus,
                  workingTreeStatus: '.',
                  staged: true,
                }
              : change
          );
        } else if (action === 'commit') {
          const message = request.message || 'Mock commit';
          workGitRequests.push({ taskId, action: 'commit', message });
          const hash = `mock${Date.now()}`;
          status.head = hash;
          status.commits.unshift({
            hash,
            shortHash: hash.slice(0, 7),
            author: 'E2E User',
            authoredAt: new Date().toISOString(),
            subject: message,
          });
          status.changes = status.changes.filter(change => !change.staged);
        } else if (action === 'branches') {
          const name = request.name || 'new-branch';
          workGitRequests.push({ taskId, action: 'branch', name });
          if (!status.branches.includes(name)) status.branches.push(name);
        } else {
          const name = request.name || status.branch || 'main';
          workGitRequests.push({ taskId, action: 'switch', name });
          status.branch = name;
          status.detached = false;
        }

        await fulfillJson(route, status);
        return;
      }

      const workPreviewMatch = path.match(
        /^\/work\/tasks\/([^/]+)\/preview\/(start|stop)$/
      );
      if (workPreviewMatch && method === 'POST') {
        const taskId = decodeURIComponent(workPreviewMatch[1]);
        const action = workPreviewMatch[2] as 'start' | 'stop';
        const task = workTasks.find(item => item.id === taskId);
        if (!task) {
          await fulfillApiError(route, 404, 'Work task not found');
          return;
        }

        if (action === 'start') {
          if (!task.networkEnabled) {
            await fulfillApiError(
              route,
              409,
              'Enable task networking before starting a preview'
            );
            return;
          }
          const request = (route.request().postDataJSON() || {}) as {
            command?: string;
          };
          workPreviewRequests.push({
            taskId,
            action,
            command: request.command,
          });
          task.previewStatus = 'running';
          task.previewUrl = `/api/work/previews/preview-workspace/49173.${'N'.repeat(22)}.${'S'.repeat(43)}/`;
        } else {
          workPreviewRequests.push({ taskId, action });
          task.previewStatus = 'stopped';
          task.previewUrl = null;
        }
        task.updatedAt = Date.now();
        await fulfillJson(route, workTaskDetail(task));
        return;
      }

      if (path === '/ollama/health' && method === 'GET') {
        await fulfillJson(
          route,
          { status: ollamaHealthy ? 'ok' : 'offline' },
          ollamaHealthy
        );
        return;
      }

      if (path === '/ollama/settings' && method === 'GET') {
        await fulfillJson(route, {
          enabled: true,
          baseUrl: 'http://localhost:11434',
        });
        return;
      }

      if (path === '/ollama/models' && method === 'GET') {
        if (!ollamaHealthy) {
          await fulfillApiError(route, 503, 'Ollama is offline');
          return;
        }
        await fulfillJson(route, models);
        return;
      }

      if (path === '/ollama/models/visibility' && method === 'GET') {
        await fulfillJson(route, modelCatalog);
        return;
      }

      if (path === '/ollama/models/visibility' && method === 'PUT') {
        const update = route
          .request()
          .postDataJSON() as Partial<MockModelCatalog>;
        modelCatalogUpdateRequests.push(structuredClone(update));
        modelCatalog = { ...modelCatalog, ...structuredClone(update) };
        await fulfillJson(route, modelCatalog);
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

      if (path === '/preferences/default-theme' && method === 'GET') {
        await fulfillJson(route, { theme: instanceDefaultTheme });
        return;
      }

      if (path === '/preferences/default-theme' && method === 'PUT') {
        const body = route.request().postDataJSON() as {
          theme?: Record<string, unknown>;
        };
        instanceDefaultTheme = {
          ...instanceDefaultTheme,
          ...(body.theme ?? {}),
        };
        await fulfillJson(route, { theme: instanceDefaultTheme });
        return;
      }

      if (path === '/preferences' && method === 'GET') {
        await fulfillJson(route, preferencesForRoute(route));
        return;
      }

      if (path === '/preferences' && method === 'PUT') {
        const authenticatedUser = authUserForRoute(route);
        const activePreferences = preferencesForRoute(route);
        const updates = route.request().postDataJSON() as Partial<
          typeof defaultPreferences
        >;
        preferenceUpdateRequests.push(structuredClone(updates));
        preferenceUpdateUserIds.push(authenticatedUser?.id ?? null);

        if (options.deferPreferenceUpdates) {
          await new Promise<void>(resolve => {
            pendingPreferenceUpdateReleases.push(resolve);
          });
        }

        if (preferenceUpdateFailures > 0) {
          preferenceUpdateFailures -= 1;
          await fulfillJson(route, {}, false);
          return;
        }

        Object.assign(activePreferences, updates);
        if (updates.theme) {
          activePreferences.theme = {
            ...activePreferences.theme,
            ...updates.theme,
          };
        }
        await fulfillJson(route, activePreferences);
        return;
      }

      if (path.startsWith('/preferences') && method !== 'GET') {
        // Which preferences endpoint was written to, so a test can tell a
        // global save from one pinned to a single model.
        preferenceScopedWrites.push({
          path,
          body: route.request().postDataJSON() as Record<string, unknown>,
        });
        await fulfillJson(route, preferencesForRoute(route));
        return;
      }

      if (path === '/chat/sessions' && method === 'GET') {
        await fulfillJson(route, sessions);
        return;
      }

      if (path === '/chat/folders' && method === 'GET') {
        await fulfillJson(route, folders);
        return;
      }

      if (path === '/chat/folders' && method === 'POST') {
        const request = route.request().postDataJSON() as { name?: string };
        const now = Date.now();
        const folder: MockFolder = {
          id: `folder-${nextFolderId++}`,
          name: String(request.name ?? '').trim(),
          createdAt: now,
          updatedAt: now,
        };
        folderCreateRequests.push({ name: folder.name });
        folders.push(folder);
        await fulfillJson(route, folder);
        return;
      }

      const folderMatch = path.match(/^\/chat\/folders\/([^/]+)$/);
      if (folderMatch && (method === 'PUT' || method === 'DELETE')) {
        const folderId = decodeURIComponent(folderMatch[1]);
        const folder = folders.find(item => item.id === folderId);
        if (!folder) {
          await fulfillApiError(route, 404, 'Folder not found');
          return;
        }
        if (method === 'PUT') {
          const request = route.request().postDataJSON() as { name?: string };
          folder.name = String(request.name ?? '').trim();
          folder.updatedAt = Date.now();
          folderRenameRequests.push({ folderId, name: folder.name });
          await fulfillJson(route, folder);
          return;
        }
        folderDeleteRequests.push(folderId);
        folders.splice(folders.indexOf(folder), 1);
        for (const session of sessions) {
          if (session.folderId === folderId) session.folderId = null;
        }
        await fulfillJson(route, undefined);
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
        await fulfillJson(route, options.personas ?? []);
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
        const delayMs = pendingPluginListDelayMs;
        pendingPluginListDelayMs = 0;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
        await fulfillJson(route, plugins);
        return;
      }

      const pluginDiscoveryMatch = path.match(/^\/plugins\/discover\/([^/]+)$/);
      if (pluginDiscoveryMatch && method === 'POST') {
        const pluginId = decodeURIComponent(pluginDiscoveryMatch[1]);
        pluginDiscoveryRequests.push(pluginId);

        const delayMs = options.pluginDiscoveryDelayMs ?? 0;
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }

        const failure = options.pluginDiscoveryFailures?.[pluginId];
        if (failure) {
          await fulfillApiError(route, 500, failure);
          return;
        }

        const plugin = plugins.find(candidate => candidate.id === pluginId);
        if (!plugin) {
          await fulfillApiError(route, 404, 'Plugin not found');
          return;
        }

        const discoveredModels =
          options.pluginDiscoveryResults?.[pluginId] ?? plugin.model_map;
        plugin.model_map = [...discoveredModels];
        await fulfillJson(route, discoveredModels);
        return;
      }

      const pluginVariablesMatch = path.match(
        /^\/plugins\/([^/]+)\/variables$/
      );
      if (pluginVariablesMatch && method === 'GET') {
        const pluginId = decodeURIComponent(pluginVariablesMatch[1]);
        await fulfillJson(route, pluginVariables[pluginId] ?? {});
        return;
      }

      if (pluginVariablesMatch && method === 'PUT') {
        const pluginId = decodeURIComponent(pluginVariablesMatch[1]);
        const update = route.request().postDataJSON() as {
          variables?: Record<string, string | number | boolean>;
          unset?: string[];
        };
        pluginVariableUpdateRequests.push({
          pluginId,
          variables: update.variables ?? {},
          unset: update.unset ?? [],
        });
        pendingPluginListDelayMs = options.pluginMutationRefreshDelayMs ?? 0;
        await fulfillJson(route, true);
        return;
      }

      if (pluginVariablesMatch && method === 'DELETE') {
        const pluginId = decodeURIComponent(pluginVariablesMatch[1]);
        pluginVariableResetRequests += 1;
        if (pluginVariableResetFailures > 0) {
          pluginVariableResetFailures -= 1;
          await fulfillJson(route, false);
          return;
        }
        pluginVariables[pluginId] = {};
        pendingPluginListDelayMs = options.pluginMutationRefreshDelayMs ?? 0;
        await fulfillJson(route, true);
        return;
      }

      const pluginCredentialsMatch = path.match(
        /^\/plugins\/([^/]+)\/credentials$/
      );
      if (pluginCredentialsMatch && method === 'POST') {
        const pluginId = decodeURIComponent(pluginCredentialsMatch[1]);
        const request = route.request().postDataJSON() as { api_key?: string };
        pluginCredentialUpdateRequests.push({
          pluginId,
          apiKey: request.api_key ?? '',
        });
        pendingPluginListDelayMs = options.pluginMutationRefreshDelayMs ?? 0;
        await fulfillJson(route, true);
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
        await fulfillJson(route, imageGenPlugins);
        return;
      }

      if (path === '/image-gen/models' && method === 'GET') {
        await fulfillJson(route, imageGenModels);
        return;
      }

      if (path === '/image-gen/gallery' && method === 'GET') {
        await fulfillJson(route, { images: [], total: 0 });
        return;
      }

      if (path === '/image-gen/generate' && method === 'POST') {
        const request = route
          .request()
          .postDataJSON() as MockImageGenerationRequest;
        imageGenerationRequests.push(request);
        await fulfillJson(route, {
          images: [{ b64_json: 'iVBORw0KGgo=' }],
          model: request.model,
          pluginId: request.pluginId,
        });
        return;
      }

      if (path === '/media/models' && method === 'GET') {
        await fulfillJson(route, mediaModels);
        return;
      }

      if (path === '/media/video/jobs' && method === 'GET') {
        await fulfillJson(route, { jobs: mediaVideoJobs });
        return;
      }

      if (path === '/media/video/generate' && method === 'POST') {
        const request = route
          .request()
          .postDataJSON() as MockVideoGenerationRequest;
        videoGenerationRequests.push(request);
        const now = Date.now();
        const job: MockVideoGenerationJob = {
          id: `video-job-${videoGenerationRequests.length}`,
          status: 'pending',
          model: request.model,
          pluginId: request.pluginId,
          prompt: request.prompt,
          cancellable: false,
          createdAt: now,
          updatedAt: now,
        };
        mediaVideoJobs = [job, ...mediaVideoJobs];
        await fulfillJson(route, job);
        return;
      }

      const mediaVideoJobMatch = path.match(/^\/media\/video\/jobs\/([^/]+)$/);
      const mediaVideoResumeMatch = path.match(
        /^\/media\/video\/jobs\/([^/]+)\/resume$/
      );
      if (mediaVideoResumeMatch && method === 'POST') {
        const jobId = decodeURIComponent(mediaVideoResumeMatch[1]);
        videoResumeRequests.push(jobId);
        const job = mediaVideoJobs.find(candidate => candidate.id === jobId);
        if (!job) {
          await fulfillJson(route, null, false);
          return;
        }
        const completed: MockVideoGenerationJob = {
          ...job,
          status: 'completed',
          galleryId: `gallery-${jobId}`,
          cancellable: false,
          updatedAt: Date.now(),
          media: { id: `gallery-${jobId}`, kind: 'video' },
        };
        mediaVideoJobs = mediaVideoJobs.map(candidate =>
          candidate.id === jobId ? completed : candidate
        );
        await fulfillJson(route, completed);
        return;
      }
      if (mediaVideoJobMatch && method === 'DELETE') {
        const jobId = decodeURIComponent(mediaVideoJobMatch[1]);
        videoCancelRequests.push(jobId);
        mediaVideoJobs = mediaVideoJobs.filter(job => job.id !== jobId);
        await fulfillJson(route, undefined);
        return;
      }

      if (path === '/media/gallery' && method === 'GET') {
        await fulfillJson(route, { media: [], total: 0 });
        return;
      }

      if (path === '/media/audio/voice-clone' && method === 'POST') {
        voiceCloneRequests.push({
          body: route.request().postDataBuffer()?.toString('utf8') || '',
          contentType: route.request().headers()['content-type'] || '',
        });
        await fulfillJson(route, {
          id: 'generated-voice-clone',
          userId: 'default',
          kind: 'audio',
          prompt: 'Cloned speech',
          model: 'meituan-longcat/LongCat-AudioDiT-1B',
          pluginId: 'longcat-audiodit',
          mediaData: '/api/media/gallery/generated-voice-clone/content',
          mimeType: 'audio/wav',
          createdAt: Date.now(),
        });
        return;
      }

      if (path === '/media/sound/generate' && method === 'POST') {
        const request = route
          .request()
          .postDataJSON() as MockSoundGenerationRequest;
        soundGenerationRequests.push(request);
        await fulfillJson(route, {
          id: 'generated-sound',
          userId: 'default',
          kind: 'audio',
          prompt: request.prompt,
          model: request.model,
          pluginId: request.pluginId,
          mediaData: '/api/media/gallery/generated-sound/content',
          mimeType: 'audio/wav',
          createdAt: Date.now(),
        });
        return;
      }

      if (path === '/tts/models' && method === 'GET') {
        await fulfillJson(route, ttsModels);
        return;
      }

      if (path === '/stt/models' && method === 'GET') {
        await fulfillJson(route, sttModels);
        return;
      }

      if (path === '/stt/transcribe' && method === 'POST') {
        sttTranscriptionRequests.push({
          body: route.request().postDataBuffer()?.toString('latin1') || '',
          contentType: route.request().headers()['content-type'] || '',
        });
        if (options.sttTranscriptionDelayMs) {
          await new Promise(resolve =>
            setTimeout(resolve, options.sttTranscriptionDelayMs)
          );
        }
        try {
          await fulfillJson(route, { text: sttTranscript, language: 'en' });
        } catch {
          // A cancelled transcription can close the intercepted request before
          // its delayed provider response is ready.
        }
        return;
      }

      if (path === '/tts/plugins' && method === 'GET') {
        await fulfillJson(route, ttsPlugins);
        return;
      }

      if (path === '/tts/voice-profiles' && method === 'GET') {
        const pluginId = url.searchParams.get('pluginId');
        const model = url.searchParams.get('model');
        await fulfillJson(
          route,
          ttsVoiceProfiles
            .filter(
              profile =>
                (!pluginId || profile.pluginId === pluginId) &&
                (!model || profile.model === model)
            )
            .map(profile => ({
              consentConfirmedAt: 0,
              consentExpiresAt: null,
              revokedAt: null,
              transferCount: 0,
              lastTransferAt: null,
              consentStatus: 'active',
              ...profile,
            }))
        );
        return;
      }

      const ttsVoiceProfileMatch = path.match(
        /^\/tts\/voice-profiles\/([^/]+)$/
      );
      if (ttsVoiceProfileMatch && method === 'DELETE') {
        const id = decodeURIComponent(ttsVoiceProfileMatch[1]);
        ttsVoiceProfileDeleteRequests.push(id);
        ttsVoiceProfiles = ttsVoiceProfiles.filter(
          profile => profile.id !== id
        );
        await route.fulfill({ status: 204, body: '' });
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

      if (path === '/tts/generate' && method === 'POST') {
        ttsGenerationRequests.push(
          route.request().postDataJSON() as MockTTSGenerationRequest
        );
        await route.fulfill({
          status: 200,
          contentType: 'audio/wav',
          body: Buffer.from('RIFF0000WAVEfmt '),
        });
        return;
      }

      // Passive defaults for the team surfaces: the notification bell and
      // channel list poll from every page, so specs that don't exercise
      // them still get quiet, empty answers.
      // Passive defaults: the admin usage page polls cost governance data.
      if (method === 'GET' && path === '/costs/analytics') {
        await fulfillJson(route, {
          from: 0,
          to: 0,
          totalUsd: 0,
          meteredEvents: 0,
          unmeteredEvents: 0,
          byPlugin: [],
          byModel: [],
          byUser: [],
          byDay: [],
          budgets: [],
        });
        return;
      }
      if (
        method === 'GET' &&
        (path === '/costs/tariffs' || path === '/costs/budgets')
      ) {
        await fulfillJson(route, []);
        return;
      }

      if (method === 'GET' && path === '/notifications/unread-count') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { count: 0 } }),
        });
        return;
      }
      if (method === 'GET' && /^\/notifications(?:\?.*)?$/.test(path)) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
        return;
      }
      if (method === 'GET' && path === '/channels') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
        return;
      }
      if (method === 'GET' && path === '/calendar/calendars') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
        return;
      }
      if (method === 'GET' && path === '/auth/mfa') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: {
              totpEnabled: false,
              totpPending: false,
              recoveryCodesRemaining: 0,
              required: false,
              requiredModeLocked: false,
              passkeys: [],
            },
          }),
        });
        return;
      }
      if (method === 'GET' && path === '/auth/mfa/policy') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { mode: 'optional', locked: false },
          }),
        });
        return;
      }
      if (method === 'GET' && path === '/recovery/drills') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { supported: true, intervalHours: null, drills: [] },
          }),
        });
        return;
      }
      if (method === 'GET' && path === '/push/public-key') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data: { publicKey: 'BE2E-not-a-real-key' },
          }),
        });
        return;
      }
      if (method === 'GET' && path === '/push/subscriptions') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
        });
        return;
      }
      if (method === 'GET' && path === '/auth/passkeys') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: [] }),
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
    preferenceScopedWrites,
    /** Stands in for a model appearing on the backend, as a pull would. */
    setModels: (next: MockModel[]) => {
      models = next;
    },
    getModels: () => models,
    pullStreamUrls,
    preferenceUpdateRequests,
    modelCatalogUpdateRequests,
    pluginCredentialUpdateRequests,
    pluginDiscoveryRequests,
    pluginVariableUpdateRequests,
    get pluginVariableResetRequests() {
      return pluginVariableResetRequests;
    },
    preferenceUpdateUserIds,
    releasePreferenceUpdates: () => {
      pendingPreferenceUpdateReleases
        .splice(0)
        .forEach(releasePreferenceUpdate => releasePreferenceUpdate());
    },
    ttsGenerationRequests,
    sttTranscriptionRequests,
    ttsVoiceProfileDeleteRequests,
    imageGenerationRequests,
    soundGenerationRequests,
    videoGenerationRequests,
    videoResumeRequests,
    videoCancelRequests,
    voiceCloneRequests,
    titleGenerationRequests,
    sessionUpdateRequests,
    folderCreateRequests,
    folderRenameRequests,
    folderDeleteRequests,
    workTaskCreateRequests,
    workTaskDetailRequests,
    workTaskSeenRequests,
    workTaskListRequests,
    workTaskDeleteRequests,
    workMessagePageRequests,
    applyWorkTaskTransition,
    workRunRequests,
    workCancelRequests,
    workFileUpdateRequests,
    releaseWorkFileUpdates: () => {
      pendingWorkFileUpdateReleases
        .splice(0)
        .forEach(releaseWorkFileUpdate => releaseWorkFileUpdate());
    },
    workPreviewRequests,
    workGitRequests,
  };
}
