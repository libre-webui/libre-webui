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
  VideoGenConfig,
} from '../types/index.js';
import codexOAuthService, {
  CODEX_OAUTH_PLUGIN_ID,
} from './codexOAuthService.js';
import { userModel } from '../models/userModel.js';
import pluginCredentialsService from './pluginCredentialsService.js';
import pluginVariablesService from './pluginVariablesService.js';
import pluginActivationService from './pluginActivationService.js';
import { PluginAudioGenerationService } from './pluginAudioGenerationService.js';
import { PluginCapabilityRegistryService } from './pluginCapabilityRegistryService.js';
import { PluginEmbeddingService } from './pluginEmbeddingService.js';
import { PluginImageGenerationService } from './pluginImageGenerationService.js';
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
import { resolveBundledPluginsDir } from '../utils/packagePaths.js';
import { getDatabaseSafe } from '../db.js';
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

const logger = createLogger('plugins');

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
type DiscoverableMediaCapability = 'image' | 'tts' | 'audio' | 'video';

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

export class PluginService {
  private pluginsDir: string;
  private bundledPluginsDir: string;
  private legacyPluginsDir: string;
  private pluginReadDirs: string[];
  private discoveredModelsCache = new Map<string, string[] | null>();
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
  private embeddingService: PluginEmbeddingService;
  private ttsService: PluginTTSService;
  private imageGenerationService: PluginImageGenerationService;
  private audioGenerationService: PluginAudioGenerationService;
  private videoGenerationService: PluginVideoGenerationService;
  private capabilityRegistryService: PluginCapabilityRegistryService;
  private bundledRoutingProjectionCache = new Map<string, string | null>();

  constructor() {
    this.bundledPluginsDir = resolveBundledPluginsDir(import.meta.url);
    this.legacyPluginsDir = path.join(process.cwd(), 'plugins');
    this.pluginsDir =
      process.env.PLUGINS_DIR ||
      (process.env.DATA_DIR
        ? path.join(process.env.DATA_DIR, 'plugins')
        : this.legacyPluginsDir);
    this.pluginReadDirs = Array.from(
      new Set([this.bundledPluginsDir, this.legacyPluginsDir, this.pluginsDir])
    );
    this.ensurePluginsDirectory();
    pluginActivationService.migrateLegacyStatus(
      [this.pluginsDir, this.legacyPluginsDir],
      pluginId => this.canMigrateLegacyActivation(pluginId)
    );
    this.embeddingService = new PluginEmbeddingService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.ttsService = new PluginTTSService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.imageGenerationService = new PluginImageGenerationService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.audioGenerationService = new PluginAudioGenerationService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.videoGenerationService = new PluginVideoGenerationService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getPlugin: (id, userId) => this.getPlugin(id, userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
      getPluginVariables: (plugin, userId) =>
        this.getPluginVariables(plugin, userId),
      validateEndpointUrl: endpoint => this.validateEndpointUrl(endpoint),
      recordUsage: usage => pluginUsageService.record(usage),
    });
    this.capabilityRegistryService = new PluginCapabilityRegistryService({
      getAllPlugins: userId => this.getActivePlugins(userId),
      getApiKey: (plugin, userId) => this.getApiKey(plugin, userId),
    });
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

  private getDiscoveredCapabilityModels(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId?: string
  ): string[] | undefined {
    const effectiveUserId = userId || 'default';
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      effectiveUserId
    );
    if (this.discoveredCapabilityModelsCache.has(cacheKey)) {
      return this.discoveredCapabilityModelsCache.get(cacheKey) || undefined;
    }

    const db = getDatabaseSafe();
    if (!db) {
      this.discoveredCapabilityModelsCache.set(cacheKey, null);
      return undefined;
    }

    try {
      const row = db
        .prepare(
          `SELECT models_json, updated_at
           FROM plugin_discovered_capability_models
           WHERE user_id = ? AND plugin_id = ? AND capability = ?`
        )
        .get(effectiveUserId, pluginId, capability) as
        { models_json: string; updated_at: number } | undefined;
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

  private storeDiscoveredCapabilityModels(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    models: string[],
    userId?: string
  ): void {
    const effectiveUserId = userId || 'default';
    const uniqueModels = Array.from(new Set(models));
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      effectiveUserId
    );
    const discoveredAt = Date.now();
    this.discoveredCapabilityModelsCache.set(cacheKey, uniqueModels);
    this.discoveredCapabilityModelsUpdatedAt.set(cacheKey, discoveredAt);

    const db = getDatabaseSafe();
    if (!db) return;
    db.prepare(
      `INSERT INTO plugin_discovered_capability_models
         (user_id, plugin_id, capability, models_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, plugin_id, capability) DO UPDATE SET
         models_json = excluded.models_json,
         updated_at = excluded.updated_at`
    ).run(
      effectiveUserId,
      pluginId,
      capability,
      JSON.stringify(uniqueModels),
      discoveredAt
    );
  }

