/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { PoolClient, QueryResultRow } from 'pg';
import type { PostgresDatabase } from './postgresDatabase.js';
import type {
  ExtensionRepositories,
  PluginActivationRepository,
  PluginApprovalRepository,
  PluginCredentialRepository,
  PluginDefinitionRepository,
  PluginDiscoveryRepository,
  PluginUsageAggregate,
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

type NumericRow = QueryResultRow & Record<string, unknown>;

const integer = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`PostgreSQL returned an invalid ${field}`);
  }
  return parsed;
};

const rowCount = (value: number | null): number => value ?? 0;

const credential = (row: NumericRow): StoredPluginCredential => ({
  ...(row as unknown as StoredPluginCredential),
  created_at: integer(row.created_at, 'credential created_at'),
  updated_at: integer(row.updated_at, 'credential updated_at'),
});

const variable = (row: NumericRow): StoredPluginVariable => ({
  ...(row as unknown as StoredPluginVariable),
  is_encrypted: integer(row.is_encrypted, 'variable encryption state'),
  created_at: integer(row.created_at, 'variable created_at'),
  updated_at: integer(row.updated_at, 'variable updated_at'),
});

const pluginDefinition = (row: NumericRow): StoredPluginDefinition => ({
  ...(row as unknown as StoredPluginDefinition),
  approved_at:
    row.approved_at === null
      ? null
      : integer(row.approved_at, 'plugin definition approved_at'),
  created_at: integer(row.created_at, 'plugin definition created_at'),
  updated_at: integer(row.updated_at, 'plugin definition updated_at'),
});

const voiceProfile = (row: NumericRow): StoredVoiceProfile => ({
  ...(row as unknown as StoredVoiceProfile),
  audio_size: integer(row.audio_size, 'voice audio_size'),
  consent_confirmed_at: integer(
    row.consent_confirmed_at,
    'voice consent_confirmed_at'
  ),
  consent_expires_at:
    row.consent_expires_at === null || row.consent_expires_at === undefined
      ? null
      : integer(row.consent_expires_at, 'voice consent_expires_at'),
  revoked_at:
    row.revoked_at === null || row.revoked_at === undefined
      ? null
      : integer(row.revoked_at, 'voice revoked_at'),
  transfer_count: integer(row.transfer_count ?? 0, 'voice transfer_count'),
  last_transfer_at:
    row.last_transfer_at === null || row.last_transfer_at === undefined
      ? null
      : integer(row.last_transfer_at, 'voice last_transfer_at'),
  created_at: integer(row.created_at, 'voice created_at'),
  updated_at: integer(row.updated_at, 'voice updated_at'),
});

