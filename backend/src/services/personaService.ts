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
   * Get all personas for a user with optional advanced features
   */
  async getPersonas(userId: string = 'default'): Promise<Persona[]> {
    const basePersonas = await personaModel.getPersonas(userId);

    // Check each persona for advanced features and merge them
    const enhancedPersonas = await Promise.all(
      basePersonas.map(async (persona): Promise<Persona> => {
        // Check if this persona has advanced features stored
        const advancedFeatures = await this.getAdvancedFeatures(
          persona.id,
          userId
        );

        return {
          ...persona,
          ...advancedFeatures,
        };
      })
    );

    return enhancedPersonas;
  }

  /**
   * Get advanced features for a persona if they exist
   */
  private async getAdvancedFeatures(
    personaId: string,
    userId: string
  ): Promise<{
    embedding_model?: string;
    memory_settings?: {
      enabled: boolean;
      max_memories: number;
      auto_cleanup: boolean;
      retention_days: number;
    };
    mutation_settings?: {
      enabled: boolean;
      sensitivity: 'low' | 'medium' | 'high';
      auto_adapt: boolean;
    };
  }> {
    try {
      const { getDatabase } = await import('../db.js');
      const db = getDatabase();

      // Retrieve the embedding_model and other advanced features from the database
      const personaAdvancedData = db
        .prepare(
          `
          SELECT embedding_model, memory_settings, mutation_settings 
          FROM personas 
          WHERE id = ? AND user_id = ?
        `
        )
        .get(personaId, userId) as
        | {
            embedding_model?: string;
            memory_settings?: string;
            mutation_settings?: string;
          }
        | undefined;

      if (!personaAdvancedData) {
        return {};
      }

      // Parse JSON settings or use defaults
      let memorySettings;
      let mutationSettings;

      try {
        memorySettings = personaAdvancedData.memory_settings
          ? JSON.parse(personaAdvancedData.memory_settings)
          : undefined;
      } catch {
        memorySettings = undefined;
      }

      try {
        mutationSettings = personaAdvancedData.mutation_settings
          ? JSON.parse(personaAdvancedData.mutation_settings)
          : undefined;
      } catch {
        mutationSettings = undefined;
      }

      // Check if persona has memory entries to determine if it has advanced features
      const memoryCheck = db
        .prepare(
          `
        SELECT COUNT(*) as count FROM persona_memories 
        WHERE persona_id = ? AND user_id = ?
      `
        )
        .get(personaId, userId) as { count: number } | undefined;

      const stateCheck = db
        .prepare(
          `
        SELECT * FROM persona_states 
        WHERE persona_id = ? AND user_id = ?
      `
        )
        .get(personaId, userId) as Record<string, unknown> | undefined;

      // If persona has memories, state, or stored advanced settings, return advanced features
      if (
        (memoryCheck?.count ?? 0) > 0 ||
        stateCheck ||
        personaAdvancedData.embedding_model ||
        memorySettings ||
        mutationSettings
      ) {
        return {
          embedding_model:
            personaAdvancedData.embedding_model || 'nomic-embed-text',
          memory_settings: memorySettings || {
            enabled: true,
            max_memories: 1000,
            auto_cleanup: true,
            retention_days: 90,
          },
          mutation_settings: mutationSettings || {
            enabled: true,
            sensitivity: 'medium' as const,
            auto_adapt: true,
          },
        };
      }

      return {};
    } catch (_error) {
      // If tables don't exist or error occurs, return empty
      return {};
    }
  }

  /**
   * Get all personas for a user (original method)
   */
  async getBasicPersonas(userId: string = 'default'): Promise<Persona[]> {
    return await personaModel.getPersonas(userId);
  }

  /**
   * Get a specific persona by ID with optional advanced features
   */
  async getPersonaById(
    id: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    const basePersona = await personaModel.getPersonaById(id, userId);
    if (!basePersona) {
      return null;
    }

    // Check for advanced features and merge them
    const advancedFeatures = await this.getAdvancedFeatures(id, userId);

    return {
      ...basePersona,
      ...advancedFeatures,
    };
  }

  /**
   * Get a specific persona by ID (basic version)
   */
  async getBasicPersonaById(
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

    const createdPersona = await personaModel.createPersona(
      personaData,
      userId
    );

    // If advanced features are provided, initialize them
    if (data.memory_settings?.enabled || data.mutation_settings?.enabled) {
      await this.initializeAdvancedFeatures(createdPersona.id, userId, {
        embedding_model: data.embedding_model,
        memory_settings: data.memory_settings,
        mutation_settings: data.mutation_settings,
      });
    }

    // Return enhanced persona with advanced features if they were initialized
    return (
      (await this.getPersonaById(createdPersona.id, userId)) || createdPersona
    );
  }

  /**
   * Initialize advanced features for a persona
   */
  private async initializeAdvancedFeatures(
    personaId: string,
    userId: string,
    features: {
      embedding_model?: string;
      memory_settings?: {
        enabled: boolean;
        max_memories: number;
        auto_cleanup: boolean;
        retention_days: number;
      };
      mutation_settings?: {
        enabled: boolean;
        sensitivity: 'low' | 'medium' | 'high';
        auto_adapt: boolean;
      };
    }
  ): Promise<void> {
    try {
      // Initialize mutation engine state if mutation settings are enabled
      if (features.mutation_settings?.enabled) {
        const { mutationEngineService } = await import(
          './mutationEngineService.js'
        );
        await mutationEngineService.initializePersonaState(personaId, userId);
      }
    } catch (error) {
      console.error('Failed to initialize advanced features:', error);
      // Don't throw error - persona creation should still succeed
    }
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
      // Include advanced features in export
      embedding_model: persona.embedding_model,
      memory_settings: persona.memory_settings,
      mutation_settings: persona.mutation_settings,
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
      // Include advanced features from import data
      embedding_model: personaData.embedding_model,
      memory_settings: personaData.memory_settings,
      mutation_settings: personaData.mutation_settings,
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
