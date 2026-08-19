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

/**
 * Registered external tool servers (TOOL-02/TOOL-03). Registration is
 * administrator-only; the server's OpenAPI specification or MCP tool list is
 * fetched once and pinned with a digest, so the executable surface cannot
 * drift without an explicit administrator refresh. Availability is scoped
 * per server: admins-only, all users, or grant-based through the common
 * resource-grant model. Per-user credentials are encrypted with additional
 * authenticated data binding them to the exact user and server identity.
 */

import { createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { getPersistence } from '../persistence/index.js';
import type {
  StoredToolServerRecord,
  StoredToolServerToolRecord,
} from '../persistence/index.js';
import type {
  EffectiveTool,
  ToolDefinition,
  ToolServer,
  ToolServerAccessMode,
  ToolServerAuthMode,
  ToolServerKind,
  OpenApiOperationDetail,
} from '../types/tools.js';
import {
  MAX_TOOL_SERVERS,
  MAX_TOOL_SERVER_DESCRIPTION_LENGTH,
  MAX_TOOL_SERVER_NAME_LENGTH,
  MAX_TOOL_SERVER_SECRET_LENGTH,
  MAX_TOOL_SERVER_SPEC_BYTES,
  MAX_TOOL_SERVER_TOOLS,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';
import {
  secureToolRequest,
  validateToolServerUrl,
} from '../utils/toolEgress.js';
import { encryptionService } from './encryptionService.js';
import { authorize, type AuthzActor } from './authorizationService.js';
import { deleteGrantsForResource } from './resourceGrantService.js';
import { recordAuditEvent } from './securityAuditService.js';
import {
  mcpInitialize,
  mcpListTools,
  type McpEndpoint,
} from './mcpClientService.js';
import { parseOpenApiSpec } from './openApiToolService.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES_CEILING = 4 * 1024 * 1024;

const SERVER_KINDS: readonly ToolServerKind[] = ['openapi', 'mcp'];
const AUTH_MODES: readonly ToolServerAuthMode[] = ['none', 'bearer', 'header'];
const ACCESS_MODES: readonly ToolServerAccessMode[] = [
  'admins-only',
  'all-users',
  'granted',
];

const resources = () =>
  getPersistence(encryptionService).repositories.resources;

const credentialAad = (serverId: string, userId: string): Buffer =>
  Buffer.from(`tool-server-credential\0${serverId}\0${userId}`, 'utf-8');

export const mapToolServerRow = (row: StoredToolServerRecord): ToolServer => ({
  id: row.id,
  name: encryptionService.decrypt(row.name),
  ...(row.description
    ? { description: encryptionService.decrypt(row.description) }
    : {}),
  kind: row.kind as ToolServerKind,
  baseUrl: encryptionService.decrypt(row.base_url),
  ...(row.spec_digest ? { specDigest: row.spec_digest } : {}),
  specRevision: row.spec_revision,
  authMode: row.auth_mode as ToolServerAuthMode,
  ...(row.auth_header ? { authHeader: row.auth_header } : {}),
  accessMode: row.access_mode as ToolServerAccessMode,
  enabled: row.enabled === 1,
  timeoutMs: row.timeout_ms,
  maxResponseBytes: row.max_response_bytes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerUserId: row.user_id,
});

export const mapToolRow = (
  row: StoredToolServerToolRecord
): ToolDefinition => ({
  name: row.name,
  ...(row.description
    ? { description: encryptionService.decrypt(row.description) }
    : {}),
  ...(row.params_schema
    ? {
        paramsSchema: JSON.parse(
          encryptionService.decrypt(row.params_schema)
        ) as Record<string, unknown>,
      }
    : {}),
  sideEffect: row.side_effect === 1,
  enabled: row.enabled === 1,
  ...(row.detail
    ? {
        detail: JSON.parse(
          encryptionService.decrypt(row.detail)
        ) as OpenApiOperationDetail,
      }
    : {}),
});

export interface ToolServerInput {
  name: string;
  description?: string;
  kind: ToolServerKind;
  baseUrl: string;
  /** OpenAPI only: where the JSON specification lives; defaults to baseUrl. */
  specUrl?: string;
  authMode: ToolServerAuthMode;
  authHeader?: string;
  accessMode: ToolServerAccessMode;
  enabled?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const validateInput = (input: ToolServerInput): void => {
  if (!input.name?.trim() || input.name.length > MAX_TOOL_SERVER_NAME_LENGTH) {
    throw new ResourcePolicyError('Invalid tool server name', 400);
  }
  if (
    input.description !== undefined &&
    input.description.length > MAX_TOOL_SERVER_DESCRIPTION_LENGTH
  ) {
    throw new ResourcePolicyError('Tool server description is too long', 400);
  }
  if (!SERVER_KINDS.includes(input.kind)) {
    throw new ResourcePolicyError('Invalid tool server kind', 400);
  }
  if (!AUTH_MODES.includes(input.authMode)) {
    throw new ResourcePolicyError('Invalid tool server auth mode', 400);
  }
  if (!ACCESS_MODES.includes(input.accessMode)) {
    throw new ResourcePolicyError('Invalid tool server access mode', 400);
  }
  if (
    input.authMode === 'header' &&
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(input.authHeader ?? '')
  ) {
    throw new ResourcePolicyError(
      'A header auth mode requires a valid header name',
      400
    );
  }
  validateToolServerUrl(input.baseUrl);
  if (input.specUrl !== undefined) validateToolServerUrl(input.specUrl);
};

const clampTimeout = (value: number | undefined): number =>
  Math.min(
    Math.max(Math.trunc(value ?? DEFAULT_TIMEOUT_MS), MIN_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );

const clampResponseBytes = (value: number | undefined): number =>
  Math.min(
    Math.max(Math.trunc(value ?? DEFAULT_MAX_RESPONSE_BYTES), 1024),
    MAX_RESPONSE_BYTES_CEILING
  );

interface PinnedInventory {
  specJson: string;
  digest: string;
  tools: ToolDefinition[];
}

/**
 * The encrypted spec column stores an envelope so a refresh can re-fetch
 * from the exact source the administrator registered. The digest covers the
 * pinned document alone.
 */
interface StoredSpecEnvelope {
  sourceUrl: string;
  document: string;
}

const specEnvelope = (sourceUrl: string, document: string): string =>
  JSON.stringify({ sourceUrl, document } satisfies StoredSpecEnvelope);

const readSpecEnvelope = (
  encrypted: string | null
): StoredSpecEnvelope | null => {
  if (!encrypted) return null;
  try {
    const parsed = JSON.parse(
      encryptionService.decrypt(encrypted)
    ) as StoredSpecEnvelope;
    return typeof parsed?.sourceUrl === 'string' ? parsed : null;
  } catch {
    return null;
  }
};

/** Fetch and pin the server's tool inventory (OpenAPI spec or MCP list). */
const pinInventory = async (
  input: Pick<ToolServerInput, 'kind' | 'baseUrl' | 'specUrl'>,
  timeoutMs: number
): Promise<PinnedInventory> => {
  if (input.kind === 'openapi') {
    const response = await secureToolRequest({
      url: input.specUrl ?? input.baseUrl,
      method: 'GET',
      headers: { Accept: 'application/json' },
      timeoutMs,
      maxResponseBytes: MAX_TOOL_SERVER_SPEC_BYTES,
    });
    if (response.status >= 400 || response.truncated) {
      throw new ResourcePolicyError(
        'The OpenAPI specification could not be fetched',
        400
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.bodyText);
    } catch {
      throw new ResourcePolicyError(
        'The OpenAPI specification is not valid JSON',
        400
      );
    }
    const { tools } = parseOpenApiSpec(parsed, MAX_TOOL_SERVER_TOOLS);
    const specJson = JSON.stringify(parsed);
    return {
      specJson,
      digest: createHash('sha256').update(specJson).digest('hex'),
      tools,
    };
  }

  const endpoint: McpEndpoint = {
    url: input.baseUrl,
    headers: {},
    timeoutMs,
    maxResponseBytes: MAX_TOOL_SERVER_SPEC_BYTES,
  };
  const session = await mcpInitialize(endpoint);
  const descriptors = await mcpListTools(endpoint, session);
  if (descriptors.length === 0) {
    throw new ResourcePolicyError('The MCP server exposes no tools', 400);
  }
  const tools: ToolDefinition[] = descriptors
    .slice(0, MAX_TOOL_SERVER_TOOLS)
    .map(descriptor => ({
      name: descriptor.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      ...(descriptor.description
        ? { description: descriptor.description.slice(0, 1024) }
        : {}),
      ...(descriptor.inputSchema
        ? { paramsSchema: descriptor.inputSchema }
        : {}),
      sideEffect: descriptor.readOnlyHint !== true,
      enabled: true,
    }));
  const specJson = JSON.stringify(descriptors);
  return {
    specJson,
    digest: createHash('sha256').update(specJson).digest('hex'),
    tools,
  };
};

const toolRows = (
  serverId: string,
  tools: ToolDefinition[],
  now: number
): StoredToolServerToolRecord[] =>
  tools.map(tool => ({
    id: uuidv4(),
    server_id: serverId,
    name: tool.name,
    description: tool.description
      ? encryptionService.encrypt(tool.description)
      : null,
    params_schema: tool.paramsSchema
      ? encryptionService.encrypt(JSON.stringify(tool.paramsSchema))
      : null,
    detail: tool.detail
      ? encryptionService.encrypt(JSON.stringify(tool.detail))
      : null,
    side_effect: tool.sideEffect ? 1 : 0,
    enabled: tool.enabled ? 1 : 0,
    created_at: now,
    updated_at: now,
  }));

export async function registerToolServer(
  adminUserId: string,
  input: ToolServerInput
): Promise<ToolServer> {
  validateInput(input);
  const timeoutMs = clampTimeout(input.timeoutMs);
  const inventory = await pinInventory(input, timeoutMs);
  const now = Date.now();
  const record: StoredToolServerRecord = {
    id: uuidv4(),
    user_id: adminUserId,
    name: encryptionService.encrypt(input.name.trim()),
    description: input.description
      ? encryptionService.encrypt(input.description)
      : null,
    kind: input.kind,
    base_url: encryptionService.encrypt(input.baseUrl),
    spec: encryptionService.encrypt(
      specEnvelope(input.specUrl ?? input.baseUrl, inventory.specJson)
    ),
    spec_digest: inventory.digest,
    spec_revision: 1,
    auth_mode: input.authMode,
    auth_header:
      input.authMode === 'header' ? (input.authHeader ?? null) : null,
    access_mode: input.accessMode,
    enabled: input.enabled === false ? 0 : 1,
    timeout_ms: timeoutMs,
    max_response_bytes: clampResponseBytes(input.maxResponseBytes),
    created_at: now,
    updated_at: now,
  };
  try {
    await resources().toolServers.replaceWithLimit(record, MAX_TOOL_SERVERS);
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === 'PersistenceResourceLimitError'
    ) {
      throw new ResourcePolicyError(
        `This instance may register at most ${MAX_TOOL_SERVERS} tool servers`,
        409
      );
    }
    throw error;
  }
  await resources().toolServerTools.replaceAllForServer(
    record.id,
    toolRows(record.id, inventory.tools, now)
  );
  recordAuditEvent({
    action: 'tool-server.register',
    result: 'success',
    actorUserId: adminUserId,
    targetType: 'tool-server',
    targetId: record.id,
    details: { kind: input.kind, digest: inventory.digest },
  });
  return mapToolServerRow(record);
}

export interface ToolServerUpdate {
  name?: string;
  description?: string | null;
  authMode?: ToolServerAuthMode;
  authHeader?: string | null;
  accessMode?: ToolServerAccessMode;
  enabled?: boolean;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

/** Update mutable policy fields. The destination and pinned spec never change here. */
export async function updateToolServer(
  adminUserId: string,
  serverId: string,
  update: ToolServerUpdate
): Promise<ToolServer | null> {
  const existing = await resources().toolServers.findById(serverId);
  if (!existing) return null;
  const merged: StoredToolServerRecord = { ...existing };
  if (update.name !== undefined) {
    if (
      !update.name.trim() ||
      update.name.length > MAX_TOOL_SERVER_NAME_LENGTH
    ) {
      throw new ResourcePolicyError('Invalid tool server name', 400);
    }
    merged.name = encryptionService.encrypt(update.name.trim());
  }
  if (update.description !== undefined) {
    if (
      update.description !== null &&
      update.description.length > MAX_TOOL_SERVER_DESCRIPTION_LENGTH
    ) {
      throw new ResourcePolicyError('Tool server description is too long', 400);
    }
    merged.description = update.description
      ? encryptionService.encrypt(update.description)
      : null;
  }
  if (update.authMode !== undefined) {
    if (!AUTH_MODES.includes(update.authMode)) {
      throw new ResourcePolicyError('Invalid tool server auth mode', 400);
    }
    merged.auth_mode = update.authMode;
  }
  if (update.authHeader !== undefined) merged.auth_header = update.authHeader;
  if (
    merged.auth_mode === 'header' &&
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(merged.auth_header ?? '')
  ) {
    throw new ResourcePolicyError(
      'A header auth mode requires a valid header name',
      400
    );
  }
  if (update.accessMode !== undefined) {
    if (!ACCESS_MODES.includes(update.accessMode)) {
      throw new ResourcePolicyError('Invalid tool server access mode', 400);
    }
    merged.access_mode = update.accessMode;
  }
  if (update.enabled !== undefined) merged.enabled = update.enabled ? 1 : 0;
  if (update.timeoutMs !== undefined) {
    merged.timeout_ms = clampTimeout(update.timeoutMs);
  }
  if (update.maxResponseBytes !== undefined) {
    merged.max_response_bytes = clampResponseBytes(update.maxResponseBytes);
  }
  merged.updated_at = Date.now();
  await resources().toolServers.replaceWithLimit(merged, MAX_TOOL_SERVERS);
  recordAuditEvent({
    action: 'tool-server.update',
    result: 'success',
    actorUserId: adminUserId,
    targetType: 'tool-server',
    targetId: serverId,
  });
  return mapToolServerRow(merged);
}

/** Re-fetch the inventory; a changed digest advances the pinned revision. */
export async function refreshToolServer(
  adminUserId: string,
  serverId: string
): Promise<ToolServer | null> {
  const existing = await resources().toolServers.findById(serverId);
  if (!existing) return null;
  const server = mapToolServerRow(existing);
  const storedEnvelope = readSpecEnvelope(existing.spec);
  const inventory = await pinInventory(
    {
      kind: server.kind,
      baseUrl: server.baseUrl,
      ...(storedEnvelope ? { specUrl: storedEnvelope.sourceUrl } : {}),
    },
    server.timeoutMs
  );
  const now = Date.now();
  const changed = inventory.digest !== existing.spec_digest;
  const merged: StoredToolServerRecord = {
    ...existing,
    spec: encryptionService.encrypt(
      specEnvelope(
        storedEnvelope?.sourceUrl ?? server.baseUrl,
        inventory.specJson
      )
    ),
    spec_digest: inventory.digest,
    spec_revision: changed
      ? existing.spec_revision + 1
      : existing.spec_revision,
    updated_at: now,
  };
  await resources().toolServers.replaceWithLimit(merged, MAX_TOOL_SERVERS);
  await resources().toolServerTools.replaceAllForServer(
    serverId,
    toolRows(serverId, inventory.tools, now)
  );
  recordAuditEvent({
    action: 'tool-server.refresh',
    result: 'success',
    actorUserId: adminUserId,
    targetType: 'tool-server',
    targetId: serverId,
    details: { digest: inventory.digest, changed },
  });
  return mapToolServerRow(merged);
}

export async function deleteToolServer(
  adminUserId: string,
  serverId: string
): Promise<boolean> {
  const deleted = await resources().toolServers.delete(serverId);
  if (deleted) {
    await deleteGrantsForResource('tool-server', serverId);
    recordAuditEvent({
      action: 'tool-server.delete',
      result: 'success',
      actorUserId: adminUserId,
      targetType: 'tool-server',
      targetId: serverId,
    });
  }
  return deleted;
}

export async function getToolServer(
  serverId: string
): Promise<ToolServer | null> {
  const row = await resources().toolServers.findById(serverId);
  return row ? mapToolServerRow(row) : null;
}

export async function listToolServers(): Promise<ToolServer[]> {
  const rows = await resources().toolServers.list(MAX_TOOL_SERVERS);
  return rows.map(mapToolServerRow);
}

export async function listServerTools(
  serverId: string
): Promise<ToolDefinition[]> {
  const rows = await resources().toolServerTools.listByServer(serverId);
  return rows.map(mapToolRow);
}

export async function overrideServerTool(
  adminUserId: string,
  serverId: string,
  toolName: string,
  overrides: { enabled?: boolean; sideEffect?: boolean }
): Promise<ToolDefinition | null> {
  const row = await resources().toolServerTools.updateOverrides(
    serverId,
    toolName,
    {
      ...(overrides.enabled !== undefined
        ? { enabled: overrides.enabled ? 1 : 0 }
        : {}),
      ...(overrides.sideEffect !== undefined
        ? { side_effect: overrides.sideEffect ? 1 : 0 }
        : {}),
    },
    Date.now()
  );
  if (row) {
    recordAuditEvent({
      action: 'tool-server.tool-override',
      result: 'success',
      actorUserId: adminUserId,
      targetType: 'tool-server',
      targetId: serverId,
      details: { tool: toolName, ...overrides },
    });
  }
  return row ? mapToolRow(row) : null;
}

/** Whether one server is usable by this actor (feature gate checked separately). */
export async function actorCanUseServer(
  actor: AuthzActor,
  server: ToolServer
): Promise<boolean> {
  if (!server.enabled) return false;
  if (actor.role === 'admin') return true;
  if (server.accessMode === 'admins-only') return false;
  if (server.accessMode === 'all-users') return true;
  const decision = await authorize(actor, 'use', {
    type: 'tool-server',
    id: server.id,
    ownerUserId: server.ownerUserId,
  });
  // The registering admin "owns" the row, but grant-scoped servers are
  // available to non-owners only through explicit grants.
  return decision.allowed;
}

export async function listVisibleToolServers(
  actor: AuthzActor
): Promise<ToolServer[]> {
  const servers = await listToolServers();
  const visible: ToolServer[] = [];
  for (const server of servers) {
    if (await actorCanUseServer(actor, server)) visible.push(server);
  }
  return visible;
}

const NAMESPACE_PATTERN = /[^a-z0-9_]/g;

export const serverNamespace = (name: string): string => {
  const base = name.toLowerCase().replace(NAMESPACE_PATTERN, '_').slice(0, 24);
  return base.replace(/^_+|_+$/g, '') || 'server';
};

/**
 * The effective server-tool catalog for one actor: enabled tools of every
 * visible enabled server, namespaced `<server>__<tool>` for the provider.
 */
export async function effectiveServerTools(
  actor: AuthzActor,
  serverIds?: readonly string[]
): Promise<EffectiveTool[]> {
  const servers = await listVisibleToolServers(actor);
  const selected = serverIds
    ? servers.filter(server => serverIds.includes(server.id))
    : servers;
  const catalog: EffectiveTool[] = [];
  const usedNamespaces = new Map<string, number>();
  for (const server of selected) {
    let namespace = serverNamespace(server.name);
    const collisions = usedNamespaces.get(namespace) ?? 0;
    usedNamespaces.set(namespace, collisions + 1);
    if (collisions > 0) namespace = `${namespace}${collisions + 1}`;
    const tools = await listServerTools(server.id);
    for (const tool of tools) {
      if (!tool.enabled) continue;
      catalog.push({
        name: `${namespace}__${tool.name}`.slice(0, 64),
        ...(tool.description ? { description: tool.description } : {}),
        ...(tool.paramsSchema ? { paramsSchema: tool.paramsSchema } : {}),
        sideEffect: tool.sideEffect,
        source: server.kind,
        serverId: server.id,
        serverName: server.name,
        toolName: tool.name,
      });
    }
  }
  return catalog;
}

// === Per-user credentials ===

export async function setToolServerCredential(
  userId: string,
  serverId: string,
  secret: string
): Promise<void> {
  if (!secret || secret.length > MAX_TOOL_SERVER_SECRET_LENGTH) {
    throw new ResourcePolicyError('Invalid tool server credential', 400);
  }
  const server = await resources().toolServers.findById(serverId);
  if (!server) throw new ResourcePolicyError('Unknown tool server', 400);
  const now = Date.now();
  await resources().toolServerCredentials.upsert({
    id: uuidv4(),
    server_id: serverId,
    user_id: userId,
    secret: encryptionService
      .encryptBuffer(
        Buffer.from(secret, 'utf-8'),
        credentialAad(serverId, userId)
      )
      .toString('base64'),
    created_at: now,
    updated_at: now,
  });
  recordAuditEvent({
    action: 'tool-server.credential-set',
    result: 'success',
    actorUserId: userId,
    targetType: 'tool-server',
    targetId: serverId,
  });
}

export async function deleteToolServerCredential(
  userId: string,
  serverId: string
): Promise<boolean> {
  const deleted = await resources().toolServerCredentials.delete(
    serverId,
    userId
  );
  if (deleted) {
    recordAuditEvent({
      action: 'tool-server.credential-delete',
      result: 'success',
      actorUserId: userId,
      targetType: 'tool-server',
      targetId: serverId,
    });
  }
  return deleted;
}

export async function hasToolServerCredential(
  userId: string,
  serverId: string
): Promise<boolean> {
  return Boolean(
    await resources().toolServerCredentials.find(serverId, userId)
  );
}

/** Resolve the outbound auth headers for this user on this server. */
export async function resolveAuthHeaders(
  userId: string,
  server: ToolServer
): Promise<Record<string, string>> {
  if (server.authMode === 'none') return {};
  const row = await resources().toolServerCredentials.find(server.id, userId);
  if (!row) {
    throw new ResourcePolicyError(
      'This tool server requires a personal credential; add one in Tools',
      400
    );
  }
  const secret = encryptionService
    .decryptBuffer(
      Buffer.from(row.secret, 'base64'),
      credentialAad(server.id, userId)
    )
    .toString('utf-8')
    .replace(/[\r\n]/g, '');
  if (server.authMode === 'bearer') {
    return { Authorization: `Bearer ${secret}` };
  }
  return { [server.authHeader ?? 'X-Api-Key']: secret };
}