class PostgresPluginDefinitionRepository implements PluginDefinitionRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(): Promise<StoredPluginDefinition[]> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_definitions ORDER BY plugin_id ASC'
    );
    return result.rows.map(pluginDefinition);
  }

  async find(pluginId: string): Promise<StoredPluginDefinition | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_definitions WHERE plugin_id = $1',
      [pluginId]
    );
    return result.rows[0] ? pluginDefinition(result.rows[0]) : null;
  }

  async replaceApproved(definition: StoredPluginDefinition): Promise<void> {
    if (
      definition.approved_by_user_id === null ||
      definition.approved_at === null
    ) {
      throw new Error('Shared plugin definition approval is required');
    }
    await this.database.transaction(async client => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`libre:plugin-definition:${definition.plugin_id}`]
      );
      await client.query(
        'DELETE FROM plugin_activations WHERE plugin_id = $1',
        [definition.plugin_id]
      );
      await client.query(
        'DELETE FROM plugin_definition_approvals WHERE plugin_id = $1',
        [definition.plugin_id]
      );
      await client.query(
        'DELETE FROM plugin_discovered_models WHERE plugin_id = $1',
        [definition.plugin_id]
      );
      await client.query(
        'DELETE FROM plugin_discovered_capability_models WHERE plugin_id = $1',
        [definition.plugin_id]
      );
      await client.query(
        `INSERT INTO plugin_definitions
           (plugin_id, definition_json, definition_fingerprint,
            approved_by_user_id, approved_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (plugin_id) DO UPDATE SET
           definition_json = EXCLUDED.definition_json,
           definition_fingerprint = EXCLUDED.definition_fingerprint,
           approved_by_user_id = EXCLUDED.approved_by_user_id,
           approved_at = EXCLUDED.approved_at,
           updated_at = EXCLUDED.updated_at`,
        [
          definition.plugin_id,
          definition.definition_json,
          definition.definition_fingerprint,
          definition.approved_by_user_id,
          definition.approved_at,
          definition.created_at,
          definition.updated_at,
        ]
      );
    });
  }

  async deleteWithState(pluginId: string): Promise<boolean> {
    return this.database.transaction(async client => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`libre:plugin-definition:${pluginId}`]
      );
      const existing = await client.query(
        'SELECT 1 FROM plugin_definitions WHERE plugin_id = $1 FOR UPDATE',
        [pluginId]
      );
      for (const table of [
        'plugin_activations',
        'plugin_definition_approvals',
        'plugin_variables',
        'plugin_credentials',
        'plugin_discovered_models',
        'plugin_discovered_capability_models',
      ]) {
        await client.query(`DELETE FROM ${table} WHERE plugin_id = $1`, [
          pluginId,
        ]);
      }
      await client.query(
        'DELETE FROM plugin_definitions WHERE plugin_id = $1',
        [pluginId]
      );
      return existing.rowCount === 1;
    });
  }
}

