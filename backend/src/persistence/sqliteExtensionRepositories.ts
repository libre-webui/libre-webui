/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type Database from 'better-sqlite3';
import type {
  ExtensionRepositories,
  PluginActivationRepository,
  PluginApprovalRepository,
  PluginCredentialRepository,
  PluginDefinitionRepository,
  PluginDiscoveryRepository,
  PluginUsageRepository,
  PluginVariableRepository,
  StoredDiscoveredCapabilityModels,
  StoredDiscoveredModels,
  StoredPluginApproval,
  StoredPluginCredential,
  StoredPluginDefinition,
  StoredPluginUsageEvent,
  StoredPluginVariable,
  StoredVoiceProfile,
  VoiceProfileRepository,
} from './extensionTypes.js';
import { VoiceProfileLimitError } from './extensionTypes.js';

class SQLitePluginDefinitionRepository implements PluginDefinitionRepository {
  constructor(private readonly database: Database.Database) {}

  async list(): Promise<StoredPluginDefinition[]> {
    return this.database
      .prepare('SELECT * FROM plugin_definitions ORDER BY plugin_id ASC')
      .all() as StoredPluginDefinition[];
  }

  async find(pluginId: string): Promise<StoredPluginDefinition | null> {
    return (
      (this.database
        .prepare('SELECT * FROM plugin_definitions WHERE plugin_id = ?')
        .get(pluginId) as StoredPluginDefinition | undefined) ?? null
    );
  }

  async replaceApproved(definition: StoredPluginDefinition): Promise<void> {
    if (
      definition.approved_by_user_id === null ||
      definition.approved_at === null
    ) {
      throw new Error('Shared plugin definition approval is required');
    }
    const replace = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM plugin_activations WHERE plugin_id = ?')
        .run(definition.plugin_id);
      this.database
        .prepare('DELETE FROM plugin_definition_approvals WHERE plugin_id = ?')
        .run(definition.plugin_id);
      this.database
        .prepare('DELETE FROM plugin_discovered_models WHERE plugin_id = ?')
        .run(definition.plugin_id);
      this.database
        .prepare(
          'DELETE FROM plugin_discovered_capability_models WHERE plugin_id = ?'
        )
        .run(definition.plugin_id);
      this.database
        .prepare(
          `INSERT INTO plugin_definitions
             (plugin_id, definition_json, definition_fingerprint,
              approved_by_user_id, approved_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(plugin_id) DO UPDATE SET
             definition_json = excluded.definition_json,
             definition_fingerprint = excluded.definition_fingerprint,
             approved_by_user_id = excluded.approved_by_user_id,
             approved_at = excluded.approved_at,
             updated_at = excluded.updated_at`
        )
        .run(
          definition.plugin_id,
          definition.definition_json,
          definition.definition_fingerprint,
          definition.approved_by_user_id,
          definition.approved_at,
          definition.created_at,
          definition.updated_at
        );
    });
    replace();
  }

  async deleteWithState(pluginId: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      const existed = Boolean(
        this.database
          .prepare('SELECT 1 FROM plugin_definitions WHERE plugin_id = ?')
          .get(pluginId)
      );
      for (const table of [
        'plugin_activations',
        'plugin_definition_approvals',
        'plugin_variables',
        'plugin_credentials',
        'plugin_discovered_models',
        'plugin_discovered_capability_models',
      ]) {
        this.database
          .prepare(`DELETE FROM ${table} WHERE plugin_id = ?`)
          .run(pluginId);
      }
      this.database
        .prepare('DELETE FROM plugin_definitions WHERE plugin_id = ?')
        .run(pluginId);
      return existed;
    });
    return remove();
  }
}

class SQLitePluginCredentialRepository implements PluginCredentialRepository {
  constructor(private readonly database: Database.Database) {}

