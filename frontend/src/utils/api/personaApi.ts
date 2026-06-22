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

import type {
  ApiResponse,
  CreatePersonaRequest,
  Persona,
  PersonaExport,
  PersonaParameters,
  UpdatePersonaRequest,
} from '@/types';
import { isDemoMode } from '@/utils/demoMode';
import { getPersonaAvatarFallback } from '@/utils/personaAvatar';
import { api, createDemoResponse, logger } from './client';

// === Persona API ===

export const personaApi = {
  // Get all personas
  getPersonas: (): Promise<ApiResponse<Persona[]>> => {
    if (isDemoMode()) {
      // Demo personas
      const demoPersonas: Persona[] = [
        {
          id: 'demo-1',
          user_id: 'default',
          name: 'Creative Assistant',
          description: 'Helpful assistant for creative tasks',
          model: 'llama3.3:latest',
          parameters: {
            temperature: 0.8,
            top_p: 0.9,
            context_window: 4096,
            system_prompt:
              'You are a creative and helpful assistant. Provide thoughtful and engaging responses.',
          },
          avatar: getPersonaAvatarFallback('Creative Assistant', 128),
          created_at: Date.now() - 86400000,
          updated_at: Date.now() - 86400000,
        },
        {
          id: 'demo-2',
          user_id: 'default',
          name: 'Research Assistant',
          description: 'Academic assistant for research and learning',
          model: 'qwen3:7b',
          parameters: {
            temperature: 0.3,
            top_p: 0.8,
            context_window: 8192,
            system_prompt:
              'You are a knowledgeable research assistant. Provide detailed, informative explanations.',
          },
          avatar: getPersonaAvatarFallback('Research Assistant', 128),
          created_at: Date.now() - 172800000,
          updated_at: Date.now() - 172800000,
        },
      ];
      return createDemoResponse(demoPersonas);
    }

    return api.get('/personas').then(res => res.data);
  },

  // Get persona by ID
  getPersona: (id: string): Promise<ApiResponse<Persona>> => {
    if (isDemoMode()) {
      const demoPersona: Persona = {
        id,
        user_id: 'default',
        name: 'Sample Assistant',
        description: 'A sample assistant for demonstration',
        model: 'llama3.2:latest',
        parameters: {
          temperature: 0.7,
          top_p: 0.9,
          context_window: 4096,
          system_prompt: 'You are a helpful assistant.',
        },
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      return createDemoResponse(demoPersona);
    }

    return api.get(`/personas/${id}`).then(res => res.data);
  },

  // Create persona
  createPersona: (
    data: CreatePersonaRequest
  ): Promise<ApiResponse<Persona>> => {
    if (isDemoMode()) {
      const newPersona: Persona = {
        id: 'demo-' + Date.now(),
        user_id: 'default',
        ...data,
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      return createDemoResponse(newPersona);
    }

    return api.post('/personas', data).then(res => res.data);
  },

  // Update persona
  updatePersona: (
    id: string,
    data: UpdatePersonaRequest
  ): Promise<ApiResponse<Persona>> => {
    if (isDemoMode()) {
      const updatedPersona: Persona = {
        id,
        user_id: 'default',
        name: data.name || 'Updated Sample Assistant',
        description: data.description,
        model: data.model || 'llama3.2:latest',
        parameters: data.parameters || {
          temperature: 0.7,
          top_p: 0.9,
          context_window: 4096,
          system_prompt: 'You are a helpful assistant.',
        },
        avatar: data.avatar,
        background: data.background,
        created_at: Date.now() - 86400000,
        updated_at: Date.now(),
      };
      return createDemoResponse(updatedPersona);
    }

    return api.put(`/personas/${id}`, data).then(res => res.data);
  },

  // Delete persona
  deletePersona: (id: string): Promise<ApiResponse<void>> => {
    if (isDemoMode()) {
      return createDemoResponse(undefined);
    }

    return api.delete(`/personas/${id}`).then(res => res.data);
  },

  // Export persona
  exportPersona: (id: string): Promise<PersonaExport> => {
    if (isDemoMode()) {
      const exportData: PersonaExport = {
        name: 'Sample Assistant',
        description: 'A sample assistant for demonstration',
        model: 'llama3.2:latest',
        params: {
          temperature: 0.7,
          top_p: 0.9,
          context_window: 4096,
          system_prompt: 'You are a helpful assistant.',
        },
        exportedAt: Date.now(),
        version: '1.0.0',
      };
      return Promise.resolve(exportData);
    }
    return api.get(`/personas/${id}/export`).then(res => res.data);
  },

  // Import persona
  importPersona: (data: PersonaExport): Promise<ApiResponse<Persona>> => {
    if (isDemoMode()) {
      const importedPersona: Persona = {
        id: 'demo-imported-' + Date.now(),
        user_id: 'default',
        name: data.name,
        description: data.description,
        model: data.model,
        parameters: data.params,
        avatar: data.avatar,
        background: data.background,
        created_at: Date.now(),
        updated_at: Date.now(),
        // Include advanced features from import data
        embedding_model: data.embedding_model,
        memory_settings: data.memory_settings,
        mutation_settings: data.mutation_settings,
      };
      return createDemoResponse(importedPersona);
    }

    return api.post('/personas/import', data).then(res => res.data);
  },

  // Get personas count
  getPersonasCount: (): Promise<ApiResponse<{ count: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ count: 2 });
    }

    return api.get('/personas/stats/count').then(res => res.data);
  },

  // Get default parameters
  getDefaultParameters: (): Promise<ApiResponse<PersonaParameters>> => {
    if (isDemoMode()) {
      return createDemoResponse({
        temperature: 0.7,
        top_p: 0.9,
        top_k: 40,
        context_window: 4096,
        max_tokens: 1024,
        system_prompt: '',
        repeat_penalty: 1.1,
        presence_penalty: 0.0,
        frequency_penalty: 0.0,
      });
    }

    return api.get('/personas/defaults/parameters').then(res => res.data);
  },

  // === Advanced Features (unified system) ===

  // Get memory status for a persona
  getMemoryStatus: (
    personaId: string
  ): Promise<
    ApiResponse<{
      status: 'active' | 'wiped' | 'backed_up';
      memory_count: number;
      last_backup: number;
      size_mb: number;
    }>
  > => {
    if (isDemoMode()) {
      return createDemoResponse({
        status: 'active' as const,
        memory_count: 42,
        last_backup: Date.now() - 86400000,
        size_mb: 2.3,
      });
    }
    return api
      .get(`/personas/${personaId}/memory/status`)
      .then(res => res.data);
  },

  // Wipe memories for a persona
  wipeMemories: (
    personaId: string
  ): Promise<ApiResponse<{ deleted_count: number }>> => {
    if (isDemoMode()) {
      return createDemoResponse({ deleted_count: 42 });
    }
    return api.delete(`/personas/${personaId}/memory`).then(res => res.data);
  },

  // Backup persona
  backupPersona: (personaId: string): Promise<Blob> => {
    if (isDemoMode()) {
      const demoData = JSON.stringify({
        persona_id: personaId,
        backup_date: new Date().toISOString(),
        data: 'demo backup data',
      });
      return Promise.resolve(
        new Blob([demoData], { type: 'application/json' })
      );
    }
    return api
      .get(`/personas/${personaId}/backup`, { responseType: 'blob' })
      .then(res => res.data);
  },

  // Export persona DNA
  exportPersonaDNA: (personaId: string): Promise<Blob> => {
    if (isDemoMode()) {
      const demoData = JSON.stringify({
        persona_id: personaId,
        export_date: new Date().toISOString(),
        dna: 'demo DNA data',
        memories: [],
        learned_behaviors: {},
      });
      return Promise.resolve(
        new Blob([demoData], { type: 'application/json' })
      );
    }
    return api
      .get(`/personas/${personaId}/export/dna`, { responseType: 'blob' })
      .then(res => res.data);
  },

  // Import persona DNA
  importPersonaDNA: (dnaFile: File): Promise<ApiResponse<Persona>> => {
    if (isDemoMode()) {
      const importedPersona: Persona = {
        id: 'demo-dna-' + Date.now(),
        user_id: 'default',
        name: 'Imported Persona',
        description: 'Persona imported from DNA',
        model: 'llama3.2:latest',
        parameters: {
          temperature: 0.7,
          top_p: 0.9,
          context_window: 4096,
          system_prompt: 'You are a helpful assistant.',
        },
        created_at: Date.now(),
        updated_at: Date.now(),
      };
      return createDemoResponse(importedPersona);
    }

    const formData = new FormData();
    formData.append('dnaFile', dnaFile);
    return api.post('/personas/import/dna', formData).then(res => res.data);
  },

  // Download persona (export and trigger download)
  downloadPersona: async (id: string, name: string): Promise<void> => {
    try {
      const exportData = await personaApi.exportPersona(id);
      const blob = new Blob([JSON.stringify(exportData, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${name}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_error) {
      logger.error('Error while downloading persona:', _error);
      throw new Error(
        `Failed to download persona: ${_error instanceof Error ? _error.message : String(_error)}`
      );
    }
  },
};
