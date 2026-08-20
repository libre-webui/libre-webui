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
 * Prompt library (PROMPT-01): versioned, shareable prompt templates.
 *
 * Titles, descriptions, bodies, variable declarations, and tags are
 * encrypted at the service boundary. Slugs stay in plaintext: they carry the
 * per-owner uniqueness constraint and are the lookup key, neither of which
 * survives encryption.
 */

import { v4 as uuidv4 } from 'uuid';
import { encryptionService } from './encryptionService.js';
import { getPersistence } from '../persistence/index.js';
import { PersistenceResourceLimitError } from '../persistence/resourceTypes.js';
import type {
  StoredPromptRecord,
  StoredPromptVersionRecord,
} from '../persistence/resourceTypes.js';
import {
  authorize,
  requireAuthorized,
  type AuthzActor,
} from './authorizationService.js';
import { deleteGrantsForResource } from './resourceGrantService.js';
import {
  grantedResourceIdsFor,
  sharedMetaFor,
  type SharedResourceMeta,
} from './sharedResourceAccess.js';
import { recordAuditEvent } from './securityAuditService.js';
import {
  MAX_PROMPT_CONTENT_LENGTH,
  MAX_PROMPT_DESCRIPTION_LENGTH,
  MAX_PROMPT_SLUG_LENGTH,
  MAX_PROMPT_TAGS,
  MAX_PROMPT_TITLE_LENGTH,
  MAX_PROMPT_VARIABLES,
  MAX_PROMPT_VERSIONS,
  MAX_PROMPTS_PER_USER,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';

export type PromptVariableType = 'text' | 'number' | 'select' | 'boolean';

export interface PromptVariable {
  name: string;
  type: PromptVariableType;
  label?: string;
  required?: boolean;
  default?: string;
  options?: string[];
}

export interface Prompt {
  id: string;
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: PromptVariable[];
  tags: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
}

export interface PromptInput {
  slug?: unknown;
  title?: unknown;
  description?: unknown;
  content?: unknown;
  variables?: unknown;
  tags?: unknown;
}

export interface PromptRevision {
  version: number;
  content: string;
  variables: PromptVariable[];
  createdAt: number;
}

export const PROMPT_EXPORT_FORMAT = 'libre-prompt.v1';

export interface PromptExport {
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: PromptVariable[];
  tags: string[];
  version: number;
  exportedAt: number;
  format: typeof PROMPT_EXPORT_FORMAT;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;
const VARIABLE_TYPES: readonly PromptVariableType[] = [
  'text',
  'number',
  'select',
  'boolean',
];
const MAX_TAG_LENGTH = 64;

const prompts = () =>
  getPersistence(encryptionService).repositories.resources.prompts;

const readText = (
  value: unknown,
  field: string,
  maximum: number,
  required: boolean
): string | undefined => {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ResourcePolicyError(`${field} is required`, 400);
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ResourcePolicyError(`${field} must be a string`, 400);
  }
  if (value.length > maximum) {
    throw new ResourcePolicyError(
      `${field} exceeds the maximum length of ${maximum} characters`,
      400
    );
  }
  return value;
};

const readSlug = (value: unknown): string => {
  const slug = readText(value, 'slug', MAX_PROMPT_SLUG_LENGTH, true) as string;
  if (!SLUG_PATTERN.test(slug)) {
    throw new ResourcePolicyError(
      'slug must be lowercase alphanumeric with hyphens and start with a letter or digit',
      400
    );
  }
  return slug;
};

const readVariables = (value: unknown): PromptVariable[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ResourcePolicyError('variables must be an array', 400);
  }
  if (value.length > MAX_PROMPT_VARIABLES) {
    throw new ResourcePolicyError(
      `A prompt may declare at most ${MAX_PROMPT_VARIABLES} variables`,
      400
    );
  }
  const seen = new Set<string>();
  return value.map(entry => {
    if (typeof entry !== 'object' || entry === null) {
      throw new ResourcePolicyError('each variable must be an object', 400);
    }
    const raw = entry as Record<string, unknown>;
    const name = raw.name;
    if (typeof name !== 'string' || !VARIABLE_NAME_PATTERN.test(name)) {
      throw new ResourcePolicyError(
        'variable names must be identifiers of at most 64 characters',
        400
      );
    }
    if (seen.has(name)) {
      throw new ResourcePolicyError(`duplicate variable "${name}"`, 400);
    }
    seen.add(name);
    const type = raw.type;
    if (
      typeof type !== 'string' ||
      !(VARIABLE_TYPES as readonly string[]).includes(type)
    ) {
      throw new ResourcePolicyError(
        `variable "${name}" must declare one of: ${VARIABLE_TYPES.join(', ')}`,
        400
      );
    }
    const label = readText(raw.label, `variable "${name}" label`, 200, false);
    const defaultValue = readText(
      raw.default,
      `variable "${name}" default`,
      1000,
      false
    );
    let options: string[] | undefined;
    if (raw.options !== undefined && raw.options !== null) {
      if (
        !Array.isArray(raw.options) ||
        raw.options.some(option => typeof option !== 'string' || !option)
      ) {
        throw new ResourcePolicyError(
          `variable "${name}" options must be non-empty strings`,
          400
        );
      }
      if (raw.options.length > MAX_PROMPT_VARIABLES) {
        throw new ResourcePolicyError(
          `variable "${name}" declares too many options`,
          400
        );
      }
      options = raw.options as string[];
    }
    if (type === 'select' && (!options || options.length === 0)) {
      throw new ResourcePolicyError(
        `variable "${name}" is a select and needs at least one option`,
        400
      );
    }
    return {
      name,
      type: type as PromptVariableType,
      ...(label !== undefined ? { label } : {}),
      ...(raw.required === true ? { required: true } : {}),
      ...(defaultValue !== undefined ? { default: defaultValue } : {}),
      ...(options !== undefined ? { options } : {}),
    };
  });
};

