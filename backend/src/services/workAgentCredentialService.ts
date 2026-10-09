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
 * The real credentials behind agent CLIs in Work. None of them ever enters
 * a sandbox: a run receives a placeholder, and the egress proxy swaps the
 * value in on the credential's own hosts.
 *
 * Each slot can be filled three ways, checked in this order:
 *  1. a headless key an administrator saved (encrypted at rest),
 *  2. `WORK_AGENT_<NAME>` in the server environment, set by an operator,
 *  3. for provider-backed slots, the provider key the running user already
 *     saved for that bundled provider (OpenRouter, Anthropic, OpenAI, or
 *     Amazon Bedrock), resolved exactly as Chat resolves it.
 * The server's own `KIRO_API_KEY` or `ANTHROPIC_API_KEY` is never picked
 * up implicitly: the WORK_AGENT_ prefix is an explicit opt-in.
 */

import { createLogger } from '../utils/logger.js';
import { encryptionService } from './encryptionService.js';
import {
  getSystemSettings,
  setSystemSetting,
} from './systemSettingsService.js';
import {
  WORK_AGENT_CLI_IDS,
  WORK_AGENT_CLIS,
  workAgentCredentialNames,
  workAgentCredentialSlots,
  type WorkAgentCliId,
  type WorkAgentCliSpec,
  type WorkAgentCredentialSlot,
} from './workAgentCatalog.js';

const logger = createLogger('services:work-agent-credentials');

const SETTING_PREFIX = 'work_agent_secret.';
const ENVIRONMENT_PREFIX = 'WORK_AGENT_';
const MAX_SECRET_LENGTH = 8192;
const DEFAULT_BEDROCK_REGION = 'us-east-1';

export type WorkAgentCredentialSource = 'stored' | 'environment';

export interface WorkAgentCredentialView {
  /** The environment variable the CLI reads, e.g. KIRO_API_KEY. */
  readonly name: string;
  readonly configured: boolean;
  readonly source: WorkAgentCredentialSource | null;
  /** Saved values can be replaced or cleared; environment values cannot. */
  readonly lockedByEnv: boolean;
  readonly usedBy: readonly WorkAgentCliId[];
  /** Bundled provider whose saved key can stand in for this slot. */
  readonly providerPlugin?: string;
}

export interface ResolvedWorkAgentCredential {
  readonly slot: WorkAgentCredentialSlot;
  readonly secret: string;
  /** Non-secret environment the slot needs (region, provider switches). */
  readonly env: Readonly<Record<string, string>>;
  readonly origin: WorkAgentCredentialSource | 'provider';
}

export class WorkAgentCredentialError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'WORK_AGENT_CREDENTIAL_INVALID'
  ) {
    super(message);
    this.name = 'WorkAgentCredentialError';
  }
}

/** Provider-key lookups, injected so the service has no plugin coupling. */
export interface WorkAgentProviderKeys {
  apiKey(pluginId: string, userId: string): Promise<string | null>;
  variables(
    pluginId: string,
    userId: string
  ): Promise<Record<string, string | number | boolean>>;
}

const settingKey = (name: string): string => `${SETTING_PREFIX}${name}`;

function environmentValue(name: string): string | undefined {
  const value = process.env[`${ENVIRONMENT_PREFIX}${name}`]?.trim();
  return value ? value : undefined;
}

export class WorkAgentCredentialService {
  constructor(private readonly providers?: WorkAgentProviderKeys) {}

  /** Every slot the catalog knows, without values. */
  async list(): Promise<WorkAgentCredentialView[]> {
    const names = workAgentCredentialNames();
    const stored = await this.storedValues(names);
    return names.map(name => {
      const fromEnvironment = environmentValue(name) !== undefined;
      const saved = Boolean(stored[settingKey(name)]);
      const usedBy = WORK_AGENT_CLI_IDS.filter(id =>
        WORK_AGENT_CLIS[id].credentials.some(slot => slot.env === name)
      );
      const providerPlugin = WORK_AGENT_CLI_IDS.flatMap(
        id => WORK_AGENT_CLIS[id].credentials
      ).find(slot => slot.env === name && slot.providerPlugin)?.providerPlugin;
      return {
        name,
        configured: saved || fromEnvironment,
        source: saved ? 'stored' : fromEnvironment ? 'environment' : null,
        lockedByEnv: fromEnvironment && !saved,
        usedBy,
        ...(providerPlugin ? { providerPlugin } : {}),
      };
    });
  }