class PostgresPluginCredentialRepository implements PluginCredentialRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async find(
    pluginId: string,
    userId: string
  ): Promise<StoredPluginCredential | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_credentials WHERE plugin_id = $1 AND user_id = $2',
      [pluginId, userId]
    );
    return result.rows[0] ? credential(result.rows[0]) : null;
  }

  async bindLegacy(id: string, fingerprint: string): Promise<boolean> {
    const result = await this.database.query(
      `UPDATE plugin_credentials
          SET routing_auth_fingerprint = $1
        WHERE id = $2 AND routing_auth_fingerprint IS NULL`,
      [fingerprint, id]
    );
    return result.rowCount === 1;
  }

  async listByUser(userId: string): Promise<StoredPluginCredential[]> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_credentials WHERE user_id = $1',
      [userId]
    );
    return result.rows.map(credential);
  }

  async upsert(record: StoredPluginCredential): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_credentials
         (id, user_id, plugin_id, api_key, routing_auth_fingerprint,
          created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, plugin_id) DO UPDATE SET
         api_key = EXCLUDED.api_key,
         routing_auth_fingerprint = EXCLUDED.routing_auth_fingerprint,
         updated_at = EXCLUDED.updated_at`,
      [
        record.id,
        record.user_id,
        record.plugin_id,
        record.api_key,
        record.routing_auth_fingerprint,
        record.created_at,
        record.updated_at,
      ]
    );
  }

  async delete(pluginId: string, userId: string): Promise<boolean> {
    return (
      rowCount(
        (
          await this.database.query(
            'DELETE FROM plugin_credentials WHERE plugin_id = $1 AND user_id = $2',
            [pluginId, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async deleteByUser(userId: string): Promise<number> {
    return rowCount(
      (
        await this.database.query(
          'DELETE FROM plugin_credentials WHERE user_id = $1',
          [userId]
        )
      ).rowCount
    );
  }

  async deleteByPlugin(pluginId: string): Promise<number> {
    return rowCount(
      (
        await this.database.query(
          'DELETE FROM plugin_credentials WHERE plugin_id = $1',
          [pluginId]
        )
      ).rowCount
    );
  }
}

class PostgresPluginVariableRepository implements PluginVariableRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(
    pluginId: string,
    userId: string
  ): Promise<StoredPluginVariable[]> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_variables WHERE plugin_id = $1 AND user_id = $2',
      [pluginId, userId]
    );
    return result.rows.map(variable);
  }

  async apply(
    pluginId: string,
    userId: string,
    mutation: {
      unsetNames: readonly string[];
      upserts: readonly StoredPluginVariable[];
    }
  ): Promise<void> {
    await this.database.transaction(async client => {
      if (mutation.unsetNames.length > 0) {
        await client.query(
          `DELETE FROM plugin_variables
            WHERE plugin_id = $1 AND user_id = $2
              AND variable_name = ANY($3::text[])`,
          [pluginId, userId, [...mutation.unsetNames]]
        );
      }
      for (const record of mutation.upserts) {
        if (record.plugin_id !== pluginId || record.user_id !== userId) {
          throw new Error('Plugin variable mutation scope mismatch');
        }
        await client.query(
          `INSERT INTO plugin_variables
             (id, user_id, plugin_id, variable_name, variable_value,
              is_encrypted, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (user_id, plugin_id, variable_name) DO UPDATE SET
             variable_value = EXCLUDED.variable_value,
             is_encrypted = EXCLUDED.is_encrypted,
             updated_at = EXCLUDED.updated_at`,
          [
            record.id,
            record.user_id,
            record.plugin_id,
            record.variable_name,
            record.variable_value,
            record.is_encrypted,
            record.created_at,
            record.updated_at,
          ]
        );
      }
    });
  }

  async delete(pluginId: string, userId?: string): Promise<number> {
    const result = userId
      ? await this.database.query(
          'DELETE FROM plugin_variables WHERE plugin_id = $1 AND user_id = $2',
          [pluginId, userId]
        )
      : await this.database.query(
          'DELETE FROM plugin_variables WHERE plugin_id = $1',
          [pluginId]
        );
    return rowCount(result.rowCount);
  }

  async deleteByUser(userId: string): Promise<number> {
    return rowCount(
      (
        await this.database.query(
          'DELETE FROM plugin_variables WHERE user_id = $1',
          [userId]
        )
      ).rowCount
    );
  }
}

class PostgresPluginActivationRepository implements PluginActivationRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async listUserIds(): Promise<string[]> {
    const result = await this.database.query<{ id: string }>(
      'SELECT id FROM users'
    );
    return result.rows.map(row => row.id);
  }

  async list(userId: string): Promise<string[]> {
    const result = await this.database.query<{ plugin_id: string }>(
      'SELECT plugin_id FROM plugin_activations WHERE user_id = $1',
      [userId]
    );
    return result.rows.map(row => row.plugin_id);
  }

  async activate(
    pluginId: string,
    userId: string,
    activatedAt: number
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_activations (user_id, plugin_id, activated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, plugin_id) DO UPDATE SET
         activated_at = EXCLUDED.activated_at`,
      [userId, pluginId, activatedAt]
    );
  }

  async deactivate(
    pluginId: string | undefined,
    userId: string
  ): Promise<number> {
    const result = pluginId
      ? await this.database.query(
          'DELETE FROM plugin_activations WHERE user_id = $1 AND plugin_id = $2',
          [userId, pluginId]
        )
      : await this.database.query(
          'DELETE FROM plugin_activations WHERE user_id = $1',
          [userId]
        );
    return rowCount(result.rowCount);
  }

  async deleteByPlugin(pluginId: string): Promise<number> {
    return rowCount(
      (
        await this.database.query(
          'DELETE FROM plugin_activations WHERE plugin_id = $1',
          [pluginId]
        )
      ).rowCount
    );
  }

  async migrateLegacy(
    activations: ReadonlyMap<string, readonly string[]>,
    migratedAt: number,
    markerKey: string
  ): Promise<boolean> {
    return this.database.transaction(async client => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [`libre:plugin-activation-migration:${markerKey}`]
      );
      const marker = await client.query<{ value: string }>(
        'SELECT value FROM system_settings WHERE key = $1 FOR UPDATE',
        [markerKey]
      );
      if (marker.rows[0]?.value === 'true') return false;
      const users = new Set(
        (
          await client.query<{ id: string }>('SELECT id FROM users FOR SHARE')
        ).rows.map(row => row.id)
      );
      for (const [userId, pluginIds] of activations) {
        if (!users.has(userId)) continue;
        for (const pluginId of pluginIds) {
          await client.query(
            `INSERT INTO plugin_activations
               (user_id, plugin_id, activated_at)
             VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
            [userId, pluginId, migratedAt]
          );
        }
      }
      await client.query(
        `INSERT INTO system_settings (key, value, updated_at)
         VALUES ($1, 'true', $2)
         ON CONFLICT (key) DO UPDATE SET
           value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [markerKey, migratedAt]
      );
      return true;
    });
  }
}

