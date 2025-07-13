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

import Database from 'better-sqlite3';
import { McpServerConfig, McpServerConfigSchema } from '../types/mcpTypes.js';
import { getErrorMessage } from '../types/index.js';

// Database row interface for MCP servers
interface McpServerRow {
  id: string;
  name: string;
  description: string | null;
  enabled: number;
  type: 'stdio' | 'sse' | 'websocket';
  command: string | null;
  args: string | null;
  url: string | null;
  env: string | null;
  timeout: number;
  maxRetries: number;
  created_at: string;
  updated_at: string;
}

export class McpModel {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initializeTables();
  }

  private initializeTables(): void {
    // Create MCP servers table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        enabled INTEGER DEFAULT 1,
        type TEXT DEFAULT 'stdio',
        command TEXT,
        args TEXT, -- JSON array
        url TEXT,
        env TEXT, -- JSON object
        timeout INTEGER DEFAULT 30000,
        max_retries INTEGER DEFAULT 3,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled);
      CREATE INDEX IF NOT EXISTS idx_mcp_servers_type ON mcp_servers(type);
    `);
  }

  /**
   * Create a new MCP server configuration
   */
  async createServer(
    serverConfig: Omit<McpServerConfig, 'created_at' | 'updated_at'>
  ): Promise<McpServerConfig> {
    try {
      const validatedConfig = McpServerConfigSchema.parse(serverConfig);

      const stmt = this.db.prepare(`
        INSERT INTO mcp_servers (
          id, name, description, enabled, type, command, args, url, env, timeout, max_retries
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const now = new Date().toISOString();

      stmt.run(
        validatedConfig.id,
        validatedConfig.name,
        validatedConfig.description || null,
        validatedConfig.enabled ? 1 : 0,
        validatedConfig.type,
        validatedConfig.command || null,
        validatedConfig.args ? JSON.stringify(validatedConfig.args) : null,
        validatedConfig.url || null,
        validatedConfig.env ? JSON.stringify(validatedConfig.env) : null,
        validatedConfig.timeout,
        validatedConfig.maxRetries
      );

      return {
        ...validatedConfig,
        created_at: now,
        updated_at: now,
      };
    } catch (error) {
      throw new Error(
        `Failed to create MCP server: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Get an MCP server by ID
   */
  async getServer(id: string): Promise<McpServerConfig | null> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM mcp_servers WHERE id = ?
      `);

      const row = stmt.get(id) as McpServerRow;
      if (!row) {
        return null;
      }

      return this.mapRowToServerConfig(row);
    } catch (error) {
      throw new Error(
        `Failed to get MCP server: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Get all MCP servers
   */
  async getAllServers(): Promise<McpServerConfig[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM mcp_servers ORDER BY name ASC
      `);

      const rows = stmt.all() as McpServerRow[];
      return rows.map(row => this.mapRowToServerConfig(row));
    } catch (error) {
      throw new Error(
        `Failed to get MCP servers: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Get enabled MCP servers
   */
  async getEnabledServers(): Promise<McpServerConfig[]> {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM mcp_servers WHERE enabled = 1 ORDER BY name ASC
      `);

      const rows = stmt.all() as McpServerRow[];
      return rows.map(row => this.mapRowToServerConfig(row));
    } catch (error) {
      throw new Error(
        `Failed to get enabled MCP servers: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Update an MCP server
   */
  async updateServer(
    id: string,
    updates: Partial<Omit<McpServerConfig, 'id' | 'created_at' | 'updated_at'>>
  ): Promise<McpServerConfig | null> {
    try {
      const existing = await this.getServer(id);
      if (!existing) {
        return null;
      }

      const updated = { ...existing, ...updates };
      const validatedConfig = McpServerConfigSchema.parse(updated);

      const stmt = this.db.prepare(`
        UPDATE mcp_servers 
        SET name = ?, description = ?, enabled = ?, type = ?, command = ?, 
            args = ?, url = ?, env = ?, timeout = ?, max_retries = ?, updated_at = ?
        WHERE id = ?
      `);

      const now = new Date().toISOString();

      stmt.run(
        validatedConfig.name,
        validatedConfig.description || null,
        validatedConfig.enabled ? 1 : 0,
        validatedConfig.type,
        validatedConfig.command || null,
        validatedConfig.args ? JSON.stringify(validatedConfig.args) : null,
        validatedConfig.url || null,
        validatedConfig.env ? JSON.stringify(validatedConfig.env) : null,
        validatedConfig.timeout,
        validatedConfig.maxRetries,
        now,
        id
      );

      return {
        ...validatedConfig,
        created_at: existing.created_at,
        updated_at: now,
      };
    } catch (error) {
      throw new Error(
        `Failed to update MCP server: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Delete an MCP server
   */
  async deleteServer(id: string): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        DELETE FROM mcp_servers WHERE id = ?
      `);

      const result = stmt.run(id);
      return result.changes > 0;
    } catch (error) {
      throw new Error(
        `Failed to delete MCP server: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Enable/disable an MCP server
   */
  async toggleServer(id: string, enabled: boolean): Promise<boolean> {
    try {
      const stmt = this.db.prepare(`
        UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?
      `);

      const now = new Date().toISOString();
      const result = stmt.run(enabled ? 1 : 0, now, id);
      return result.changes > 0;
    } catch (error) {
      throw new Error(
        `Failed to toggle MCP server: ${getErrorMessage(error, 'Unknown error')}`
      );
    }
  }

  /**
   * Map database row to McpServerConfig
   */
  private mapRowToServerConfig(row: McpServerRow): McpServerConfig {
    return {
      id: row.id,
      name: row.name,
      description: row.description || undefined,
      enabled: Boolean(row.enabled),
      type: row.type,
      command: row.command || undefined,
      args: row.args ? JSON.parse(row.args) : undefined,
      url: row.url || undefined,
      env: row.env ? JSON.parse(row.env) : undefined,
      timeout: row.timeout,
      maxRetries: row.maxRetries,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
