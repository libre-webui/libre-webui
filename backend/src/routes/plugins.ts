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

import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import rateLimit from '../middleware/sharedRateLimit.js';
import pluginService, {
  type PluginModelDiscoveryResult,
} from '../services/pluginService.js';
import pluginCredentialsService from '../services/pluginCredentialsService.js';
import pluginVariablesService, {
  PluginVariableValue,
} from '../services/pluginVariablesService.js';
import {
  ApiResponse,
  Plugin,
  PluginStatus,
  getErrorMessage,
} from '../types/index.js';
import {
  pluginUpload as upload,
  pluginUploadTempDirectory,
  safeCleanupFile,
  type MulterRequest,
} from '../utils/pluginUpload.js';
import {
  validatePluginVariables,
  validatePluginVariablesToUnset,
} from '../utils/pluginVariableValidation.js';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth.js';
import { userModel } from '../models/userModel.js';
import { isPluginConnectionVariableForPlugin } from '../utils/pluginConnectionVariables.js';
import {
  inferPluginApiMode,
  PLUGIN_MODEL_DISCOVERY_VARIABLES,
} from '../utils/pluginValidation.js';
import type { PluginVariableDefinition } from '../types/index.js';
import pluginUsageService, {
  type PluginUsageAnalytics,
} from '../services/pluginUsageService.js';

const router = express.Router();

const getRequestUserId = (req: Request): string => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) {
    throw new Error('Authenticated user context is required');
  }
  return userId;
};

const requestUserIsAdmin = async (req: Request): Promise<boolean> => {
  const userId = (req as AuthenticatedRequest).user?.userId;
  if (!userId) return false;

  try {
    return (await userModel.getUserById(userId))?.role === 'admin';
  } catch {
    return false;
  }
};

const supportsCompletionModelDiscovery = (plugin: Plugin): boolean =>
  plugin.type === 'completion' || plugin.type === 'chat';

const DISCOVERABLE_MEDIA_CAPABILITIES = [
  'image',
  'tts',
  'audio',
  'video',
] as const;

const getModelDiscoveryVariableNames = (
  plugin: Plugin
): ReadonlySet<string> => {
  const names = new Set<string>(PLUGIN_MODEL_DISCOVERY_VARIABLES);

  for (const capability of Object.values(
    (plugin.capabilities || {}) as Record<string, unknown>
  )) {
    if (!capability || typeof capability !== 'object') continue;
    const capabilityRecord = capability as Record<string, unknown>;
    const config =
      capabilityRecord.config && typeof capabilityRecord.config === 'object'
        ? (capabilityRecord.config as Record<string, unknown>)
        : {};
    const selectors = [
      config.endpoint_variable ?? capabilityRecord.endpoint_variable,
      config.models_endpoint_variable,
    ];
    for (const selector of selectors) {
      if (typeof selector === 'string' && selector.trim()) {
        names.add(selector.trim());
      }
    }
  }

  return names;
};

const modelDiscoveryConnectionChanged = (
  plugin: Plugin,
  previousVariables: Record<string, string | number | boolean>,
  nextVariables: Record<string, string | number | boolean>
): boolean =>
  [...getModelDiscoveryVariableNames(plugin)].some(
    name => previousVariables[name] !== nextVariables[name]
  );

const matchesInheritedDefault = (
  plugin: Plugin,
  definition: PluginVariableDefinition,
  value: string | number | boolean
): boolean => {
  let inheritedValue = definition.default;
  if (inheritedValue === undefined) {
    if (definition.name === 'endpoint' || definition.name === 'api_url') {
      inheritedValue = plugin.endpoint;
    } else if (definition.name === 'base_url') {
      inheritedValue = plugin.base_url;
    } else if (definition.name === 'api_path') {
      inheritedValue = plugin.api_path;
    } else if (definition.name === 'api_mode') {
      inheritedValue = plugin.api_mode ?? inferPluginApiMode(plugin.endpoint);
    } else {
      for (const capability of Object.values(
        (plugin.capabilities || {}) as Record<string, unknown>
      )) {
        if (!capability || typeof capability !== 'object') continue;
        const capabilityRecord = capability as Record<string, unknown>;
        const config =
          capabilityRecord.config && typeof capabilityRecord.config === 'object'
            ? (capabilityRecord.config as Record<string, unknown>)
            : {};
        const endpointSelector =
          config.endpoint_variable ?? capabilityRecord.endpoint_variable;
        if (
          endpointSelector === definition.name &&
          typeof capabilityRecord.endpoint === 'string'
        ) {
          inheritedValue = capabilityRecord.endpoint;
          break;
        }
        if (
          config.models_endpoint_variable === definition.name &&
          typeof capabilityRecord.models_endpoint === 'string'
        ) {
          inheritedValue = capabilityRecord.models_endpoint;
          break;
        }
      }
    }
  }

  const defaultValidation = validatePluginVariables([definition], {
    [definition.name]: inheritedValue ?? '',
  });
  return (
    defaultValidation.success &&
    Object.is(defaultValidation.variables[definition.name], value)
  );
};

