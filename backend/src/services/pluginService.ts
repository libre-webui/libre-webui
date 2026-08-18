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

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import sanitize from 'sanitize-filename';
import axios from 'axios';
import {
  AudioGenConfig,
  EmbeddingModel,
  OllamaEmbeddingsResponse,
  Plugin,
  PluginStatus,
  PluginResponse,
  ChatMessage,
  GenerationOptions,
  TTSConfig,
  ImageGenConfig,
  ImageGenResponse,
  PluginType,
  STTConfig,
  VideoGenConfig,
} from '../types/index.js';
import codexOAuthService, {
  CODEX_OAUTH_PLUGIN_ID,
} from './codexOAuthService.js';
import { userModel } from '../models/userModel.js';
import pluginCredentialsService from './pluginCredentialsService.js';
import pluginVariablesService from './pluginVariablesService.js';
import {
  ensurePluginCacheInvalidationSubscription,
  publishPluginCacheInvalidation,
  registerPluginCacheInvalidationListener,
  type PluginCacheInvalidation,
} from './pluginCacheInvalidation.js';
import pluginActivationService from './pluginActivationService.js';
import { PluginAudioGenerationService } from './pluginAudioGenerationService.js';
import { PluginCapabilityRegistryService } from './pluginCapabilityRegistryService.js';
import { PluginEmbeddingService } from './pluginEmbeddingService.js';
import { PluginImageGenerationService } from './pluginImageGenerationService.js';
import { PluginSTTService } from './pluginSTTService.js';
import { PluginTTSService } from './pluginTTSService.js';
import { PluginVideoGenerationService } from './pluginVideoGenerationService.js';
import {
  applyPluginDefinitionPolicy,
  buildPluginChatPayload,
  convertProviderResponse,
  getOpenAICompatibleSamplingParameters,
  resolvePluginChatParameters,
  toOpenAICompatibleMessages,
} from '../utils/pluginChatAdapter.js';
import {
  parseDiscoveredCatalog,
  readModelContextMap,
  serializeDiscoveredCatalog,
  type PluginModelContextMap,
} from '../utils/pluginModelCatalog.js';
import {
  streamAnthropicResponse,
  streamOpenAICompatibleResponse,
  streamOpenAIResponsesResponse,
  type PluginStreamChunk,
} from '../utils/pluginStreamAdapter.js';
import {
  applyModelEndpointTemplate,
  assertSafePluginEndpoint,
  buildPluginAuthHeaders,
  buildPluginModelDiscoveryHeaders,
  pluginRequiresApiKey,
  resolvePluginApiConfig,
  resolvePluginEndpoint,
  resolvePluginModelsEndpoint,
  validatePluginModel,
} from '../utils/pluginValidation.js';
import { createLogger } from '../utils/logger.js';
import {
  isChatGenerationCancelled,
  throwIfChatGenerationCancelled,
} from '../utils/chatCancellation.js';
import { resolveBundledPluginsDir } from '../utils/packagePaths.js';
import {
  BACKEND_DIRECTORY,
  PROJECT_DIRECTORY,
  resolveDataDirectory,
  resolveLegacyPluginsDirectories,
  resolvePhysicalPathCandidate,
  resolvePluginsDirectory,
} from '../utils/dataDirectory.js';
import { getPersistence } from '../persistence/index.js';
import {
  createOpenAIResponsesStateScope,
  createPluginCredentialFingerprint,
  OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY,
} from '../utils/openAIResponsesAdapter.js';
import { getPluginConnectionVariableNames } from '../utils/pluginConnectionVariables.js';
import pluginUsageService, {
  type PluginUsageStatus,
  type ProviderTokenUsage,
} from './pluginUsageService.js';
import {
  getPluginDefinitionFingerprint,
  matchesBundledPluginTrustAnchor,
} from '../utils/pluginDefinitionTrust.js';
import { encryptionService } from './encryptionService.js';
import type { StoredPluginDefinition } from '../persistence/extensionTypes.js';

const logger = createLogger('plugins');

/**
 * Server-reported generation timings. llama.cpp (and servers that copy its
 * shape) return this next to `usage` on the OpenAI-compatible endpoint; it is
 * not part of the OpenAI schema, so it arrives untyped.
 */
const readProviderTimings = (
  payload: unknown
):
  | { promptMs?: number; predictedMs?: number; predictedPerSecond?: number }
  | undefined => {
  const timings = (payload as { timings?: unknown } | null)?.timings;
  if (!timings || typeof timings !== 'object') return undefined;
  const record = timings as Record<string, unknown>;
  const numeric = (key: string): number | undefined =>
    typeof record[key] === 'number' && Number.isFinite(record[key] as number)
      ? (record[key] as number)
      : undefined;
  const result = {
    ...(numeric('prompt_ms') !== undefined
      ? { promptMs: numeric('prompt_ms') }
      : {}),
    ...(numeric('predicted_ms') !== undefined
      ? { predictedMs: numeric('predicted_ms') }
      : {}),
    ...(numeric('predicted_per_second') !== undefined
      ? { predictedPerSecond: numeric('predicted_per_second') }
      : {}),
  };
  return Object.keys(result).length > 0 ? result : undefined;
};

const hasSymlinkPathComponentFromRoot = (
  root: string,
  target: string
): boolean => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return false;
  }
  let current = resolvedRoot;
  for (const component of relative.split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
  return false;
};