  async find(
    pluginId: string,
    userId: string
  ): Promise<StoredPluginCredential | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?'
        )
        .get(pluginId, userId) as StoredPluginCredential | undefined) ?? null
    );
  }

  async bindLegacy(id: string, fingerprint: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE plugin_credentials
              SET routing_auth_fingerprint = ?
            WHERE id = ? AND routing_auth_fingerprint IS NULL`
        )
        .run(fingerprint, id).changes === 1
    );
  }

  async listByUser(userId: string): Promise<StoredPluginCredential[]> {
    return this.database
      .prepare('SELECT * FROM plugin_credentials WHERE user_id = ?')
      .all(userId) as StoredPluginCredential[];
  }

  async upsert(record: StoredPluginCredential): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO plugin_credentials
           (id, user_id, plugin_id, api_key, routing_auth_fingerprint,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
           api_key = excluded.api_key,
           routing_auth_fingerprint = excluded.routing_auth_fingerprint,
           updated_at = excluded.updated_at`
      )
      .run(
        record.id,
        record.user_id,
        record.plugin_id,
        record.api_key,
        record.routing_auth_fingerprint,
        record.created_at,
        record.updated_at
      );
  }

  async delete(pluginId: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare(
          'DELETE FROM plugin_credentials WHERE plugin_id = ? AND user_id = ?'
        )
        .run(pluginId, userId).changes > 0
    );
  }

  async deleteByUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM plugin_credentials WHERE user_id = ?')
      .run(userId).changes;
  }

  async deleteByPlugin(pluginId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM plugin_credentials WHERE plugin_id = ?')
      .run(pluginId).changes;
  }
}

class SQLitePluginVariableRepository implements PluginVariableRepository {
  constructor(private readonly database: Database.Database) {}

  async list(
    pluginId: string,
    userId: string
  ): Promise<StoredPluginVariable[]> {
    return this.database
      .prepare(
        'SELECT * FROM plugin_variables WHERE plugin_id = ? AND user_id = ?'
      )
      .all(pluginId, userId) as StoredPluginVariable[];
  }

  async apply(
    pluginId: string,
    userId: string,
    mutation: {
      unsetNames: readonly string[];
      upserts: readonly StoredPluginVariable[];
    }
  ): Promise<void> {
    const apply = this.database.transaction(() => {
      const remove = this.database.prepare(
        `DELETE FROM plugin_variables
          WHERE plugin_id = ? AND user_id = ? AND variable_name = ?`
      );
      for (const name of mutation.unsetNames) {
        remove.run(pluginId, userId, name);
      }
      const upsert = this.database.prepare(
        `INSERT INTO plugin_variables
           (id, user_id, plugin_id, variable_name, variable_value,
            is_encrypted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id, variable_name) DO UPDATE SET
           variable_value = excluded.variable_value,
           is_encrypted = excluded.is_encrypted,
           updated_at = excluded.updated_at`
      );
      for (const record of mutation.upserts) {
        if (record.plugin_id !== pluginId || record.user_id !== userId) {
          throw new Error('Plugin variable mutation scope mismatch');
        }
        upsert.run(
          record.id,
          record.user_id,
          record.plugin_id,
          record.variable_name,
          record.variable_value,
          record.is_encrypted,
          record.created_at,
          record.updated_at
        );
      }
    });
    apply();
  }

  async delete(pluginId: string, userId?: string): Promise<number> {
    return userId
      ? this.database
          .prepare(
            'DELETE FROM plugin_variables WHERE plugin_id = ? AND user_id = ?'
          )
          .run(pluginId, userId).changes
      : this.database
          .prepare('DELETE FROM plugin_variables WHERE plugin_id = ?')
          .run(pluginId).changes;
  }

  async deleteByUser(userId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM plugin_variables WHERE user_id = ?')
      .run(userId).changes;
  }
}

class SQLitePluginActivationRepository implements PluginActivationRepository {
  constructor(private readonly database: Database.Database) {}

  async listUserIds(): Promise<string[]> {
    return (
      this.database.prepare('SELECT id FROM users').all() as Array<{
        id: string;
      }>
    ).map(row => row.id);
  }

  async list(userId: string): Promise<string[]> {
    return (
      this.database
        .prepare('SELECT plugin_id FROM plugin_activations WHERE user_id = ?')
        .all(userId) as Array<{ plugin_id: string }>
    ).map(row => row.plugin_id);
  }