  private getDiscoveredModels(
    pluginId: string,
    userId?: string
  ): string[] | undefined {
    const effectiveUserId = userId || 'default';
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    if (this.discoveredModelsCache.has(cacheKey)) {
      return this.discoveredModelsCache.get(cacheKey) || undefined;
    }

    const db = getDatabaseSafe();
    if (!db) {
      this.discoveredModelsCache.set(cacheKey, null);
      return undefined;
    }

    try {
      const row = db
        .prepare(
          'SELECT models_json, updated_at FROM plugin_discovered_models WHERE user_id = ? AND plugin_id = ?'
        )
        .get(effectiveUserId, pluginId) as
        { models_json: string; updated_at: number } | undefined;
      if (!row) {
        this.discoveredModelsCache.set(cacheKey, null);
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
        this.discoveredModelsCache.set(cacheKey, null);
        return undefined;
      }
      this.discoveredModelsCache.set(cacheKey, models);
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
      return undefined;
    }
  }

  private storeDiscoveredModels(
    pluginId: string,
    models: string[],
    userId?: string
  ): void {
    const effectiveUserId = userId || 'default';
    const uniqueModels = Array.from(new Set(models));
    const cacheKey = this.discoveredModelsCacheKey(pluginId, effectiveUserId);
    const discoveredAt = Date.now();
    this.discoveredModelsCache.set(cacheKey, uniqueModels);
    this.discoveredModelsUpdatedAt.set(cacheKey, discoveredAt);

    const db = getDatabaseSafe();
    if (!db) return;

    try {
      db.prepare(
        `INSERT INTO plugin_discovered_models
          (user_id, plugin_id, models_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
          models_json = excluded.models_json,
          updated_at = excluded.updated_at`
      ).run(
        effectiveUserId,
        pluginId,
        JSON.stringify(uniqueModels),
        discoveredAt
      );
    } catch (error) {
      logger.warn(
        'Failed to persist discovered models for plugin %s:',
        pluginId,
        error
      );
    }
  }

  clearDiscoveredModels(pluginId: string, userId?: string): void {
    this.clearDiscoveredCapabilityModels(pluginId, userId);
    const db = getDatabaseSafe();
    if (userId) {
      const cacheKey = this.discoveredModelsCacheKey(pluginId, userId);
      this.discoveredModelsCache.set(cacheKey, null);
      this.discoveredModelsUpdatedAt.delete(cacheKey);
      this.discoveryAttemptedAt.delete(cacheKey);
      if (!db) return;
      try {
        db.prepare(
          'DELETE FROM plugin_discovered_models WHERE user_id = ? AND plugin_id = ?'
        ).run(userId, pluginId);
      } catch (error) {
        logger.warn(
          'Failed to clear discovered models for plugin %s:',
          pluginId,
          error
        );
      }
      return;
    }

    for (const key of this.discoveredModelsCache.keys()) {
      if (key.endsWith(`:${pluginId}`)) {
        this.discoveredModelsCache.delete(key);
        this.discoveredModelsUpdatedAt.delete(key);
        this.discoveryAttemptedAt.delete(key);
      }
    }
    if (!db) return;
    try {
      db.prepare(
        'DELETE FROM plugin_discovered_models WHERE plugin_id = ?'
      ).run(pluginId);
    } catch (error) {
      logger.warn(
        'Failed to clear discovered models for plugin %s:',
        pluginId,
        error
      );
    }
  }

