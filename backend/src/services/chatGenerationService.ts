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

import { mergeGenerationOptions } from '../utils/generationUtils.js';
import { personaService } from './personaService.js';
import pluginService from './pluginService.js';
import preferencesService from './preferencesService.js';
import type { ChatSession, GenerationOptions, Plugin } from '../types/index.js';

export const AUTO_TITLE_CURRENT_MODEL = '__current_running_model__';

export interface GenerationTarget {
  actualModelName: string;
  mergedOptions: GenerationOptions;
  activePlugin: Plugin | null;
  pluginVariables: Record<string, string | number | boolean>;
}

class ChatGenerationService {
  async resolveActualModelName(
    sessionModel: string,
    userId: string = 'default'
  ): Promise<string> {
    if (!sessionModel.startsWith('persona:')) {
      return sessionModel;
    }

    try {
      const personaId = sessionModel.replace('persona:', '');

      let persona = await personaService.getPersonaById(personaId, userId);
      if (!persona && userId !== 'default') {
        persona = await personaService.getPersonaById(personaId, 'default');
      }

      if (persona?.model) {
        return persona.model;
      }

      console.warn(
        `Persona ${personaId} not found, falling back to session model`
      );
      return sessionModel;
    } catch (error) {
      console.error('Error resolving persona model:', error);
      return sessionModel;
    }
  }

  async resolveTitleGenerationModel(
    requestedModel: string,
    session: ChatSession,
    userId: string
  ): Promise<string> {
    if (requestedModel === AUTO_TITLE_CURRENT_MODEL) {
      return this.resolveActualModelName(session.model, userId);
    }

    return requestedModel;
  }

  mergeOptions(options: GenerationOptions = {}): GenerationOptions {
    return mergeGenerationOptions(
      preferencesService.getGenerationOptions(),
      options
    );
  }

  async prepareGenerationTarget(
    sessionModel: string,
    userId: string,
    options: GenerationOptions = {}
  ): Promise<GenerationTarget> {
    const actualModelName = await this.resolveActualModelName(
      sessionModel,
      userId
    );
    const mergedOptions = this.mergeOptions(options);
    const activePlugin = pluginService.getActivePluginForModel(
      actualModelName,
      userId
    );
    const pluginVariables = activePlugin
      ? pluginService.getPluginVariables(activePlugin, userId)
      : {};

    return {
      actualModelName,
      mergedOptions,
      activePlugin,
      pluginVariables,
    };
  }
}

export default new ChatGenerationService();
