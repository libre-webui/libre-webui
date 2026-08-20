/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

export type PluginCapability =
  'chat' | 'embedding' | 'image' | 'stt' | 'tts' | 'audio' | 'video';
export type PluginUsageStatus = 'success' | 'error' | 'cancelled';
export type PluginMediaCapability = 'image' | 'stt' | 'tts' | 'audio' | 'video';

export interface StoredPluginCredential {
  id: string;
  user_id: string;
  plugin_id: string;
  api_key: string;
  routing_auth_fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

export interface PluginCredentialRepository {
  find(
    pluginId: string,
    userId: string
  ): Promise<StoredPluginCredential | null>;
  bindLegacy(id: string, fingerprint: string): Promise<boolean>;
  listByUser(userId: string): Promise<StoredPluginCredential[]>;
  upsert(record: StoredPluginCredential): Promise<void>;
  delete(pluginId: string, userId: string): Promise<boolean>;
  deleteByUser(userId: string): Promise<number>;
  deleteByPlugin(pluginId: string): Promise<number>;
}

export interface StoredPluginVariable {
  id: string;
  user_id: string;
  plugin_id: string;
  variable_name: string;
  variable_value: string;
  is_encrypted: number;
  created_at: number;
  updated_at: number;
}

export interface PluginVariableMutation {
  unsetNames: readonly string[];
  upserts: readonly StoredPluginVariable[];
}

export interface PluginVariableRepository {
  list(pluginId: string, userId: string): Promise<StoredPluginVariable[]>;
  apply(
    pluginId: string,
    userId: string,
    mutation: PluginVariableMutation
  ): Promise<void>;
  delete(pluginId: string, userId?: string): Promise<number>;
  deleteByUser(userId: string): Promise<number>;
}

export interface PluginActivationRepository {
  listUserIds(): Promise<string[]>;
  list(userId: string): Promise<string[]>;
  activate(
    pluginId: string,
    userId: string,
    activatedAt: number
  ): Promise<void>;
  deactivate(pluginId: string | undefined, userId: string): Promise<number>;
  deleteByPlugin(pluginId: string): Promise<number>;
  migrateLegacy(
    activations: ReadonlyMap<string, readonly string[]>,
    migratedAt: number,
    markerKey: string
  ): Promise<boolean>;
}

export interface StoredPluginApproval {
  plugin_id: string;
  definition_fingerprint: string;
  source_path: string;
  approved_by_user_id: string;
  approved_at: number;
}

export interface PluginApprovalRepository {
  find(pluginId: string): Promise<StoredPluginApproval | null>;
  upsert(approval: StoredPluginApproval): Promise<void>;
  delete(pluginId: string): Promise<boolean>;
  revokeConsent(pluginId: string): Promise<void>;
}

/**
 * Canonical custom plugin definition stored in the selected database. Bundled
 * definitions are release assets and intentionally never copied into this
 * table. An unapproved row remains a durable quarantine shadow for the same
 * bundled ID instead of silently falling back to a different provider route.
 */
export interface StoredPluginDefinition {
  plugin_id: string;
  definition_json: string;
  definition_fingerprint: string;
  approved_by_user_id: string | null;
  approved_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PluginDefinitionRepository {
  list(): Promise<StoredPluginDefinition[]>;
  find(pluginId: string): Promise<StoredPluginDefinition | null>;
  /** Replace a definition and atomically revoke its previous runtime consent. */
  replaceApproved(definition: StoredPluginDefinition): Promise<void>;
  /** Delete a custom definition and every plugin-scoped mutable record. */
  deleteWithState(pluginId: string): Promise<boolean>;
}

export interface StoredDiscoveredModels {
  user_id: string;
  plugin_id: string;
  models_json: string;
  updated_at: number;
}

export interface StoredDiscoveredCapabilityModels extends StoredDiscoveredModels {
  capability: PluginMediaCapability;
}

export interface PluginDiscoveryRepository {
  get(pluginId: string, userId: string): Promise<StoredDiscoveredModels | null>;
  upsert(record: StoredDiscoveredModels): Promise<void>;
  getCapability(
    pluginId: string,
    capability: PluginMediaCapability,
    userId: string
  ): Promise<StoredDiscoveredCapabilityModels | null>;
  upsertCapability(record: StoredDiscoveredCapabilityModels): Promise<void>;
  delete(pluginId: string, userId?: string): Promise<void>;
}

export interface StoredPluginUsageEvent {
  id: string;
  user_id: string;
  plugin_id: string;
  plugin_name: string;
  capability: PluginCapability;
  model: string;
  status: PluginUsageStatus;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  input_units: number;
  output_units: number;
  unit_kind: string | null;
  duration_ms: number;
  created_at: number;
}

export interface PluginUsageAggregate {
  calls: number;
  successful_calls: number;
  failed_calls: number;
  cancelled_calls: number;
  metered_calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  reported_tokens: number;
  average_latency_ms: number;
  unique_users: number;
}

export interface PluginUsageRepository {
  recordAndPrune(
    event: StoredPluginUsageEvent,
    retainFrom: number
  ): Promise<void>;
  totals(from: number, to: number): Promise<PluginUsageAggregate>;
  series(
    from: number,
    to: number,
    bucketMs: number
  ): Promise<Array<Record<string, unknown>>>;
  plugins(from: number, to: number): Promise<Array<Record<string, unknown>>>;
  models(from: number, to: number): Promise<Array<Record<string, unknown>>>;
  heatmap(
    from: number,
    to: number,
    bucketMs: number
  ): Promise<Array<Record<string, unknown>>>;
  capabilities(
    from: number,
    to: number
  ): Promise<Array<Record<string, unknown>>>;
  /** Raw events for cost attribution, oldest first, bounded by `maximum`. */
  listSince(from: number, maximum: number): Promise<StoredPluginUsageEvent[]>;
}

export interface StoredVoiceProfile {
  id: string;
  user_id: string;
  name: Buffer;
  plugin_id: string;
  model: string;
  routing_fingerprint: string;
  reference_audio: Buffer;
  reference_text: Buffer | null;
  audio_mime_type: string;
  audio_format: 'wav' | 'mp3' | 'flac' | 'ogg' | 'm4a';
  audio_size: number;
  consent_confirmed_at: number;
  /** Optional consent expiry; a profile past this moment cannot be used. */
  consent_expires_at: number | null;
  /** Consent withdrawal moment; kept as a receipt rather than deleted. */
  revoked_at: number | null;
  /** How many times the reference audio was sent to the provider. */
  transfer_count: number;
  last_transfer_at: number | null;
  created_at: number;
  updated_at: number;
  name_lookup: string;
}

export interface VoiceProfileCreateLimits {
  maximumProfiles: number;
  maximumTotalAudioBytes: number;
  additionalAudioBytes: number;
}

export interface VoiceProfileRepository {
  list(
    userId: string,
    filters: { pluginId?: string; model?: string },
    maximum: number
  ): Promise<StoredVoiceProfile[]>;
  find(id: string, userId: string): Promise<StoredVoiceProfile | null>;
  insertWithLimits(
    profile: StoredVoiceProfile,
    limits: VoiceProfileCreateLimits
  ): Promise<void>;
  delete(id: string, userId: string): Promise<boolean>;
  /** Withdraw consent, keeping the row as a receipt. False when already revoked or missing. */
  revoke(id: string, userId: string, revokedAt: number): Promise<boolean>;
  /** Count one provider transfer of the reference audio. */
  recordTransfer(
    id: string,
    userId: string,
    transferredAt: number
  ): Promise<boolean>;
}

export class VoiceProfileLimitError extends Error {
  constructor(readonly kind: 'count' | 'bytes' | 'duplicate') {
    super(`Voice profile ${kind} limit failed`);
    this.name = 'VoiceProfileLimitError';
  }
}

export interface ExtensionRepositories {
  pluginDefinitions: PluginDefinitionRepository;
  pluginCredentials: PluginCredentialRepository;
  pluginVariables: PluginVariableRepository;
  pluginActivations: PluginActivationRepository;
  pluginApprovals: PluginApprovalRepository;
  pluginDiscovery: PluginDiscoveryRepository;
  pluginUsage: PluginUsageRepository;
  voiceProfiles: VoiceProfileRepository;
}