const readTags = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new ResourcePolicyError('tags must be an array', 400);
  }
  if (value.length > MAX_PROMPT_TAGS) {
    throw new ResourcePolicyError(
      `A prompt may carry at most ${MAX_PROMPT_TAGS} tags`,
      400
    );
  }
  const tags: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry) {
      throw new ResourcePolicyError('each tag must be a non-empty string', 400);
    }
    if (entry.length > MAX_TAG_LENGTH) {
      throw new ResourcePolicyError(
        `tags may be at most ${MAX_TAG_LENGTH} characters`,
        400
      );
    }
    if (!tags.includes(entry)) tags.push(entry);
  }
  return tags;
};

/** Every `{{token}}` in the body must resolve to a declared variable. */
const assertPlaceholdersDeclared = (
  content: string,
  variables: PromptVariable[]
): void => {
  const declared = new Set(variables.map(variable => variable.name));
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match = PLACEHOLDER_PATTERN.exec(content);
  while (match !== null) {
    const name = match[1] as string;
    if (!declared.has(name)) {
      throw new ResourcePolicyError(
        `content references undeclared variable "${name}"`,
        400
      );
    }
    match = PLACEHOLDER_PATTERN.exec(content);
  }
};

interface NormalizedPrompt {
  slug: string;
  title: string;
  description?: string;
  content: string;
  variables: PromptVariable[];
  tags: string[];
}

const normalize = (input: PromptInput): NormalizedPrompt => {
  const slug = readSlug(input.slug);
  const title = readText(
    input.title,
    'title',
    MAX_PROMPT_TITLE_LENGTH,
    true
  ) as string;
  const description = readText(
    input.description,
    'description',
    MAX_PROMPT_DESCRIPTION_LENGTH,
    false
  );
  const content = readText(
    input.content,
    'content',
    MAX_PROMPT_CONTENT_LENGTH,
    true
  ) as string;
  const variables = readVariables(input.variables);
  const tags = readTags(input.tags);
  assertPlaceholdersDeclared(content, variables);
  return {
    slug,
    title,
    ...(description !== undefined ? { description } : {}),
    content,
    variables,
    tags,
  };
};

