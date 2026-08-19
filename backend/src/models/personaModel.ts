/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { v4 as uuidv4 } from 'uuid';
import { getPlatformStorageRuntime } from '../platform/storage/index.js';
import type { PersonaPatch } from '../platform/storage/platformDomainRepositories.js';
import type {
  CreatePersonaRequest,
  Persona,
  UpdatePersonaRequest,
} from '../types/index.js';

export class PersonaModel {
  async getPersonas(userId = 'default'): Promise<Persona[]> {
    return getPlatformStorageRuntime().domains.personas.listByOwner(userId);
  }

  async getPersonaById(
    id: string,
    userId = 'default'
  ): Promise<Persona | null> {
    return (
      (await getPlatformStorageRuntime().domains.personas.findByOwner(
        id,
        userId
      )) || null
    );
  }

  async createPersona(
    data: CreatePersonaRequest,
    userId = 'default'
  ): Promise<Persona> {
    const now = Date.now();
    const persona: Persona = {
      id: uuidv4(),
      user_id: userId,
      name: data.name,
      ...(data.description ? { description: data.description } : {}),
      model: data.model,
      parameters: data.parameters,
      ...(data.avatar ? { avatar: data.avatar } : {}),
      ...(data.background ? { background: data.background } : {}),
      ...(data.embedding_model
        ? { embedding_model: data.embedding_model }
        : {}),
      ...(data.memory_settings
        ? { memory_settings: data.memory_settings }
        : {}),
      ...(data.mutation_settings
        ? { mutation_settings: data.mutation_settings }
        : {}),
      ...(data.bindings ? { bindings: data.bindings } : {}),
      created_at: now,
      updated_at: now,
    };
    await getPlatformStorageRuntime().domains.personas.insert(persona);
    return persona;
  }

  async updatePersona(
    id: string,
    data: UpdatePersonaRequest,
    userId = 'default'
  ): Promise<Persona | null> {
    const patch: PersonaPatch = {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.description !== undefined
        ? { description: data.description || null }
        : {}),
      ...(data.model !== undefined ? { model: data.model } : {}),
      ...(data.parameters !== undefined ? { parameters: data.parameters } : {}),
      ...(data.avatar !== undefined ? { avatar: data.avatar || null } : {}),
      ...(data.background !== undefined
        ? { background: data.background || null }
        : {}),
      ...(data.embedding_model !== undefined
        ? { embedding_model: data.embedding_model || null }
        : {}),
      ...(data.memory_settings !== undefined
        ? { memory_settings: data.memory_settings }
        : {}),
      ...(data.mutation_settings !== undefined
        ? { mutation_settings: data.mutation_settings }
        : {}),
      ...(data.bindings !== undefined ? { bindings: data.bindings } : {}),
      updated_at: Date.now(),
    };
    return (
      (await getPlatformStorageRuntime().domains.personas.patchByOwner(
        id,
        userId,
        patch
      )) || null
    );
  }

  async deletePersona(id: string, userId = 'default'): Promise<boolean> {
    return getPlatformStorageRuntime().domains.personas.deleteByOwner(
      id,
      userId
    );
  }

  async getPersonaByName(
    name: string,
    userId = 'default'
  ): Promise<Persona | null> {
    const personas = await this.getPersonas(userId);
    return personas.find(persona => persona.name === name) || null;
  }

  async getPersonasCount(userId = 'default'): Promise<number> {
    return getPlatformStorageRuntime().domains.personas.countByOwner(userId);
  }
}

export const personaModel = new PersonaModel();
