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

import type { ToolServerInput } from '@/utils/api/toolsApi';

/**
 * Starter tool servers for the admin register form. Card names and
 * descriptions localize through `toolsPage.templates.<id>.*`. These are
 * form prefills only — nothing is contacted until the administrator
 * submits, and every value can be edited first.
 */
export interface ToolServerTemplate {
  id: string;
  input: ToolServerInput;
}

export const TOOL_SERVER_TEMPLATES: readonly ToolServerTemplate[] = [
  {
    id: 'petstore',
    input: {
      name: 'Petstore demo',
      description:
        'The public Swagger Petstore demo API — safe to register for a ' +
        'first end-to-end test of OpenAPI tools.',
      kind: 'openapi',
      baseUrl: 'https://petstore3.swagger.io/api/v3',
      specUrl: 'https://petstore3.swagger.io/api/v3/openapi.json',
      authMode: 'none',
      accessMode: 'admins-only',
    },
  },
  {
    id: 'internalOpenApi',
    input: {
      name: 'Internal API',
      description:
        'A starting point for your own OpenAPI 3.x JSON service. Replace ' +
        'the URLs; internal hostnames also need ' +
        'TOOLS_PRIVATE_NETWORK_ALLOWLIST on the server.',
      kind: 'openapi',
      baseUrl: 'https://api.example.internal',
      specUrl: 'https://api.example.internal/openapi.json',
      authMode: 'bearer',
      accessMode: 'admins-only',
    },
  },
  {
    id: 'mcpServer',
    input: {
      name: 'MCP server',
      description:
        'A starting point for an MCP server over Streamable HTTP. Replace ' +
        'the URL with your server’s endpoint; its tool list is fetched and ' +
        'pinned when you register.',
      kind: 'mcp',
      baseUrl: 'https://mcp.example.com/mcp',
      authMode: 'header',
      authHeader: 'X-Api-Key',
      accessMode: 'admins-only',
    },
  },
];