const parseVariables = (value: string | null): PromptVariable[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(encryptionService.decrypt(value)) as unknown;
    return Array.isArray(parsed) ? (parsed as PromptVariable[]) : [];
  } catch {
    return [];
  }
};

const parseTags = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(encryptionService.decrypt(value)) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
};

const mapPromptRow = (row: StoredPromptRecord): Prompt => ({
  id: row.id,
  slug: row.slug,
  title: encryptionService.decrypt(row.title),
  ...(row.description
    ? { description: encryptionService.decrypt(row.description) }
    : {}),
  content: encryptionService.decrypt(row.content),
  variables: parseVariables(row.variables),
  tags: parseTags(row.tags),
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerUserId: row.user_id,
});

const toRow = (
  prompt: Prompt,
  normalized: NormalizedPrompt
): StoredPromptRecord => ({
  id: prompt.id,
  user_id: prompt.ownerUserId,
  slug: normalized.slug,
  title: encryptionService.encrypt(normalized.title),
  description:
    normalized.description !== undefined
      ? encryptionService.encrypt(normalized.description)
      : null,
  content: encryptionService.encrypt(normalized.content),
  variables: encryptionService.encrypt(JSON.stringify(normalized.variables)),
  tags: encryptionService.encrypt(JSON.stringify(normalized.tags)),
  version: prompt.version,
  created_at: prompt.createdAt,
  updated_at: prompt.updatedAt,
});

const archiveRowOf = (row: StoredPromptRecord): StoredPromptVersionRecord => ({
  id: uuidv4(),
  prompt_id: row.id,
  version: row.version,
  content: row.content,
  variables: row.variables,
  created_at: row.updated_at,
});

const persist = async (
  row: StoredPromptRecord,
  archived: StoredPromptVersionRecord | null
): Promise<void> => {
  try {
    await prompts().replaceWithLimit(row, MAX_PROMPTS_PER_USER, archived);
  } catch (error) {
    if (error instanceof PersistenceResourceLimitError) {
      throw new ResourcePolicyError(
        `A user may store at most ${MAX_PROMPTS_PER_USER} prompts`,
        409
      );
    }
    throw error;
  }
};

const assertSlugAvailable = async (
  userId: string,
  slug: string,
  currentId?: string
): Promise<void> => {
  const existing = await prompts().findBySlug(userId, slug);
  if (existing && existing.id !== currentId) {
    throw new ResourcePolicyError(
      `A prompt already uses the slug "${slug}"`,
      409
    );
  }
};

/** Read access resolved through ownership or a grant; null hides existence. */
const readable = async (
  promptId: string,
  actor: AuthzActor
): Promise<StoredPromptRecord | null> => {
  const row = await prompts().findById(promptId);
  if (!row) return null;
  if (row.user_id === actor.userId) return row;
  const decision = await authorize(actor, 'read', {
    type: 'prompt',
    id: promptId,
    ownerUserId: row.user_id,
  });
  return decision.allowed ? row : null;
};

export const listPrompts = async (userId: string): Promise<Prompt[]> => {
  const rows = await prompts().listByOwner(userId, MAX_PROMPTS_PER_USER);
  return rows.map(mapPromptRow);
};

export interface PromptWithAccess extends Prompt {
  shared?: SharedResourceMeta;
}

/** Own prompts followed by prompts shared with the actor. */
export const listPromptsWithShared = async (
  actor: AuthzActor
): Promise<PromptWithAccess[]> => {
  const own: PromptWithAccess[] = (
    await prompts().listByOwner(actor.userId, MAX_PROMPTS_PER_USER)
  ).map(mapPromptRow);
  const sharedIds = await grantedResourceIdsFor(
    actor,
    'prompt',
    new Set(own.map(prompt => prompt.id))
  );
  const shared: PromptWithAccess[] = [];
  for (const promptId of sharedIds) {
    const row = await prompts().findById(promptId);
    if (!row || row.user_id === actor.userId) continue;
    const meta = await sharedMetaFor(actor, 'prompt', promptId, row.user_id);
    if (!meta) continue;
    shared.push({ ...mapPromptRow(row), shared: meta });
  }
  shared.sort((left, right) => right.updatedAt - left.updatedAt);
  return [...own, ...shared];
};

