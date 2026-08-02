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

import { Plugin, PluginType } from '../types/index.js';

export interface PluginCapabilityRegistryDependencies {
  getAllPlugins(userId?: string): Plugin[];
  getApiKey(plugin: Plugin, userId?: string): string | null;
}

export class PluginCapabilityRegistryService {
  constructor(private readonly deps: PluginCapabilityRegistryDependencies) {}

  getPluginsByCapability(
    capabilityType: PluginType,
    userId?: string
  ): Plugin[] {
    const allPlugins = this.deps.getAllPlugins(userId);
    const result: Plugin[] = [];

    for (const plugin of allPlugins) {
      if (plugin.type === capabilityType) {
        const capabilityConfig =
          capabilityType === 'tts'
            ? plugin.capabilities?.tts?.config
            : capabilityType === 'image'
              ? plugin.capabilities?.image?.config
              : undefined;
        const noAuthRequired =
          (capabilityConfig as Record<string, unknown> | undefined)
            ?.no_auth_required === true;
        const apiKey = this.deps.getApiKey(plugin, userId);
        if (apiKey || noAuthRequired) {
          result.push(plugin);
        }
        continue;
      }

      if (plugin.capabilities) {
        let hasCapability = false;
        let noAuthRequired = false;

        switch (capabilityType) {
          case 'tts':
            hasCapability = !!plugin.capabilities.tts;
            noAuthRequired =
              (
                plugin.capabilities.tts?.config as
                  Record<string, unknown> | undefined
              )?.no_auth_required === true;
            break;
          case 'stt':
            hasCapability = !!plugin.capabilities.stt;
            break;
          case 'embedding':
            hasCapability = !!plugin.capabilities.embedding;
            break;
          case 'image':
            hasCapability = !!plugin.capabilities.image;
            noAuthRequired =
              (
                plugin.capabilities.image?.config as
                  Record<string, unknown> | undefined
              )?.no_auth_required === true;
            break;
          case 'audio':
            hasCapability = !!plugin.capabilities.audio;
            break;
          case 'video':
            hasCapability = !!plugin.capabilities.video;
            break;
          case 'completion':
          case 'chat':
            hasCapability = !!plugin.capabilities.completion;
            break;
        }

        if (hasCapability) {
          const apiKey = this.deps.getApiKey(plugin, userId);
          if (apiKey || noAuthRequired) {
            result.push(plugin);
          }
        }
      }
    }

    return result;
  }
}