class PostgresPluginApprovalRepository implements PluginApprovalRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async find(pluginId: string): Promise<StoredPluginApproval | null> {
    const result = await this.database.query<
      StoredPluginApproval & QueryResultRow
    >('SELECT * FROM plugin_definition_approvals WHERE plugin_id = $1', [
      pluginId,
    ]);
    const row = result.rows[0];
    return row
      ? { ...row, approved_at: integer(row.approved_at, 'approval timestamp') }
      : null;
  }

  async upsert(approval: StoredPluginApproval): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_definition_approvals
         (plugin_id, definition_fingerprint, source_path,
          approved_by_user_id, approved_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (plugin_id) DO UPDATE SET
         definition_fingerprint = EXCLUDED.definition_fingerprint,
         source_path = EXCLUDED.source_path,
         approved_by_user_id = EXCLUDED.approved_by_user_id,
         approved_at = EXCLUDED.approved_at`,
      [
        approval.plugin_id,
        approval.definition_fingerprint,
        approval.source_path,
        approval.approved_by_user_id,
        approval.approved_at,
      ]
    );
  }

  async delete(pluginId: string): Promise<boolean> {
    return (
      rowCount(
        (
          await this.database.query(
            'DELETE FROM plugin_definition_approvals WHERE plugin_id = $1',
            [pluginId]
          )
        ).rowCount
      ) > 0
    );
  }

  async revokeConsent(pluginId: string): Promise<void> {
    await this.database.transaction(async client => {
      await client.query(
        'DELETE FROM plugin_activations WHERE plugin_id = $1',
        [pluginId]
      );
      await client.query(
        'DELETE FROM plugin_definition_approvals WHERE plugin_id = $1',
        [pluginId]
      );
    });
  }
}

class PostgresPluginDiscoveryRepository implements PluginDiscoveryRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async get(
    pluginId: string,
    userId: string
  ): Promise<StoredDiscoveredModels | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM plugin_discovered_models WHERE user_id = $1 AND plugin_id = $2',
      [userId, pluginId]
    );
    return result.rows[0]
      ? ({
          ...result.rows[0],
          updated_at: integer(result.rows[0].updated_at, 'discovery timestamp'),
        } as unknown as StoredDiscoveredModels)
      : null;
  }

  async upsert(record: StoredDiscoveredModels): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_discovered_models
         (user_id, plugin_id, models_json, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, plugin_id) DO UPDATE SET
         models_json = EXCLUDED.models_json,
         updated_at = EXCLUDED.updated_at`,
      [record.user_id, record.plugin_id, record.models_json, record.updated_at]
    );
  }

  async getCapability(
    pluginId: string,
    capability: StoredDiscoveredCapabilityModels['capability'],
    userId: string
  ): Promise<StoredDiscoveredCapabilityModels | null> {
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM plugin_discovered_capability_models
        WHERE user_id = $1 AND plugin_id = $2 AND capability = $3`,
      [userId, pluginId, capability]
    );
    return result.rows[0]
      ? ({
          ...result.rows[0],
          updated_at: integer(result.rows[0].updated_at, 'discovery timestamp'),
        } as unknown as StoredDiscoveredCapabilityModels)
      : null;
  }

  async upsertCapability(
    record: StoredDiscoveredCapabilityModels
  ): Promise<void> {
    await this.database.query(
      `INSERT INTO plugin_discovered_capability_models
         (user_id, plugin_id, capability, models_json, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, plugin_id, capability) DO UPDATE SET
         models_json = EXCLUDED.models_json,
         updated_at = EXCLUDED.updated_at`,
      [
        record.user_id,
        record.plugin_id,
        record.capability,
        record.models_json,
        record.updated_at,
      ]
    );
  }

  async delete(pluginId: string, userId?: string): Promise<void> {
    await this.database.transaction(async client => {
      for (const table of [
        'plugin_discovered_models',
        'plugin_discovered_capability_models',
      ]) {
        if (userId) {
          await client.query(
            `DELETE FROM ${table} WHERE plugin_id = $1 AND user_id = $2`,
            [pluginId, userId]
          );
        } else {
          await client.query(`DELETE FROM ${table} WHERE plugin_id = $1`, [
            pluginId,
          ]);
        }
      }
    });
  }
}

const postgresTotalsSql = `SELECT
  COUNT(*)::text AS calls,
  COUNT(*) FILTER (WHERE status = 'success')::text AS successful_calls,
  COUNT(*) FILTER (WHERE status = 'error')::text AS failed_calls,
  COUNT(*) FILTER (WHERE status = 'cancelled')::text AS cancelled_calls,
  COUNT(*) FILTER (WHERE total_tokens IS NOT NULL)::text AS metered_calls,
  COALESCE(SUM(prompt_tokens), 0)::text AS prompt_tokens,
  COALESCE(SUM(completion_tokens), 0)::text AS completion_tokens,
  COALESCE(SUM(total_tokens), 0)::text AS reported_tokens,
  COALESCE(ROUND(AVG(duration_ms)), 0)::text AS average_latency_ms,
  COUNT(DISTINCT user_id)::text AS unique_users
FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $2`;

class PostgresPluginUsageRepository implements PluginUsageRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async recordAndPrune(
    event: StoredPluginUsageEvent,
    retainFrom: number
  ): Promise<void> {
    await this.database.transaction(async client => {
      await client.query(
        'DELETE FROM plugin_usage_events WHERE created_at < $1',
        [retainFrom]
      );
      await client.query(
        `INSERT INTO plugin_usage_events
           (id, user_id, plugin_id, plugin_name, capability, model, status,
            prompt_tokens, completion_tokens, total_tokens, input_units,
            output_units, unit_kind, duration_ms, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15)`,
        [
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
          event.created_at,
        ]
      );
    });
  }

  async totals(from: number, to: number): Promise<PluginUsageAggregate> {
    const result = await this.database.query<NumericRow>(postgresTotalsSql, [
      from,
      to,
    ]);
    const row = result.rows[0] || {};
    return {
      calls: integer(row.calls || 0, 'usage calls'),
      successful_calls: integer(row.successful_calls || 0, 'successful calls'),
      failed_calls: integer(row.failed_calls || 0, 'failed calls'),
      cancelled_calls: integer(row.cancelled_calls || 0, 'cancelled calls'),
      metered_calls: integer(row.metered_calls || 0, 'metered calls'),
      prompt_tokens: integer(row.prompt_tokens || 0, 'prompt tokens'),
      completion_tokens: integer(
        row.completion_tokens || 0,
        'completion tokens'
      ),
      reported_tokens: integer(row.reported_tokens || 0, 'reported tokens'),
      average_latency_ms: integer(
        row.average_latency_ms || 0,
        'average latency'
      ),
      unique_users: integer(row.unique_users || 0, 'unique users'),
    };
  }

  private async rows(sql: string, parameters: readonly unknown[]) {
    return (await this.database.query(sql, parameters)).rows as Array<
      Record<string, unknown>
    >;
  }

  series(from: number, to: number, bucketMs: number) {
    return this.rows(
      `SELECT floor((created_at - $1)::numeric / $2)::bigint AS bucket,
              COUNT(*)::text AS calls,
              COALESCE(SUM(total_tokens), 0)::text AS tokens,
              COUNT(*) FILTER (WHERE status = 'error')::text AS errors
         FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $3
        GROUP BY bucket ORDER BY bucket ASC`,
      [from, bucketMs, to]
    );
  }

  plugins(from: number, to: number) {
    return this.rows(
      `SELECT plugin_id, plugin_name, COUNT(*)::text AS calls,
              COALESCE(SUM(total_tokens), 0)::text AS tokens,
              COUNT(*) FILTER (WHERE status <> 'success')::text AS errors,
              COALESCE(ROUND(AVG(duration_ms)), 0)::text AS average_latency_ms
         FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $2
        GROUP BY plugin_id, plugin_name
        ORDER BY COUNT(*) DESC, COALESCE(SUM(total_tokens), 0) DESC LIMIT 50`,
      [from, to]
    );
  }

  models(from: number, to: number) {
    return this.rows(
      `SELECT model, plugin_id, plugin_name, COUNT(*)::text AS calls,
              COALESCE(SUM(total_tokens), 0)::text AS tokens,
              COUNT(*) FILTER (WHERE status <> 'success')::text AS errors,
              COALESCE(ROUND(AVG(duration_ms)), 0)::text AS average_latency_ms
         FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $2
        GROUP BY model, plugin_id, plugin_name
        ORDER BY COUNT(*) DESC, COALESCE(SUM(total_tokens), 0) DESC LIMIT 100`,
      [from, to]
    );
  }

  heatmap(from: number, to: number, bucketMs: number) {
    return this.rows(
      `SELECT floor((created_at - $1)::numeric / $2)::bigint AS bucket,
              model, COUNT(*)::text AS calls
         FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $3
        GROUP BY bucket, model ORDER BY bucket ASC, COUNT(*) DESC`,
      [from, bucketMs, to]
    );
  }

  capabilities(from: number, to: number) {
    return this.rows(
      `SELECT capability, COUNT(*)::text AS calls,
              COALESCE(SUM(total_tokens), 0)::text AS tokens,
              COALESCE(SUM(input_units), 0)::text AS input_units,
              COALESCE(SUM(output_units), 0)::text AS output_units
         FROM plugin_usage_events WHERE created_at >= $1 AND created_at <= $2
        GROUP BY capability ORDER BY COUNT(*) DESC`,
      [from, to]
    );
  }
}

class PostgresVoiceProfileRepository implements VoiceProfileRepository {
  constructor(private readonly database: PostgresDatabase) {}

  async list(
    userId: string,
    filters: { pluginId?: string; model?: string },
    maximum: number
  ): Promise<StoredVoiceProfile[]> {
    const values: unknown[] = [userId];
    const conditions = ['user_id = $1'];
    if (filters.pluginId) {
      values.push(filters.pluginId);
      conditions.push(`plugin_id = $${values.length}`);
    }
    if (filters.model) {
      values.push(filters.model);
      conditions.push(`model = $${values.length}`);
    }
    values.push(maximum);
    const result = await this.database.query<NumericRow>(
      `SELECT * FROM voice_profiles WHERE ${conditions.join(' AND ')}
       ORDER BY updated_at DESC, id ASC LIMIT $${values.length}`,
      values
    );
    return result.rows.map(voiceProfile);
  }

  async find(id: string, userId: string): Promise<StoredVoiceProfile | null> {
    const result = await this.database.query<NumericRow>(
      'SELECT * FROM voice_profiles WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    return result.rows[0] ? voiceProfile(result.rows[0]) : null;
  }

  async insertWithLimits(
    profile: StoredVoiceProfile,
    limits: {
      maximumProfiles: number;
      maximumTotalAudioBytes: number;
      additionalAudioBytes: number;
    }
  ): Promise<void> {
    await this.database.transaction(async client => {
      const owner = await client.query(
        'SELECT id FROM users WHERE id = $1 FOR UPDATE',
        [profile.user_id]
      );
      if (owner.rowCount !== 1)
        throw new Error('Voice profile owner not found');
      const usage = await client.query<{ count: string; bytes: string }>(
        `SELECT COUNT(*)::text AS count,
                COALESCE(SUM(audio_size), 0)::text AS bytes
           FROM voice_profiles WHERE user_id = $1`,
        [profile.user_id]
      );
      if (Number(usage.rows[0]?.count || 0) >= limits.maximumProfiles) {
        throw new VoiceProfileLimitError('count');
      }
      if (
        Number(usage.rows[0]?.bytes || 0) + limits.additionalAudioBytes >
        limits.maximumTotalAudioBytes
      ) {
        throw new VoiceProfileLimitError('bytes');
      }
      const duplicate = await client.query(
        `SELECT 1 FROM voice_profiles
          WHERE user_id = $1 AND plugin_id = $2 AND model = $3
            AND name_lookup = $4`,
        [profile.user_id, profile.plugin_id, profile.model, profile.name_lookup]
      );
      if (duplicate.rowCount === 1) {
        throw new VoiceProfileLimitError('duplicate');
      }
      await client.query(
        `INSERT INTO voice_profiles
           (id, user_id, name, name_lookup, plugin_id, model, reference_audio,
            reference_text, routing_fingerprint, audio_mime_type, audio_format,
            audio_size, consent_confirmed_at, consent_expires_at, created_at,
            updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13, $14, $15, $16)`,
        [
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
          profile.updated_at,
        ]
      );
    });
  }

  async delete(id: string, userId: string): Promise<boolean> {
    return (
      rowCount(
        (
          await this.database.query(
            'DELETE FROM voice_profiles WHERE id = $1 AND user_id = $2',
            [id, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async revoke(
    id: string,
    userId: string,
    revokedAt: number
  ): Promise<boolean> {
    return (
      rowCount(
        (
          await this.database.query(
            `UPDATE voice_profiles
               SET revoked_at = $1, updated_at = $2
             WHERE id = $3 AND user_id = $4 AND revoked_at IS NULL`,
            [revokedAt, revokedAt, id, userId]
          )
        ).rowCount
      ) > 0
    );
  }

  async recordTransfer(
    id: string,
    userId: string,
    transferredAt: number
  ): Promise<boolean> {
    return (
      rowCount(
        (
          await this.database.query(
            `UPDATE voice_profiles
               SET transfer_count = transfer_count + 1, last_transfer_at = $1
             WHERE id = $2 AND user_id = $3`,
            [transferredAt, id, userId]
          )
        ).rowCount
      ) > 0
    );
  }
}

export const createPostgresExtensionRepositories = (
  database: PostgresDatabase
): ExtensionRepositories => ({
  pluginDefinitions: new PostgresPluginDefinitionRepository(database),
  pluginCredentials: new PostgresPluginCredentialRepository(database),
  pluginVariables: new PostgresPluginVariableRepository(database),
  pluginActivations: new PostgresPluginActivationRepository(database),
  pluginApprovals: new PostgresPluginApprovalRepository(database),
  pluginDiscovery: new PostgresPluginDiscoveryRepository(database),
  pluginUsage: new PostgresPluginUsageRepository(database),
  voiceProfiles: new PostgresVoiceProfileRepository(database),
});

export const createPostgresTransactionalExtensionRepositories = (
  client: PoolClient
): ExtensionRepositories => {
  const database = {
    query: client.query.bind(client),
    transaction: async <T>(operation: (nested: PoolClient) => Promise<T>) =>
      operation(client),
  } as unknown as PostgresDatabase;
  return createPostgresExtensionRepositories(database);
};
