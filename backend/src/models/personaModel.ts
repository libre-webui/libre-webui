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

import { getDatabase } from '../db';
import { Persona, CreatePersonaRequest, UpdatePersonaRequest } from '../types';
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
  created_at: number;
  updated_at: number;
}

export class PersonaModel {
  private db = getDatabase();

  /**
   * Get all personas for a user
   */
  async getPersonas(userId: string = 'default'): Promise<Persona[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, user_id, name, description, model, parameters, avatar, background, created_at, updated_at
        FROM personas 
        WHERE user_id = ?
        ORDER BY updated_at DESC
      `);

      const rows = stmt.all(userId) as PersonaRow[];

      return rows.map(row => ({
        ...row,
        parameters: JSON.parse(row.parameters),
      }));
    } catch (error) {
      console.error('Error fetching personas:', error);
      throw new Error('Failed to fetch personas');
    }
  }

  /**
   * Get a specific persona by ID
   */
  async getPersonaById(
    id: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, user_id, name, description, model, parameters, avatar, background, created_at, updated_at
        FROM personas 
        WHERE id = ? AND user_id = ?
      `);

      const row = stmt.get(id, userId) as PersonaRow | undefined;

      if (!row) {
        return null;
      }

      return {
        ...row,
        parameters: JSON.parse(row.parameters),
      };
    } catch (error) {
      console.error('Error fetching persona:', error);
      throw new Error('Failed to fetch persona');
    }
  }

  /**
   * Create a new persona
   */
  async createPersona(
    data: CreatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona> {
    try {
      const id = uuidv4();
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO personas (id, user_id, name, description, model, parameters, avatar, background, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        id,
        userId,
        data.name,
        data.description || null,
        data.model,
        JSON.stringify(data.parameters),
        data.avatar || null,
        data.background || null,
        now,
        now
      );

      const created = await this.getPersonaById(id, userId);
      if (!created) {
        throw new Error('Failed to create persona');
      }

      return created;
    } catch (error) {
      console.error('Error creating persona:', error);
      throw new Error('Failed to create persona');
    }
  }

  /**
   * Update an existing persona
   */
  async updatePersona(
    id: string,
    data: UpdatePersonaRequest,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const existing = await this.getPersonaById(id, userId);
      if (!existing) {
        return null;
      }

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

      if (updates.length === 0) {
        return existing;
      }

      updates.push('updated_at = ?');
      values.push(now);
      values.push(id);
      values.push(userId);

      const stmt = this.db.prepare(`
        UPDATE personas 
        SET ${updates.join(', ')}
        WHERE id = ? AND user_id = ?
      `);

      stmt.run(...values);

      return await this.getPersonaById(id, userId);
    } catch (error) {
      console.error('Error updating persona:', error);
      throw new Error('Failed to update persona');
    }
  }

  /**
   * Delete a persona
   */
  async deletePersona(
    id: string,
    userId: string = 'default'
  ): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM personas 
        WHERE id = ? AND user_id = ?
      `);

      const result = stmt.run(id, userId);
      return result.changes > 0;
    } catch (error) {
      console.error('Error deleting persona:', error);
      throw new Error('Failed to delete persona');
    }
  }

  /**
   * Get persona by name (for duplicate checking)
   */
  async getPersonaByName(
    name: string,
    userId: string = 'default'
  ): Promise<Persona | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT id, user_id, name, description, model, parameters, avatar, background, created_at, updated_at
        FROM personas 
        WHERE name = ? AND user_id = ?
      `);

      const row = stmt.get(name, userId) as PersonaRow | undefined;

      if (!row) {
        return null;
      }

      return {
        ...row,
        parameters: JSON.parse(row.parameters),
      };
    } catch (error) {
      console.error('Error fetching persona by name:', error);
      throw new Error('Failed to fetch persona by name');
    }
  }

  /**
   * Get personas count for a user
   */
  async getPersonasCount(userId: string = 'default'): Promise<number> {
    try {
      const stmt = this.db.prepare(`
        SELECT COUNT(*) as count 
        FROM personas 
        WHERE user_id = ?
      `);

      const result = stmt.get(userId) as { count: number };
      return result.count;
    } catch (error) {
      console.error('Error counting personas:', error);
      throw new Error('Failed to count personas');
    }
  }
}

export const personaModel = new PersonaModel();
