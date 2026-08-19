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
 * OpenAPI tool extraction and execution. A registered server's JSON spec is
 * pinned at registration; each operation becomes one tool whose argument
 * schema exposes the operation's query/path/header parameters by name plus a
 * `body` property for the JSON request body. Execution reconstructs the call
 * deterministically from the pinned operation detail — arguments never
 * select the destination. GET operations are classified read-only; every
 * other method is a side effect until an administrator overrides it.
 */

import type { OpenApiOperationDetail, ToolDefinition } from '../types/tools.js';
import { secureToolRequest } from '../utils/toolEgress.js';

const SUPPORTED_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_DESCRIPTION_LENGTH = 1024;

export class OpenApiSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenApiSpecError';
  }
}

interface OpenApiParameter {
  name?: unknown;
  in?: unknown;
  required?: unknown;
  schema?: unknown;
  description?: unknown;
}

interface OpenApiOperation {
  operationId?: unknown;
  summary?: unknown;
  description?: unknown;
  parameters?: unknown;
  requestBody?: {
    required?: unknown;
    content?: Record<string, { schema?: unknown }>;
  };
}

const sanitizeToolName = (raw: string): string => {
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return TOOL_NAME_PATTERN.test(cleaned) ? cleaned : '';
};

const fallbackToolName = (method: string, path: string): string => {
  const slug = path
    .replace(/[{}]/g, '')
    .split('/')
    .filter(Boolean)
    .join('_')
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  return sanitizeToolName(`${method}_${slug || 'root'}`);
};

const boundedDescription = (
  operation: OpenApiOperation
): string | undefined => {
  const raw =
    (typeof operation.summary === 'string' && operation.summary) ||
    (typeof operation.description === 'string' && operation.description) ||
    '';
  const trimmed = raw.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, MAX_DESCRIPTION_LENGTH) : undefined;
};

/**
 * Extract tool definitions from a parsed OpenAPI 3.x document. $ref schemas
 * are resolved one level against #/components/schemas; deeper references
 * degrade to a permissive object schema rather than failing registration.
 */
export function parseOpenApiSpec(
  spec: unknown,
  maximumTools: number
): { tools: ToolDefinition[]; title?: string } {
  if (!spec || typeof spec !== 'object') {
    throw new OpenApiSpecError('The specification is not a JSON object');
  }
  const document = spec as {
    openapi?: unknown;
    swagger?: unknown;
    info?: { title?: unknown };
    paths?: Record<string, Record<string, unknown>>;
    components?: { schemas?: Record<string, unknown> };
  };
  if (
    typeof document.openapi !== 'string' ||
    !document.openapi.startsWith('3')
  ) {
    throw new OpenApiSpecError(
      'Only OpenAPI 3.x JSON specifications are supported'
    );
  }
  if (!document.paths || typeof document.paths !== 'object') {
    throw new OpenApiSpecError('The specification declares no paths');
  }

  const schemas = document.components?.schemas ?? {};
  const resolveSchema = (schema: unknown, depth = 0): unknown => {
    if (!schema || typeof schema !== 'object' || depth > 4) {
      return { type: 'object' };
    }
    const record = schema as Record<string, unknown>;
    const ref = record.$ref;
    if (typeof ref === 'string') {
      const match = ref.match(/^#\/components\/schemas\/([^/]+)$/);
      const resolved = match ? schemas[match[1]] : undefined;
      return resolved ? resolveSchema(resolved, depth + 1) : { type: 'object' };
    }
    const clone: Record<string, unknown> = { ...record };
    if (clone.properties && typeof clone.properties === 'object') {
      clone.properties = Object.fromEntries(
        Object.entries(clone.properties as Record<string, unknown>).map(
          ([key, value]) => [key, resolveSchema(value, depth + 1)]
        )
      );
    }
    if (clone.items) clone.items = resolveSchema(clone.items, depth + 1);
    return clone;
  };

  const tools: ToolDefinition[] = [];
  const seen = new Set<string>();

  for (const [path, operations] of Object.entries(document.paths)) {
    if (!operations || typeof operations !== 'object') continue;
    const sharedParameters = Array.isArray(
      (operations as { parameters?: unknown }).parameters
    )
      ? ((operations as { parameters?: unknown })
          .parameters as OpenApiParameter[])
      : [];
    for (const method of SUPPORTED_METHODS) {
      const operation = (operations as Record<string, unknown>)[method] as
        OpenApiOperation | undefined;
      if (!operation || typeof operation !== 'object') continue;

      let name =
        (typeof operation.operationId === 'string' &&
          sanitizeToolName(operation.operationId)) ||
        fallbackToolName(method, path);
      if (!name) continue;
      let suffix = 2;
      while (seen.has(name)) name = sanitizeToolName(`${name}_${suffix++}`);
      seen.add(name);

      const parameters: OpenApiOperationDetail['parameters'] = [];
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const declared = [
        ...sharedParameters,
        ...(Array.isArray(operation.parameters)
          ? (operation.parameters as OpenApiParameter[])
          : []),
      ];
      for (const parameter of declared) {
        if (
          typeof parameter?.name !== 'string' ||
          (parameter.in !== 'query' &&
            parameter.in !== 'path' &&
            parameter.in !== 'header')
        ) {
          continue;
        }
        if (parameter.name === 'body') continue;
        const isRequired =
          parameter.required === true || parameter.in === 'path';
        parameters.push({
          name: parameter.name,
          in: parameter.in,
          required: isRequired,
        });
        const schema = resolveSchema(parameter.schema ?? { type: 'string' });
        properties[parameter.name] = {
          ...(schema as Record<string, unknown>),
          ...(typeof parameter.description === 'string'
            ? { description: parameter.description.slice(0, 256) }
            : {}),
        };
        if (isRequired) required.push(parameter.name);
      }

      const bodyContent = operation.requestBody?.content ?? {};
      const jsonBody =
        bodyContent['application/json'] ?? bodyContent['application/*+json'];
      const hasBody = Boolean(jsonBody);
      if (hasBody) {
        properties.body = resolveSchema(jsonBody?.schema ?? { type: 'object' });
        if (operation.requestBody?.required === true) required.push('body');
      }

      const definition: ToolDefinition = {
        name,
        sideEffect: method !== 'get',
        enabled: true,
        paramsSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
        detail: {
          method: method.toUpperCase(),
          path,
          parameters,
          hasBody,
          ...(hasBody ? { bodyContentType: 'application/json' } : {}),
        },
      };
      const description = boundedDescription(operation);
      if (description) definition.description = description;
      tools.push(definition);
      if (tools.length >= maximumTools) {
        return {
          tools,
          ...(typeof document.info?.title === 'string'
            ? { title: document.info.title }
            : {}),
        };
      }
    }
  }

  if (tools.length === 0) {
    throw new OpenApiSpecError(
      'The specification declares no usable operations'
    );
  }
  return {
    tools,
    ...(typeof document.info?.title === 'string'
      ? { title: document.info.title }
      : {}),
  };
}

export interface OpenApiExecution {
  baseUrl: string;
  detail: OpenApiOperationDetail;
  args: Record<string, unknown>;
  authHeaders: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  signal?: AbortSignal;
}

export interface OpenApiExecutionResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const scalar = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? '');