  /** Save, replace, or clear (empty value) one headless key. */
  async set(name: string, value: string): Promise<void> {
    if (!workAgentCredentialNames().includes(name)) {
      throw new WorkAgentCredentialError(
        `Unknown agent credential "${name}".`,
        404,
        'WORK_AGENT_CREDENTIAL_UNKNOWN'
      );
    }
    const trimmed = value.trim();
    if (trimmed.length > MAX_SECRET_LENGTH) {
      throw new WorkAgentCredentialError('The credential is too long.');
    }
    if (/[\s\0]/.test(trimmed)) {
      throw new WorkAgentCredentialError(
        'Credentials cannot contain whitespace or control characters.'
      );
    }
    await setSystemSetting(
      settingKey(name),
      trimmed ? encryptionService.encrypt(trimmed) : ''
    );
  }

  /**
   * The first usable credential for this CLI and model, with what produced
   * it. Null when nothing is configured; the caller explains what to add.
   */
  async resolve(
    cli: WorkAgentCliSpec,
    model: string | undefined,
    userId: string
  ): Promise<ResolvedWorkAgentCredential | null> {
    const slots = workAgentCredentialSlots(cli, model);
    const stored = await this.storedValues(slots.map(slot => slot.env));
    for (const slot of slots) {
      const env = { ...(slot.env_extra ?? {}) };
      const encrypted = stored[settingKey(slot.env)];
      if (encrypted) {
        try {
          const secret = encryptionService.decryptAuthenticated(encrypted);
          if (secret) {
            return {
              slot,
              secret,
              env: await this.slotEnvironment(slot, env, userId),
              origin: 'stored',
            };
          }
        } catch (error) {
          logger.error(`The saved ${slot.env} could not be decrypted`, error);
        }
      }
      const fromEnvironment = environmentValue(slot.env);
      if (fromEnvironment) {
        return {
          slot,
          secret: fromEnvironment,
          env: await this.slotEnvironment(slot, env, userId),
          origin: 'environment',
        };
      }
      if (slot.providerPlugin && this.providers) {
        try {
          const key = await this.providers.apiKey(slot.providerPlugin, userId);
          if (key) {
            return {
              slot,
              secret: key,
              env: await this.slotEnvironment(slot, env, userId),
              origin: 'provider',
            };
          }
        } catch (error) {
          logger.warn(
            `Could not read the ${slot.providerPlugin} key for a Work agent run`,
            error
          );
        }
      }
    }
    return null;
  }

  /** Whether any slot this CLI could use is filled for this user. */
  async isConfigured(
    cli: WorkAgentCliSpec,
    model: string | undefined,
    userId: string
  ): Promise<boolean> {
    return (await this.resolve(cli, model, userId)) !== null;
  }

  private async slotEnvironment(
    slot: WorkAgentCredentialSlot,
    env: Record<string, string>,
    userId: string
  ): Promise<Record<string, string>> {
    if (slot.env !== 'AWS_BEARER_TOKEN_BEDROCK') return env;
    // Claude Code calls the Region's bedrock-runtime host; reuse the Region
    // the user picked for the Bedrock provider.
    let region = DEFAULT_BEDROCK_REGION;
    try {
      const variables = await this.providers?.variables('bedrock', userId);
      const chosen = variables?.region;
      if (
        typeof chosen === 'string' &&
        /^[a-z]{2}(?:-[a-z]+)+-\d$/.test(chosen)
      ) {
        region = chosen;
      }
    } catch (error) {
      logger.warn(
        'Could not read the Bedrock Region for a Work agent run',
        error
      );
    }
    return { ...env, AWS_REGION: region };
  }

  private async storedValues(
    names: readonly string[]
  ): Promise<Record<string, string>> {
    try {
      return await getSystemSettings(names.map(settingKey));
    } catch {
      return {};
    }
  }
}