export const getPrompt = async (
  promptId: string,
  actor: AuthzActor
): Promise<Prompt | null> => {
  const row = await readable(promptId, actor);
  return row ? mapPromptRow(row) : null;
};

export const getPromptBySlug = async (
  userId: string,
  slug: string
): Promise<Prompt | null> => {
  const row = await prompts().findBySlug(userId, slug);
  return row ? mapPromptRow(row) : null;
};

export const createPrompt = async (
  userId: string,
  input: PromptInput
): Promise<Prompt> => {
  const normalized = normalize(input);
  await assertSlugAvailable(userId, normalized.slug);
  const now = Date.now();
  const prompt: Prompt = {
    id: uuidv4(),
    ...normalized,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ownerUserId: userId,
  };
  await persist(toRow(prompt, normalized), null);
  await recordAuditEvent({
    action: 'prompt.create',
    result: 'success',
    actorUserId: userId,
    targetType: 'prompt',
    targetId: prompt.id,
    details: { slug: prompt.slug, version: prompt.version },
  });
  return prompt;
};

export const updatePrompt = async (
  promptId: string,
  actor: AuthzActor,
  input: PromptInput
): Promise<Prompt | null> => {
  const existing = await readable(promptId, actor);
  if (!existing) return null;
  await requireAuthorized(actor, 'write', {
    type: 'prompt',
    id: promptId,
    ownerUserId: existing.user_id,
  });
  const normalized = normalize({
    slug: input.slug ?? existing.slug,
    title: input.title,
    description: input.description,
    content: input.content,
    variables: input.variables,
    tags: input.tags,
  });
  await assertSlugAvailable(existing.user_id, normalized.slug, promptId);
  const prompt: Prompt = {
    id: existing.id,
    ...normalized,
    version: existing.version + 1,
    createdAt: existing.created_at,
    updatedAt: Date.now(),
    ownerUserId: existing.user_id,
  };
  await persist(toRow(prompt, normalized), archiveRowOf(existing));
  await recordAuditEvent({
    action: 'prompt.update',
    result: 'success',
    actorUserId: actor.userId,
    targetType: 'prompt',
    targetId: prompt.id,
    details: { slug: prompt.slug, version: prompt.version },
  });
  return prompt;
};

export const deletePrompt = async (
  promptId: string,
  userId: string
): Promise<boolean> => {
  const deleted = await prompts().deleteByOwner(promptId, userId);
  if (!deleted) return false;
  await deleteGrantsForResource('prompt', promptId);
  await recordAuditEvent({
    action: 'prompt.delete',
    result: 'success',
    actorUserId: userId,
    targetType: 'prompt',
    targetId: promptId,
  });
  return true;
};

export const listVersions = async (
  promptId: string,
  actor: AuthzActor
): Promise<PromptRevision[] | null> => {
  const row = await readable(promptId, actor);
  if (!row) return null;
  const versions = await prompts().listVersions(promptId, MAX_PROMPT_VERSIONS);
  return versions.map(version => ({
    version: version.version,
    content: encryptionService.decrypt(version.content),
    variables: parseVariables(version.variables),
    createdAt: version.created_at,
  }));
};

/** A rollback replays an archived revision forward as the next version. */
export const rollbackPrompt = async (
  promptId: string,
  actor: AuthzActor,
  version: number
): Promise<Prompt | null> => {
  const existing = await readable(promptId, actor);
  if (!existing) return null;
  await requireAuthorized(actor, 'write', {
    type: 'prompt',
    id: promptId,
    ownerUserId: existing.user_id,
  });
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ResourcePolicyError('version must be a positive integer', 400);
  }
  const revision = await prompts().findVersion(promptId, version);
  if (!revision) {
    throw new ResourcePolicyError(`Version ${version} is not archived`, 400);
  }
  const restored: StoredPromptRecord = {
    ...existing,
    content: revision.content,
    variables: revision.variables,
    version: existing.version + 1,
    updated_at: Date.now(),
  };
  await persist(restored, archiveRowOf(existing));
  await recordAuditEvent({
    action: 'prompt.rollback',
    result: 'success',
    actorUserId: actor.userId,
    targetType: 'prompt',
    targetId: promptId,
    details: { restoredFrom: version, version: restored.version },
  });
  return mapPromptRow(restored);
};