const refreshUserModels = async (
  plugin: Plugin,
  userId: string,
  clearExisting = true
): Promise<void> => {
  const capabilities = DISCOVERABLE_MEDIA_CAPABILITIES.filter(
    capability => plugin.capabilities?.[capability]?.models_endpoint
  );
  if (!supportsCompletionModelDiscovery(plugin) && capabilities.length === 0) {
    return;
  }
  if (clearExisting) {
    await pluginService.clearDiscoveredModels(plugin.id, userId);
  }
  await Promise.all([
    ...(supportsCompletionModelDiscovery(plugin)
      ? [pluginService.discoverModels(plugin.id, userId).catch(() => {})]
      : []),
    ...capabilities.map(capability =>
      pluginService
        .discoverCapabilityModels(plugin.id, capability, userId)
        .catch(() => {})
    ),
  ]);
};

// Rate limiting for plugin operations
const pluginRateLimit = rateLimit({
  keyPrefix: 'plugins-operations',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many plugin requests from this IP, please try again later.',
  },
});

// More restrictive rate limiting for upload operations
const uploadRateLimit = rateLimit({
  keyPrefix: 'plugins-upload',
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 uploads per windowMs
  message: {
    success: false,
    error: 'Too many upload requests from this IP, please try again later.',
  },
});

// Get all plugins
router.get(
  '/',
  async (req: Request, res: Response<ApiResponse<Plugin[]>>): Promise<void> => {
    try {
      const userId = getRequestUserId(req);
      // Keep provider catalogs current: a stale or never-discovered model list
      // is refreshed here so a browser reload reflects the provider's models.
      await pluginService.refreshStaleModels(userId).catch(() => {});
      const plugins = await pluginService.getAllPlugins(userId);
      res.json({
        success: true,
        data: plugins,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load plugins'),
      });
    }
  }
);

// Get active plugins
router.get(
  '/active',
  async (req: Request, res: Response<ApiResponse<Plugin[]>>): Promise<void> => {
    try {
      const activePlugins = await pluginService.getActivePlugins(
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: activePlugins,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get active plugins'),
      });
    }
  }
);

// Get active plugin (alternative route)
router.get(
  '/active/current',
  async (
    req: Request,
    res: Response<ApiResponse<Plugin | null>>
  ): Promise<void> => {
    try {
      const activePlugin = await pluginService.getActivePlugin(
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: activePlugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get active plugin'),
      });
    }
  }
);

// Get plugin status
router.get(
  '/status/all',
  async (
    req: Request,
    res: Response<ApiResponse<PluginStatus[]>>
  ): Promise<void> => {
    try {
      const status = await pluginService.getPluginStatus(getRequestUserId(req));

      res.json({
        success: true,
        data: status,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin status'),
      });
    }
  }
);

// Instance-wide provider consumption. Only administrators may inspect usage
// aggregated across accounts; raw prompts and responses are never stored.
router.get(
  '/usage',
  requireAdmin,
  async (
    req: Request,
    res: Response<ApiResponse<PluginUsageAnalytics>>
  ): Promise<void> => {
    const daysValue = Array.isArray(req.query.days)
      ? req.query.days[0]
      : req.query.days;
    const days = daysValue === undefined ? 30 : Number(daysValue);
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      res.status(400).json({
        success: false,
        error: 'days must be an integer between 1 and 365',
      });
      return;
    }

    try {
      res.json({
        success: true,
        data: await pluginUsageService.getAnalytics(days),
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to load plugin usage'),
      });
    }
  }
);

// Get a specific plugin
router.get(
  '/:id',
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const plugin = await pluginService.getPlugin(id, getRequestUserId(req));

      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin'),
      });
    }
  }
);

