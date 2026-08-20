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
 * Skills workspace (SKILL-01): versioned instruction sets an assistant can
 * load on demand. The description is mandatory because it is the manifest
 * line the model sees before deciding to open the full instructions.
 *
 * Names, descriptions, and instructions are encrypted at the service
 * boundary. Slugs stay in plaintext: they carry the per-owner uniqueness
 * constraint and are the lookup key.
 */

import { v4 as uuidv4 } from 'uuid';
import { encryptionService } from './encryptionService.js';
import { getPersistence } from '../persistence/index.js';
import { PersistenceResourceLimitError } from '../persistence/resourceTypes.js';
import type {
  StoredSkillRecord,
  StoredSkillVersionRecord,
} from '../persistence/resourceTypes.js';
import {
  authorize,
  requireAuthorized,
  type AuthzActor,
} from './authorizationService.js';
import { deleteGrantsForResource } from './resourceGrantService.js';
import { recordAuditEvent } from './securityAuditService.js';
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_SLUG_LENGTH,
  MAX_SKILL_VERSIONS,
  MAX_SKILLS_PER_USER,
  ResourcePolicyError,
} from '../utils/resourceLimits.js';

export interface Skill {
  id: string;
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  createdAt: number;
  updatedAt: number;
  ownerUserId: string;
}

export interface SkillInput {
  slug?: unknown;
  name?: unknown;
  description?: unknown;
  instructions?: unknown;
  enabled?: unknown;
}

export interface SkillRevision {
  version: number;
  instructions: string;
  createdAt: number;
}

export interface SkillManifest {
  slug: string;
  name: string;
  description: string;
}

export const SKILL_EXPORT_FORMAT = 'libre-skill.v1';

export interface SkillExport {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
  version: number;
  exportedAt: number;
  format: typeof SKILL_EXPORT_FORMAT;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const skills = () =>
  getPersistence(encryptionService).repositories.resources.skills;

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
  const slug = readText(value, 'slug', MAX_SKILL_SLUG_LENGTH, true) as string;
  if (!SLUG_PATTERN.test(slug)) {
    throw new ResourcePolicyError(
      'slug must be lowercase alphanumeric with hyphens and start with a letter or digit',
      400
    );
  }
  return slug;
};

interface NormalizedSkill {
  slug: string;
  name: string;
  description: string;
  instructions: string;
  enabled: boolean;
}

const normalize = (
  input: SkillInput,
  fallbackEnabled = true
): NormalizedSkill => ({
  slug: readSlug(input.slug),
  name: readText(input.name, 'name', MAX_SKILL_NAME_LENGTH, true) as string,
  description: readText(
    input.description,
    'description',
    MAX_SKILL_DESCRIPTION_LENGTH,
    true
  ) as string,
  instructions: readText(
    input.instructions,
    'instructions',
    MAX_SKILL_INSTRUCTIONS_LENGTH,
    true
  ) as string,
  enabled:
    input.enabled === undefined ? fallbackEnabled : input.enabled !== false,
});

const mapSkillRow = (row: StoredSkillRecord): Skill => ({
  id: row.id,
  slug: row.slug,
  name: encryptionService.decrypt(row.name),
  description: encryptionService.decrypt(row.description),
  instructions: encryptionService.decrypt(row.instructions),
  enabled: row.enabled === 1,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ownerUserId: row.user_id,
});

const toRow = (
  skill: Skill,
  normalized: NormalizedSkill
): StoredSkillRecord => ({
  id: skill.id,
  user_id: skill.ownerUserId,
  slug: normalized.slug,
  name: encryptionService.encrypt(normalized.name),
  description: encryptionService.encrypt(normalized.description),
  instructions: encryptionService.encrypt(normalized.instructions),
  enabled: normalized.enabled ? 1 : 0,
  version: skill.version,
  created_at: skill.createdAt,
  updated_at: skill.updatedAt,
});

const archiveRowOf = (row: StoredSkillRecord): StoredSkillVersionRecord => ({
  id: uuidv4(),
  skill_id: row.id,
  version: row.version,
  instructions: row.instructions,
  created_at: row.updated_at,
});