export async function executeOpenApiTool(
  execution: OpenApiExecution
): Promise<OpenApiExecutionResult> {
  const { detail, args } = execution;
  let path = detail.path;
  const url = new URL(execution.baseUrl);
  const headers: Record<string, string> = { ...execution.authHeaders };

  for (const parameter of detail.parameters) {
    const value = args[parameter.name];
    if (value === undefined || value === null) {
      if (parameter.required) {
        return {
          text: `Missing required parameter: ${parameter.name}`,
          isError: true,
          truncated: false,
        };
      }
      continue;
    }
    if (parameter.in === 'path') {
      path = path
        .split(`{${parameter.name}}`)
        .join(encodeURIComponent(scalar(value)));
    } else if (parameter.in === 'query') {
      url.searchParams.set(parameter.name, scalar(value));
    } else if (HEADER_NAME_PATTERN.test(parameter.name)) {
      headers[parameter.name] = scalar(value).replace(/[\r\n]/g, ' ');
    }
  }

  const basePath = url.pathname.replace(/\/$/, '');
  const search = url.searchParams.toString();
  const targetUrl = `${url.origin}${basePath}${path}${search ? `?${search}` : ''}`;

  let body: string | undefined;
  if (detail.hasBody && args.body !== undefined) {
    headers['Content-Type'] = detail.bodyContentType ?? 'application/json';
    body = JSON.stringify(args.body);
  }

  const response = await secureToolRequest({
    url: targetUrl,
    method: detail.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    timeoutMs: execution.timeoutMs,
    maxResponseBytes: execution.maxResponseBytes,
    ...(execution.signal ? { signal: execution.signal } : {}),
  });

  const contentType = response.headers['content-type'] ?? '';
  let text = response.bodyText;
  if (contentType.includes('application/json')) {
    try {
      text = JSON.stringify(JSON.parse(response.bodyText), null, 2);
    } catch {
      // Keep the raw body when the declared type is wrong.
    }
  }
  const isError = response.status >= 400;
  return {
    text: isError ? `HTTP ${response.status}\n${text}` : text,
    isError,
    truncated: response.truncated,
  };
}
