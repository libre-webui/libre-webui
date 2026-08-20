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
import {
  readDocumentSegments,
  resolveSegmentLabel,
} from '../utils/documentExtraction.js';
import {
  getSkillBySlug,
  getSkillFile,
  listSkillFiles,
  listSkills,
} from './skillService.js';
import {
  createNote,
  getNote,
  listNotes,
  NoteError,
  updateNote,
} from './noteService.js';

const MAX_RESULT_CHARS = 24_000;
const READ_DOCUMENT_WINDOW = 8_000;

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
  /** Assistant-profile bindings scoping this turn, when a persona binds them. */
  skillIds?: readonly string[];
  collectionIds?: readonly string[];
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
  /** Mutating tools require the standard side-effect approval flow. */
  sideEffect?: boolean;
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
        context.collectionIds ? [...context.collectionIds] : undefined,
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
        .map(chunk => {
          const cite = [
            titles.get(chunk.documentId),
            `chunk ${chunk.chunkIndex}`,
            ...(chunk.location ? [chunk.location] : []),
          ].join(' · ');
          return `[${cite}]\n${chunk.content}`;
        })
        .join('\n\n');
      return { ...bounded(rendered), isError: false };
    },
  },
  {
    name: 'list_documents',
    description:
      'List the documents available to this chat: its uploads, attached knowledge collections, and standing uploads. Returns ids for read_document.',
    paramsSchema: {
      type: 'object',
      properties: {},
    },
    available: async () => true,
    execute: async (_args, context) => {
      const documents = await documentService.getDocumentsInScope(
        context.actor.userId,
        context.sessionId,
        context.collectionIds ? [...context.collectionIds] : undefined
      );
      if (documents.length === 0) {
        return {
          text: 'No documents are available in this chat.',
          isError: false,
          truncated: false,
        };
      }
      const rendered = documents
        .map(document => {
          const chars = (document.content ?? '').length;
          const type = document.fileType ?? 'txt';
          return `- ${document.filename} (id: ${document.id}, ${type}, ${chars} chars)`;
        })
        .join('\n');
      return { ...bounded(rendered), isError: false };
    },
  },
  {
    name: 'read_document',
    description:
      'Read part of an available document by id. Returns up to 8000 characters from the requested offset with its source location.',
    paramsSchema: {
      type: 'object',
      properties: {
        document_id: {
          type: 'string',
          description: 'The document id from list_documents or search results',
        },
        offset: {
          type: 'integer',
          description: 'Character offset to start reading from (default 0)',
        },
      },
      required: ['document_id'],
    },
    available: async () => true,
    execute: async (args, context) => {
      const documentId = asString(args.document_id).trim();
      if (!documentId) {
        return {
          text: 'A document_id is required.',
          isError: true,
          truncated: false,
        };
      }
      const documents = await documentService.getDocumentsInScope(
        context.actor.userId,
        context.sessionId,
        context.collectionIds ? [...context.collectionIds] : undefined
      );
      const document = documents.find(candidate => candidate.id === documentId);
      if (!document) {
        return {
          text: `No available document has the id "${documentId}". Call list_documents first.`,
          isError: true,
          truncated: false,
        };
      }
      const content = document.content ?? '';
      const total = content.length;
      const requestedOffset =
        typeof args.offset === 'number' && Number.isFinite(args.offset)
          ? Math.trunc(args.offset)
          : 0;
      const offset = Math.min(Math.max(requestedOffset, 0), total);
      const window = content.slice(offset, offset + READ_DOCUMENT_WINDOW);
      if (!window) {
        return {
          text: `The document "${document.filename}" has ${total} characters; offset ${offset} is past its end.`,
          isError: true,
          truncated: false,
        };
      }
      const location = resolveSegmentLabel(
        readDocumentSegments(document.metadata),
        offset,
        offset + window.length
      );
      const end = offset + window.length;
      const header = [
        `# ${document.filename}`,
        `chars ${offset}-${end} of ${total}`,
        ...(location ? [location] : []),
        ...(end < total ? [`continue with offset ${end}`] : []),
      ].join(' · ');
      return { ...bounded(`${header}\n\n${window}`), isError: false };
    },
  },
  {
    name: 'list_notes',
    description:
      "List the user's notes (own and shared) with their ids and titles.",
    paramsSchema: {
      type: 'object',
      properties: {},
    },
    available: async () => true,
    execute: async (_args, context) => {
      const all = await listNotes(context.actor);
      if (all.length === 0) {
        return {
          text: 'No notes exist yet.',
          isError: false,
          truncated: false,
        };
      }
      const rendered = all
        .map(entry => {
          const marks = [
            ...(entry.pinned ? ['pinned'] : []),
            ...(entry.shared ? [`shared, ${entry.shared.permission}`] : []),
          ];
          const suffix = marks.length > 0 ? ` [${marks.join('; ')}]` : '';
          return `- ${entry.title || 'Untitled'} (id: ${entry.id})${suffix}`;
        })
        .join('\n');
      return { ...bounded(rendered), isError: false };
    },
  },
  {
    name: 'read_note',
    description: 'Read the full content of one note by its id.',
    paramsSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The note id from list_notes' },
      },
      required: ['note_id'],
    },
    available: async () => true,
    execute: async (args, context) => {
      const noteId = asString(args.note_id).trim();
      try {
        const note = await getNote(context.actor, noteId);
        return {
          ...bounded(`# ${note.title || 'Untitled'}\n\n${note.content}`),
          isError: false,
        };
      } catch (error) {
        if (error instanceof NoteError) {
          return { text: error.message, isError: true, truncated: false };
        }
        throw error;
      }
    },
  },
  {
    name: 'create_note',
    description:
      'Create a new note with a title and Markdown content. Requires approval.',
    sideEffect: true,
    paramsSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The note title' },
        content: { type: 'string', description: 'The Markdown note content' },
      },
      required: ['title', 'content'],
    },
    available: async () => true,
    execute: async (args, context) => {
      try {
        const note = await createNote(context.actor, {
          title: asString(args.title),
          content: asString(args.content),
        });
        return {
          text: `Created note "${note.title}" (id: ${note.id}).`,
          isError: false,
          truncated: false,
        };
      } catch (error) {
        if (error instanceof NoteError) {
          return { text: error.message, isError: true, truncated: false };
        }
        throw error;
      }
    },
  },
  {
    name: 'update_note',
    description:
      'Replace the content (and optionally the title) of an existing note. The previous state is kept as a restorable revision. Requires approval.',
    sideEffect: true,
    paramsSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string', description: 'The note id from list_notes' },
        content: {
          type: 'string',
          description: 'The complete replacement Markdown content',
        },
        title: { type: 'string', description: 'Optional replacement title' },
      },
      required: ['note_id', 'content'],
    },
    available: async () => true,
    execute: async (args, context) => {
      const noteId = asString(args.note_id).trim();
      try {
        const note = await updateNote(context.actor, noteId, {
          content: asString(args.content),
          ...(typeof args.title === 'string' ? { title: args.title } : {}),
        });
        return {
          text: `Updated note "${note.title}" (id: ${note.id}); the previous version is saved as a revision.`,
          isError: false,
          truncated: false,
        };
      } catch (error) {
        if (error instanceof NoteError) {
          return { text: error.message, isError: true, truncated: false };
        }
        throw error;
      }
    },
  },
  {
    name: 'load_skill',
    description:
      'Load the full instructions of one of the available skills by its slug.',
    paramsSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The skill slug to load' },
      },
      required: ['slug'],
    },
    available: async context => (await availableSkills(context)).length > 0,
    execute: async (args, context) => {
      const slug = asString(args.slug).trim();
      const permitted = await availableSkills(context);
      const listed = permitted.find(skill => skill.slug === slug);
      const skill = listed
        ? await getSkillBySlug(context.actor.userId, slug)
        : null;
      if (!skill || !skill.enabled) {
        return {
          text: `No enabled skill named "${slug}" is available.`,
          isError: true,
          truncated: false,
        };
      }
      const files = (await listSkillFiles(skill.id, context.actor)) ?? [];
      const inventory =
        files.length > 0
          ? [
              '',
              '',
              'Bundled files (read one with read_skill_file):',
              ...files.map(file => `- ${file.path} (${file.size} bytes)`),
            ].join('\n')
          : '';
      return {
        ...bounded(
          `# Skill: ${skill.name}\n\n${skill.instructions}${inventory}`
        ),
        isError: false,
      };
    },
  },
  {
    name: 'read_skill_file',
    description:
      'Read a file bundled with a loaded skill. Pass the skill slug and the relative path listed by load_skill.',
    paramsSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The skill slug' },
        path: {
          type: 'string',
          description: 'The bundled file path, as listed by load_skill',
        },
      },
      required: ['slug', 'path'],
    },
    available: async context => (await availableSkills(context)).length > 0,
    execute: async (args, context) => {
      const slug = asString(args.slug).trim();
      const path = asString(args.path).trim();
      const permitted = await availableSkills(context);
      const listed = permitted.find(skill => skill.slug === slug);
      const skill = listed
        ? await getSkillBySlug(context.actor.userId, slug)
        : null;
      if (!skill || !skill.enabled) {
        return {
          text: `No enabled skill named "${slug}" is available.`,
          isError: true,
          truncated: false,
        };
      }
      let file;
      try {
        file = await getSkillFile(skill.id, context.actor, path);
      } catch {
        file = null;
      }
      if (!file) {
        return {
          text: `The skill "${slug}" bundles no file at "${path}". Call load_skill to list its files.`,
          isError: true,
          truncated: false,
        };
      }
      return {
        ...bounded(`# ${slug}/${file.path}\n\n${file.content}`),
        isError: false,
      };
    },
  },
];