// Upload and install a plugin
router.post(
  '/upload',
  requireAdmin,
  uploadRateLimit,
  upload.single('plugin'),
  async (
    req: MulterRequest,
    res: Response<ApiResponse<Plugin>>
  ): Promise<void> => {
    const tempDir = pluginUploadTempDirectory;

    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded',
        });
        return;
      }

      // Validate file path is within temp directory
      const resolvedFilePath = path.resolve(req.file.path);
      const relativePath = path.relative(tempDir, resolvedFilePath);
      if (
        !relativePath ||
        relativePath.startsWith('..') ||
        path.isAbsolute(relativePath)
      ) {
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'Invalid file path',
        });
        return;
      }

      const fileExt = path.extname(req.file.originalname).toLowerCase();
      let pluginData: unknown;

      if (fileExt === '.json') {
        // Handle JSON file with safe path handling
        const fileContent = fs.readFileSync(resolvedFilePath, 'utf8');
        pluginData = JSON.parse(fileContent);
      } else if (fileExt === '.zip') {
        // Handle ZIP file (for future extension)
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'ZIP file support is not implemented yet',
        });
        return;
      } else {
        // Clean up invalid file type
        safeCleanupFile(req.file.path, tempDir);
        res.status(400).json({
          success: false,
          error: 'Unsupported file type',
        });
        return;
      }

      // Clean up uploaded file after reading
      safeCleanupFile(req.file.path, tempDir);

      // Install the plugin
      const plugin = await pluginService.importPlugin(
        pluginData,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      // Clean up uploaded file if it exists
      if (req.file) {
        safeCleanupFile(req.file.path, tempDir);
      }

      const errorMessage = getErrorMessage(error, 'Failed to upload plugin');

      if (errorMessage.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: errorMessage,
        });
      } else if (errorMessage.includes('Invalid')) {
        res.status(400).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Install plugin from JSON data (alternative to file upload)
router.post(
  '/install',
  requireAdmin,
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const pluginData = req.body;
      const plugin = await pluginService.installPlugin(
        pluginData,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to install plugin');

      if (errorMessage.includes('already exists')) {
        res.status(409).json({
          success: false,
          error: errorMessage,
        });
      } else if (errorMessage.includes('Invalid')) {
        res.status(400).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Update a plugin
router.put(
  '/:id',
  requireAdmin,
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<Plugin>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const updates = req.body;

      // Ensure the ID matches
      if (updates.id && updates.id !== id) {
        res.status(400).json({
          success: false,
          error: 'Plugin ID in body does not match URL parameter',
        });
        return;
      }

      updates.id = id;
      const plugin = await pluginService.installPlugin(
        updates,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: plugin,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to update plugin'),
      });
    }
  }
);

// Delete a plugin
router.delete(
  '/:id',
  requireAdmin,
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const success = await pluginService.deletePlugin(id);

      if (!success) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      res.json({
        success: true,
        data: true,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete plugin'),
      });
    }
  }
);

// Activate a plugin
router.post(
  '/activate/:id',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const userId = getRequestUserId(req);
      const success = await pluginService.activatePlugin(id, userId);

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, 'Failed to activate plugin');

      if (errorMessage.includes('not found')) {
        res.status(404).json({
          success: false,
          error: errorMessage,
        });
      } else {
        res.status(500).json({
          success: false,
          error: errorMessage,
        });
      }
    }
  }
);

// Discover available models from a plugin's API
router.post(
  '/discover/:id',
  pluginRateLimit,
  async (
    req: Request,
    res: Response<ApiResponse<PluginModelDiscoveryResult>>
  ): Promise<void> => {
    try {
      const id = req.params.id as string;
      // Report the outcome rather than only the catalog: without a usable API
      // key or a reachable provider the returned models are the previous ones,
      // and the caller must not present that as a refresh.
      const result = await pluginService.discoverModelsResult(
        id,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to discover models'),
      });
    }
  }
);

// Deactivate a specific plugin
router.post(
  '/deactivate/:id',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const success = await pluginService.deactivatePlugin(
        id,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to deactivate plugin'),
      });
    }
  }
);

// Deactivate all plugins (legacy)
router.post(
  '/deactivate',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const success = await pluginService.deactivatePlugin(
        undefined,
        getRequestUserId(req)
      );

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to deactivate plugin'),
      });
    }
  }
);

// Export plugin
router.get(
  '/:id/export',
  async (req: Request, res: Response): Promise<void> => {
    try {
      const id = req.params.id as string;
      const plugin = await pluginService.exportPlugin(
        id,
        getRequestUserId(req)
      );

      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      // Remove runtime properties for export
      const exportData = {
        ...plugin,
        active: undefined,
        created_at: undefined,
        updated_at: undefined,
      };

      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${id}.json"`);
      res.send(JSON.stringify(exportData, null, 2));
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to export plugin'),
      });
    }
  }
);

