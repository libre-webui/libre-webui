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
 * Named Work runtime policies: admin-defined presets (image, resource
 * limits, workspace size, idle timeout, network default) a task can be
 * created under. Every field is optional — a policy states only what it
 * changes from the deployment's global runtime configuration, and
 * resolution merges the two. Policies never weaken the sandbox hardening
 * profile: the non-negotiable parts (non-root, read-only rootfs, dropped
 * capabilities, network isolation) are not policy fields at all.
 */

import { v4 as uuidv4 } from 'uuid';

import { getDatabase } from '../db.js';
import { createLogger } from '../utils/logger.js';
import {
  ResolvedWorkRuntimePolicy,
  WorkRuntimeError,
  defaultRuntimePolicy,
  workRuntimeConfig,
} from './workRuntimeShared.js';

const logger = createLogger('services:work-policy');

const NAME_MAX_LENGTH = 100;
const IMAGE_MAX_LENGTH = 300;
// Docker memory quantities: bytes, or one-letter binary suffixes with the
// two-letter spellings Docker also accepts (2g, 2gb, 2gib). Bounded to
// what a container can actually start with: Docker refuses less than 6m,
// and anything past 1024g is a typo, not a limit.
const MEMORY_PATTERN = /^\d+(?:\.\d+)?(?:[bkmg](?:i?b)?)?$/i;
const MEMORY_MIN_BYTES = 6 * 1024 ** 2;
const MEMORY_MAX_BYTES = 1024 ** 4;
// Kubernetes resource quantities for workspace PVCs, capped at 16Ti so a
// slipped keystroke cannot request a petabyte claim.
const WORKSPACE_SIZE_PATTERN = /^\d+(?:\.\d+)?(?:Ki|Mi|Gi|Ti|K|M|G|T)?$/;
const WORKSPACE_MAX_BYTES = 16 * 1024 ** 4;

const MEMORY_UNIT_BYTES: Record<string, number> = {
  b: 1,
  k: 1024,
  m: 1024 ** 2,
  g: 1024 ** 3,
};

function memoryLimitBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([bkmg])?/i.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * MEMORY_UNIT_BYTES[(match[2] ?? 'b').toLowerCase()];
}

const WORKSPACE_UNIT_BYTES: Record<string, number> = {
  '': 1,
  K: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
};