const isRegularPluginDirectory = (directory: string): boolean => {
  try {
    const stat = fs.lstatSync(directory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const isRegularPluginDefinition = (filePath: string): boolean => {
  try {
    if (!isRegularPluginDirectory(path.dirname(filePath))) return false;
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

const readRegularPluginDefinition = (filePath: string): string => {
  if (!isRegularPluginDirectory(path.dirname(filePath))) {
    throw new Error('Plugin definition directory is not a regular directory');
  }
  const namedStat = fs.lstatSync(filePath);
  if (!namedStat.isFile() || namedStat.isSymbolicLink()) {
    throw new Error('Plugin definition is not a regular file');
  }
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)
  );
  try {
    const openedStat = fs.fstatSync(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== namedStat.dev ||
      openedStat.ino !== namedStat.ino
    ) {
      throw new Error('Plugin definition changed during inspection');
    }
    return fs.readFileSync(descriptor, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
};

const readPositiveIntEnv = (name: string, fallback: number): number => {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

// A discovered catalog older than this is refreshed the next time the plugin
// list is requested, so a browser reload picks up provider-side model changes.
const modelDiscoveryTtlMs = (): number =>
  readPositiveIntEnv('PLUGIN_MODEL_DISCOVERY_TTL_MS', 6 * 60 * 60 * 1000);

// Backoff between attempts. Applies to failures too, so an unreachable provider
// is retried periodically instead of on every request.
const modelDiscoveryRetryMs = (): number =>
  readPositiveIntEnv('PLUGIN_MODEL_DISCOVERY_RETRY_MS', 10 * 60 * 1000);

// Upper bound on how long a plugin-list request waits for background refreshes.
// Slower providers keep resolving and land in the next response.
const modelDiscoveryRefreshDeadlineMs = (): number =>
  readPositiveIntEnv('PLUGIN_MODEL_DISCOVERY_REFRESH_DEADLINE_MS', 3000);

const MODEL_DISCOVERY_REQUEST_TIMEOUT_MS = 5000;
type DiscoverableMediaCapability = 'image' | 'stt' | 'tts' | 'audio' | 'video';

/**
 * Why a refresh did or did not change the catalog. Reported to the caller so a
 * silent fallback to the bundled catalog is never presented as a live update.
 */
export type PluginModelDiscoveryOutcome =
  'updated' | 'unchanged' | 'missing_credentials' | 'unavailable';

export interface PluginModelDiscoveryResult {
  models: string[];
  outcome: PluginModelDiscoveryOutcome;
  reason?: string;
}

function describeModelDiscoveryFailure(error: unknown): string {
  if (axios.isAxiosError(error)) {
    if (error.response) {
      return `The provider responded with HTTP ${error.response.status}`;
    }
    if (error.code === 'ECONNABORTED') {
      return 'The provider did not respond in time';
    }
    return error.code
      ? `Could not reach the provider (${error.code})`
      : 'Could not reach the provider';
  }

  return error instanceof Error ? error.message : 'Unknown error';
}

function getPluginRoutingAuthProjection(plugin: Plugin): string {
  const capabilityEndpoints = Object.entries(
    (plugin.capabilities || {}) as Record<string, unknown>
  )
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const capability =
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)
          : {};
      const config =
        capability.config && typeof capability.config === 'object'
          ? (capability.config as Record<string, unknown>)
          : {};
      return {
        name,
        endpoint: capability.endpoint ?? null,
        models_endpoint: capability.models_endpoint ?? null,
        endpoint_variable:
          config.endpoint_variable ?? capability.endpoint_variable ?? null,
        models_endpoint_variable: config.models_endpoint_variable ?? null,
        voice_clone_endpoint: config.voice_clone_endpoint ?? null,
        voice_clone_endpoint_variable:
          config.voice_clone_endpoint_variable ?? null,
      };
    });
  const definitions = new Map(
    (plugin.variables || []).map(definition => [definition.name, definition])
  );
  const connectionVariables = Array.from(
    getPluginConnectionVariableNames(plugin),
    name => {
      const definition = definitions.get(name);
      if (!definition) return null;
      return {
        name: definition.name,
        type: definition.type,
        label: definition.label,
        description: definition.description ?? null,
        default: definition.default ?? null,
        required: definition.required ?? null,
        sensitive: definition.sensitive ?? null,
        options: definition.options ?? null,
        min: definition.min ?? null,
        max: definition.max ?? null,
      };
    }
  );

  return JSON.stringify({
    endpoint: plugin.endpoint,
    base_url: (plugin as unknown as Record<string, unknown>).base_url ?? null,
    api_path: (plugin as unknown as Record<string, unknown>).api_path ?? null,
    api_mode: (plugin as unknown as Record<string, unknown>).api_mode ?? null,
    auth: {
      header: plugin.auth.header,
      prefix: plugin.auth.prefix ?? '',
      key_env: plugin.auth.key_env,
    },
    capabilityEndpoints,
    connectionVariables,
  });
}

export interface PluginServiceOptions {
  /** Dependency injection for isolated tests; production uses deterministic legacy paths. */
  legacyPluginsDirectories?: string[];
}

export class PluginService {
  private pluginsDir: string;
  private bundledPluginsDir: string;
  private legacyPluginsDirs: string[];
  private historicalPluginConflictDirs: string[];
  private pluginReadDirs: string[];
  private discoveredModelsCache = new Map<string, string[] | null>();
  /** Context windows the provider reported for its own models. */
  private discoveredModelContextCache = new Map<
    string,
    PluginModelContextMap | null
  >();
  /** Catalogs stored before context windows were captured. */
  private discoveredCatalogIsLegacy = new Map<string, boolean>();
  private discoveredModelsUpdatedAt = new Map<string, number>();
  private discoveryAttemptedAt = new Map<string, number>();
  private inflightDiscovery = new Map<
    string,
    Promise<PluginModelDiscoveryResult>
  >();
  private discoveredCapabilityModelsCache = new Map<string, string[] | null>();
  private discoveredCapabilityModelsUpdatedAt = new Map<string, number>();
  private capabilityDiscoveryAttemptedAt = new Map<string, number>();
  private inflightCapabilityDiscovery = new Map<
    string,
    Promise<PluginModelDiscoveryResult>
  >();
  private discoveryCacheRevisions = new Map<string, number>();
  private capabilityDiscoveryCacheRevisions = new Map<string, number>();
  private removeCacheInvalidationListener: (() => void) | undefined;
  private embeddingService: PluginEmbeddingService;
  private ttsService: PluginTTSService;
  private sttService: PluginSTTService;
  private imageGenerationService: PluginImageGenerationService;
  private audioGenerationService: PluginAudioGenerationService;
  private videoGenerationService: PluginVideoGenerationService;
  private capabilityRegistryService: PluginCapabilityRegistryService;
  private bundledRoutingProjectionCache = new Map<string, string | null>();
  private legacyActivationMigration: Promise<void> | undefined;
  private readonly sharedPluginDefinitions: boolean;
  private readonly sharedDefinitionIds = new Set<string>();

  constructor(options: PluginServiceOptions = {}) {
    this.sharedPluginDefinitions =
      getPersistence(encryptionService).dialect === 'postgres';
    this.bundledPluginsDir = resolveBundledPluginsDir(import.meta.url);
    this.pluginsDir = resolvePluginsDirectory();
    this.legacyPluginsDirs =
      options.legacyPluginsDirectories ?? resolveLegacyPluginsDirectories();
    const activePluginDirectories = new Set(
      [this.bundledPluginsDir, this.pluginsDir, ...this.legacyPluginsDirs].map(
        directory => resolvePhysicalPathCandidate(directory)
      )
    );
    this.historicalPluginConflictDirs = options.legacyPluginsDirectories
      ? []
      : resolveLegacyPluginsDirectories(process.env, {
          historicalWorkingDirectory: process.cwd(),
        }).filter(
          directory =>
            !activePluginDirectories.has(
              resolvePhysicalPathCandidate(directory)
            )
        );
    this.pluginReadDirs = this.sharedPluginDefinitions
      ? [this.bundledPluginsDir]
      : Array.from(
          new Set([
            this.bundledPluginsDir,
            ...this.legacyPluginsDirs,
            this.pluginsDir,
          ])
        );
    if (this.sharedPluginDefinitions) {
      this.assertNoLocalCustomDefinitions();
    } else {
      this.ensurePluginsDirectory();
    }
    this.embeddingService = new PluginEmbeddingService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.ttsService = new PluginTTSService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getPlugin: (id, userId) => this.getPluginUnchecked(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.sttService = new PluginSTTService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getPlugin: (id, userId) => this.getPluginUnchecked(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.imageGenerationService = new PluginImageGenerationService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getPlugin: (id, userId) => this.getPluginUnchecked(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.audioGenerationService = new PluginAudioGenerationService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getPlugin: (id, userId) => this.getPluginUnchecked(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.videoGenerationService = new PluginVideoGenerationService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getPlugin: (id, userId) => this.getPluginUnchecked(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.capabilityRegistryService = new PluginCapabilityRegistryService({
      getAllPlugins: userId => this.getActivePluginsUnchecked(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
    });
  }

  private repositories() {
    return getPersistence(encryptionService).repositories.extensions;
  }

  private async ensureCacheInvalidation(): Promise<void> {
    this.removeCacheInvalidationListener ??=
      registerPluginCacheInvalidationListener(invalidation =>
        this.invalidateRuntimeCaches(invalidation)
      );
    await ensurePluginCacheInvalidationSubscription();
  }

  private bumpDiscoveryRevision(key: string): void {
    this.discoveryCacheRevisions.set(
      key,
      (this.discoveryCacheRevisions.get(key) ?? 0) + 1
    );
  }

  private bumpCapabilityDiscoveryRevision(key: string): void {
    this.capabilityDiscoveryCacheRevisions.set(
      key,
      (this.capabilityDiscoveryCacheRevisions.get(key) ?? 0) + 1
    );
  }

  private invalidateRuntimeCaches(invalidation: PluginCacheInvalidation): void {
    const completionKeys = new Set([
      ...this.discoveredModelsCache.keys(),
      ...this.discoveredModelContextCache.keys(),
      ...this.discoveredModelsUpdatedAt.keys(),
      ...this.discoveryAttemptedAt.keys(),
      ...this.inflightDiscovery.keys(),
      ...this.discoveryCacheRevisions.keys(),
    ]);
    const capabilityKeys = new Set([
      ...this.discoveredCapabilityModelsCache.keys(),
      ...this.discoveredCapabilityModelsUpdatedAt.keys(),
      ...this.capabilityDiscoveryAttemptedAt.keys(),
      ...this.inflightCapabilityDiscovery.keys(),
      ...this.capabilityDiscoveryCacheRevisions.keys(),
    ]);
    const completionMatches = (key: string): boolean => {
      if (invalidation.scope === 'plugin-user') {
        return (
          key ===
          this.discoveredModelsCacheKey(
            invalidation.pluginId,
            invalidation.userId
          )
        );
      }
      if (invalidation.scope === 'plugin') {
        return key.endsWith(`:${invalidation.pluginId}`);
      }
      return key.startsWith(`${invalidation.userId}:`);
    };
    const capabilityMatches = (key: string): boolean => {
      if (invalidation.scope === 'plugin-user') {
        return key.startsWith(
          `${invalidation.userId}:${invalidation.pluginId}:`
        );
      }
      if (invalidation.scope === 'plugin') {
        return key.includes(`:${invalidation.pluginId}:`);
      }
      return key.startsWith(`${invalidation.userId}:`);
    };

    for (const key of completionKeys) {
      if (!completionMatches(key)) continue;
      this.discoveredModelsCache.delete(key);
      this.discoveredModelContextCache.delete(key);
      this.discoveredCatalogIsLegacy.delete(key);
      this.discoveredModelsUpdatedAt.delete(key);
      this.discoveryAttemptedAt.delete(key);
      this.inflightDiscovery.delete(key);
      this.bumpDiscoveryRevision(key);
    }
    for (const key of capabilityKeys) {
      if (!capabilityMatches(key)) continue;
      this.discoveredCapabilityModelsCache.delete(key);
      this.discoveredCapabilityModelsUpdatedAt.delete(key);
      this.capabilityDiscoveryAttemptedAt.delete(key);
      this.inflightCapabilityDiscovery.delete(key);
      this.bumpCapabilityDiscoveryRevision(key);
    }
  }

  private ensureLegacyActivationMigration(): Promise<void> {
    if (this.sharedPluginDefinitions) return Promise.resolve();
    this.legacyActivationMigration ??=
      pluginActivationService.migrateLegacyStatus(
        [...this.pluginReadDirs]
          .reverse()
          .filter(
            pluginsDir =>
              path.resolve(pluginsDir) !== path.resolve(this.bundledPluginsDir)
          ),
        pluginId => this.canMigrateLegacyActivation(pluginId)
      );
    return this.legacyActivationMigration;
  }

  /**
   * Team replicas must never pick a provider definition from node-local disk.
   * Refuse startup when an old writable definition is present so an operator
   * has to migrate it deliberately instead of getting replica-dependent
   * routing, credentials, or activation state.
   */
  private assertNoLocalCustomDefinitions(): void {
    const bundledDirectory = path.resolve(this.bundledPluginsDir);
    const directories = new Set([
      this.pluginsDir,
      ...this.legacyPluginsDirs,
      ...this.historicalPluginConflictDirs,
    ]);
    for (const directory of directories) {
      if (path.resolve(directory) === bundledDirectory) continue;
      let entries: fs.Dirent[];
      try {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error(
            `Plugin definition path ${directory} is not a physical directory`
          );
        }
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (entries.some(entry => entry.name.endsWith('.json'))) {
        throw new Error(
          `Local custom plugin definitions exist at ${directory}. PostgreSQL mode requires definitions in the shared database; run the SQLite-to-PostgreSQL migration with the plugin directory before starting any replica.`
        );
      }
    }
  }

  private parseSharedPluginDefinition(
    row: StoredPluginDefinition
  ): Plugin | null {
    this.sharedDefinitionIds.add(row.plugin_id);
    if (row.approved_by_user_id === null || row.approved_at === null) {
      return null;
    }
    try {
      const plugin = JSON.parse(row.definition_json) as Plugin;
      if (
        !this.validatePlugin(plugin) ||
        plugin.id !== row.plugin_id ||
        getPluginDefinitionFingerprint(plugin) !== row.definition_fingerprint
      ) {
        return null;
      }
      return applyPluginDefinitionPolicy(plugin);
    } catch {
      return null;
    }
  }

  private discoveredModelsCacheKey(pluginId: string, userId: string): string {
    return `${userId}:${pluginId}`;
  }

  private discoveredCapabilityModelsCacheKey(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId: string
  ): string {
    return `${userId}:${pluginId}:${capability}`;
  }

  private async getDiscoveredCapabilityModels(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId?: string
  ): Promise<string[] | undefined> {
    await this.ensureCacheInvalidation();
    const effectiveUserId = userId || 'default';
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      effectiveUserId
    );
    if (
      !this.sharedPluginDefinitions &&
      this.discoveredCapabilityModelsCache.has(cacheKey)
    ) {
      return this.discoveredCapabilityModelsCache.get(cacheKey) || undefined;
    }

    try {
      const row = await this.repositories().pluginDiscovery.getCapability(
        pluginId,
        capability,
        effectiveUserId
      );
      if (!row) {
        this.discoveredCapabilityModelsCache.set(cacheKey, null);
        return undefined;
      }

      const parsed = JSON.parse(row.models_json) as unknown;
      const models = Array.isArray(parsed)
        ? Array.from(
            new Set(
              parsed.filter(
                (model): model is string =>
                  typeof model === 'string' && model.length > 0
              )
            )
          )
        : [];
      if (models.length === 0) {
        this.discoveredCapabilityModelsCache.set(cacheKey, null);
        return undefined;
      }
      this.discoveredCapabilityModelsCache.set(cacheKey, models);
      this.discoveredCapabilityModelsUpdatedAt.set(cacheKey, row.updated_at);
      return models;
    } catch (error) {
      logger.warn(
        'Failed to read discovered %s models for plugin %s:',
        capability,
        pluginId,
        error
      );
      this.discoveredCapabilityModelsCache.set(cacheKey, null);
      return undefined;
    }
  }

  private async storeDiscoveredCapabilityModels(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    models: string[],
    userId?: string
  ): Promise<void> {
    await this.ensureCacheInvalidation();
    const effectiveUserId = userId || 'default';
    const uniqueModels = Array.from(new Set(models));
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      effectiveUserId
    );
    const discoveredAt = Date.now();
    await this.repositories().pluginDiscovery.upsertCapability({
      user_id: effectiveUserId,
      plugin_id: pluginId,
      capability,
      models_json: JSON.stringify(uniqueModels),
      updated_at: discoveredAt,
    });
    this.discoveredCapabilityModelsCache.set(cacheKey, uniqueModels);
    this.discoveredCapabilityModelsUpdatedAt.set(cacheKey, discoveredAt);
    await publishPluginCacheInvalidation({
      version: 1,
      scope: 'plugin-user',
      pluginId,
      userId: effectiveUserId,
    });
  }

  private async getDiscoveredModels(
    pluginId: string,
    userId?: string
  ): Promise<string[] | undefined> {
    await this.ensureCacheInvalidation();
    const effectiveUserId = userId || 'default';
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    if (
      !this.sharedPluginDefinitions &&
      this.discoveredModelsCache.has(cacheKey)
    ) {
      return this.discoveredModelsCache.get(cacheKey) || undefined;
    }

    try {
      const row = await this.repositories().pluginDiscovery.get(
        pluginId,
        effectiveUserId
      );
      if (!row) {
        this.discoveredModelsCache.set(cacheKey, null);
        this.discoveredModelContextCache.set(cacheKey, null);
        return undefined;
      }

      const { models, modelContext, legacy } = parseDiscoveredCatalog(
        row.models_json
      );
      this.discoveredCatalogIsLegacy.set(cacheKey, legacy === true);
      if (models.length === 0) {
        this.discoveredModelsCache.set(cacheKey, null);
        this.discoveredModelContextCache.set(cacheKey, null);
        return undefined;
      }
      this.discoveredModelsCache.set(cacheKey, models);
      this.discoveredModelContextCache.set(cacheKey, modelContext ?? null);
      if (typeof row.updated_at === 'number') {
        this.discoveredModelsUpdatedAt.set(cacheKey, row.updated_at);
      }
      return models;
    } catch (error) {
      logger.warn(
        'Failed to read discovered models for plugin %s:',
        pluginId,
        error
      );
      this.discoveredModelsCache.set(cacheKey, null);
      this.discoveredModelContextCache.set(cacheKey, null);
      return undefined;
    }
  }

  private async storeDiscoveredModels(
    pluginId: string,
    models: string[],
    userId?: string,
    modelContext?: PluginModelContextMap
  ): Promise<void> {
    await this.ensureCacheInvalidation();
    const effectiveUserId = userId || 'default';
    const uniqueModels = Array.from(new Set(models));
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    const discoveredAt = Date.now();
    try {
      await this.repositories().pluginDiscovery.upsert({
        user_id: effectiveUserId,
        plugin_id: pluginId,
        models_json: serializeDiscoveredCatalog({
          models: uniqueModels,
          modelContext,
        }),
        updated_at: discoveredAt,
      });
      this.discoveredModelsCache.set(cacheKey, uniqueModels);
      this.discoveredModelContextCache.set(cacheKey, modelContext ?? null);
      this.discoveredCatalogIsLegacy.set(cacheKey, false);
      this.discoveredModelsUpdatedAt.set(cacheKey, discoveredAt);
      await publishPluginCacheInvalidation({
        version: 1,
        scope: 'plugin-user',
        pluginId,
        userId: effectiveUserId,
      });
    } catch (error) {
      logger.warn(
        'Failed to persist discovered models for plugin %s:',
        pluginId,
        error
      );
    }
  }

  async clearDiscoveredModels(
    pluginId: string,
    userId?: string
  ): Promise<void> {
    await this.ensureCacheInvalidation();
    await this.clearDiscoveredCapabilityModels(pluginId, userId);
    if (userId) {
      const cacheKey = this.discoveredModelsCacheKey(pluginId, userId);
      this.discoveredModelsCache.set(cacheKey, null);
      this.discoveredModelsUpdatedAt.delete(cacheKey);
      this.discoveryAttemptedAt.delete(cacheKey);
      try {
        await this.repositories().pluginDiscovery.delete(pluginId, userId);
      } catch (error) {
        logger.warn(
          'Failed to clear discovered models for plugin %s:',
          pluginId,
          error
        );
      }
      await publishPluginCacheInvalidation({
        version: 1,
        scope: 'plugin-user',
        pluginId,
        userId,
      });
      return;
    }

    for (const key of this.discoveredModelsCache.keys()) {
      if (key.endsWith(`:${pluginId}`)) {
        this.discoveredModelsCache.delete(key);
        this.discoveredModelsUpdatedAt.delete(key);
        this.discoveryAttemptedAt.delete(key);
      }
    }
    try {
      await this.repositories().pluginDiscovery.delete(pluginId);
    } catch (error) {
      logger.warn(
        'Failed to clear discovered models for plugin %s:',
        pluginId,
        error
      );
    }
    await publishPluginCacheInvalidation({
      version: 1,
      scope: 'plugin',
      pluginId,
    });
  }

  private async clearDiscoveredCapabilityModels(
    pluginId: string,
    userId?: string
  ): Promise<void> {
    if (userId) {
      for (const capability of [
        'image',
        'stt',
        'tts',
        'audio',
        'video',
      ] as const) {
        const key = this.discoveredCapabilityModelsCacheKey(
          pluginId,
          capability,
          userId
        );
        this.discoveredCapabilityModelsCache.delete(key);
        this.discoveredCapabilityModelsUpdatedAt.delete(key);
        this.capabilityDiscoveryAttemptedAt.delete(key);
      }
      // The discovery repository removes both completion and capability rows
      // atomically, which prevents stale partial catalogs after reset.
      await this.repositories().pluginDiscovery.delete(pluginId, userId);
      return;
    }

    for (const key of this.discoveredCapabilityModelsCache.keys()) {
      if (
        (['image', 'stt', 'tts', 'audio', 'video'] as const).some(capability =>
          key.endsWith(`:${pluginId}:${capability}`)
        )
      ) {
        this.discoveredCapabilityModelsCache.delete(key);
        this.discoveredCapabilityModelsUpdatedAt.delete(key);
        this.capabilityDiscoveryAttemptedAt.delete(key);
      }
    }
    await this.repositories().pluginDiscovery.delete(pluginId);
  }

  private async applyDiscoveredModels(
    plugin: Plugin,
    userId?: string
  ): Promise<Plugin> {
    if (
      !(await this.canUseStoredConnectionOverrides(userId)) &&
      (await pluginVariablesService.hasStoredConnectionOverride(
        plugin.id,
        userId,
        plugin.variables,
        getPluginConnectionVariableNames(plugin)
      ))
    ) {
      return plugin;
    }
    const models = await this.getDiscoveredModels(plugin.id, userId);
    const capabilities = plugin.capabilities
      ? { ...plugin.capabilities }
      : undefined;
    if (capabilities) {
      for (const capability of [
        'image',
        'stt',
        'tts',
        'audio',
        'video',
      ] as const) {
        const definition = capabilities[capability];
        const discovered = await this.getDiscoveredCapabilityModels(
          plugin.id,
          capability,
          userId
        );
        if (definition && discovered) {
          capabilities[capability] = {
            ...definition,
            model_map: [...discovered],
          };
        }
      }
    }
    // Context windows travel with the catalog they were discovered from, so a
    // model list and the budget each model runs against cannot disagree.
    const modelContext = this.discoveredModelContextCache.get(
      this.discoveredModelsCacheKey(plugin.id, userId || 'default')
    );

    return {
      ...plugin,
      ...(models ? { model_map: [...models] } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(modelContext ? { model_context: { ...modelContext } } : {}),
    };
  }

  private ensurePluginsDirectory(): void {
    const dataDirectory = resolveDataDirectory();
    const configuredRelativeToData = path.relative(
      dataDirectory,
      this.pluginsDir
    );
    const configuredPathRoot =
      configuredRelativeToData === '' ||
      (configuredRelativeToData !== '..' &&
        !configuredRelativeToData.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(configuredRelativeToData))
        ? dataDirectory
        : process.env.PLUGINS_DIR?.trim() &&
            !path.isAbsolute(process.env.PLUGINS_DIR.trim())
          ? PROJECT_DIRECTORY
          : path.dirname(this.pluginsDir);
    try {
      if (
        hasSymlinkPathComponentFromRoot(configuredPathRoot, this.pluginsDir)
      ) {
        throw new Error(
          'PLUGINS_DIR cannot contain a symbolic-link path component'
        );
      }
      const pluginsStat = fs.lstatSync(this.pluginsDir);
      if (!pluginsStat.isDirectory() || pluginsStat.isSymbolicLink()) {
        throw new Error(
          'PLUGINS_DIR must be a physical directory, not a symlink or special file'
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      fs.mkdirSync(this.pluginsDir, { recursive: true });
      const createdStat = fs.lstatSync(this.pluginsDir);
      if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
        throw new Error('PLUGINS_DIR could not be created safely');
      }
    }
    for (const legacyDirectory of this.legacyPluginsDirs) {
      const relativeToBackend = path.relative(
        BACKEND_DIRECTORY,
        legacyDirectory
      );
      const legacyRoot =
        relativeToBackend === '' ||
        (relativeToBackend !== '..' &&
          !relativeToBackend.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relativeToBackend))
          ? BACKEND_DIRECTORY
          : path.dirname(legacyDirectory);
      if (hasSymlinkPathComponentFromRoot(legacyRoot, legacyDirectory)) {
        throw new Error(
          'A legacy plugin path contains a symbolic-link component; refusing to follow it'
        );
      }
      const legacyStat = (() => {
        try {
          return fs.lstatSync(legacyDirectory);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        }
      })();
      if (
        legacyStat &&
        (!legacyStat.isDirectory() || legacyStat.isSymbolicLink())
      ) {
        throw new Error(
          'A legacy plugin path is not a physical directory; refusing to follow it'
        );
      }
    }
    for (const historicalDirectory of this.historicalPluginConflictDirs) {
      let historicalEntries: fs.Dirent[];
      try {
        historicalEntries = fs.readdirSync(historicalDirectory, {
          withFileTypes: true,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw new Error(
          `Historical plugin directory ${historicalDirectory} cannot be inspected safely`
        );
      }
      if (historicalEntries.some(entry => entry.name.endsWith('.json'))) {
        throw new Error(
          `Legacy plugin definitions exist at ${historicalDirectory}, where the relative PLUGINS_DIR previously resolved from the caller working directory. Move them into ${this.pluginsDir} or configure an absolute PLUGINS_DIR; Libre will not silently choose between them.`
        );
      }
    }
  }

  private bundledPluginPath(id: string): string {
    return path.resolve(this.bundledPluginsDir, `${sanitize(id)}.json`);
  }

  private isAnchoredBundledDefinition(
    plugin: Plugin,
    filePath: string
  ): boolean {
    return (
      path.resolve(filePath) === this.bundledPluginPath(plugin.id) &&
      matchesBundledPluginTrustAnchor(plugin)
    );
  }

  private async isPluginDefinitionApproved(
    plugin: Plugin,
    filePath: string
  ): Promise<boolean> {
    if (this.isAnchoredBundledDefinition(plugin, filePath)) {
      return true;
    }

    try {
      const row = await this.repositories().pluginApprovals.find(plugin.id);
      return (
        row?.definition_fingerprint ===
          getPluginDefinitionFingerprint(plugin) &&
        row.source_path === path.resolve(filePath)
      );
    } catch (error) {
      logger.warn(
        'Failed to inspect definition approval for plugin %s:',
        plugin.id,
        error
      );
      return false;
    }
  }

  private async approvePluginDefinition(
    plugin: Plugin,
    filePath: string,
    userId: string
  ): Promise<void> {
    if (!(await this.canUseStoredConnectionOverrides(userId))) {
      throw new Error('Administrator approval is required');
    }
    await this.repositories().pluginApprovals.upsert({
      plugin_id: plugin.id,
      definition_fingerprint: getPluginDefinitionFingerprint(plugin),
      source_path: path.resolve(filePath),
      approved_by_user_id: userId,
      approved_at: Date.now(),
    });
  }

  private async removePluginDefinitionApproval(
    pluginId: string
  ): Promise<void> {
    await this.repositories().pluginApprovals.delete(pluginId);
  }

  private async revokePluginDefinitionConsent(pluginId: string): Promise<void> {
    await this.repositories().pluginApprovals.revokeConsent(pluginId);
  }

  private canMigrateLegacyActivation(pluginId: string): boolean {
    const effectivePath = this.resolveEffectivePluginFilePath(pluginId);
    if (!effectivePath) return false;
    try {
      const parsedPlugin = JSON.parse(
        readRegularPluginDefinition(effectivePath)
      ) as Plugin;
      return (
        this.validatePlugin(parsedPlugin) &&
        parsedPlugin.id === pluginId &&
        this.isAnchoredBundledDefinition(parsedPlugin, effectivePath)
      );
    } catch {
      return false;
    }
  }

  private resolveEffectivePluginFilePath(id: string): string | null {
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) return null;

    for (const pluginsDir of [...this.pluginReadDirs].reverse()) {
      const resolvedDirectory = path.resolve(pluginsDir);
      const candidate = path.resolve(pluginsDir, `${sanitizedId}.json`);
      if (!candidate.startsWith(resolvedDirectory)) continue;
      const directoryStat = (() => {
        try {
          return fs.lstatSync(pluginsDir);
        } catch {
          return null;
        }
      })();
      if (
        directoryStat &&
        (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
      ) {
        // Preserve precedence while forcing the no-follow reader to reject the
        // unsafe path instead of falling back to a lower-priority definition.
        return candidate;
      }
      try {
        fs.lstatSync(candidate);
        // Return invalid named entries too. The strict reader will reject them,
        // preventing a symlink/special-file shadow from revealing a bundled ID.
        return candidate;
      } catch {
        // Continue to lower-priority sources only when the named entry is absent.
      }
    }

    return null;
  }

  private getBundledRoutingProjection(id: string): string | null {
    if (this.bundledRoutingProjectionCache.has(id)) {
      return this.bundledRoutingProjectionCache.get(id) ?? null;
    }

    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) return null;
    const bundledDirectory = path.resolve(this.bundledPluginsDir);
    const bundledPath = this.bundledPluginPath(sanitizedId);
    if (
      !bundledPath.startsWith(bundledDirectory) ||
      !fs.existsSync(bundledPath)
    ) {
      this.bundledRoutingProjectionCache.set(id, null);
      return null;
    }

    try {
      const parsedPlugin = JSON.parse(
        readRegularPluginDefinition(bundledPath)
      ) as Plugin;
      if (
        !this.validatePlugin(parsedPlugin) ||
        parsedPlugin.id !== sanitizedId ||
        !matchesBundledPluginTrustAnchor(parsedPlugin)
      ) {
        this.bundledRoutingProjectionCache.set(id, null);
        return null;
      }
      const projection = getPluginRoutingAuthProjection(
        applyPluginDefinitionPolicy(parsedPlugin)
      );
      this.bundledRoutingProjectionCache.set(id, projection);
      return projection;
    } catch (error) {
      logger.warn(
        'Failed to inspect bundled routing for plugin %s:',
        id,
        error
      );
      this.bundledRoutingProjectionCache.set(id, null);
      return null;
    }
  }

  private usesTrustedBundledRouting(plugin: Plugin): boolean {
    if (
      this.sharedPluginDefinitions &&
      this.sharedDefinitionIds.has(plugin.id)
    ) {
      return false;
    }
    const effectivePath = this.resolveEffectivePluginFilePath(plugin.id);
    const bundledPath = this.bundledPluginPath(plugin.id);
    if (!effectivePath || effectivePath !== bundledPath) return false;

    const bundledProjection = this.getBundledRoutingProjection(plugin.id);
    return (
      bundledProjection !== null &&
      getPluginRoutingAuthProjection(plugin) === bundledProjection
    );
  }

  private async isPluginActive(
    pluginId: string,
    userId?: string
  ): Promise<boolean> {
    return (await pluginActivationService.getActivePluginIds(userId)).has(
      pluginId
    );
  }

  private async canUseStoredConnectionOverrides(
    userId?: string
  ): Promise<boolean> {
    try {
      return (
        (await userModel.getUserById(userId || 'default'))?.role === 'admin'
      );
    } catch (error) {
      logger.warn('Failed to resolve plugin routing permission:', error);
      return false;
    }
  }

  /**
   * Get API key for a plugin from database (per-user) or environment variable (fallback)
   * @param plugin The plugin to get the API key for
   * @param userId Optional user ID for per-user credentials
   * @returns The API key or null if not found
   */
  async getApiKey(plugin: Plugin, userId?: string): Promise<string | null> {
    if (plugin.id === CODEX_OAUTH_PLUGIN_ID) {
      // Resolved from the server's Codex CLI sign-in, never user credentials.
      // A writable same-ID definition must never receive the server user's
      // OAuth bearer token, even when an administrator approved that file.
      return this.usesTrustedBundledRouting(plugin) &&
        matchesBundledPluginTrustAnchor(plugin)
        ? codexOAuthService.getCachedAccessToken()
        : null;
    }
    const hasHonoredConnectionOverride =
      (await this.canUseStoredConnectionOverrides(userId)) &&
      (await pluginVariablesService.hasStoredConnectionOverride(
        plugin.id,
        userId,
        plugin.variables,
        getPluginConnectionVariableNames(plugin)
      ));
    const usesTrustedBundledRouting = this.usesTrustedBundledRouting(plugin);
    const allowTrustedFallback =
      usesTrustedBundledRouting && !hasHonoredConnectionOverride;
    return pluginCredentialsService.getApiKey(
      plugin.id,
      plugin.auth.key_env,
      userId,
      {
        allowEnvironmentFallback: allowTrustedFallback,
        expectedRoutingAuthFingerprint:
          await this.getCredentialRoutingAuthFingerprint(plugin, userId),
        allowLegacyUnboundCredential: allowTrustedFallback,
      }
    );
  }

  /**
   * Bind a user credential to the exact routing/authentication contract in
   * effect when they save it. Generation controls are intentionally excluded.
   */
  async getCredentialRoutingAuthFingerprint(
    plugin: Plugin,
    userId?: string
  ): Promise<string> {
    const variables = await this.getPluginVariables(plugin, userId);
    const effectiveConnectionValues = Array.from(
      getPluginConnectionVariableNames(plugin),
      name => {
        const definition = plugin.variables?.find(
          candidate => candidate.name === name
        );
        if (!definition) return null;
        return {
          name,
          value: variables[name] ?? definition.default ?? '',
        };
      }
    );
    const sharedDefinition = this.sharedPluginDefinitions
      ? await this.repositories().pluginDefinitions.find(plugin.id)
      : null;
    if (sharedDefinition) this.sharedDefinitionIds.add(plugin.id);
    const effectivePath = sharedDefinition
      ? null
      : this.resolveEffectivePluginFilePath(plugin.id);
    let effectiveDefinitionFingerprint = getPluginDefinitionFingerprint(plugin);
    if (effectivePath) {
      try {
        const effectiveDefinition = JSON.parse(
          readRegularPluginDefinition(effectivePath)
        ) as Plugin;
        if (
          this.validatePlugin(effectiveDefinition) &&
          effectiveDefinition.id === plugin.id
        ) {
          effectiveDefinitionFingerprint =
            getPluginDefinitionFingerprint(effectiveDefinition);
        }
      } catch {
        // Keep the in-memory fingerprint. A missing/invalid source is already
        // excluded from normal plugin loading and cannot gain trust here.
      }
    }
    const fingerprintInput = JSON.stringify({
      plugin_id: plugin.id,
      plugin_type: plugin.type,
      trusted_bundled_source: this.usesTrustedBundledRouting(plugin),
      effective_source_path: sharedDefinition
        ? 'database:plugin_definitions'
        : effectivePath
          ? path.resolve(effectivePath)
          : null,
      effective_definition_fingerprint: effectiveDefinitionFingerprint,
      routing_auth_projection: getPluginRoutingAuthProjection(plugin),
      effective_connection_values: effectiveConnectionValues,
    });
    return createHash('sha256').update(fingerprintInput).digest('hex');
  }

  /**
   * Get resolved variable values for a plugin (decrypted, typed).
   */
  async getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): Promise<Record<string, string | number | boolean>> {
    if (!plugin.variables || plugin.variables.length === 0) {
      return {};
    }
    const variables = await pluginVariablesService.getResolvedVariables(
      plugin.id,
      plugin.variables,
      userId
    );
    if (await this.canUseStoredConnectionOverrides(userId)) return variables;

    return Object.fromEntries(
      Object.entries(variables).map(([name, value]) => {
        if (!getPluginConnectionVariableNames(plugin).has(name)) {
          return [name, value];
        }
        const definition = plugin.variables?.find(
          candidate => candidate.name === name
        );
        return [name, definition?.default ?? ''];
      })
    );
  }

  /**
   * Validate an endpoint override as an absolute HTTP or HTTPS URL.
   * Returns the URL string if valid and throws for an invalid explicit value.
   */
  private validateEndpointUrl(endpoint: string): string {
    return resolvePluginEndpoint('', endpoint);
  }

  /**
   * Resolve and validate routing before credential lookup. The credential
   * service's custom-route policy is integrated separately; keeping this
   * boundary ordered prevents a rejected override from ever selecting an
   * environment credential.
   */
  private async resolveOperationEndpoint(
    plugin: Plugin,
    userId?: string
  ): Promise<string> {
    return resolvePluginApiConfig(
      plugin,
      await this.getPluginVariables(plugin, userId)
    ).endpoint;
  }

  /**
   * Attempt to auto-discover available models from a plugin's full API endpoint.
   * Resolves the provider's model-list endpoint and updates the plugin's model_map.
   * Falls back to the existing model_map if the endpoint is unavailable; callers
   * that need to tell a real update from a fallback use discoverModelsResult.
   */
  async discoverModels(pluginId: string, userId?: string): Promise<string[]> {
    const { models } = await this.discoverModelsResult(pluginId, userId);
    return models;
  }

  /**
   * Model discovery with the outcome attached, so a caller can report whether
   * the provider was actually reached instead of assuming the returned catalog
   * is fresh.
   */
  async discoverModelsResult(
    pluginId: string,
    userId?: string
  ): Promise<PluginModelDiscoveryResult> {
    await this.ensureCacheInvalidation();
    const cacheKey = this.discoveredModelsCacheKey(
      pluginId,
      userId || 'default'
    );
    const inflight = this.inflightDiscovery.get(cacheKey);
    if (inflight) return inflight;

    const revision = this.discoveryCacheRevisions.get(cacheKey) ?? 0;
    const attempt = this.runModelDiscovery(pluginId, userId, revision).finally(
      () => {
        if (this.inflightDiscovery.get(cacheKey) === attempt) {
          this.inflightDiscovery.delete(cacheKey);
        }
      }
    );
    this.inflightDiscovery.set(cacheKey, attempt);
    return attempt;
  }

  /**
   * Whether a plugin's catalog should be re-fetched. Missing catalogs are due
   * immediately; stored ones age out after the TTL. Both cases are gated by a
   * per-plugin backoff so a failing provider is not probed on every request.
   */
  private async isModelDiscoveryDue(
    pluginId: string,
    userId?: string
  ): Promise<boolean> {
    const cacheKey = this.discoveredModelsCacheKey(
      pluginId,
      userId || 'default'
    );
    const attemptedAt = this.discoveryAttemptedAt.get(cacheKey);
    if (attemptedAt && Date.now() - attemptedAt < modelDiscoveryRetryMs()) {
      return false;
    }

    const models = await this.getDiscoveredModels(pluginId, userId);
    const updatedAt = this.discoveredModelsUpdatedAt.get(cacheKey);
    if (!models || !updatedAt) return true;

    // A catalog stored before context windows were captured has none of them.
    // Waiting out the whole refresh interval would leave every provider model
    // without a window for hours after an upgrade, so it is refreshed once.
    if (this.discoveredCatalogIsLegacy.get(cacheKey)) return true;

    return Date.now() - updatedAt >= modelDiscoveryTtlMs();
  }

  /**
   * Re-discover models for every active completion plugin whose catalog is
   * missing or stale. Bounded by a deadline so a slow provider cannot stall the
   * plugin-list response; refreshes that outrun it still persist and surface on
   * the next request.
   */
  async refreshStaleModels(userId?: string): Promise<void> {
    const due: Plugin[] = [];
    for (const plugin of await this.getActivePlugins(userId)) {
      if (
        (plugin.type === 'completion' || plugin.type === 'chat') &&
        (await this.isModelDiscoveryDue(plugin.id, userId))
      ) {
        due.push(plugin);
      }
    }
    if (due.length === 0) return;

    const refreshes = Promise.all(
      due.map(plugin =>
        this.discoverModels(plugin.id, userId).catch(() => [] as string[])
      )
    );

    await Promise.race([
      refreshes,
      new Promise(resolve =>
        setTimeout(resolve, modelDiscoveryRefreshDeadlineMs()).unref?.()
      ),
    ]);
  }

  async discoverCapabilityModels(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId?: string
  ): Promise<PluginModelDiscoveryResult> {
    await this.ensureCacheInvalidation();
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      userId || 'default'
    );
    const inflight = this.inflightCapabilityDiscovery.get(cacheKey);
    if (inflight) return inflight;

    const revision = this.capabilityDiscoveryCacheRevisions.get(cacheKey) ?? 0;
    const attempt = this.runCapabilityModelDiscovery(
      pluginId,
      capability,
      userId,
      revision
    ).finally(() => {
      if (this.inflightCapabilityDiscovery.get(cacheKey) === attempt) {
        this.inflightCapabilityDiscovery.delete(cacheKey);
      }
    });
    this.inflightCapabilityDiscovery.set(cacheKey, attempt);
    return attempt;
  }

  private async isCapabilityModelDiscoveryDue(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId?: string
  ): Promise<boolean> {
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      userId || 'default'
    );
    const attemptedAt = this.capabilityDiscoveryAttemptedAt.get(cacheKey);
    if (attemptedAt && Date.now() - attemptedAt < modelDiscoveryRetryMs()) {
      return false;
    }
    const models = await this.getDiscoveredCapabilityModels(
      pluginId,
      capability,
      userId
    );
    const updatedAt = this.discoveredCapabilityModelsUpdatedAt.get(cacheKey);
    return (
      !models || !updatedAt || Date.now() - updatedAt >= modelDiscoveryTtlMs()
    );
  }

  async refreshStaleCapabilityModels(
    capability: DiscoverableMediaCapability,
    userId?: string
  ): Promise<void> {
    const due: Plugin[] = [];
    for (const plugin of await this.getActivePlugins(userId)) {
      const definition = plugin.capabilities?.[capability];
      if (
        Boolean(definition?.models_endpoint) &&
        (await this.isCapabilityModelDiscoveryDue(
          plugin.id,
          capability,
          userId
        ))
      ) {
        due.push(plugin);
      }
    }
    if (due.length === 0) return;

    const refreshes = Promise.all(
      due.map(plugin =>
        this.discoverCapabilityModels(plugin.id, capability, userId).catch(
          () => undefined
        )
      )
    );
    await Promise.race([
      refreshes,
      new Promise(resolve =>
        setTimeout(resolve, modelDiscoveryRefreshDeadlineMs()).unref?.()
      ),
    ]);
  }

  private async runCapabilityModelDiscovery(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId: string | undefined,
    expectedRevision: number
  ): Promise<PluginModelDiscoveryResult> {
    const plugin = await this.getPlugin(pluginId, userId);
    const definition = plugin?.capabilities?.[capability];
    if (!plugin || !definition) {
      return {
        models: [],
        outcome: 'unavailable',
        reason: `Plugin has no ${capability} capability`,
      };
    }
    if (!definition.models_endpoint) {
      return { models: definition.model_map, outcome: 'unchanged' };
    }

    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      userId || 'default'
    );
    this.capabilityDiscoveryAttemptedAt.set(cacheKey, Date.now());
    const config =
      definition.config && typeof definition.config === 'object'
        ? (definition.config as Record<string, unknown>)
        : {};
    const modelsEndpointVariable = config.models_endpoint_variable;
    const pluginVariables = await this.getPluginVariables(plugin, userId);
    const modelsEndpointOverride =
      typeof modelsEndpointVariable === 'string'
        ? pluginVariables[modelsEndpointVariable]
        : undefined;
    const modelsEndpoint =
      typeof modelsEndpointOverride === 'string' &&
      modelsEndpointOverride.trim().length > 0
        ? this.validateEndpointUrl(modelsEndpointOverride.trim())
        : definition.models_endpoint;
    assertSafePluginEndpoint(
      modelsEndpoint,
      `${capability} model discovery endpoint`
    );

    const apiKey = await this.getApiKey(plugin, userId);
    if (pluginRequiresApiKey(plugin) && !apiKey) {
      return {
        models: definition.model_map,
        outcome: 'missing_credentials',
        reason: this.describeMissingCredential(plugin),
      };
    }

    try {
      const response = await axios.get(modelsEndpoint, {
        headers: buildPluginModelDiscoveryHeaders(
          plugin,
          apiKey,
          modelsEndpoint
        ),
        timeout: MODEL_DISCOVERY_REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
      });
      const data = response.data?.data;
      const models = Array.isArray(data)
        ? Array.from(
            new Set(
              data
                .map((entry: { id?: unknown }) => entry?.id)
                .filter(
                  (id: unknown): id is string =>
                    typeof id === 'string' && id.length > 0
                )
            )
          )
        : [];
      if (models.length === 0) {
        return {
          models: definition.model_map,
          outcome: 'unavailable',
          reason: 'The provider returned no models',
        };
      }

      const previous = definition.model_map;
      if (
        (this.capabilityDiscoveryCacheRevisions.get(cacheKey) ?? 0) !==
        expectedRevision
      ) {
        return {
          models: previous,
          outcome: 'unavailable',
          reason: 'Provider configuration changed during discovery',
        };
      }
      await this.storeDiscoveredCapabilityModels(
        pluginId,
        capability,
        models,
        userId
      );
      return {
        models,
        outcome:
          JSON.stringify(previous) === JSON.stringify(models)
            ? 'unchanged'
            : 'updated',
      };
    } catch (error) {
      const reason = describeModelDiscoveryFailure(error);
      logger.debug(
        '[Plugin] %s model discovery unavailable for %s (%s)',
        capability,
        pluginId,
        reason
      );
      return { models: definition.model_map, outcome: 'unavailable', reason };
    }
  }

  /**
   * Say why no key was usable. An environment key is deliberately ignored for a
   * provider whose definition was installed into the writable plugins directory,
   * because that file can be edited to point the credential somewhere else — a
   * silent "no API key" hides that distinction from whoever set the variable.
   */
  private describeMissingCredential(plugin: Plugin): string {
    const keyEnv = plugin.auth.key_env;
    if (
      keyEnv &&
      process.env[keyEnv] &&
      !this.usesTrustedBundledRouting(plugin)
    ) {
      return `${keyEnv} is set but is not used for this provider because it runs an installed definition instead of the bundled one. Save the key in the provider's settings, or remove the installed copy to fall back to the bundled provider.`;
    }

    return 'No API key is configured for this provider.';
  }

  private async runModelDiscovery(
    pluginId: string,
    userId: string | undefined,
    expectedRevision: number
  ): Promise<PluginModelDiscoveryResult> {
    const plugin = await this.getPlugin(pluginId, userId);
    if (!plugin) {
      return { models: [], outcome: 'unavailable', reason: 'Plugin not found' };
    }

    this.discoveryAttemptedAt.set(
      this.discoveredModelsCacheKey(pluginId, userId || 'default'),
      Date.now()
    );

    const pluginVars = await this.getPluginVariables(plugin, userId);
    const { endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      plugin,
      pluginVars
    );
    const modelsEndpoint = resolvePluginModelsEndpoint(
      effectiveEndpoint,
      typeof pluginVars.models_endpoint === 'string'
        ? pluginVars.models_endpoint
        : undefined
    );
    assertSafePluginEndpoint(modelsEndpoint, 'model discovery endpoint');

    const apiKey = await this.getApiKey(plugin, userId);
    if (pluginRequiresApiKey(plugin) && !apiKey) {
      logger.debug(
        '[Plugin] Model discovery for %s has no usable API key; keeping the existing catalog',
        pluginId
      );
      return {
        models: plugin.model_map,
        outcome: 'missing_credentials',
        reason: this.describeMissingCredential(plugin),
      };
    }
    const headers = buildPluginModelDiscoveryHeaders(
      plugin,
      apiKey,
      modelsEndpoint
    );

    try {
      const response = await axios.get(modelsEndpoint, {
        headers,
        timeout: MODEL_DISCOVERY_REQUEST_TIMEOUT_MS,
        maxRedirects: 0,
      });

      if (response.data?.data && Array.isArray(response.data.data)) {
        const models = response.data.data
          .map((m: { id?: string }) => m.id)
          .filter((id: unknown): id is string => typeof id === 'string');
        // Providers that publish a context window are worth remembering: it is
        // the only way the application can say how full a conversation is.
        const modelContext = readModelContextMap(response.data.data);

        if (models.length > 0) {
          logger.debug(
            '[Plugin] Auto-discovered %d models for %s:',
            models.length,
            pluginId,
            models
          );

          const previousModels = plugin.model_map;
          const cacheKey = this.discoveredModelsCacheKey(
            pluginId,
            userId || 'default'
          );
          if (
            (this.discoveryCacheRevisions.get(cacheKey) ?? 0) !==
            expectedRevision
          ) {
            return {
              models: previousModels,
              outcome: 'unavailable',
              reason: 'Provider configuration changed during discovery',
            };
          }
          await this.storeDiscoveredModels(
            pluginId,
            models,
            userId,
            modelContext
          );
          const stored =
            (await this.getDiscoveredModels(pluginId, userId)) || models;
          return {
            models: stored,
            outcome:
              JSON.stringify(stored) === JSON.stringify(previousModels)
                ? 'unchanged'
                : 'updated',
          };
        }
      }

      return {
        models: plugin.model_map,
        outcome: 'unavailable',
        reason: 'The provider returned no models',
      };
    } catch (error) {
      const reason = describeModelDiscoveryFailure(error);
      logger.debug(
        '[Plugin] Model discovery unavailable for %s (%s), using existing model_map',
        pluginId,
        reason
      );
      return { models: plugin.model_map, outcome: 'unavailable', reason };
    }
  }

  // List all installed plugins
  private async getAllPluginsUnchecked(userId?: string): Promise<Plugin[]> {
    await this.ensureLegacyActivationMigration();
    const plugins = new Map<string, Plugin>();
    const activePluginIds =
      await pluginActivationService.getActivePluginIds(userId);

    for (const pluginsDir of this.pluginReadDirs) {
      const directoryStat = (() => {
        try {
          return fs.lstatSync(pluginsDir);
        } catch {
          return null;
        }
      })();
      if (!directoryStat) {
        continue;
      }
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        plugins.clear();
        logger.error(
          'Ignoring unsafe plugin directory %s and every lower-priority definition',
          pluginsDir
        );
        continue;
      }

      try {
        const entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
        for (const entry of entries) {
          const file = entry.name;
          if (file.endsWith('.json') && !file.startsWith('.')) {
            const filenameId = path.basename(file, '.json');
            try {
              const filePath = path.join(pluginsDir, file);
              if (!entry.isFile() || entry.isSymbolicLink()) {
                plugins.delete(filenameId);
                logger.error(
                  'Ignoring non-regular plugin definition %s',
                  filePath
                );
                continue;
              }
              const content = readRegularPluginDefinition(filePath);
              const parsedPlugin: Plugin = JSON.parse(content);

              // Validate plugin structure
              if (
                this.validatePlugin(parsedPlugin) &&
                parsedPlugin.id === filenameId
              ) {
                if (
                  !(await this.isPluginDefinitionApproved(
                    parsedPlugin,
                    filePath
                  ))
                ) {
                  // A later writable definition shadows an earlier bundled
                  // definition even while quarantined.
                  plugins.delete(parsedPlugin.id);
                  continue;
                }
                const plugin = applyPluginDefinitionPolicy(parsedPlugin);
                plugin.active = activePluginIds.has(plugin.id);
                plugins.set(
                  plugin.id,
                  await this.applyDiscoveredModels(plugin, userId)
                );
              } else if (parsedPlugin.id !== filenameId) {
                plugins.delete(filenameId);
                logger.warn(
                  'Ignoring plugin %s because its declared ID does not match its filename',
                  file
                );
              } else {
                plugins.delete(filenameId);
              }
            } catch (error) {
              // Invalid JSON in an effective same-ID writable file must fail
              // closed instead of revealing an earlier bundled definition.
              plugins.delete(filenameId);
              logger.error(`Failed to load plugin ${file}:`, error);
            }
          }
        }
      } catch (error) {
        logger.error(`Failed to read plugins directory ${pluginsDir}:`, error);
      }
    }

    if (this.sharedPluginDefinitions) {
      const definitions = await this.repositories().pluginDefinitions.list();
      const currentDefinitionIds = new Set(
        definitions.map(definition => definition.plugin_id)
      );
      for (const pluginId of this.sharedDefinitionIds) {
        if (!currentDefinitionIds.has(pluginId)) {
          this.sharedDefinitionIds.delete(pluginId);
        }
      }
      for (const definition of definitions) {
        // The shared row has precedence over bundled release assets even when
        // corrupt or unapproved, preserving quarantine rather than silently
        // changing the provider route on another replica.
        plugins.delete(definition.plugin_id);
        const plugin = this.parseSharedPluginDefinition(definition);
        if (!plugin) {
          logger.error(
            'Ignoring invalid or unapproved shared plugin definition %s',
            definition.plugin_id
          );
          continue;
        }
        plugin.active = activePluginIds.has(plugin.id);
        plugins.set(
          plugin.id,
          await this.applyDiscoveredModels(plugin, userId)
        );
      }
    }

    return Array.from(plugins.values());
  }

  async getAllPlugins(userId?: string): Promise<Plugin[]> {
    const plugins = await this.getAllPluginsUnchecked(userId);
    const visible: Plugin[] = [];
    for (const plugin of plugins) {
      if (await this.isPluginVisibleToUser(plugin, userId)) {
        visible.push(plugin);
      }
    }
    return visible;
  }

  /**
   * The codex-oauth plugin rides the server user's ChatGPT sign-in, so it is
   * administrator-only and hidden entirely when no sign-in exists.
   */
  private async isPluginVisibleToUser(
    plugin: Pick<Plugin, 'id'>,
    userId?: string
  ): Promise<boolean> {
    if (plugin.id !== CODEX_OAUTH_PLUGIN_ID) return true;
    if (!codexOAuthService.isAvailable()) return false;
    if (!userId) return false;
    return (await userModel.getUserById(userId))?.role === 'admin';
  }

  // Get a specific plugin by ID
  private async loadPlugin(
    id: string,
    userId?: string
  ): Promise<Plugin | null> {
    await this.ensureLegacyActivationMigration();
    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Invalid plugin ID provided:', id);
      return null;
    }

    if (this.sharedPluginDefinitions) {
      const definition =
        await this.repositories().pluginDefinitions.find(sanitizedId);
      if (definition) {
        const plugin = this.parseSharedPluginDefinition(definition);
        if (!plugin) return null;
        plugin.active = await this.isPluginActive(plugin.id, userId);
        return this.applyDiscoveredModels(plugin, userId);
      }
      this.sharedDefinitionIds.delete(sanitizedId);
    }

    const filePath = this.resolveEffectivePluginFilePath(sanitizedId);
    if (!filePath) return null;

    try {
      const content = readRegularPluginDefinition(filePath);
      const parsedPlugin: Plugin = JSON.parse(content);

      if (
        this.validatePlugin(parsedPlugin) &&
        parsedPlugin.id === sanitizedId &&
        (await this.isPluginDefinitionApproved(parsedPlugin, filePath))
      ) {
        const plugin = applyPluginDefinitionPolicy(parsedPlugin);
        plugin.active = await this.isPluginActive(plugin.id, userId);
        return this.applyDiscoveredModels(plugin, userId);
      }
    } catch (error) {
      logger.error('Failed to load plugin %s:', sanitizedId, error);
    }

    return null;
  }

  private async getPluginUnchecked(
    id: string,
    userId?: string
  ): Promise<Plugin | null> {
    if (id === CODEX_OAUTH_PLUGIN_ID) return null;
    return this.loadPlugin(id, userId);
  }

  async getPlugin(id: string, userId?: string): Promise<Plugin | null> {
    const plugin = await this.loadPlugin(id, userId);
    if (!plugin || !(await this.isPluginVisibleToUser(plugin, userId))) {
      return null;
    }
    return plugin;
  }

  // Install or update a plugin
  async installPlugin(
    pluginData: Plugin,
    approvedByUserId: string
  ): Promise<Plugin> {
    if (!this.sharedPluginDefinitions) this.ensurePluginsDirectory();
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin structure');
    }
    if (pluginData.id === CODEX_OAUTH_PLUGIN_ID) {
      throw new Error('The bundled Codex OAuth plugin ID is reserved');
    }
    if (!(await this.canUseStoredConnectionOverrides(approvedByUserId))) {
      throw new Error('Administrator approval is required');
    }

    const now = Date.now();
    const plugin: Plugin = {
      ...pluginData,
      created_at: pluginData.created_at || now,
      updated_at: now,
      active: false,
    };

    const safeId = plugin.id.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (safeId !== plugin.id) throw new Error('Invalid plugin ID');
    if (this.sharedPluginDefinitions) {
      await this.repositories().pluginDefinitions.replaceApproved({
        plugin_id: plugin.id,
        definition_json: JSON.stringify(plugin, null, 2),
        definition_fingerprint: getPluginDefinitionFingerprint(plugin),
        approved_by_user_id: approvedByUserId,
        approved_at: now,
        created_at: plugin.created_at || now,
        updated_at: now,
      });
      this.sharedDefinitionIds.add(plugin.id);
      await this.clearDiscoveredModels(plugin.id);
      return plugin;
    }
    const filePath = path.resolve(this.pluginsDir, `${safeId}.json`);
    if (!filePath.startsWith(path.resolve(this.pluginsDir))) {
      throw new Error('Path traversal detected');
    }
    // Revoke definition approval and every user's activation before replacing
    // bytes on disk. Any crash or write failure therefore leaves the provider
    // quarantined and inactive.
    await this.revokePluginDefinitionConsent(plugin.id);
    await this.clearDiscoveredModels(plugin.id);
    const temporaryPath = path.resolve(
      this.pluginsDir,
      `.${safeId}.${process.pid}.${Date.now()}.tmp`
    );
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(plugin, null, 2), {
        flag: 'wx',
      });
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      if (fs.existsSync(temporaryPath)) {
        fs.unlinkSync(temporaryPath);
      }
      throw error;
    }
    await this.approvePluginDefinition(plugin, filePath, approvedByUserId);

    return plugin;
  }

  // Delete a plugin
  async deletePlugin(id: string): Promise<boolean> {
    // Validate the ID parameter using a strict pattern (allows dots for version numbers like 1.6b)
    const idPattern = /^[a-zA-Z0-9._-]+$/;
    if (!idPattern.test(id)) {
      logger.error('Invalid plugin ID format:', id);
      return false;
    }

    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Plugin ID failed sanitization:', id);
      return false;
    }

    if (this.sharedPluginDefinitions) {
      try {
        const removed =
          await this.repositories().pluginDefinitions.deleteWithState(id);
        if (!removed) return false;
        this.sharedDefinitionIds.delete(id);
        await this.clearDiscoveredModels(id);
        return true;
      } catch (error) {
        logger.error('Failed to delete shared plugin %s:', sanitizedId, error);
        return false;
      }
    }

    const bundledDirectory = path.resolve(this.bundledPluginsDir);
    const writablePluginDirs = Array.from(
      new Set([this.pluginsDir, ...this.legacyPluginsDirs])
    ).filter(pluginsDir => path.resolve(pluginsDir) !== bundledDirectory);
    const filePath = writablePluginDirs
      .map(pluginsDir => path.resolve(pluginsDir, `${sanitizedId}.json`))
      .find(candidate => isRegularPluginDefinition(candidate));

    if (!filePath) {
      logger.error('File path is invalid or does not exist:', filePath);
      return false;
    }

    try {
      fs.unlinkSync(filePath);

      await pluginActivationService.deletePlugin(id);
      await this.removePluginDefinitionApproval(id);

      // Clean up stored variables
      await pluginVariablesService.deletePluginVariables(id);
      await pluginCredentialsService.deleteAllPluginCredentials(id);
      await this.clearDiscoveredModels(id);

      return true;
    } catch (error) {
      logger.error('Failed to delete plugin %s:', sanitizedId, error);
      return false;
    }
  }

  // Activate a plugin
  async activatePlugin(id: string, userId?: string): Promise<boolean> {
    const plugin = await this.getPlugin(id, userId);

    if (!plugin) {
      throw new Error('Plugin not found');
    }

    if (!(await pluginActivationService.activate(id, userId))) {
      throw new Error('Failed to persist plugin activation');
    }

    // Wait for discovery so the activation response and the UI's first reload
    // observe the same user-scoped model catalog. These writes are deliberately
    // sequential: each persisted catalog publishes a cross-replica plugin-user
    // invalidation. Running sibling discoveries concurrently would make the
    // first completed catalog advance every sibling's configuration revision,
    // causing the remaining valid results to be discarded as stale.
    await this.discoverModels(id, userId).catch(() => []);
    for (const capability of [
      'image',
      'stt',
      'tts',
      'audio',
      'video',
    ] as const) {
      if (!plugin.capabilities?.[capability]?.models_endpoint) continue;
      await this.discoverCapabilityModels(id, capability, userId).catch(
        () => undefined
      );
    }

    return true;
  }

  // Deactivate a specific plugin
  deactivatePlugin(id?: string, userId?: string): Promise<boolean> {
    // The legacy no-ID route now deactivates all plugins only for this user.
    return pluginActivationService.deactivate(id, userId);
  }

  // Get the active plugin for a specific model
  async getActivePluginForModel(
    model: string,
    userId?: string,
    pluginId?: string
  ): Promise<Plugin | null> {
    if (pluginId) {
      let plugin = await this.getPlugin(pluginId, userId);
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }
      if (!(await this.isPluginActive(pluginId, userId))) {
        throw new Error(`Plugin is not active: ${pluginId}`);
      }
      if (!plugin.model_map.includes(model)) {
        // The UI offers a live-fetched catalog, so a just-released provider
        // model can be requested before the shared store carries it — and an
        // external worker resolves from the shared store only. Refresh a due
        // catalog once before rejecting; the discovery backoff keeps a
        // mistyped model from probing the provider on every request.
        if (await this.isModelDiscoveryDue(pluginId, userId)) {
          await this.discoverModelsResult(pluginId, userId).catch(
            () => undefined
          );
          plugin = await this.getPlugin(pluginId, userId);
        }
        if (!plugin?.model_map.includes(model)) {
          throw new Error(
            `Model ${model} is not supported by plugin ${pluginId}`
          );
        }
      }

      await this.resolveOperationEndpoint(plugin, userId);
      const apiKey = await this.getApiKey(plugin, userId);
      if (pluginRequiresApiKey(plugin) && !apiKey) {
        throw new Error(
          `API key not found for plugin ${pluginId} (save a provider credential in Settings)`
        );
      }

      return plugin;
    }

    // Only route through plugins the user explicitly activated.
    const activePlugins = await this.getActivePlugins(userId);

    // Find the active plugin that supports this model
    for (const plugin of activePlugins) {
      if (plugin.model_map.includes(model)) {
        // Local OpenAI-compatible servers can explicitly opt out of auth by
        // leaving both auth fields empty.
        await this.resolveOperationEndpoint(plugin, userId);
        const apiKey = await this.getApiKey(plugin, userId);
        if (pluginRequiresApiKey(plugin) && !apiKey) {
          continue;
        }

        return plugin;
      }
    }

    // Same store-vs-catalog skew guard for sessions without an explicit
    // provider: refresh every due catalog once, then rescan before giving up.
    let refreshedAnyCatalog = false;
    for (const plugin of activePlugins) {
      if (
        (plugin.type === 'completion' || plugin.type === 'chat') &&
        (await this.isModelDiscoveryDue(plugin.id, userId))
      ) {
        await this.discoverModelsResult(plugin.id, userId).catch(
          () => undefined
        );
        refreshedAnyCatalog = true;
      }
    }
    if (refreshedAnyCatalog) {
      for (const plugin of await this.getActivePlugins(userId)) {
        if (plugin.model_map.includes(model)) {
          await this.resolveOperationEndpoint(plugin, userId);
          const apiKey = await this.getApiKey(plugin, userId);
          if (pluginRequiresApiKey(plugin) && !apiKey) {
            continue;
          }
          return plugin;
        }
      }
    }

    return null;
  }

  // Get all currently active plugins
  async getActivePlugins(userId?: string): Promise<Plugin[]> {
    const allPlugins = await this.getAllPlugins(userId);
    const activePlugins = allPlugins.filter(plugin => plugin.active);
    return activePlugins;
  }

  private async getActivePluginsUnchecked(userId?: string): Promise<Plugin[]> {
    return (await this.getAllPluginsUnchecked(userId)).filter(
      plugin => plugin.active && plugin.id !== CODEX_OAUTH_PLUGIN_ID
    );
  }

  // Legacy method for backward compatibility - returns first active plugin
  async getActivePlugin(userId?: string): Promise<Plugin | null> {
    const activePlugins = await this.getActivePlugins(userId);
    return activePlugins.length > 0 ? activePlugins[0] : null;
  }

  // Get plugin status
  async getPluginStatus(userId?: string): Promise<PluginStatus[]> {
    const plugins = await this.getAllPlugins(userId);
    return Promise.all(
      plugins.map(async plugin => ({
        id: plugin.id,
        active: plugin.active || false,
        available:
          !pluginRequiresApiKey(plugin) ||
          (await this.getApiKey(plugin, userId)) !== null,
      }))
    );
  }

  // Execute a chat request through the active plugin
  async executePluginRequest(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions = {},
    userId?: string,
    pluginId?: string,
    signal?: AbortSignal
  ): Promise<PluginResponse> {
    throwIfChatGenerationCancelled(signal);
    validatePluginModel(model);

    const activePlugin = await this.getActivePluginForModel(
      model,
      userId,
      pluginId
    );
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }
    if (activePlugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken(signal);
      // The codex endpoint only answers as an SSE stream; aggregate it here
      // so non-streaming callers still get a complete response.
      let aggregated = '';
      for await (const chunk of this.executePluginStreamRequest(
        model,
        messages,
        options,
        userId,
        activePlugin.id,
        signal
      )) {
        if (chunk.type === 'content' && chunk.content) {
          aggregated += chunk.content;
        }
      }
      return {
        choices: [{ message: { role: 'assistant', content: aggregated } }],
      } as PluginResponse;
    }

    const pluginVars = await this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint, 'endpoint URL constructed');
    const apiKey = await this.getApiKey(activePlugin, userId);
    if (pluginRequiresApiKey(activePlugin) && !apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (save a provider credential in Settings)`
      );
    }
    const providerStateScope =
      apiMode === 'responses'
        ? createOpenAIResponsesStateScope(
            activePlugin.id,
            model,
            processedEndpoint,
            createPluginCredentialFingerprint(apiKey)
          )
        : undefined;
    const headers = buildPluginAuthHeaders(
      activePlugin,
      apiKey,
      processedEndpoint
    );
    const { payload, headers: payloadHeaders } = buildPluginChatPayload(
      activePlugin,
      model,
      messages,
      options,
      pluginVars,
      false,
      apiMode,
      providerStateScope
    );
    Object.assign(headers, payloadHeaders);

    const startedAt = Date.now();
    try {
      const response = await axios.post(processedEndpoint, payload, {
        headers,
        timeout: 60000, // 60 second timeout
        maxRedirects: 0,
        signal,
      });

      const normalized = convertProviderResponse(
        activePlugin,
        response.data,
        model,
        apiMode,
        providerStateScope
      );
      pluginUsageService.record({
        userId,
        pluginId: activePlugin.id,
        pluginName: activePlugin.name,
        capability: 'chat',
        model,
        status: 'success',
        durationMs: Date.now() - startedAt,
        tokens: normalized.usage
          ? {
              promptTokens: normalized.usage.prompt_tokens,
              completionTokens: normalized.usage.completion_tokens,
              totalTokens: normalized.usage.total_tokens,
            }
          : undefined,
      });
      return normalized;
    } catch (error: unknown) {
      const cancelled = isChatGenerationCancelled(error, signal);
      pluginUsageService.record({
        userId,
        pluginId: activePlugin.id,
        pluginName: activePlugin.name,
        capability: 'chat',
        model,
        status: cancelled ? 'cancelled' : 'error',
        durationMs: Date.now() - startedAt,
      });
      if (!cancelled) {
        logger.error(`Plugin request failed for ${activePlugin.id}:`, error);
      }

      if (cancelled) {
        throw error;
      }

      if (error && typeof error === 'object' && 'response' in error) {
        const axiosError = error as {
          response: {
            status: number;
            data?: { error?: { message?: string } };
            statusText: string;
          };
        };
        throw new Error(
          `Plugin API error: ${axiosError.response.status} - ${axiosError.response.data?.error?.message || axiosError.response.statusText}`
        );
      } else if (error && typeof error === 'object' && 'request' in error) {
        throw new Error(
          `Plugin connection error: Unable to reach ${processedEndpoint}`
        );
      } else {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error';
        throw new Error(`Plugin error: ${errorMessage}`);
      }
    }
  }

  /**
   * Execute a streaming chat request through the active plugin.
   * Returns an async generator that yields SSE delta content strings.
   * Also collects tool_calls from the stream.
   */
  async *executePluginStreamRequest(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions = {},
    userId?: string,
    pluginId?: string,
    signal?: AbortSignal
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    throwIfChatGenerationCancelled(signal);
    validatePluginModel(model);

    const activePlugin = await this.getActivePluginForModel(
      model,
      userId,
      pluginId
    );
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }
    if (activePlugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken(signal);
    }

    const pluginVars = await this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint);
    const apiKey = await this.getApiKey(activePlugin, userId);
    if (pluginRequiresApiKey(activePlugin) && !apiKey) {
      throw new Error(
        `API key not found for plugin ${activePlugin.id} (save a provider credential in Settings)`
      );
    }
    const providerStateScope =
      apiMode === 'responses'
        ? createOpenAIResponsesStateScope(
            activePlugin.id,
            model,
            processedEndpoint,
            createPluginCredentialFingerprint(apiKey)
          )
        : undefined;
    const headers = buildPluginAuthHeaders(
      activePlugin,
      apiKey,
      processedEndpoint
    );
    let payload: Record<string, unknown>;

    if (activePlugin.id === 'anthropic' || apiMode === 'responses') {
      const pluginRequest = buildPluginChatPayload(
        activePlugin,
        model,
        messages,
        options,
        pluginVars,
        true,
        apiMode,
        providerStateScope
      );
      payload = pluginRequest.payload;
      Object.assign(headers, pluginRequest.headers);
    } else {
      const params = resolvePluginChatParameters(options, pluginVars);
      payload = {
        model,
        messages: toOpenAICompatibleMessages(messages, {
          includeReasoning: activePlugin.id === 'openrouter',
        }),
        ...getOpenAICompatibleSamplingParameters(activePlugin, params),
        max_tokens: params.maxTokens,
        stop: options.stop,
        stream: true,
        // OpenAI-compatible servers omit token counts from a stream unless
        // they are asked for, which is why provider-backed replies used to
        // report zero tokens.
        stream_options: { include_usage: true },
      };
    }

    const startedAt = Date.now();
    let status: PluginUsageStatus = 'cancelled';
    let tokenUsage: ProviderTokenUsage | undefined;
    const captureUsage = (chunk: PluginStreamChunk): void => {
      if (chunk.type !== 'usage' || !chunk.usage) return;
      const { promptTokens, completionTokens, totalTokens } = chunk.usage;
      if (
        promptTokens === undefined &&
        completionTokens === undefined &&
        totalTokens === undefined
      ) {
        return;
      }
      const prompt = promptTokens ?? 0;
      const completion = completionTokens ?? 0;
      tokenUsage = {
        promptTokens: prompt,
        completionTokens: completion,
        totalTokens: totalTokens ?? prompt + completion,
      };
    };
    const forward = async function* (
      chunks: AsyncIterable<PluginStreamChunk>
    ): AsyncGenerator<PluginStreamChunk, void, unknown> {
      for await (const chunk of chunks) {
        captureUsage(chunk);
        yield chunk;
      }
    };

    try {
      const response = await fetch(processedEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        redirect: 'error',
        signal,
      });

      if (activePlugin.id === 'anthropic') {
        yield* forward(streamAnthropicResponse(response));
      } else if (apiMode === 'responses') {
        const contentType = response.headers.get('content-type') || '';
        // The codex endpoint streams SSE without any content-type header.
        const streamedAnyway =
          activePlugin.id === CODEX_OAUTH_PLUGIN_ID && response.ok;
        if (!contentType.includes('text/event-stream') && !streamedAnyway) {
          if (!response.ok) {
            const errorText = await response.text();
            throw new Error(
              `Plugin API error: ${response.status} - ${errorText.slice(0, 200)}`
            );
          }
          const normalized = convertProviderResponse(
            activePlugin,
            (await response.json()) as Record<string, unknown>,
            model,
            apiMode,
            providerStateScope
          );
          const choice = normalized.choices[0];
          const message = choice?.message;
          if (typeof message?.content === 'string' && message.content) {
            yield { type: 'content', content: message.content };
          }
          if (
            typeof message?.reasoning_content === 'string' &&
            message.reasoning_content
          ) {
            yield {
              type: 'reasoning',
              content: message.reasoning_content,
            };
          }
          for (const call of message?.tool_calls || []) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: call.id,
                name: call.function.name,
                arguments: call.function.arguments,
                ...(call.providerMetadata
                  ? { providerMetadata: call.providerMetadata }
                  : {}),
              },
            };
          }
          const providerTimings = readProviderTimings(normalized);
          if (normalized.usage || providerTimings) {
            const usageChunk: PluginStreamChunk = {
              type: 'usage',
              ...(normalized.usage
                ? {
                    usage: {
                      promptTokens: normalized.usage.prompt_tokens,
                      completionTokens: normalized.usage.completion_tokens,
                      totalTokens: normalized.usage.total_tokens,
                    },
                  }
                : {}),
              ...(providerTimings ? { timings: providerTimings } : {}),
            };
            captureUsage(usageChunk);
            yield usageChunk;
          }
          const incompleteReason =
            typeof normalized.providerMetadata?.[
              OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY
            ] === 'string'
              ? normalized.providerMetadata[
                  OPENAI_RESPONSES_INCOMPLETE_REASON_METADATA_KEY
                ]
              : undefined;
          yield {
            type: 'done',
            ...(incompleteReason
              ? { doneReason: `incomplete:${incompleteReason}` }
              : {}),
            ...(normalized.providerMetadata
              ? { providerMetadata: normalized.providerMetadata }
              : {}),
          };
        } else {
          yield* forward(
            streamOpenAIResponsesResponse(response, providerStateScope, {
              allowEmptyTerminalOutput:
                activePlugin.id === CODEX_OAUTH_PLUGIN_ID,
            })
          );
        }
      } else {
        yield* forward(streamOpenAICompatibleResponse(response));
      }
      status = 'success';
    } catch (error) {
      status = isChatGenerationCancelled(error, signal) ? 'cancelled' : 'error';
      throw error;
    } finally {
      pluginUsageService.record({
        userId,
        pluginId: activePlugin.id,
        pluginName: activePlugin.name,
        capability: 'chat',
        model,
        status,
        durationMs: Date.now() - startedAt,
        tokens: tokenUsage,
      });
    }
  }

  // Validate plugin structure
  private validatePlugin(plugin: unknown): plugin is Plugin {
    const pluginRecord =
      typeof plugin === 'object' && plugin !== null
        ? (plugin as Record<string, unknown>)
        : null;
    const variables = pluginRecord?.variables;
    const variableNames =
      variables === undefined
        ? []
        : Array.isArray(variables)
          ? variables.map(variable =>
              typeof variable === 'object' &&
              variable !== null &&
              typeof (variable as Record<string, unknown>).name === 'string'
                ? ((variable as Record<string, unknown>).name as string)
                : null
            )
          : [null];
    const hasUniqueVariableNames =
      !variableNames.includes(null) &&
      new Set(variableNames).size === variableNames.length;

    return (
      pluginRecord !== null &&
      hasUniqueVariableNames &&
      typeof pluginRecord.id === 'string' &&
      typeof pluginRecord.name === 'string' &&
      typeof pluginRecord.type === 'string' &&
      typeof pluginRecord.endpoint === 'string' &&
      (pluginRecord.api_mode === undefined ||
        pluginRecord.api_mode === 'chat_completions' ||
        pluginRecord.api_mode === 'responses') &&
      (pluginRecord.base_url === undefined ||
        typeof pluginRecord.base_url === 'string') &&
      (pluginRecord.api_path === undefined ||
        typeof pluginRecord.api_path === 'string') &&
      typeof pluginRecord.auth === 'object' &&
      pluginRecord.auth !== null &&
      typeof (pluginRecord.auth as Record<string, unknown>).header ===
        'string' &&
      typeof (pluginRecord.auth as Record<string, unknown>).key_env ===
        'string' &&
      ((pluginRecord.auth as Record<string, unknown>).prefix === undefined ||
        typeof (pluginRecord.auth as Record<string, unknown>).prefix ===
          'string') &&
      Array.isArray(pluginRecord.model_map) &&
      pluginRecord.model_map.length > 0
    );
  }

  // Export plugin to JSON
  async exportPlugin(id: string, userId?: string): Promise<Plugin | null> {
    return this.getPlugin(id, userId);
  }

  // Import plugin from JSON data
  async importPlugin(
    pluginData: unknown,
    approvedByUserId: string
  ): Promise<Plugin> {
    // Validate and clean the plugin data
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin data');
    }

    if (this.sharedPluginDefinitions) {
      const existing = await this.repositories().pluginDefinitions.find(
        pluginData.id
      );
      if (existing && this.parseSharedPluginDefinition(existing)) {
        throw new Error(`Plugin with ID ${pluginData.id} already exists`);
      }
    }

    // Check if plugin already exists
    const existingPluginPath = this.resolveEffectivePluginFilePath(
      pluginData.id
    );
    if (existingPluginPath) {
      try {
        const existingPlugin = JSON.parse(
          readRegularPluginDefinition(existingPluginPath)
        ) as Plugin;
        if (
          this.validatePlugin(existingPlugin) &&
          existingPlugin.id === pluginData.id &&
          (await this.isPluginDefinitionApproved(
            existingPlugin,
            existingPluginPath
          ))
        ) {
          throw new Error(`Plugin with ID ${pluginData.id} already exists`);
        }
      } catch (error) {
        if (
          error instanceof Error &&
          error.message.includes('already exists')
        ) {
          throw error;
        }
        // Invalid and unapproved legacy definitions may be replaced by this
        // authenticated administrator import.
      }
    }

    return this.installPlugin(pluginData, approvedByUserId);
  }

  // ============================================
  // Capability Methods
  // ============================================

  async getPluginForTTS(
    model: string,
    pluginId?: string,
    userId?: string
  ): Promise<Plugin | null> {
    return this.ttsService.getPluginForTTS(model, pluginId, userId);
  }

  async getPluginForEmbedding(
    model: string,
    pluginId?: string,
    userId?: string
  ): Promise<Plugin | null> {
    return this.embeddingService.getPluginForEmbedding(model, pluginId, userId);
  }

  async getAvailableEmbeddingModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      pluginName: string;
      provider: EmbeddingModel['provider'];
      description?: string;
      fromEmbeddingCapability?: boolean;
    }>
  > {
    return this.embeddingService.getAvailableEmbeddingModels(userId);
  }

  async executeEmbeddingRequest(
    model: string,
    input: string | string[],
    pluginId?: string,
    userId?: string,
    signal?: AbortSignal
  ): Promise<OllamaEmbeddingsResponse> {
    return this.embeddingService.executeEmbeddingRequest(
      model,
      input,
      pluginId,
      userId,
      signal
    );
  }

  async getAvailableTTSModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: TTSConfig;
    }>
  > {
    return this.ttsService.getAvailableTTSModels(userId);
  }

  async getAvailableSTTModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: STTConfig;
    }>
  > {
    return this.sttService.getAvailableModels(userId);
  }

  executeSTTRequest(
    model: string,
    audio: Parameters<PluginSTTService['transcribe']>[1],
    options: Parameters<PluginSTTService['transcribe']>[2]
  ) {
    return this.sttService.transcribe(model, audio, options);
  }

  async executeTTSRequest(
    model: string,
    input: string,
    options: {
      voice?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      speed?: number;
      pluginId?: string;
      userId?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<Buffer> {
    return this.ttsService.executeTTSRequest(model, input, options);
  }

  async executeVoiceCloneRequest(
    model: string,
    input: string,
    referenceAudio: {
      buffer: Buffer;
      originalname: string;
      mimetype: string;
      size?: number;
    },
    options: {
      referenceText?: string;
      response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
      pluginId?: string;
      userId?: string;
      signal?: AbortSignal;
    } = {}
  ): Promise<Buffer> {
    return this.ttsService.executeVoiceCloneRequest(
      model,
      input,
      referenceAudio,
      options
    );
  }

  async getTTSConfig(
    pluginId: string,
    userId?: string
  ): Promise<TTSConfig | null> {
    return this.ttsService.getTTSConfig(pluginId, userId);
  }

  async getPluginForImageGen(
    model: string,
    pluginId: string,
    userId?: string
  ): Promise<Plugin | null> {
    return this.imageGenerationService.getPluginForImageGen(
      model,
      pluginId,
      userId
    );
  }

  async getAvailableImageGenModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: ImageGenConfig;
    }>
  > {
    return this.imageGenerationService.getAvailableImageGenModels(userId);
  }

  async executeImageGenRequest(
    model: string,
    prompt: string,
    options: {
      size?: string;
      quality?: string;
      style?: string;
      n?: number;
      response_format?: 'url' | 'b64_json';
      pluginId: string;
      userId?: string;
      signal?: AbortSignal;
    }
  ): Promise<ImageGenResponse> {
    return this.imageGenerationService.executeImageGenRequest(
      model,
      prompt,
      options
    );
  }

  async getImageGenConfig(
    pluginId: string,
    userId?: string
  ): Promise<ImageGenConfig | null> {
    return this.imageGenerationService.getImageGenConfig(pluginId, userId);
  }

  async getPluginsByCapability(
    capabilityType: PluginType,
    userId?: string
  ): Promise<Plugin[]> {
    return this.capabilityRegistryService.getPluginsByCapability(
      capabilityType,
      userId
    );
  }

  async getAvailableAudioGenModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: AudioGenConfig;
    }>
  > {
    return this.audioGenerationService.getAvailableModels(userId);
  }

  executeAudioGenRequest(
    model: string,
    prompt: string,
    options: Parameters<PluginAudioGenerationService['generate']>[2]
  ) {
    return this.audioGenerationService.generate(model, prompt, options);
  }

  async getAvailableVideoGenModels(userId?: string): Promise<
    Array<{
      model: string;
      plugin: string;
      config?: VideoGenConfig;
    }>
  > {
    return this.videoGenerationService.getAvailableModels(userId);
  }

  submitVideoGenRequest(
    model: string,
    prompt: string,
    options: Parameters<PluginVideoGenerationService['submit']>[2]
  ) {
    return this.videoGenerationService.submit(model, prompt, options);
  }

  pollVideoGenRequest(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ) {
    return this.videoGenerationService.poll(
      model,
      providerJobId,
      pluginId,
      userId,
      signal
    );
  }

  downloadVideoGenResult(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ) {
    return this.videoGenerationService.download(
      model,
      providerJobId,
      pluginId,
      userId,
      signal
    );
  }

  async canCancelVideoGenRequest(
    model: string,
    pluginId: string,
    userId: string
  ): Promise<boolean> {
    return this.videoGenerationService.supportsCancellation(
      model,
      pluginId,
      userId
    );
  }

  cancelVideoGenRequest(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string,
    signal?: AbortSignal
  ) {
    return this.videoGenerationService.cancel(
      model,
      providerJobId,
      pluginId,
      userId,
      signal
    );
  }

  async closeCacheInvalidation(): Promise<void> {
    this.removeCacheInvalidationListener?.();
    this.removeCacheInvalidationListener = undefined;
    this.discoveredModelsCache.clear();
    this.discoveredModelsUpdatedAt.clear();
    this.discoveryAttemptedAt.clear();
    this.inflightDiscovery.clear();
    this.discoveredCapabilityModelsCache.clear();
    this.discoveredCapabilityModelsUpdatedAt.clear();
    this.capabilityDiscoveryAttemptedAt.clear();
    this.inflightCapabilityDiscovery.clear();
    this.discoveryCacheRevisions.clear();
    this.capabilityDiscoveryCacheRevisions.clear();
  }
}

export default new PluginService();
