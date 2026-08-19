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
 * First-party chat tools (TOOL-01, minimal set). Every builtin is read-only
 * and executes with the invoking user's identity and effective permissions:
 * web search honors the web-search feature gate, document search only
 * reaches the user's own collections, and skill loading resolves the user's
 * own enabled skills. Outputs are bounded before they re-enter the model.
 */

import type { AuthzActor } from './authorizationService.js';
import type { EffectiveTool } from '../types/tools.js';
import { userCanUseWebSearch, webSearch } from './webSearchService.js';
import documentService from './documentService.js';
import { getSkillBySlug } from './skillService.js';

const MAX_RESULT_CHARS = 24_000;

const bounded = (text: string): { text: string; truncated: boolean } =>
  text.length > MAX_RESULT_CHARS
    ? {
        text: `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated]`,
        truncated: true,
      }
    : { text, truncated: false };

export interface BuiltinToolContext {
  actor: AuthzActor;
  sessionId?: string;
  signal?: AbortSignal;
}

export interface BuiltinToolResult {
  text: string;
  isError: boolean;
  truncated: boolean;
}

interface BuiltinToolSpec {
  name: string;
  description: string;
  paramsSchema: Record<string, unknown>;
  available(context: BuiltinToolContext): Promise<boolean>;
  execute(
    args: Record<string, unknown>,
    context: BuiltinToolContext
  ): Promise<BuiltinToolResult>;
}

const asString = (value: unknown): string =>
  typeof value === 'string' ? value : '';

const BUILTIN_TOOLS: readonly BuiltinToolSpec[] = [
  {
    name: 'web_search',
    description:
      'Search the web and return result titles, URLs, and snippets. Use for current events or facts outside the conversation.',
    paramsSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        max_results: {
          type: 'integer',
          description: 'Maximum results to return',
        },
      },
      required: ['query'],
    },
    available: async context =>
      userCanUseWebSearch({
        id: context.actor.userId,
        ...(context.actor.role !== undefined
          ? { role: context.actor.role }
          : {}),
        ...(context.actor.status !== undefined
          ? { status: context.actor.status }
          : {}),
      }),
    execute: async (args, context) => {
      const query = asString(args.query).trim();
      if (!query) {
        return {
          text: 'A search query is required.',
          isError: true,
          truncated: false,
        };
      }
      const maxResults =
        typeof args.max_results === 'number' ? args.max_results : undefined;
      const results = await webSearch(query, maxResults, context.signal);
      if (results.length === 0) {
        return { text: 'No results found.', isError: false, truncated: false };
      }
      const rendered = results
        .map(
          (result, index) =>
            `${index + 1}. ${result.title}\n${result.url}\n${result.content}`
        )
        .join('\n\n');
      return { ...bounded(rendered), isError: false };
    },
  },
  {
    name: 'search_documents',
    description:
      "Search the user's uploaded documents and knowledge collections; returns matching passages with their source document.",
    paramsSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for' },
        limit: { type: 'integer', description: 'Maximum passages to return' },
      },
      required: ['query'],
    },
    available: async () => true,
    execute: async (args, context) => {
      const query = asString(args.query).trim();
      if (!query) {
        return {
          text: 'A search query is required.',
          isError: true,
          truncated: false,
        };
      }
      const limit = Math.min(
        Math.max(
          typeof args.limit === 'number' ? Math.trunc(args.limit) : 5,
          1
        ),
        10
      );
      const chunks = await documentService.searchDocuments(
        query,
        context.actor.userId,
        context.sessionId,
        limit,
        undefined,
        context.signal
      );
      if (chunks.length === 0) {
        return {
          text: 'No matching passages found in the available documents.',
          isError: false,
          truncated: false,
        };
      }
      const titles = new Map<string, string>();
      for (const chunk of chunks) {
        if (titles.has(chunk.documentId)) continue;
        const document = await documentService.getDocument(
          chunk.documentId,
          context.actor.userId
        );
        titles.set(
          chunk.documentId,
          document?.title || document?.filename || chunk.documentId
        );
      }
      const rendered = chunks
        .map(
          chunk =>
            `[${titles.get(chunk.documentId)} · chunk ${chunk.chunkIndex}]\n${chunk.content}`
        )
        .join('\n\n');
      return { ...bounded(rendered), isError: false };
    },
  },
  {
    name: 'load_skill',
    description:
      'Load the full instructions of one of the available skills by its slug. Call this before applying a skill mentioned in the system prompt.',
    paramsSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The skill slug to load' },
      },
      required: ['slug'],
    },
    available: async () => true,
    execute: async (args, context) => {
      const slug = asString(args.slug).trim();
      const skill = slug
        ? await getSkillBySlug(context.actor.userId, slug)
        : null;
      if (!skill || !skill.enabled) {
        return {
          text: `No enabled skill named "${slug}" is available.`,
          isError: true,
          truncated: false,
        };
      }
      return {
        ...bounded(`# Skill: ${skill.name}\n\n${skill.instructions}`),
        isError: false,
      };
    },
  },
];

export const BUILTIN_TOOL_NAMES: readonly string[] = BUILTIN_TOOLS.map(
  tool => tool.name
);

/** The builtin tools available to this actor, optionally filtered by name. */
export async function effectiveBuiltinTools(
  context: BuiltinToolContext,
  names?: readonly string[]
): Promise<EffectiveTool[]> {
  const catalog: EffectiveTool[] = [];
  for (const tool of BUILTIN_TOOLS) {
    if (names && !names.includes(tool.name)) continue;
    if (!(await tool.available(context))) continue;
    catalog.push({
      name: tool.name,
      description: tool.description,
      paramsSchema: tool.paramsSchema,
      sideEffect: false,
      source: 'builtin',
      toolName: tool.name,
    });
  }
  return catalog;
}

export async function executeBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  context: BuiltinToolContext
): Promise<BuiltinToolResult> {
  const tool = BUILTIN_TOOLS.find(candidate => candidate.name === name);
  if (!tool) {
    return {
      text: `Unknown builtin tool: ${name}`,
      isError: true,
      truncated: false,
    };
  }
  if (!(await tool.available(context))) {
    return {
      text: `The ${name} tool is not available to this account.`,
      isError: true,
      truncated: false,
    };
  }
  return tool.execute(args, context);
}
