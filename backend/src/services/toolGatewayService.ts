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
 * The tool gateway: assembles a user's effective tool catalog for a turn and
 * executes resolved calls. Execution always resolves through catalog
 * entries — never by parsing model-supplied names against the database — so
 * a call can only reach a server the actor could see when the turn started.
 * Permissions are re-checked at execution time, results are bounded, and
 * every call leaves a redacted audit event.
 */

import { getPersistence } from '../persistence/index.js';
import type { EffectiveTool } from '../types/tools.js';
import { ResourcePolicyError } from '../utils/resourceLimits.js';
import { ToolEgressError } from '../utils/toolEgress.js';
import { authorize, type AuthzActor } from './authorizationService.js';
import {
  effectiveBuiltinTools,
  executeBuiltinTool,
  type BuiltinToolContext,
} from './builtinToolsService.js';
import { encryptionService } from './encryptionService.js';
import {
  mcpCallTool,
  mcpInitialize,
  McpClientError,
  type McpEndpoint,
} from './mcpClientService.js';
import { executeOpenApiTool } from './openApiToolService.js';
import { recordAuditEvent } from './securityAuditService.js';
import {
  actorCanUseServer,
  effectiveServerTools,
  getToolServer,
  listServerTools,
  resolveAuthHeaders,
} from './toolServerService.js';

const MAX_CONCURRENT_CALLS_PER_USER = 4;
const activeCallsByUser = new Map<string, number>();

export interface ToolCatalogSelection {
  /** Builtin tool names to offer; undefined offers every available builtin. */
  builtinTools?: readonly string[] | undefined;
  /** Server ids to offer; undefined offers every visible server. */
  serverIds?: readonly string[] | undefined;
}

export interface ToolCatalog {
  tools: EffectiveTool[];
  byName: Map<string, EffectiveTool>;
}

/** Whether this actor may use chat tools at all (the feature gate). */
export async function actorCanUseTools(actor: AuthzActor): Promise<boolean> {
  const decision = await authorize(actor, 'use', {
    type: 'feature',
    id: 'tools',
  });
  return decision.allowed;
}

export async function buildToolCatalog(
  actor: AuthzActor,
  context: { sessionId?: string },
  selection: ToolCatalogSelection = {}
): Promise<ToolCatalog> {
  const builtinContext: BuiltinToolContext = {
    actor,
    ...(context.sessionId ? { sessionId: context.sessionId } : {}),
  };
  const [builtins, serverTools] = await Promise.all([
    effectiveBuiltinTools(builtinContext, selection.builtinTools),
    effectiveServerTools(actor, selection.serverIds),
  ]);
  const tools = [...builtins, ...serverTools];
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  return { tools, byName };
}

export interface ToolExecutionInput {
  actor: AuthzActor;
  tool: EffectiveTool;
  argumentsJson: string;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface ToolExecutionResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

const parseArguments = (argumentsJson: string): Record<string, unknown> => {
  if (!argumentsJson.trim()) return {};
  const parsed = JSON.parse(argumentsJson) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool arguments must be a JSON object');
  }
  return parsed as Record<string, unknown>;
};

export async function executeToolCall(
  input: ToolExecutionInput
): Promise<ToolExecutionResult> {
  const { actor, tool } = input;
  const active = activeCallsByUser.get(actor.userId) ?? 0;
  if (active >= MAX_CONCURRENT_CALLS_PER_USER) {
    return {
      text: 'Too many concurrent tool calls; try again in a moment.',
      isError: true,
      truncated: false,
    };
  }
  activeCallsByUser.set(actor.userId, active + 1);

  let result: ToolExecutionResult;
  try {
    let args: Record<string, unknown>;
    try {
      args = parseArguments(input.argumentsJson);
    } catch (error) {
      return {
        text: `Invalid tool arguments: ${error instanceof Error ? error.message : 'not JSON'}`,
        isError: true,
        truncated: false,
      };
    }

    if (tool.source === 'builtin') {
      result = await executeBuiltinTool(tool.toolName, args, {
        actor,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else {
      const server = tool.serverId ? await getToolServer(tool.serverId) : null;
      if (!server || !(await actorCanUseServer(actor, server))) {
        result = {
          text: 'This tool server is no longer available to you.',
          isError: true,
          truncated: false,
        };
      } else {
        const serverTools = await listServerTools(server.id);
        const definition = serverTools.find(
          candidate => candidate.name === tool.toolName && candidate.enabled
        );
        if (!definition) {
          result = {
            text: 'This tool is no longer offered by its server.',
            isError: true,
            truncated: false,
          };
        } else {
          const authHeaders = await resolveAuthHeaders(actor.userId, server);
          if (server.kind === 'openapi') {
            if (!definition.detail) {
              result = {
                text: 'The pinned specification has no execution detail for this tool.',
                isError: true,
                truncated: false,
              };
            } else {
              result = await executeOpenApiTool({
                baseUrl: server.baseUrl,
                detail: definition.detail,
                args,
                authHeaders,
                timeoutMs: server.timeoutMs,
                maxResponseBytes: server.maxResponseBytes,
                ...(input.signal ? { signal: input.signal } : {}),
              });
            }
          } else {
            const endpoint: McpEndpoint = {
              url: server.baseUrl,
              headers: authHeaders,
              timeoutMs: server.timeoutMs,
              maxResponseBytes: server.maxResponseBytes,
            };
            const session = await mcpInitialize(endpoint, input.signal);
            const call = await mcpCallTool(
              endpoint,
              session,
              tool.toolName,
              args,
              input.signal
            );
            const capped = call.text.slice(0, server.maxResponseBytes);
            result = {
              text: capped,
              isError: call.isError,
              truncated: capped.length < call.text.length,
            };
          }
        }
      }
    }
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const message =
      error instanceof ToolEgressError ||
      error instanceof McpClientError ||
      error instanceof ResourcePolicyError
        ? error.message
        : 'The tool call failed unexpectedly.';
    result = { text: message, isError: true, truncated: false };
  } finally {
    const remaining = (activeCallsByUser.get(actor.userId) ?? 1) - 1;
    if (remaining <= 0) activeCallsByUser.delete(actor.userId);
    else activeCallsByUser.set(actor.userId, remaining);
  }

  recordAuditEvent({
    action: 'tool.call',
    result: result.isError ? 'failure' : 'success',
    actorUserId: actor.userId,
    targetType: tool.serverId ? 'tool-server' : 'builtin-tool',
    targetId: tool.serverId ?? tool.toolName,
    details: {
      tool: tool.toolName,
      source: tool.source,
      sideEffect: tool.sideEffect,
    },
  });
  return result;
}

/** Expire stale pending approvals opportunistically from the gateway path. */
export const expireStaleApprovals = async (): Promise<void> => {
  try {
    await getPersistence(
      encryptionService
    ).repositories.resources.toolApprovals.expirePending(Date.now());
  } catch {
    // Best-effort sweep; the waiting loop also expires on read.
  }
};