const MAX_MANIFEST_SKILLS = 30;

/** Enabled skills visible to this turn, honoring a profile's skill binding. */
const availableSkills = async (
  context: BuiltinToolContext
): Promise<Array<{ slug: string; name: string; description: string }>> => {
  const skills = await listSkills(context.actor.userId);
  return skills
    .filter(skill => skill.enabled)
    .filter(skill => !context.skillIds || context.skillIds.includes(skill.id))
    .slice(0, MAX_MANIFEST_SKILLS)
    .map(skill => ({
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
    }));
};

/**
 * The lazy skill manifest travels in the load_skill tool description, so it
 * reaches the model identically on every provider without touching the
 * system-prompt plumbing.
 */
const loadSkillDescription = (
  skills: readonly { slug: string; name: string; description: string }[]
): string =>
  [
    'Load the full instructions of one of the available skills by its slug before applying it. Available skills:',
    ...skills.map(
      skill =>
        `- ${skill.slug}: ${skill.name} — ${skill.description.slice(0, 200)}`
    ),
  ].join('\n');

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
    const description =
      tool.name === 'load_skill'
        ? loadSkillDescription(await availableSkills(context))
        : tool.description;
    catalog.push({
      name: tool.name,
      description,
      paramsSchema: tool.paramsSchema,
      sideEffect: tool.sideEffect === true,
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