const persist = async (
  row: StoredSkillRecord,
  archived: StoredSkillVersionRecord | null
): Promise<void> => {
  try {
    await skills().replaceWithLimit(row, MAX_SKILLS_PER_USER, archived);
  } catch (error) {
    if (error instanceof PersistenceResourceLimitError) {
      throw new ResourcePolicyError(
        `A user may store at most ${MAX_SKILLS_PER_USER} skills`,
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
  const existing = await skills().findBySlug(userId, slug);
  if (existing && existing.id !== currentId) {
    throw new ResourcePolicyError(
      `A skill already uses the slug "${slug}"`,
      409
    );
  }
};

/** Read access resolved through ownership or a grant; null hides existence. */
const readable = async (
  skillId: string,
  actor: AuthzActor
): Promise<StoredSkillRecord | null> => {
  const row = await skills().findById(skillId);
  if (!row) return null;
  if (row.user_id === actor.userId) return row;
  const decision = await authorize(actor, 'read', {
    type: 'skill',
    id: skillId,
    ownerUserId: row.user_id,
  });
  return decision.allowed ? row : null;
};

export const listSkills = async (userId: string): Promise<Skill[]> => {
  const rows = await skills().listByOwner(userId, MAX_SKILLS_PER_USER);
  return rows.map(mapSkillRow);
};

export const getSkill = async (
  skillId: string,
  actor: AuthzActor
): Promise<Skill | null> => {
  const row = await readable(skillId, actor);
  return row ? mapSkillRow(row) : null;
};

export const getSkillBySlug = async (
  userId: string,
  slug: string
): Promise<Skill | null> => {
  const row = await skills().findBySlug(userId, slug);
  return row ? mapSkillRow(row) : null;
};

export const createSkill = async (
  userId: string,
  input: SkillInput
): Promise<Skill> => {
  const normalized = normalize(input);
  await assertSlugAvailable(userId, normalized.slug);
  const now = Date.now();
  const skill: Skill = {
    id: uuidv4(),
    ...normalized,
    version: 1,
    createdAt: now,
    updatedAt: now,
    ownerUserId: userId,
  };
  await persist(toRow(skill, normalized), null);
  await recordAuditEvent({
    action: 'skill.create',
    result: 'success',
    actorUserId: userId,
    targetType: 'skill',
    targetId: skill.id,
    details: { slug: skill.slug, version: skill.version },
  });
  return skill;
};

export const updateSkill = async (
  skillId: string,
  actor: AuthzActor,
  input: SkillInput
): Promise<Skill | null> => {
  const existing = await readable(skillId, actor);
  if (!existing) return null;
  await requireAuthorized(actor, 'write', {
    type: 'skill',
    id: skillId,
    ownerUserId: existing.user_id,
  });
  const normalized = normalize(
    {
      slug: input.slug ?? existing.slug,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      enabled: input.enabled,
    },
    existing.enabled === 1
  );
  await assertSlugAvailable(existing.user_id, normalized.slug, skillId);
  const skill: Skill = {
    id: existing.id,
    ...normalized,
    version: existing.version + 1,
    createdAt: existing.created_at,
    updatedAt: Date.now(),
    ownerUserId: existing.user_id,
  };
  await persist(toRow(skill, normalized), archiveRowOf(existing));
  await recordAuditEvent({
    action: 'skill.update',
    result: 'success',
    actorUserId: actor.userId,
    targetType: 'skill',
    targetId: skill.id,
    details: {
      slug: skill.slug,
      version: skill.version,
      enabled: skill.enabled,
    },
  });
  return skill;
};

export const deleteSkill = async (
  skillId: string,
  userId: string
): Promise<boolean> => {
  const deleted = await skills().deleteByOwner(skillId, userId);
  if (!deleted) return false;
  await deleteGrantsForResource('skill', skillId);
  await recordAuditEvent({
    action: 'skill.delete',
    result: 'success',
    actorUserId: userId,
    targetType: 'skill',
    targetId: skillId,
  });
  return true;
};

export const listVersions = async (
  skillId: string,
  actor: AuthzActor
): Promise<SkillRevision[] | null> => {
  const row = await readable(skillId, actor);
  if (!row) return null;
  const versions = await skills().listVersions(skillId, MAX_SKILL_VERSIONS);
  return versions.map(version => ({
    version: version.version,
    instructions: encryptionService.decrypt(version.instructions),
    createdAt: version.created_at,
  }));
};

/** A rollback replays an archived revision forward as the next version. */
export const rollbackSkill = async (
  skillId: string,
  actor: AuthzActor,
  version: number
): Promise<Skill | null> => {
  const existing = await readable(skillId, actor);
  if (!existing) return null;
  await requireAuthorized(actor, 'write', {
    type: 'skill',
    id: skillId,
    ownerUserId: existing.user_id,
  });
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new ResourcePolicyError('version must be a positive integer', 400);
  }
  const revision = await skills().findVersion(skillId, version);
  if (!revision) {
    throw new ResourcePolicyError(`Version ${version} is not archived`, 400);
  }
  const restored: StoredSkillRecord = {
    ...existing,
    instructions: revision.instructions,
    version: existing.version + 1,
    updated_at: Date.now(),
  };
  await persist(restored, archiveRowOf(existing));
  await recordAuditEvent({
    action: 'skill.rollback',
    result: 'success',
    actorUserId: actor.userId,
    targetType: 'skill',
    targetId: skillId,
    details: { restoredFrom: version, version: restored.version },
  });
  return mapSkillRow(restored);
};

/**
 * The SKILL.md interchange form: YAML-style frontmatter carrying the
 * manifest fields, followed by the Markdown instructions verbatim.
 */
export const skillToMarkdown = (skill: {
  slug: string;
  name: string;
  description: string;
  instructions: string;
}): string => {
  const escape = (value: string): string => value.replace(/\r?\n/g, ' ').trim();
  return [
    '---',
    `name: ${escape(skill.name)}`,
    `slug: ${escape(skill.slug)}`,
    `description: ${escape(skill.description)}`,
    '---',
    '',
    skill.instructions.trimEnd(),
    '',
  ].join('\n');
};

const SLUGIFY_PATTERN = /[^a-z0-9-]+/g;

/** Parse a SKILL.md document (frontmatter + body) into a skill input. */
export const skillFromMarkdown = (markdown: string): SkillInput => {
  const match = markdown.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    throw new ResourcePolicyError(
      'A SKILL.md file starts with frontmatter: --- name/description ---',
      400
    );
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (key && value) fields[key] = value;
  }
  const name = fields.name ?? '';
  const description = fields.description ?? '';
  const slug =
    fields.slug ??
    name
      .toLowerCase()
      .replace(SLUGIFY_PATTERN, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64);
  const instructions = markdown.slice(match[0].length).trim();
  return { slug, name, description, instructions };
};

export const exportSkill = async (
  skillId: string,
  actor: AuthzActor
): Promise<(SkillExport & { markdown: string }) | null> => {
  const skill = await getSkill(skillId, actor);
  if (!skill) return null;
  return {
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    enabled: skill.enabled,
    version: skill.version,
    exportedAt: Date.now(),
    format: SKILL_EXPORT_FORMAT,
    markdown: skillToMarkdown(skill),
  };
};

export const importSkill = async (
  userId: string,
  payload: unknown,
  options: { overwriteSlug?: boolean } = {}
): Promise<Skill> => {
  if (typeof payload !== 'object' || payload === null) {
    throw new ResourcePolicyError('An import payload is required', 400);
  }
  const raw = payload as Record<string, unknown>;
  if (raw.format !== undefined && raw.format !== SKILL_EXPORT_FORMAT) {
    throw new ResourcePolicyError(
      `Unsupported import format; expected ${SKILL_EXPORT_FORMAT}`,
      400
    );
  }
  // A SKILL.md document is the preferred interchange form. A JSON export
  // envelope also carries the markdown for convenience, so explicit fields
  // win when present — they preserve state markdown cannot (enabled).
  const normalized = normalize(
    typeof raw.markdown === 'string' && typeof raw.instructions !== 'string'
      ? skillFromMarkdown(raw.markdown)
      : (raw as SkillInput)
  );
  const existing = await skills().findBySlug(userId, normalized.slug);
  if (existing && !options.overwriteSlug) {
    throw new ResourcePolicyError(
      `A skill already uses the slug "${normalized.slug}"`,
      409
    );
  }
  const now = Date.now();
  const skill: Skill = {
    id: existing?.id ?? uuidv4(),
    ...normalized,
    version: existing ? existing.version + 1 : 1,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
    ownerUserId: userId,
  };
  await persist(
    toRow(skill, normalized),
    existing ? archiveRowOf(existing) : null
  );
  await recordAuditEvent({
    action: 'skill.import',
    result: 'success',
    actorUserId: userId,
    targetType: 'skill',
    targetId: skill.id,
    details: {
      slug: skill.slug,
      version: skill.version,
      overwrote: Boolean(existing),
    },
  });
  return skill;
};

/** The lazy manifest line: what the model sees before loading instructions. */
export const skillManifest = (skill: Skill): SkillManifest => ({
  slug: skill.slug,
  name: skill.name,
  description: skill.description,
});

// === Remote skill import ===
//
// Skills travel as SKILL.md documents in public Git repositories, and
// registries such as skills.sh identify them as `owner/repo[/skill]`. The
// resolver turns every accepted spelling into a bounded list of candidate
// raw-content URLs; the fetch itself goes through the pinned egress guard,
// so a skill source can never reach private address space.

const MAX_REMOTE_SKILL_BYTES = 200 * 1024;
const REMOTE_FETCH_TIMEOUT_MS = 15_000;
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

const rawGitHubUrl = (
  owner: string,
  repo: string,
  ref: string,
  path: string
): string =>
  `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${path}`;

const candidatesForRepoSkill = (
  owner: string,
  repo: string,
  ref: string,
  skill?: string
): string[] => {
  if (!skill) return [rawGitHubUrl(owner, repo, ref, 'SKILL.md')];
  return [
    rawGitHubUrl(owner, repo, ref, `skills/${skill}/SKILL.md`),
    rawGitHubUrl(owner, repo, ref, `skills/.curated/${skill}/SKILL.md`),
    rawGitHubUrl(owner, repo, ref, `${skill}/SKILL.md`),
  ];
};

/**
 * Accepted source spellings, resolved to candidate SKILL.md URLs:
 * - a direct URL to a Markdown document,
 * - `owner/repo` or `owner/repo/skill` shorthand,
 * - a skills.sh listing URL,
 * - a github.com repo, tree, or blob URL.
 */
export const resolveSkillSourceCandidates = (rawSource: string): string[] => {
  const source = rawSource.trim();
  if (!source || source.length > 512) {
    throw new ResourcePolicyError('A skill source is required', 400);
  }

  if (!/^https?:\/\//i.test(source)) {
    const segments = source.split('/').filter(Boolean);
    if (
      segments.length < 2 ||
      segments.length > 3 ||
      !segments.every(segment => GITHUB_SEGMENT.test(segment))
    ) {
      throw new ResourcePolicyError(
        'Use owner/repo, owner/repo/skill, or a full URL',
        400
      );
    }
    const [owner, repo, skill] = segments;
    return candidatesForRepoSkill(owner, repo, 'HEAD', skill);
  }

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new ResourcePolicyError('Invalid skill source URL', 400);
  }
  const host = url.hostname.toLowerCase();
  const segments = url.pathname.split('/').filter(Boolean);

  if (host === 'skills.sh' || host === 'www.skills.sh') {
    const [owner, repo, skill] = segments;
    if (!owner || !repo) {
      throw new ResourcePolicyError(
        'A skills.sh source needs at least owner/repo in its path',
        400
      );
    }
    return candidatesForRepoSkill(owner, repo, 'HEAD', skill);
  }

  if (host === 'github.com' || host === 'www.github.com') {
    const [owner, repo, kind, ref, ...rest] = segments;
    if (!owner || !repo) {
      throw new ResourcePolicyError('A repository URL needs owner/repo', 400);
    }
    if ((kind === 'tree' || kind === 'blob') && ref) {
      const path = rest.join('/');
      if (path.toLowerCase().endsWith('.md')) {
        return [rawGitHubUrl(owner, repo, ref, path)];
      }
      return [
        rawGitHubUrl(owner, repo, ref, path ? `${path}/SKILL.md` : 'SKILL.md'),
      ];
    }
    return candidatesForRepoSkill(owner, repo, 'HEAD', segments[2]);
  }

  // Any other URL must point at the Markdown document itself.
  return [url.toString()];
};