  async activate(
    pluginId: string,
    userId: string,
    activatedAt: number
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
           activated_at = excluded.activated_at`
      )
      .run(userId, pluginId, activatedAt);
  }

  async deactivate(
    pluginId: string | undefined,
    userId: string
  ): Promise<number> {
    return pluginId
      ? this.database
          .prepare(
            'DELETE FROM plugin_activations WHERE user_id = ? AND plugin_id = ?'
          )
          .run(userId, pluginId).changes
      : this.database
          .prepare('DELETE FROM plugin_activations WHERE user_id = ?')
          .run(userId).changes;
  }

  async deleteByPlugin(pluginId: string): Promise<number> {
    return this.database
      .prepare('DELETE FROM plugin_activations WHERE plugin_id = ?')
      .run(pluginId).changes;
  }

  async migrateLegacy(
    activations: ReadonlyMap<string, readonly string[]>,
    migratedAt: number,
    markerKey: string
  ): Promise<boolean> {
    const migrate = this.database.transaction(() => {
      const marker = this.database
        .prepare('SELECT value FROM system_settings WHERE key = ?')
        .get(markerKey) as { value?: string } | undefined;
      if (marker?.value === 'true') return false;
      const users = new Set(
        (
          this.database.prepare('SELECT id FROM users').all() as Array<{
            id: string;
          }>
        ).map(row => row.id)
      );
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO plugin_activations
           (user_id, plugin_id, activated_at)
         VALUES (?, ?, ?)`
      );
      for (const [userId, pluginIds] of activations) {
        if (!users.has(userId)) continue;
        for (const pluginId of pluginIds)
          insert.run(userId, pluginId, migratedAt);
      }
      this.database
        .prepare(
          `INSERT INTO system_settings (key, value, updated_at)
           VALUES (?, 'true', ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        )
        .run(markerKey, migratedAt);
      return true;
    });
    return migrate();
  }
}

class SQLitePluginApprovalRepository implements PluginApprovalRepository {
  constructor(private readonly database: Database.Database) {}

  async find(pluginId: string): Promise<StoredPluginApproval | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM plugin_definition_approvals WHERE plugin_id = ?'
        )
        .get(pluginId) as StoredPluginApproval | undefined) ?? null
    );
  }

  async upsert(approval: StoredPluginApproval): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO plugin_definition_approvals
           (plugin_id, definition_fingerprint, source_path,
            approved_by_user_id, approved_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(plugin_id) DO UPDATE SET
           definition_fingerprint = excluded.definition_fingerprint,
           source_path = excluded.source_path,
           approved_by_user_id = excluded.approved_by_user_id,
           approved_at = excluded.approved_at`
      )
      .run(
        approval.plugin_id,
        approval.definition_fingerprint,
        approval.source_path,
        approval.approved_by_user_id,
        approval.approved_at
      );
  }

  async delete(pluginId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM plugin_definition_approvals WHERE plugin_id = ?')
        .run(pluginId).changes > 0
    );
  }

  async revokeConsent(pluginId: string): Promise<void> {
    const revoke = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM plugin_activations WHERE plugin_id = ?')
        .run(pluginId);
      this.database
        .prepare('DELETE FROM plugin_definition_approvals WHERE plugin_id = ?')
        .run(pluginId);
    });
    revoke();
  }
}

class SQLitePluginDiscoveryRepository implements PluginDiscoveryRepository {
  constructor(private readonly database: Database.Database) {}

  async get(
    pluginId: string,
    userId: string
  ): Promise<StoredDiscoveredModels | null> {
    return (
      (this.database
        .prepare(
          'SELECT * FROM plugin_discovered_models WHERE user_id = ? AND plugin_id = ?'
        )
        .get(userId, pluginId) as StoredDiscoveredModels | undefined) ?? null
    );
  }

  async upsert(record: StoredDiscoveredModels): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO plugin_discovered_models
           (user_id, plugin_id, models_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id) DO UPDATE SET
           models_json = excluded.models_json,
           updated_at = excluded.updated_at`
      )
      .run(
        record.user_id,
        record.plugin_id,
        record.models_json,
        record.updated_at
      );
  }

  async getCapability(
    pluginId: string,
    capability: StoredDiscoveredCapabilityModels['capability'],
    userId: string
  ): Promise<StoredDiscoveredCapabilityModels | null> {
    return (
      (this.database
        .prepare(
          `SELECT * FROM plugin_discovered_capability_models
            WHERE user_id = ? AND plugin_id = ? AND capability = ?`
        )
        .get(userId, pluginId, capability) as
        StoredDiscoveredCapabilityModels | undefined) ?? null
    );
  }

  async upsertCapability(
    record: StoredDiscoveredCapabilityModels
  ): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO plugin_discovered_capability_models
           (user_id, plugin_id, capability, models_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, plugin_id, capability) DO UPDATE SET
           models_json = excluded.models_json,
           updated_at = excluded.updated_at`
      )
      .run(
        record.user_id,
        record.plugin_id,
        record.capability,
        record.models_json,
        record.updated_at
      );
  }

  async delete(pluginId: string, userId?: string): Promise<void> {
    const remove = this.database.transaction(() => {
      for (const table of [
        'plugin_discovered_models',
        'plugin_discovered_capability_models',
      ]) {
        if (userId) {
          this.database
            .prepare(`DELETE FROM ${table} WHERE plugin_id = ? AND user_id = ?`)
            .run(pluginId, userId);
        } else {
          this.database
            .prepare(`DELETE FROM ${table} WHERE plugin_id = ?`)
            .run(pluginId);
        }
      }
    });
    remove();
  }
}