export const exportPrompt = async (
  promptId: string,
  actor: AuthzActor
): Promise<PromptExport | null> => {
  const prompt = await getPrompt(promptId, actor);
  if (!prompt) return null;
  return {
    slug: prompt.slug,
    title: prompt.title,
    ...(prompt.description !== undefined
      ? { description: prompt.description }
      : {}),
    content: prompt.content,
    variables: prompt.variables,
    tags: prompt.tags,
    version: prompt.version,
    exportedAt: Date.now(),
    format: PROMPT_EXPORT_FORMAT,
  };
};

export const importPrompt = async (
  userId: string,
  payload: unknown,
  options: { overwriteSlug?: boolean } = {}
): Promise<Prompt> => {
  if (typeof payload !== 'object' || payload === null) {
    throw new ResourcePolicyError('An import payload is required', 400);
  }
  const raw = payload as Record<string, unknown>;
  if (raw.format !== undefined && raw.format !== PROMPT_EXPORT_FORMAT) {
    throw new ResourcePolicyError(
      `Unsupported import format; expected ${PROMPT_EXPORT_FORMAT}`,
      400
    );
  }
  const normalized = normalize(raw as PromptInput);
  const existing = await prompts().findBySlug(userId, normalized.slug);
  if (existing && !options.overwriteSlug) {
    throw new ResourcePolicyError(
      `A prompt already uses the slug "${normalized.slug}"`,
      409
    );
  }
  const now = Date.now();
  const prompt: Prompt = {
    id: existing?.id ?? uuidv4(),
    ...normalized,
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
    ownerUserId: userId,
  };
  await persist(
    toRow(prompt, normalized),
    existing ? archiveRowOf(existing) : null
  );
  await recordAuditEvent({
    action: 'prompt.import',
    result: 'success',
    actorUserId: userId,
    targetType: 'prompt',
    targetId: prompt.id,
    details: {
      slug: prompt.slug,
      version: prompt.version,
      overwrote: Boolean(existing),
    },
  });
  return prompt;
};

/**
 * Pure substitution used by the chat surface: validates the supplied values
 * against the declarations, then replaces every `{{name}}` token.
 */
export const renderPrompt = (
  content: string,
  variables: PromptVariable[],
  values: Record<string, unknown>
): string => {
  const resolved = new Map<string, string>();
  for (const variable of variables) {
    const supplied = values[variable.name];
    const raw =
      supplied === undefined || supplied === null || supplied === ''
        ? variable.default
        : supplied;
    if (raw === undefined || raw === null || raw === '') {
      if (variable.required) {
        throw new ResourcePolicyError(
          `variable "${variable.name}" is required`,
          400
        );
      }
      resolved.set(variable.name, '');
      continue;
    }
    if (variable.type === 'number') {
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(parsed)) {
        throw new ResourcePolicyError(
          `variable "${variable.name}" must be a number`,
          400
        );
      }
      resolved.set(variable.name, String(parsed));
      continue;
    }
    if (variable.type === 'boolean') {
      const truthy = raw === true || raw === 'true';
      const falsy = raw === false || raw === 'false';
      if (!truthy && !falsy) {
        throw new ResourcePolicyError(
          `variable "${variable.name}" must be a boolean`,
          400
        );
      }
      resolved.set(variable.name, truthy ? 'true' : 'false');
      continue;
    }
    const text = String(raw);
    if (
      variable.type === 'select' &&
      !(variable.options ?? []).includes(text)
    ) {
      throw new ResourcePolicyError(
        `variable "${variable.name}" must be one of the declared options`,
        400
      );
    }
    resolved.set(variable.name, text);
  }
  return content.replace(
    PLACEHOLDER_PATTERN,
    (match, name: string) => resolved.get(name) ?? match
  );
};