/** Import one skill from a remote SKILL.md source. */
export const importSkillFromUrl = async (
  userId: string,
  source: string,
  options: { overwriteSlug?: boolean } = {}
): Promise<Skill> => {
  const { secureToolRequest, ToolEgressError } =
    await import('../utils/toolEgress.js');
  const candidates = resolveSkillSourceCandidates(source);
  let lastError: Error | undefined;
  for (const candidate of candidates) {
    let response;
    try {
      response = await secureToolRequest({
        url: candidate,
        method: 'GET',
        headers: { Accept: 'text/markdown, text/plain, */*' },
        timeoutMs: REMOTE_FETCH_TIMEOUT_MS,
        maxResponseBytes: MAX_REMOTE_SKILL_BYTES,
      });
    } catch (error) {
      if (error instanceof ToolEgressError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      continue;
    }
    if (response.status === 404) {
      lastError = new Error(`No SKILL.md at ${candidate}`);
      continue;
    }
    if (response.status >= 400 || response.truncated) {
      throw new ResourcePolicyError(
        `The skill source answered with status ${response.status}`,
        400
      );
    }
    const skill = await importSkill(
      userId,
      { markdown: response.bodyText },
      options
    );
    recordAuditEvent({
      action: 'skill.import-url',
      result: 'success',
      actorUserId: userId,
      targetType: 'skill',
      targetId: skill.id,
      details: { host: new URL(candidate).hostname },
    });
    return skill;
  }
  throw new ResourcePolicyError(
    lastError?.message ?? 'No SKILL.md was found at the given source',
    400
  );
};
