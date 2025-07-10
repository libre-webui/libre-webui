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

import { personaModel } from '../models/personaModel.js';
import {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
  PersonaExport,
} from '../types/index.js';

export class PersonaService {
  /**
   * Get all personas for a user
   */
  async getPersonas(userId: string = 'default'): Promise<Persona[]> {
    return await personaModel.getPersonas(userId);
  }

  /**
   * Get a specific persona by ID
   */
  async getPersonaById(
    id: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    return await personaModel.getPersonaById(id, userId);
  }

  /**
   * Create a new persona with validation
   */
  async createPersona(
    data: CreatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona> {
    // Validate required fields
    if (!data.name || !data.name.trim()) {
      throw new Error('Persona name is required');
    }

    if (!data.model || !data.model.trim()) {
      throw new Error('Model is required');
    }

    // Check for duplicate name
    const existingPersona = await personaModel.getPersonaByName(
      data.name.trim(),
      userId
    );
    if (existingPersona) {
      throw new Error('A persona with this name already exists');
    }

    // Validate parameters
    if (!data.parameters) {
      throw new Error('Persona parameters are required');
    }

    // Set default parameters if not provided
    const parameters = {
      temperature: data.parameters.temperature ?? 0.7,
      top_p: data.parameters.top_p ?? 0.9,
      top_k: data.parameters.top_k ?? 40,
      context_window: data.parameters.context_window ?? 4096,
      max_tokens: data.parameters.max_tokens ?? 1024,
      system_prompt: data.parameters.system_prompt ?? '',
      repeat_penalty: data.parameters.repeat_penalty ?? 1.1,
      presence_penalty: data.parameters.presence_penalty ?? 0.0,
      frequency_penalty: data.parameters.frequency_penalty ?? 0.0,
    };

    // Validate parameter ranges
    if (parameters.temperature < 0 || parameters.temperature > 2) {
      throw new Error('Temperature must be between 0 and 2');
    }

    if (parameters.top_p < 0 || parameters.top_p > 1) {
      throw new Error('Top P must be between 0 and 1');
    }

    if (parameters.top_k < 1 || parameters.top_k > 100) {
      throw new Error('Top K must be between 1 and 100');
    }

    if (parameters.context_window < 128 || parameters.context_window > 131072) {
      throw new Error('Context window must be between 128 and 131072');
    }

    if (parameters.max_tokens < 1 || parameters.max_tokens > 8192) {
      throw new Error('Max tokens must be between 1 and 8192');
    }

    const personaData: CreatePersonaRequest = {
      ...data,
      name: data.name.trim(),
      model: data.model.trim(),
      parameters,
    };

    return await personaModel.createPersona(personaData, userId);
  }

  /**
   * Update an existing persona with validation
   */
  async updatePersona(
    id: string,
    data: UpdatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona | null> {
    const existingPersona = await personaModel.getPersonaById(id, userId);
    if (!existingPersona) {
      throw new Error('Persona not found');
    }

    // Validate name if provided
    if (data.name !== undefined) {
      if (!data.name.trim()) {
        throw new Error('Persona name cannot be empty');
      }

      // Check for duplicate name (excluding current persona)
      const duplicatePersona = await personaModel.getPersonaByName(
        data.name.trim(),
        userId
      );
      if (duplicatePersona && duplicatePersona.id !== id) {
        throw new Error('A persona with this name already exists');
      }
    }

    // Validate model if provided
    if (data.model !== undefined && !data.model.trim()) {
      throw new Error('Model cannot be empty');
    }

    // Validate parameters if provided
    if (data.parameters) {
      if (data.parameters.temperature !== undefined) {
        if (
          data.parameters.temperature < 0 ||
          data.parameters.temperature > 2
        ) {
          throw new Error('Temperature must be between 0 and 2');
        }
      }

      if (data.parameters.top_p !== undefined) {
        if (data.parameters.top_p < 0 || data.parameters.top_p > 1) {
          throw new Error('Top P must be between 0 and 1');
        }
      }

      if (data.parameters.top_k !== undefined) {
        if (data.parameters.top_k < 1 || data.parameters.top_k > 100) {
          throw new Error('Top K must be between 1 and 100');
        }
      }

      if (data.parameters.context_window !== undefined) {
        if (
          data.parameters.context_window < 128 ||
          data.parameters.context_window > 131072
        ) {
          throw new Error('Context window must be between 128 and 131072');
        }
      }

      if (data.parameters.max_tokens !== undefined) {
        if (
          data.parameters.max_tokens < 1 ||
          data.parameters.max_tokens > 8192
        ) {
          throw new Error('Max tokens must be between 1 and 8192');
        }
      }
    }

    const updateData = { ...data };
    if (updateData.name) {
      updateData.name = updateData.name.trim();
    }
    if (updateData.model) {
      updateData.model = updateData.model.trim();
    }

    return await personaModel.updatePersona(id, updateData, userId);
  }

  /**
   * Delete a persona
   */
  async deletePersona(
    id: string,
    userId: string = 'default'
  ): Promise<boolean> {
    const existingPersona = await personaModel.getPersonaById(id, userId);
    if (!existingPersona) {
      throw new Error('Persona not found');
    }

    return await personaModel.deletePersona(id, userId);
  }

  /**
   * Export a persona as JSON
   */
  async exportPersona(
    id: string,
    userId: string = 'default'
  ): Promise<PersonaExport> {
    const persona = await personaModel.getPersonaById(id, userId);
    if (!persona) {
      throw new Error('Persona not found');
    }

    return {
      name: persona.name,
      description: persona.description,
      model: persona.model,
      params: persona.parameters,
      avatar: persona.avatar,
      background: persona.background,
      exportedAt: Date.now(),
      version: '1.0.0',
    };
  }

  /**
   * Import a persona from JSON
   */
  async importPersona(
    personaData: PersonaExport,
    userId: string = 'default'
  ): Promise<Persona> {
    // Validate import data
    if (!personaData.name || !personaData.model || !personaData.params) {
      throw new Error('Invalid persona data: missing required fields');
    }

    // Create persona request from import data
    const createRequest: CreatePersonaRequest = {
      name: personaData.name,
      description: personaData.description,
      model: personaData.model,
      parameters: personaData.params,
      avatar: personaData.avatar,
      background: personaData.background,
    };

    // Check if persona with same name exists and add suffix if needed
    let finalName = createRequest.name;
    let counter = 1;
    while (await personaModel.getPersonaByName(finalName, userId)) {
      finalName = `${createRequest.name} (${counter})`;
      counter++;
    }
    createRequest.name = finalName;

    return await this.createPersona(createRequest, userId);
  }

  /**
   * Get personas count for a user
   */
  async getPersonasCount(userId: string = 'default'): Promise<number> {
    return await personaModel.getPersonasCount(userId);
  }

  /**
   * Get default persona parameters
   */
  getDefaultParameters() {
    return {
      temperature: 0.7,
      top_p: 0.9,
      top_k: 40,
      context_window: 4096,
      max_tokens: 1024,
      system_prompt: '',
      repeat_penalty: 1.1,
      presence_penalty: 0.0,
      frequency_penalty: 0.0,
    };
  }
}

export const personaService = new PersonaService();