function workspaceSizeBytes(value: string): number {
  const match = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|K|M|G|T)?$/.exec(value);
  if (!match) return Number.NaN;
  return Number(match[1]) * WORKSPACE_UNIT_BYTES[match[2] ?? ''];
}
// Image references: [registry[:port]/]name[/name...][:tag][@sha256:digest].
// Anchored to the registry/repository charset so a stored image can never
// begin with '-' and reach the container runtime looking like a flag.
const IMAGE_PATTERN =
  /^[a-z0-9][a-z0-9._-]*(?::\d+)?(?:\/[a-z0-9][a-z0-9._-]*)*(?::[A-Za-z0-9_][A-Za-z0-9._-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

export interface WorkPolicyRecord {
  id: string;
  name: string;
  image?: string;
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  networkDefault?: boolean;
  workspaceSize?: string;
  idleTimeoutMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface WorkPolicyInput {
  name: string;
  image?: string | null;
  memoryLimit?: string | null;
  cpuLimit?: string | null;
  pidsLimit?: number | null;
  networkDefault?: boolean | null;
  workspaceSize?: string | null;
  idleTimeoutMs?: number | null;
}

interface PolicyRow {
  id: string;
  name: string;
  image: string | null;
  memory_limit: string | null;
  cpu_limit: string | null;
  pids_limit: number | null;
  network_default: number | null;
  workspace_size: string | null;
  idle_timeout_ms: number | null;
  created_at: number;
  updated_at: number;
}

const invalid = (message: string): WorkRuntimeError =>
  new WorkRuntimeError(message, 400, 'WORK_POLICY_INVALID');

function mapPolicy(row: PolicyRow): WorkPolicyRecord {
  return {
    id: row.id,
    name: row.name,
    image: row.image ?? undefined,
    memoryLimit: row.memory_limit ?? undefined,
    cpuLimit: row.cpu_limit ?? undefined,
    pidsLimit: row.pids_limit ?? undefined,
    networkDefault:
      row.network_default === null ? undefined : Boolean(row.network_default),
    workspaceSize: row.workspace_size ?? undefined,
    idleTimeoutMs: row.idle_timeout_ms ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function validateWorkPolicyInput(input: WorkPolicyInput): {
  name: string;
  image: string | null;
  memoryLimit: string | null;
  cpuLimit: string | null;
  pidsLimit: number | null;
  networkDefault: boolean | null;
  workspaceSize: string | null;
  idleTimeoutMs: number | null;
} {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > NAME_MAX_LENGTH) {
    throw invalid(
      `Policy name is required and must be at most ${NAME_MAX_LENGTH} characters.`
    );
  }

  const image =
    input.image === null || input.image === undefined || input.image === ''
      ? null
      : String(input.image).trim();
  if (
    image !== null &&
    (image.length > IMAGE_MAX_LENGTH || !IMAGE_PATTERN.test(image))
  ) {
    throw invalid(
      'Policy image must be a valid image reference like registry/name:tag.'
    );
  }

  const memoryLimit =
    input.memoryLimit === null ||
    input.memoryLimit === undefined ||
    input.memoryLimit === ''
      ? null
      : String(input.memoryLimit).trim();
  if (memoryLimit !== null) {
    const bytes = memoryLimitBytes(memoryLimit);
    if (
      !MEMORY_PATTERN.test(memoryLimit) ||
      !(bytes >= MEMORY_MIN_BYTES && bytes <= MEMORY_MAX_BYTES)
    ) {
      throw invalid(
        'Policy memory limit must look like 512m or 2g, between 6m and 1024g.'
      );
    }
  }

  const cpuLimitRaw =
    input.cpuLimit === null ||
    input.cpuLimit === undefined ||
    input.cpuLimit === ''
      ? null
      : String(input.cpuLimit).trim();
  let cpuLimit: string | null = null;
  if (cpuLimitRaw !== null) {
    const parsed = Number(cpuLimitRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 256) {
      throw invalid('Policy CPU limit must be a number between 0 and 256.');
    }
    // Store the parsed value, not the raw spelling: Number() accepts forms
    // like '0x10' that the container runtimes reject at start time.
    cpuLimit = String(parsed);
  }

  const pidsLimit =
    input.pidsLimit === null || input.pidsLimit === undefined
      ? null
      : Number(input.pidsLimit);
  if (
    pidsLimit !== null &&
    (!Number.isInteger(pidsLimit) || pidsLimit < 16 || pidsLimit > 100_000)
  ) {
    throw invalid('Policy PID limit must be an integer between 16 and 100000.');
  }

  const networkDefault =
    input.networkDefault === null || input.networkDefault === undefined
      ? null
      : Boolean(input.networkDefault);

  const workspaceSize =
    input.workspaceSize === null ||
    input.workspaceSize === undefined ||
    input.workspaceSize === ''
      ? null
      : String(input.workspaceSize).trim();
  if (
    workspaceSize !== null &&
    (!WORKSPACE_SIZE_PATTERN.test(workspaceSize) ||
      !(workspaceSizeBytes(workspaceSize) <= WORKSPACE_MAX_BYTES))
  ) {
    throw invalid(
      'Policy workspace size must look like 5Gi or 500Mi, at most 16Ti.'
    );
  }

  const idleTimeoutMs =
    input.idleTimeoutMs === null || input.idleTimeoutMs === undefined
      ? null
      : Number(input.idleTimeoutMs);
  if (
    idleTimeoutMs !== null &&
    (!Number.isInteger(idleTimeoutMs) ||
      idleTimeoutMs < 0 ||
      idleTimeoutMs > 30 * 24 * 60 * 60 * 1000)
  ) {
    throw invalid('Policy idle timeout must be a non-negative duration in ms.');
  }

  return {
    name,
    image,
    memoryLimit,
    cpuLimit,
    pidsLimit,
    networkDefault,
    workspaceSize,
    idleTimeoutMs,
  };
}

export class WorkPolicyService {
  list(): WorkPolicyRecord[] {
    const rows = getDatabase()
      .prepare('SELECT * FROM work_policies ORDER BY name ASC')
      .all() as PolicyRow[];
    return rows.map(mapPolicy);
  }

  get(id: string): WorkPolicyRecord | undefined {
    const row = getDatabase()
      .prepare('SELECT * FROM work_policies WHERE id = ?')
      .get(id) as PolicyRow | undefined;
    return row ? mapPolicy(row) : undefined;
  }

  create(input: WorkPolicyInput): WorkPolicyRecord {
    const fields = validateWorkPolicyInput(input);
    const id = uuidv4();
    const now = Date.now();
    try {
      getDatabase()
        .prepare(
          `INSERT INTO work_policies (
            id, name, image, memory_limit, cpu_limit, pids_limit,
            network_default, workspace_size, idle_timeout_ms,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          fields.name,
          fields.image,
          fields.memoryLimit,
          fields.cpuLimit,
          fields.pidsLimit,
          fields.networkDefault === null ? null : fields.networkDefault ? 1 : 0,
          fields.workspaceSize,
          fields.idleTimeoutMs,
          now,
          now
        );
    } catch (error) {
      if (/UNIQUE/.test(error instanceof Error ? error.message : '')) {
        throw new WorkRuntimeError(
          `A Work policy named "${fields.name}" already exists.`,
          409,
          'WORK_POLICY_NAME_CONFLICT'
        );
      }
      throw error;
    }
    const created = this.get(id);
    if (!created) throw new Error('Work policy was not created.');
    return created;
  }

  update(id: string, input: WorkPolicyInput): WorkPolicyRecord {
    const existing = this.get(id);
    if (!existing) {
      throw new WorkRuntimeError(
        'This Work policy no longer exists.',
        404,
        'WORK_POLICY_NOT_FOUND'
      );
    }
    const fields = validateWorkPolicyInput(input);
    try {
      getDatabase()
        .prepare(
          `UPDATE work_policies SET
            name = ?, image = ?, memory_limit = ?, cpu_limit = ?,
            pids_limit = ?, network_default = ?, workspace_size = ?,
            idle_timeout_ms = ?, updated_at = ?
          WHERE id = ?`
        )
        .run(
          fields.name,
          fields.image,
          fields.memoryLimit,
          fields.cpuLimit,
          fields.pidsLimit,
          fields.networkDefault === null ? null : fields.networkDefault ? 1 : 0,
          fields.workspaceSize,
          fields.idleTimeoutMs,
          Date.now(),
          id
        );
    } catch (error) {
      if (/UNIQUE/.test(error instanceof Error ? error.message : '')) {
        throw new WorkRuntimeError(
          `A Work policy named "${fields.name}" already exists.`,
          409,
          'WORK_POLICY_NAME_CONFLICT'
        );
      }
      throw error;
    }
    const updated = this.get(id);
    if (!updated) throw new Error('Work policy was not updated.');
    return updated;
  }

  /**
   * Delete a policy. Tasks that referenced it fall back to the global
   * defaults (the SET NULL semantic); their fingerprint changes, so their
   * sandbox is recreated with default limits on next use.
   */
  remove(id: string): void {
    const db = getDatabase();
    const transaction = db.transaction(() => {
      db.prepare(
        'UPDATE work_tasks SET policy_id = NULL WHERE policy_id = ?'
      ).run(id);
      const result = db
        .prepare('DELETE FROM work_policies WHERE id = ?')
        .run(id);
      if (result.changes === 0) {
        throw new WorkRuntimeError(
          'This Work policy no longer exists.',
          404,
          'WORK_POLICY_NOT_FOUND'
        );
      }
    });
    transaction();
  }

  /**
   * The runtime configuration a task actually runs with. Resolution never
   * fails the caller: a missing policy row (deleted mid-flight) or an
   * unreachable database resolves to the global defaults — the hardened
   * baseline — with a warning.
   */
  resolve(policyId: string | null | undefined): ResolvedWorkRuntimePolicy {
    if (!policyId) return defaultRuntimePolicy;
    let policy: WorkPolicyRecord | undefined;
    try {
      policy = this.get(policyId);
    } catch (error) {
      logger.warn(`Could not resolve Work policy ${policyId}:`, error);
      return defaultRuntimePolicy;
    }
    if (!policy) {
      logger.warn(
        `Work policy ${policyId} no longer exists; using the global defaults.`
      );
      return defaultRuntimePolicy;
    }
    return {
      policyId: policy.id,
      image: policy.image ?? workRuntimeConfig.image,
      memoryLimit: policy.memoryLimit ?? workRuntimeConfig.memoryLimit,
      cpuLimit: policy.cpuLimit ?? workRuntimeConfig.cpuLimit,
      pidsLimit: policy.pidsLimit ?? workRuntimeConfig.pidsLimit,
      idleTimeoutMs: policy.idleTimeoutMs ?? workRuntimeConfig.idleTimeoutMs,
      workspaceSize: policy.workspaceSize,
    };
  }

  /** Whether any policy enables idle-stop when the global knob is off. */
  anyIdleTimeoutConfigured(): boolean {
    try {
      const row = getDatabase()
        .prepare(
          'SELECT 1 FROM work_policies WHERE idle_timeout_ms > 0 LIMIT 1'
        )
        .get();
      return row !== undefined;
    } catch {
      return false;
    }
  }
}

export const workPolicyService = new WorkPolicyService();
export default workPolicyService;