// ============================================
// Plugin Credentials Endpoints
// ============================================

// Get all credentials for current user (API keys are masked)
router.get(
  '/credentials/all',
  async (
    req: Request,
    res: Response<
      ApiResponse<
        Array<{ plugin_id: string; has_api_key: boolean; updated_at: number }>
      >
    >
  ): Promise<void> => {
    try {
      // Get userId from auth context (defaults to 'default' for single-user mode)
      const userId = getRequestUserId(req);
      const credentials = await Promise.all(
        (await pluginCredentialsService.getCredentials(userId)).map(
          async credential => {
            const plugin = await pluginService.getPlugin(
              credential.plugin_id,
              userId
            );
            return {
              ...credential,
              has_api_key:
                plugin !== null &&
                (await pluginService.getApiKey(plugin, userId)) !== null,
            };
          }
        )
      );

      res.json({
        success: true,
        data: credentials,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin credentials'),
      });
    }
  }
);

// Set API key for a plugin
router.post(
  '/:id/credentials',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const { api_key } = req.body;
      const userId = getRequestUserId(req);

      if (!api_key || typeof api_key !== 'string') {
        res.status(400).json({
          success: false,
          error: 'API key is required',
        });
        return;
      }

      // Verify plugin exists
      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      const success = await pluginCredentialsService.setApiKey(
        id,
        api_key,
        userId,
        await pluginService.getCredentialRoutingAuthFingerprint(plugin, userId)
      );

      if (success) {
        await refreshUserModels(plugin, userId, true);
        res.json({
          success: true,
          data: true,
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to save API key',
        });
      }
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set API key'),
      });
    }
  }
);

// Delete API key for a plugin
router.delete(
  '/:id/credentials',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const userId = getRequestUserId(req);

      // Verify plugin exists
      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      const success = await pluginCredentialsService.deleteApiKey(id, userId);
      if (success) {
        await refreshUserModels(plugin, userId, true);
      }

      res.json({
        success: true,
        data: success,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to delete API key'),
      });
    }
  }
);

// Check if API key exists for a plugin (without revealing the key)
router.get(
  '/:id/credentials/check',
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const userId = getRequestUserId(req);

      // Verify plugin exists
      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({
          success: false,
          error: 'Plugin not found',
        });
        return;
      }

      const hasKey = pluginService.getApiKey(plugin, userId) !== null;

      res.json({
        success: true,
        data: hasKey,
      });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to check API key'),
      });
    }
  }
);

// ============================================================================
// Plugin Variables (Valves)
// ============================================================================

// Get variable values for a plugin
router.get(
  '/:id/variables',
  async (
    req: Request,
    res: Response<ApiResponse<Record<string, PluginVariableValue>>>
  ): Promise<void> => {
    try {
      const id = req.params.id as string;
      const userId = getRequestUserId(req);

      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({ success: false, error: 'Plugin not found' });
        return;
      }

      if (!plugin.variables || plugin.variables.length === 0) {
        res.json({ success: true, data: {} });
        return;
      }

      const variables = await pluginVariablesService.getVariables(
        id,
        plugin.variables,
        userId,
        true // forDisplay - mask sensitive values
      );
      if (!(await requestUserIsAdmin(req))) {
        for (const definition of plugin.variables) {
          if (!isPluginConnectionVariableForPlugin(plugin, definition.name)) {
            continue;
          }
          variables[definition.name] = {
            name: definition.name,
            value: definition.sensitive ? '' : (definition.default ?? ''),
            is_sensitive: definition.sensitive ?? false,
            has_value: false,
          };
        }
      }

      res.json({ success: true, data: variables });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to get plugin variables'),
      });
    }
  }
);