  private clearDiscoveredCapabilityModels(
    pluginId: string,
    userId?: string
  ): void {
    const db = getDatabaseSafe();
    if (userId) {
      for (const capability of ['image', 'tts', 'audio', 'video'] as const) {
        const key = this.discoveredCapabilityModelsCacheKey(
          pluginId,
          capability,
          userId
        );
        this.discoveredCapabilityModelsCache.delete(key);
        this.discoveredCapabilityModelsUpdatedAt.delete(key);
        this.capabilityDiscoveryAttemptedAt.delete(key);
      }
      if (db) {
        db.prepare(
          `DELETE FROM plugin_discovered_capability_models
           WHERE user_id = ? AND plugin_id = ?`
        ).run(userId, pluginId);
      }
      return;
    }

    for (const key of this.discoveredCapabilityModelsCache.keys()) {
      if (
        (['image', 'tts', 'audio', 'video'] as const).some(capability =>
          key.endsWith(`:${pluginId}:${capability}`)
        )
      ) {
        this.discoveredCapabilityModelsCache.delete(key);
        this.discoveredCapabilityModelsUpdatedAt.delete(key);
        this.capabilityDiscoveryAttemptedAt.delete(key);
      }
    }
    if (db) {
      db.prepare(
        'DELETE FROM plugin_discovered_capability_models WHERE plugin_id = ?'
      ).run(pluginId);
    }
  }

