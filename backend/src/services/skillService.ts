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

export const exportSkill = async (
  skillId: string,
  actor: AuthzActor
): Promise<SkillExport | null> => {
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
  const normalized = normalize(raw as SkillInput);
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