const totalsSql = `SELECT
  COUNT(*) AS calls,
  SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_calls,
  SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed_calls,
  SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_calls,
  SUM(CASE WHEN total_tokens IS NOT NULL THEN 1 ELSE 0 END) AS metered_calls,
  SUM(COALESCE(prompt_tokens, 0)) AS prompt_tokens,
  SUM(COALESCE(completion_tokens, 0)) AS completion_tokens,
  SUM(COALESCE(total_tokens, 0)) AS reported_tokens,
  ROUND(AVG(duration_ms)) AS average_latency_ms,
  COUNT(DISTINCT user_id) AS unique_users
FROM plugin_usage_events WHERE created_at >= ? AND created_at <= ?`;

class SQLitePluginUsageRepository implements PluginUsageRepository {
  constructor(private readonly database: Database.Database) {}

  async recordAndPrune(
    event: StoredPluginUsageEvent,
    retainFrom: number
  ): Promise<void> {
    const record = this.database.transaction(() => {
      this.database
        .prepare('DELETE FROM plugin_usage_events WHERE created_at < ?')
        .run(retainFrom);
      this.database
        .prepare(
          `INSERT INTO plugin_usage_events
             (id, user_id, plugin_id, plugin_name, capability, model, status,
              prompt_tokens, completion_tokens, total_tokens, input_units,
              output_units, unit_kind, duration_ms, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.id,
          event.user_id,
          event.plugin_id,
          event.plugin_name,
          event.capability,
          event.model,
          event.status,
          event.prompt_tokens,
          event.completion_tokens,
          event.total_tokens,
          event.input_units,
          event.output_units,
          event.unit_kind,
          event.duration_ms,
          event.created_at
        );
    });
    record();
  }

  async totals(from: number, to: number) {
    return this.database.prepare(totalsSql).get(from, to) as Awaited<
      ReturnType<PluginUsageRepository['totals']>
    >;
  }

  async series(from: number, to: number, bucketMs: number) {
    return this.database
      .prepare(
        `SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket,
                COUNT(*) AS calls, SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors
           FROM plugin_usage_events
          WHERE created_at >= ? AND created_at <= ?
          GROUP BY bucket ORDER BY bucket ASC`
      )
      .all(from, bucketMs, from, to) as Array<Record<string, unknown>>;
  }

  async plugins(from: number, to: number) {
    return this.database
      .prepare(
        `SELECT plugin_id, plugin_name, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
                ROUND(AVG(duration_ms)) AS average_latency_ms
           FROM plugin_usage_events WHERE created_at >= ? AND created_at <= ?
          GROUP BY plugin_id, plugin_name
          ORDER BY calls DESC, tokens DESC LIMIT 50`
      )
      .all(from, to) as Array<Record<string, unknown>>;
  }

  async models(from: number, to: number) {
    return this.database
      .prepare(
        `SELECT model, plugin_id, plugin_name, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(CASE WHEN status != 'success' THEN 1 ELSE 0 END) AS errors,
                ROUND(AVG(duration_ms)) AS average_latency_ms
           FROM plugin_usage_events WHERE created_at >= ? AND created_at <= ?
          GROUP BY model, plugin_id, plugin_name
          ORDER BY calls DESC, tokens DESC LIMIT 100`
      )
      .all(from, to) as Array<Record<string, unknown>>;
  }

  async heatmap(from: number, to: number, bucketMs: number) {
    return this.database
      .prepare(
        `SELECT CAST((created_at - ?) / ? AS INTEGER) AS bucket,
                model, COUNT(*) AS calls
           FROM plugin_usage_events WHERE created_at >= ? AND created_at <= ?
          GROUP BY bucket, model ORDER BY bucket ASC, calls DESC`
      )
      .all(from, bucketMs, from, to) as Array<Record<string, unknown>>;
  }

  async capabilities(from: number, to: number) {
    return this.database
      .prepare(
        `SELECT capability, COUNT(*) AS calls,
                SUM(COALESCE(total_tokens, 0)) AS tokens,
                SUM(input_units) AS input_units, SUM(output_units) AS output_units
           FROM plugin_usage_events WHERE created_at >= ? AND created_at <= ?
          GROUP BY capability ORDER BY calls DESC`
      )
      .all(from, to) as Array<Record<string, unknown>>;
  }
}

class SQLiteVoiceProfileRepository implements VoiceProfileRepository {
  constructor(private readonly database: Database.Database) {}

  async list(
    userId: string,
    filters: { pluginId?: string; model?: string },
    maximum: number
  ): Promise<StoredVoiceProfile[]> {
    const conditions = ['user_id = ?'];
    const values: Array<string | number> = [userId];
    if (filters.pluginId) {
      conditions.push('plugin_id = ?');
      values.push(filters.pluginId);
    }
    if (filters.model) {
      conditions.push('model = ?');
      values.push(filters.model);
    }
    values.push(maximum);
    return this.database
      .prepare(
        `SELECT * FROM voice_profiles WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, id ASC LIMIT ?`
      )
      .all(...values) as StoredVoiceProfile[];
  }

  async find(id: string, userId: string): Promise<StoredVoiceProfile | null> {
    return (
      (this.database
        .prepare('SELECT * FROM voice_profiles WHERE id = ? AND user_id = ?')
        .get(id, userId) as StoredVoiceProfile | undefined) ?? null
    );
  }

  async insertWithLimits(
    profile: StoredVoiceProfile,
    limits: {
      maximumProfiles: number;
      maximumTotalAudioBytes: number;
      additionalAudioBytes: number;
    }
  ): Promise<void> {
    const insert = this.database.transaction(() => {
      const count = this.database
        .prepare(
          'SELECT COUNT(*) AS count FROM voice_profiles WHERE user_id = ?'
        )
        .get(profile.user_id) as { count: number };
      if (count.count >= limits.maximumProfiles) {
        throw new VoiceProfileLimitError('count');
      }
      const bytes = this.database
        .prepare(
          'SELECT COALESCE(SUM(audio_size), 0) AS total FROM voice_profiles WHERE user_id = ?'
        )
        .get(profile.user_id) as { total: number };
      if (
        bytes.total + limits.additionalAudioBytes >
        limits.maximumTotalAudioBytes
      ) {
        throw new VoiceProfileLimitError('bytes');
      }
      const existing = this.database
        .prepare(
          `SELECT 1 FROM voice_profiles
            WHERE user_id = ? AND plugin_id = ? AND model = ?
              AND name_lookup = ?`
        )
        .get(
          profile.user_id,
          profile.plugin_id,
          profile.model,
          profile.name_lookup
        );
      if (existing) {
        throw new VoiceProfileLimitError('duplicate');
      }
      this.database
        .prepare(
          `INSERT INTO voice_profiles
             (id, user_id, name, name_lookup, plugin_id, model, reference_audio,
              reference_text, routing_fingerprint, audio_mime_type,
              audio_format, audio_size, consent_confirmed_at,
              consent_expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profile.id,
          profile.user_id,
          profile.name,
          profile.name_lookup,
          profile.plugin_id,
          profile.model,
          profile.reference_audio,
          profile.reference_text,
          profile.routing_fingerprint,
          profile.audio_mime_type,
          profile.audio_format,
          profile.audio_size,
          profile.consent_confirmed_at,
          profile.consent_expires_at,
          profile.created_at,
          profile.updated_at
        );
    });
    insert();
  }

  async delete(id: string, userId: string): Promise<boolean> {
    return (
      this.database
        .prepare('DELETE FROM voice_profiles WHERE id = ? AND user_id = ?')
        .run(id, userId).changes > 0
    );
  }

  async revoke(
    id: string,
    userId: string,
    revokedAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE voice_profiles
             SET revoked_at = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND revoked_at IS NULL`
        )
        .run(revokedAt, revokedAt, id, userId).changes > 0
    );
  }

  async recordTransfer(
    id: string,
    userId: string,
    transferredAt: number
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE voice_profiles
             SET transfer_count = transfer_count + 1, last_transfer_at = ?
           WHERE id = ? AND user_id = ?`
        )
        .run(transferredAt, id, userId).changes > 0
    );
  }
}

export const createSQLiteExtensionRepositories = (
  database: Database.Database
): ExtensionRepositories => ({
  pluginDefinitions: new SQLitePluginDefinitionRepository(database),
  pluginCredentials: new SQLitePluginCredentialRepository(database),
  pluginVariables: new SQLitePluginVariableRepository(database),
  pluginActivations: new SQLitePluginActivationRepository(database),
  pluginApprovals: new SQLitePluginApprovalRepository(database),
  pluginDiscovery: new SQLitePluginDiscoveryRepository(database),
  pluginUsage: new SQLitePluginUsageRepository(database),
  voiceProfiles: new SQLiteVoiceProfileRepository(database),
});