  private applyDiscoveredModels(plugin: Plugin, userId?: string): Plugin {
    if (
      !this.canUseStoredConnectionOverrides(userId) &&
      pluginVariablesService.hasStoredConnectionOverride(
        plugin.id,
        userId,
        plugin.variables,
        getPluginConnectionVariableNames(plugin)
      )
    ) {
      return plugin;
    }
    const models = this.getDiscoveredModels(plugin.id, userId);
    const capabilities = plugin.capabilities
      ? { ...plugin.capabilities }
      : undefined;
    if (capabilities) {
      for (const capability of ['image', 'tts', 'audio', 'video'] as const) {
        const definition = capabilities[capability];
        const discovered = this.getDiscoveredCapabilityModels(
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
    return {
      ...plugin,
      ...(models ? { model_map: [...models] } : {}),
      ...(capabilities ? { capabilities } : {}),
    };
  }

  private ensurePluginsDirectory(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
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

  private isPluginDefinitionApproved(
    plugin: Plugin,
    filePath: string
  ): boolean {
    if (this.isAnchoredBundledDefinition(plugin, filePath)) {
      return true;
    }

    const db = getDatabaseSafe();
    if (!db) return false;
    try {
      const row = db
        .prepare(
          `SELECT definition_fingerprint, source_path
           FROM plugin_definition_approvals
           WHERE plugin_id = ?`
        )
        .get(plugin.id) as
        { definition_fingerprint: string; source_path: string } | undefined;
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

  private approvePluginDefinition(
    plugin: Plugin,
    filePath: string,
    userId: string
  ): void {
    if (!this.canUseStoredConnectionOverrides(userId)) {
      throw new Error('Administrator approval is required');
    }
    const db = getDatabaseSafe();
    if (!db) {
      throw new Error('Database not available for plugin approval');
    }
    db.prepare(
      `INSERT INTO plugin_definition_approvals
         (plugin_id, definition_fingerprint, source_path,
          approved_by_user_id, approved_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(plugin_id) DO UPDATE SET
         definition_fingerprint = excluded.definition_fingerprint,
         source_path = excluded.source_path,
         approved_by_user_id = excluded.approved_by_user_id,
         approved_at = excluded.approved_at`
    ).run(
      plugin.id,
      getPluginDefinitionFingerprint(plugin),
      path.resolve(filePath),
      userId,
      Date.now()
    );
  }

  private removePluginDefinitionApproval(pluginId: string): void {
    const db = getDatabaseSafe();
    if (!db) return;
    db.prepare(
      'DELETE FROM plugin_definition_approvals WHERE plugin_id = ?'
    ).run(pluginId);
  }

  private revokePluginDefinitionConsent(pluginId: string): void {
    const db = getDatabaseSafe();
    if (!db) {
      throw new Error('Database not available for plugin approval');
    }
    db.transaction(() => {
      db.prepare('DELETE FROM plugin_activations WHERE plugin_id = ?').run(
        pluginId
      );
      db.prepare(
        'DELETE FROM plugin_definition_approvals WHERE plugin_id = ?'
      ).run(pluginId);
    })();
  }

  private canMigrateLegacyActivation(pluginId: string): boolean {
    const effectivePath = this.resolveEffectivePluginFilePath(pluginId);
    if (!effectivePath) return false;
    try {
      const parsedPlugin = JSON.parse(
        fs.readFileSync(effectivePath, 'utf8')
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
      if (candidate.startsWith(resolvedDirectory) && fs.existsSync(candidate)) {
        return candidate;
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
        fs.readFileSync(bundledPath, 'utf8')
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
    const effectivePath = this.resolveEffectivePluginFilePath(plugin.id);
    const bundledPath = this.bundledPluginPath(plugin.id);
    if (!effectivePath || effectivePath !== bundledPath) return false;

    const bundledProjection = this.getBundledRoutingProjection(plugin.id);
    return (
      bundledProjection !== null &&
      getPluginRoutingAuthProjection(plugin) === bundledProjection
    );
  }

  private isPluginActive(pluginId: string, userId?: string): boolean {
    return pluginActivationService.getActivePluginIds(userId).has(pluginId);
  }

  private canUseStoredConnectionOverrides(userId?: string): boolean {
    const db = getDatabaseSafe();
    if (!db) return false;

    try {
      const row = db
        .prepare('SELECT role FROM users WHERE id = ?')
        .get(userId || 'default') as { role?: string } | undefined;
      return row?.role === 'admin';
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
  getApiKey(plugin: Plugin, userId?: string): string | null {
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
      this.canUseStoredConnectionOverrides(userId) &&
      pluginVariablesService.hasStoredConnectionOverride(
        plugin.id,
        userId,
        plugin.variables,
        getPluginConnectionVariableNames(plugin)
      );
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
          this.getCredentialRoutingAuthFingerprint(plugin, userId),
        allowLegacyUnboundCredential: allowTrustedFallback,
      }
    );
  }

  /**
   * Bind a user credential to the exact routing/authentication contract in
   * effect when they save it. Generation controls are intentionally excluded.
   */
  getCredentialRoutingAuthFingerprint(plugin: Plugin, userId?: string): string {
    const variables = this.getPluginVariables(plugin, userId);
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
    const effectivePath = this.resolveEffectivePluginFilePath(plugin.id);
    let effectiveDefinitionFingerprint = getPluginDefinitionFingerprint(plugin);
    if (effectivePath) {
      try {
        const effectiveDefinition = JSON.parse(
          fs.readFileSync(effectivePath, 'utf8')
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
      effective_source_path: effectivePath ? path.resolve(effectivePath) : null,
      effective_definition_fingerprint: effectiveDefinitionFingerprint,
      routing_auth_projection: getPluginRoutingAuthProjection(plugin),
      effective_connection_values: effectiveConnectionValues,
    });
    return createHash('sha256').update(fingerprintInput).digest('hex');
  }

  /**
   * Get resolved variable values for a plugin (decrypted, typed).
   */
  getPluginVariables(
    plugin: Plugin,
    userId?: string
  ): Record<string, string | number | boolean> {
    if (!plugin.variables || plugin.variables.length === 0) {
      return {};
    }
    const variables = pluginVariablesService.getResolvedVariables(
      plugin.id,
      plugin.variables,
      userId
    );
    if (this.canUseStoredConnectionOverrides(userId)) return variables;

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
  private resolveOperationEndpoint(plugin: Plugin, userId?: string): string {
    return resolvePluginApiConfig(
      plugin,
      this.getPluginVariables(plugin, userId)
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
    const cacheKey = this.discoveredModelsCacheKey(
      pluginId,
      userId || 'default'
    );
    const inflight = this.inflightDiscovery.get(cacheKey);
    if (inflight) return inflight;

    const attempt = this.runModelDiscovery(pluginId, userId).finally(() => {
      this.inflightDiscovery.delete(cacheKey);
    });
    this.inflightDiscovery.set(cacheKey, attempt);
    return attempt;
  }

  /**
   * Whether a plugin's catalog should be re-fetched. Missing catalogs are due
   * immediately; stored ones age out after the TTL. Both cases are gated by a
   * per-plugin backoff so a failing provider is not probed on every request.
   */
  private isModelDiscoveryDue(pluginId: string, userId?: string): boolean {
    const cacheKey = this.discoveredModelsCacheKey(
      pluginId,
      userId || 'default'
    );
    const attemptedAt = this.discoveryAttemptedAt.get(cacheKey);
    if (attemptedAt && Date.now() - attemptedAt < modelDiscoveryRetryMs()) {
      return false;
    }

    const models = this.getDiscoveredModels(pluginId, userId);
    const updatedAt = this.discoveredModelsUpdatedAt.get(cacheKey);
    if (!models || !updatedAt) return true;

    return Date.now() - updatedAt >= modelDiscoveryTtlMs();
  }

  /**
   * Re-discover models for every active completion plugin whose catalog is
   * missing or stale. Bounded by a deadline so a slow provider cannot stall the
   * plugin-list response; refreshes that outrun it still persist and surface on
   * the next request.
   */
  async refreshStaleModels(userId?: string): Promise<void> {
    const due = this.getActivePlugins(userId).filter(
      plugin =>
        (plugin.type === 'completion' || plugin.type === 'chat') &&
        this.isModelDiscoveryDue(plugin.id, userId)
    );
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
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      userId || 'default'
    );
    const inflight = this.inflightCapabilityDiscovery.get(cacheKey);
    if (inflight) return inflight;

    const attempt = this.runCapabilityModelDiscovery(
      pluginId,
      capability,
      userId
    ).finally(() => this.inflightCapabilityDiscovery.delete(cacheKey));
    this.inflightCapabilityDiscovery.set(cacheKey, attempt);
    return attempt;
  }

  private isCapabilityModelDiscoveryDue(
    pluginId: string,
    capability: DiscoverableMediaCapability,
    userId?: string
  ): boolean {
    const cacheKey = this.discoveredCapabilityModelsCacheKey(
      pluginId,
      capability,
      userId || 'default'
    );
    const attemptedAt = this.capabilityDiscoveryAttemptedAt.get(cacheKey);
    if (attemptedAt && Date.now() - attemptedAt < modelDiscoveryRetryMs()) {
      return false;
    }
    const models = this.getDiscoveredCapabilityModels(
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
    const due = this.getActivePlugins(userId).filter(plugin => {
      const definition = plugin.capabilities?.[capability];
      return (
        Boolean(definition?.models_endpoint) &&
        this.isCapabilityModelDiscoveryDue(plugin.id, capability, userId)
      );
    });
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
    userId?: string
  ): Promise<PluginModelDiscoveryResult> {
    const plugin = this.getPlugin(pluginId, userId);
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
    const pluginVariables = this.getPluginVariables(plugin, userId);
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

    const apiKey = this.getApiKey(plugin, userId);
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
      this.storeDiscoveredCapabilityModels(
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
    userId?: string
  ): Promise<PluginModelDiscoveryResult> {
    const plugin = this.getPlugin(pluginId, userId);
    if (!plugin) {
      return { models: [], outcome: 'unavailable', reason: 'Plugin not found' };
    }

    this.discoveryAttemptedAt.set(
      this.discoveredModelsCacheKey(pluginId, userId || 'default'),
      Date.now()
    );

    const pluginVars = this.getPluginVariables(plugin, userId);
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

    const apiKey = this.getApiKey(plugin, userId);
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

        if (models.length > 0) {
          logger.debug(
            '[Plugin] Auto-discovered %d models for %s:',
            models.length,
            pluginId,
            models
          );

          const previousModels = plugin.model_map;
          this.storeDiscoveredModels(pluginId, models, userId);
          const stored = this.getDiscoveredModels(pluginId, userId) || models;
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
  getAllPlugins(userId?: string): Plugin[] {
    const plugins = new Map<string, Plugin>();
    const activePluginIds = pluginActivationService.getActivePluginIds(userId);

    for (const pluginsDir of this.pluginReadDirs) {
      if (!fs.existsSync(pluginsDir)) {
        continue;
      }

      try {
        const files = fs.readdirSync(pluginsDir);
        for (const file of files) {
          if (file.endsWith('.json') && !file.startsWith('.')) {
            const filenameId = path.basename(file, '.json');
            try {
              const filePath = path.join(pluginsDir, file);
              const content = fs.readFileSync(filePath, 'utf8');
              const parsedPlugin: Plugin = JSON.parse(content);

              // Validate plugin structure
              if (
                this.validatePlugin(parsedPlugin) &&
                parsedPlugin.id === filenameId
              ) {
                if (!this.isPluginDefinitionApproved(parsedPlugin, filePath)) {
                  // A later writable definition shadows an earlier bundled
                  // definition even while quarantined.
                  plugins.delete(parsedPlugin.id);
                  continue;
                }
                const plugin = applyPluginDefinitionPolicy(parsedPlugin);
                plugin.active = activePluginIds.has(plugin.id);
                plugins.set(
                  plugin.id,
                  this.applyDiscoveredModels(plugin, userId)
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

    return Array.from(plugins.values()).filter(plugin =>
      this.isPluginVisibleToUser(plugin, userId)
    );
  }

  /**
   * The codex-oauth plugin rides the server user's ChatGPT sign-in, so it is
   * administrator-only and hidden entirely when no sign-in exists.
   */
  private isPluginVisibleToUser(
    plugin: Pick<Plugin, 'id'>,
    userId?: string
  ): boolean {
    if (plugin.id !== CODEX_OAUTH_PLUGIN_ID) return true;
    if (!codexOAuthService.isAvailable()) return false;
    if (!userId) return false;
    return userModel.getUserById(userId)?.role === 'admin';
  }

  // Get a specific plugin by ID
  getPlugin(id: string, userId?: string): Plugin | null {
    // Sanitize the ID to prevent path traversal
    const sanitizedId = sanitize(id);
    if (!sanitizedId || sanitizedId !== id) {
      logger.error('Invalid plugin ID provided:', id);
      return null;
    }

    const filePath = this.resolveEffectivePluginFilePath(sanitizedId);
    if (!filePath) return null;

    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsedPlugin: Plugin = JSON.parse(content);

      if (
        this.validatePlugin(parsedPlugin) &&
        parsedPlugin.id === sanitizedId &&
        this.isPluginDefinitionApproved(parsedPlugin, filePath) &&
        this.isPluginVisibleToUser(parsedPlugin, userId)
      ) {
        const plugin = applyPluginDefinitionPolicy(parsedPlugin);
        plugin.active = this.isPluginActive(plugin.id, userId);
        return this.applyDiscoveredModels(plugin, userId);
      }
    } catch (error) {
      logger.error('Failed to load plugin %s:', sanitizedId, error);
    }

    return null;
  }

  // Install or update a plugin
  installPlugin(pluginData: Plugin, approvedByUserId: string): Plugin {
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin structure');
    }
    if (pluginData.id === CODEX_OAUTH_PLUGIN_ID) {
      throw new Error('The bundled Codex OAuth plugin ID is reserved');
    }
    if (!this.canUseStoredConnectionOverrides(approvedByUserId)) {
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
    const filePath = path.resolve(this.pluginsDir, `${safeId}.json`);
    if (!filePath.startsWith(path.resolve(this.pluginsDir))) {
      throw new Error('Path traversal detected');
    }
    // Revoke definition approval and every user's activation before replacing
    // bytes on disk. Any crash or write failure therefore leaves the provider
    // quarantined and inactive.
    this.revokePluginDefinitionConsent(plugin.id);
    this.clearDiscoveredModels(plugin.id);
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
    this.approvePluginDefinition(plugin, filePath, approvedByUserId);

    return plugin;
  }

  // Delete a plugin
  deletePlugin(id: string): boolean {
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

    const bundledDirectory = path.resolve(this.bundledPluginsDir);
    const writablePluginDirs = Array.from(
      new Set([this.pluginsDir, this.legacyPluginsDir])
    ).filter(pluginsDir => path.resolve(pluginsDir) !== bundledDirectory);
    const filePath = writablePluginDirs
      .map(pluginsDir => path.resolve(pluginsDir, `${sanitizedId}.json`))
      .find(candidate => fs.existsSync(candidate));

    if (!filePath) {
      logger.error('File path is invalid or does not exist:', filePath);
      return false;
    }

    try {
      fs.unlinkSync(filePath);

      pluginActivationService.deletePlugin(id);
      this.removePluginDefinitionApproval(id);

      // Clean up stored variables
      pluginVariablesService.deletePluginVariables(id);
      pluginCredentialsService.deleteAllPluginCredentials(id);
      this.clearDiscoveredModels(id);

      return true;
    } catch (error) {
      logger.error('Failed to delete plugin %s:', sanitizedId, error);
      return false;
    }
  }

  // Activate a plugin
  async activatePlugin(id: string, userId?: string): Promise<boolean> {
    const plugin = this.getPlugin(id, userId);

    if (!plugin) {
      throw new Error('Plugin not found');
    }

    if (!pluginActivationService.activate(id, userId)) {
      throw new Error('Failed to persist plugin activation');
    }

    // Wait for discovery so the activation response and the UI's first reload
    // observe the same user-scoped model catalog.
    await Promise.all([
      this.discoverModels(id, userId).catch(() => []),
      ...(['image', 'tts', 'audio', 'video'] as const)
        .filter(
          capability => plugin.capabilities?.[capability]?.models_endpoint
        )
        .map(capability =>
          this.discoverCapabilityModels(id, capability, userId).catch(
            () => undefined
          )
        ),
    ]);

    return true;
  }

  // Deactivate a specific plugin
  deactivatePlugin(id?: string, userId?: string): boolean {
    // The legacy no-ID route now deactivates all plugins only for this user.
    return pluginActivationService.deactivate(id, userId);
  }

  // Get the active plugin for a specific model
  getActivePluginForModel(
    model: string,
    userId?: string,
    pluginId?: string
  ): Plugin | null {
    if (pluginId) {
      const plugin = this.getPlugin(pluginId, userId);
      if (!plugin) {
        throw new Error(`Plugin not found: ${pluginId}`);
      }
      if (!this.isPluginActive(pluginId, userId)) {
        throw new Error(`Plugin is not active: ${pluginId}`);
      }
      if (!plugin.model_map.includes(model)) {
        throw new Error(
          `Model ${model} is not supported by plugin ${pluginId}`
        );
      }

      this.resolveOperationEndpoint(plugin, userId);
      const apiKey = this.getApiKey(plugin, userId);
      if (pluginRequiresApiKey(plugin) && !apiKey) {
        throw new Error(
          `API key not found for plugin ${pluginId} (save a provider credential in Settings)`
        );
      }

      return plugin;
    }

    // Only route through plugins the user explicitly activated.
    const activePlugins = this.getActivePlugins(userId);

    // Find the active plugin that supports this model
    for (const plugin of activePlugins) {
      if (plugin.model_map.includes(model)) {
        // Local OpenAI-compatible servers can explicitly opt out of auth by
        // leaving both auth fields empty.
        this.resolveOperationEndpoint(plugin, userId);
        const apiKey = this.getApiKey(plugin, userId);
        if (pluginRequiresApiKey(plugin) && !apiKey) {
          continue;
        }

        return plugin;
      }
    }

    return null;
  }

  // Get all currently active plugins
  getActivePlugins(userId?: string): Plugin[] {
    const allPlugins = this.getAllPlugins(userId);
    const activePlugins = allPlugins.filter(plugin => plugin.active);
    return activePlugins;
  }

  // Legacy method for backward compatibility - returns first active plugin
  getActivePlugin(userId?: string): Plugin | null {
    const activePlugins = this.getActivePlugins(userId);
    return activePlugins.length > 0 ? activePlugins[0] : null;
  }

  // Get plugin status
  getPluginStatus(userId?: string): PluginStatus[] {
    const plugins = this.getAllPlugins(userId);
    return plugins.map(plugin => ({
      id: plugin.id,
      active: plugin.active || false,
      available:
        !pluginRequiresApiKey(plugin) ||
        this.getApiKey(plugin, userId) !== null,
    }));
  }

  // Execute a chat request through the active plugin
  async executePluginRequest(
    model: string,
    messages: ChatMessage[],
    options: GenerationOptions = {},
    userId?: string,
    pluginId?: string
  ): Promise<PluginResponse> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId, pluginId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }

    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }
    if (activePlugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken();
      // The codex endpoint only answers as an SSE stream; aggregate it here
      // so non-streaming callers still get a complete response.
      let aggregated = '';
      for await (const chunk of this.executePluginStreamRequest(
        model,
        messages,
        options,
        userId,
        activePlugin.id
      )) {
        if (chunk.type === 'content' && chunk.content) {
          aggregated += chunk.content;
        }
      }
      return {
        choices: [{ message: { role: 'assistant', content: aggregated } }],
      } as PluginResponse;
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint, 'endpoint URL constructed');
    const apiKey = this.getApiKey(activePlugin, userId);
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
      pluginUsageService.record({
        userId,
        pluginId: activePlugin.id,
        pluginName: activePlugin.name,
        capability: 'chat',
        model,
        status: 'error',
        durationMs: Date.now() - startedAt,
      });
      logger.error(`Plugin request failed for ${activePlugin.id}:`, error);

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
    pluginId?: string
  ): AsyncGenerator<PluginStreamChunk, void, unknown> {
    validatePluginModel(model);

    const activePlugin = this.getActivePluginForModel(model, userId, pluginId);
    if (!activePlugin) {
      throw new Error(`No active plugin found for model: ${model}`);
    }
    if (!activePlugin.model_map.includes(model)) {
      throw new Error(
        `Model ${model} is not supported by plugin ${activePlugin.id}`
      );
    }
    if (activePlugin.id === CODEX_OAUTH_PLUGIN_ID) {
      await codexOAuthService.ensureFreshToken();
    }

    const pluginVars = this.getPluginVariables(activePlugin, userId);
    const { apiMode, endpoint: effectiveEndpoint } = resolvePluginApiConfig(
      activePlugin,
      pluginVars
    );
    const processedEndpoint = applyModelEndpointTemplate(
      effectiveEndpoint,
      model
    );
    assertSafePluginEndpoint(processedEndpoint);
    const apiKey = this.getApiKey(activePlugin, userId);
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
          if (normalized.usage) {
            const usageChunk: PluginStreamChunk = {
              type: 'usage',
              usage: {
                promptTokens: normalized.usage.prompt_tokens,
                completionTokens: normalized.usage.completion_tokens,
                totalTokens: normalized.usage.total_tokens,
              },
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
      status = 'error';
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
  exportPlugin(id: string, userId?: string): Plugin | null {
    return this.getPlugin(id, userId);
  }

  // Import plugin from JSON data
  importPlugin(pluginData: unknown, approvedByUserId: string): Plugin {
    // Validate and clean the plugin data
    if (!this.validatePlugin(pluginData)) {
      throw new Error('Invalid plugin data');
    }

    // Check if plugin already exists
    const existingPluginPath = this.resolveEffectivePluginFilePath(
      pluginData.id
    );
    if (existingPluginPath) {
      try {
        const existingPlugin = JSON.parse(
          fs.readFileSync(existingPluginPath, 'utf8')
        ) as Plugin;
        if (
          this.validatePlugin(existingPlugin) &&
          existingPlugin.id === pluginData.id &&
          this.isPluginDefinitionApproved(existingPlugin, existingPluginPath)
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

  getPluginForTTS(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    return this.ttsService.getPluginForTTS(model, pluginId, userId);
  }

  getPluginForEmbedding(
    model: string,
    pluginId?: string,
    userId?: string
  ): Plugin | null {
    return this.embeddingService.getPluginForEmbedding(model, pluginId, userId);
  }

  getAvailableEmbeddingModels(userId?: string): Array<{
    model: string;
    plugin: string;
    pluginName: string;
    provider: EmbeddingModel['provider'];
    description?: string;
    fromEmbeddingCapability?: boolean;
  }> {
    return this.embeddingService.getAvailableEmbeddingModels(userId);
  }

  async executeEmbeddingRequest(
    model: string,
    input: string | string[],
    pluginId?: string,
    userId?: string
  ): Promise<OllamaEmbeddingsResponse> {
    return this.embeddingService.executeEmbeddingRequest(
      model,
      input,
      pluginId,
      userId
    );
  }

  getAvailableTTSModels(userId?: string): {
    model: string;
    plugin: string;
    config?: TTSConfig;
  }[] {
    return this.ttsService.getAvailableTTSModels(userId);
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
    } = {}
  ): Promise<Buffer> {
    return this.ttsService.executeVoiceCloneRequest(
      model,
      input,
      referenceAudio,
      options
    );
  }

  getTTSConfig(pluginId: string, userId?: string): TTSConfig | null {
    return this.ttsService.getTTSConfig(pluginId, userId);
  }

  getPluginForImageGen(
    model: string,
    pluginId: string,
    userId?: string
  ): Plugin | null {
    return this.imageGenerationService.getPluginForImageGen(
      model,
      pluginId,
      userId
    );
  }

  getAvailableImageGenModels(userId?: string): {
    model: string;
    plugin: string;
    config?: ImageGenConfig;
  }[] {
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
    }
  ): Promise<ImageGenResponse> {
    return this.imageGenerationService.executeImageGenRequest(
      model,
      prompt,
      options
    );
  }

  getImageGenConfig(pluginId: string, userId?: string): ImageGenConfig | null {
    return this.imageGenerationService.getImageGenConfig(pluginId, userId);
  }

  getPluginsByCapability(
    capabilityType: PluginType,
    userId?: string
  ): Plugin[] {
    return this.capabilityRegistryService.getPluginsByCapability(
      capabilityType,
      userId
    );
  }

  getAvailableAudioGenModels(userId?: string): Array<{
    model: string;
    plugin: string;
    config?: AudioGenConfig;
  }> {
    return this.audioGenerationService.getAvailableModels(userId);
  }

  executeAudioGenRequest(
    model: string,
    prompt: string,
    options: Parameters<PluginAudioGenerationService['generate']>[2]
  ) {
    return this.audioGenerationService.generate(model, prompt, options);
  }

  getAvailableVideoGenModels(userId?: string): Array<{
    model: string;
    plugin: string;
    config?: VideoGenConfig;
  }> {
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
    userId: string
  ) {
    return this.videoGenerationService.poll(
      model,
      providerJobId,
      pluginId,
      userId
    );
  }

  downloadVideoGenResult(
    model: string,
    providerJobId: string,
    pluginId: string,
    userId: string
  ) {
    return this.videoGenerationService.download(
      model,
      providerJobId,
      pluginId,
      userId
    );
  }
}

export default new PluginService();
