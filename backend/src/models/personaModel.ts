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

import { getDatabaseSafe } from '../db.js';
import type { DatabaseAdapter } from '../database/types.js';
import {
  Persona,
  CreatePersonaRequest,
  UpdatePersonaRequest,
} from '../types/index.js';
import { v4 as uuidv4 } from 'uuid';

interface PersonaRow {
  id: string;
  user_id: string;
  name: string;
  description: string;
  model: string;
  parameters: string;
  avatar?: string;
  background?: string;
  embedding_model?: string;
  memory_settings?: string;
  mutation_settings?: string;
  created_at: number;
  updated_at: number;
}

export class PersonaModel {
  private getDb(): DatabaseAdapter | null {
    return getDatabaseSafe();
  }

  private ensureDatabase(): DatabaseAdapter {
    const db = this.getDb();
    if (!db)
      throw new Error('Database not available - SQLite features disabled');
    return db;
  }

  private rowToPersona(row: PersonaRow): Persona {
    return {
      ...row,
      parameters: JSON.parse(row.parameters),
      memory_settings: row.memory_settings
        ? JSON.parse(row.memory_settings)
        : undefined,
      mutation_settings: row.mutation_settings
        ? JSON.parse(row.mutation_settings)
        : undefined,
    };
  }

  async getPersonas(userId: string = 'default'): Promise<Persona[]> {
    const db = this.getDb();
    if (!db) {
      console.warn(
        'PersonaModel: Database not available, returning empty personas list'
      );
      return [];
    }

    try {
      const rows = await db.all<PersonaRow>(
        `SELECT id, user_id, name, description, model, parameters, avatar, background,
                embedding_model, memory_settings, mutation_settings, created_at, updated_at
         FROM personas WHERE user_id = ? ORDER BY updated_at DESC`,
        userId
      );
      return rows.map(row => this.rowToPersona(row));
    } catch (error) {
      console.error('Error fetching personas:', error);
      throw new Error('Failed to fetch personas');
    }
  }

  async getPersonaById(
    id: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const db = this.ensureDatabase();
      const row = await db.get<PersonaRow>(
        `SELECT id, user_id, name, description, model, parameters, avatar, background,
                embedding_model, memory_settings, mutation_settings, created_at, updated_at
         FROM personas WHERE id = ? AND user_id = ?`,
        id,
        userId
      );
      return row ? this.rowToPersona(row) : null;
    } catch (error) {
      console.error('Error fetching persona:', error);
      throw new Error('Failed to fetch persona');
    }
  }

  async createPersona(
    data: CreatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona> {
    try {
      const db = this.ensureDatabase();
      const id = uuidv4();
      const now = Date.now();

      await db.run(
        `INSERT INTO personas (id, user_id, name, description, model, parameters, avatar, background,
                               embedding_model, memory_settings, mutation_settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        userId,
        data.name,
        data.description || null,
        data.model,
        JSON.stringify(data.parameters),
        data.avatar || null,
        data.background || null,
        data.embedding_model || null,
        data.memory_settings ? JSON.stringify(data.memory_settings) : null,
        data.mutation_settings ? JSON.stringify(data.mutation_settings) : null,
        now,
        now
      );

      const created = await this.getPersonaById(id, userId);
      if (!created) throw new Error('Failed to create persona');
      return created;
    } catch (error) {
      console.error('Error creating persona:', error);
      throw new Error('Failed to create persona');
    }
  }

  async updatePersona(
    id: string,
    data: UpdatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const existing = await this.getPersonaById(id, userId);
      if (!existing) return null;

      const now = Date.now();
      const updates: string[] = [];
      const values: (string | number)[] = [];

      if (data.name !== undefined) {
        updates.push('name = ?');
        values.push(data.name);
      }
      if (data.description !== undefined) {
        updates.push('description = ?');
        values.push(data.description);
      }
      if (data.model !== undefined) {
        updates.push('model = ?');
        values.push(data.model);
      }
      if (data.parameters !== undefined) {
        updates.push('parameters = ?');
        values.push(JSON.stringify(data.parameters));
      }
      if (data.avatar !== undefined) {
        updates.push('avatar = ?');
        values.push(data.avatar);
      }
      if (data.background !== undefined) {
        updates.push('background = ?');
        values.push(data.background);
      }
      if (data.embedding_model !== undefined) {
        updates.push('embedding_model = ?');
        values.push(data.embedding_model);
      }
      if (data.memory_settings !== undefined) {
        updates.push('memory_settings = ?');
        values.push(JSON.stringify(data.memory_settings));
      }
      if (data.mutation_settings !== undefined) {
        updates.push('mutation_settings = ?');
        values.push(JSON.stringify(data.mutation_settings));
      }

      if (updates.length === 0) return existing;

      updates.push('updated_at = ?');
      values.push(now);
      values.push(id);
      values.push(userId);

      const db = this.ensureDatabase();
      await db.run(
        `UPDATE personas SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
        ...values
      );
      return await this.getPersonaById(id, userId);
    } catch (error) {
      console.error('Error updating persona:', error);
      throw new Error('Failed to update persona');
    }
  }

  async deletePersona(
    id: string,
    userId: string = 'default'
  ): Promise<boolean> {
    try {
      const db = this.ensureDatabase();
      const result = await db.run(
        'DELETE FROM personas WHERE id = ? AND user_id = ?',
        id,
        userId
      );
      return result.changes > 0;
    } catch (error) {
      console.error('Error deleting persona:', error);
      throw new Error('Failed to delete persona');
    }
  }

  async getPersonaByName(
    name: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const db = this.ensureDatabase();
      const row = await db.get<PersonaRow>(
        `SELECT id, user_id, name, description, model, parameters, avatar, background,
                embedding_model, memory_settings, mutation_settings, created_at, updated_at
         FROM personas WHERE name = ? AND user_id = ?`,
        name,
        userId
      );
      return row ? this.rowToPersona(row) : null;
    } catch (error) {
      console.error('Error fetching persona by name:', error);
      throw new Error('Failed to fetch persona by name');
    }
  }

  async getPersonasCount(userId: string = 'default'): Promise<number> {
    try {
      const db = this.ensureDatabase();
      const result = await db.get<{ count: number }>(
        'SELECT COUNT(*) as count FROM personas WHERE user_id = ?',
        userId
      );
      return result?.count ?? 0;
    } catch (error) {
      console.error('Error counting personas:', error);
      throw new Error('Failed to count personas');
    }
  }
}

export const personaModel = new PersonaModel();