// Set variable values for a plugin
router.put(
  '/:id/variables',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const { variables, unset } = req.body ?? {};
      const userId = getRequestUserId(req);

      if (
        !variables ||
        typeof variables !== 'object' ||
        Array.isArray(variables)
      ) {
        res
          .status(400)
          .json({ success: false, error: 'Variables object is required' });
        return;
      }

      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({ success: false, error: 'Plugin not found' });
        return;
      }

      if (!plugin.variables || plugin.variables.length === 0) {
        res.status(400).json({
          success: false,
          error: 'Plugin has no configurable variables',
        });
        return;
      }

      const submittedNames = Object.keys(variables);
      const requestedUnsetNames = Array.isArray(unset)
        ? unset.filter((name): name is string => typeof name === 'string')
        : [];
      if (
        !(await requestUserIsAdmin(req)) &&
        [...submittedNames, ...requestedUnsetNames].some(name =>
          isPluginConnectionVariableForPlugin(plugin, name)
        )
      ) {
        res.status(403).json({
          success: false,
          error: 'Administrator access is required to change provider routing',
        });
        return;
      }

      const validation = validatePluginVariables(
        plugin.variables,
        variables as Record<string, unknown>
      );
      if (!validation.success) {
        res.status(400).json({ success: false, error: validation.error });
        return;
      }

      const unsetValidation = validatePluginVariablesToUnset(
        plugin.variables,
        unset
      );
      if (!unsetValidation.success) {
        res.status(400).json({ success: false, error: unsetValidation.error });
        return;
      }

      const validatedSubmittedNames = new Set(
        Object.keys(validation.variables)
      );
      const overlap = unsetValidation.variables.find(name =>
        validatedSubmittedNames.has(name)
      );
      if (overlap) {
        res.status(400).json({
          success: false,
          error: `Variable "${overlap}" cannot be both set and unset`,
        });
        return;
      }

      const definitionsByName = new Map(
        plugin.variables.map(definition => [definition.name, definition])
      );
      const variablesToSet = { ...validation.variables };
      const variablesToUnset = new Set(unsetValidation.variables);

      // A submitted manifest default is inherited state, not a user override.
      // Keep it sparse so trusted environment credentials do not become bound
      // to a redundant stored routing row.
      for (const [name, value] of Object.entries(variablesToSet)) {
        const definition = definitionsByName.get(name);
        if (
          definition &&
          isPluginConnectionVariableForPlugin(plugin, name) &&
          matchesInheritedDefault(plugin, definition, value)
        ) {
          delete variablesToSet[name];
          variablesToUnset.add(name);
        }
      }

      const previousVariables =
        await pluginVariablesService.getResolvedVariables(
          id,
          plugin.variables,
          userId
        );
      const success = await pluginVariablesService.setVariables(
        id,
        variablesToSet,
        plugin.variables,
        userId,
        [...variablesToUnset]
      );

      if (success) {
        const nextVariables = await pluginVariablesService.getResolvedVariables(
          id,
          plugin.variables,
          userId
        );
        if (
          modelDiscoveryConnectionChanged(
            plugin,
            previousVariables,
            nextVariables
          )
        ) {
          await refreshUserModels(plugin, userId);
        }
        res.json({ success: true, data: true });
      } else {
        res
          .status(500)
          .json({ success: false, error: 'Failed to save plugin variables' });
      }
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to set plugin variables'),
      });
    }
  }
);

// Reset all variable values for a plugin (back to defaults)
router.delete(
  '/:id/variables',
  pluginRateLimit,
  async (req: Request, res: Response<ApiResponse<boolean>>): Promise<void> => {
    try {
      const id = req.params.id as string;
      const userId = getRequestUserId(req);

      const plugin = await pluginService.getPlugin(id, userId);
      if (!plugin) {
        res.status(404).json({ success: false, error: 'Plugin not found' });
        return;
      }

      // A full account-scoped reset also purges ignored legacy routing rows.
      // Non-admins still cannot target routing variables through the update
      // endpoint, but reset must not leave dormant values that a later role
      // promotion could reactivate.
      const previousVariables = plugin.variables
        ? await pluginVariablesService.getResolvedVariables(
            id,
            plugin.variables,
            userId
          )
        : {};
      const success = await pluginVariablesService.deletePluginVariables(
        id,
        userId
      );
      if (!success) {
        res.status(500).json({
          success: false,
          error: 'Failed to reset plugin variables',
        });
        return;
      }

      if (plugin.variables) {
        const nextVariables = await pluginVariablesService.getResolvedVariables(
          id,
          plugin.variables,
          userId
        );
        if (
          modelDiscoveryConnectionChanged(
            plugin,
            previousVariables,
            nextVariables
          )
        ) {
          await refreshUserModels(plugin, userId);
        }
      }

      res.json({ success: true, data: true });
    } catch (error: unknown) {
      res.status(500).json({
        success: false,
        error: getErrorMessage(error, 'Failed to reset plugin variables'),
      });
    }
  }
);

export default router;
