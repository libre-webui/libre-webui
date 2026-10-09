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
 * Agent CLIs in Work, assembled: the shared toolchain, credentials, egress
 * proxy, and runner wired to this deployment's runtime and providers, plus
 * the two questions the rest of Work asks: which agent entries a user may
 * pick, and whether a selected agent can run now.
 */

import { createLogger } from '../utils/logger.js';
import pluginService from './pluginService.js';
import {
  WORK_AGENT_CLI_IDS,
  WORK_AGENT_CLIS,
  isWorkAgentCliId,
  parseWorkAgentModel,
  workAgentCredentialSlots,
  type WorkAgentCliId,
  type WorkAgentCliSpec,
  type WorkAgentProviderFamily,
} from './workAgentCatalog.js';
import { WorkAgentCliRunner } from './workAgentCliRunner.js';
import {
  WorkAgentCredentialService,
  type ResolvedWorkAgentCredential,
} from './workAgentCredentialService.js';
import { userIdHasWorkAgentAccess } from './workAgentAccessService.js';
import { WorkAgentToolchainService } from './workAgentToolchainService.js';
import { workEgressProxy } from './workEgressProxy.js';
import { DockerWorkRuntimeDriver } from './workRuntimeDriver.js';
import workRuntimeService from './workRuntimeService.js';
import { WorkRuntimeError } from './workRuntimeShared.js';
import type { WorkProviderSelection } from '../types/work.js';

const logger = createLogger('services:work-agents');

/** Cap per provider family, so one huge catalog cannot flood the picker. */
const MAX_PROVIDER_MODELS = 500;

export const workAgentToolchain = new WorkAgentToolchainService(() => {
  const driver = workRuntimeService.driver;
  if (!(driver instanceof DockerWorkRuntimeDriver)) return undefined;
  return (args, options) =>
    driver.docker(args, { ...options, acceptFailure: true });
});

async function bundledPlugin(pluginId: string, userId: string) {
  const plugin = await pluginService.getPlugin(pluginId, userId);
  return plugin && plugin.active ? plugin : null;
}

export const workAgentCredentials = new WorkAgentCredentialService({
  apiKey: async (pluginId, userId) => {
    const plugin = await bundledPlugin(pluginId, userId);
    return plugin ? pluginService.getApiKey(plugin, userId) : null;
  },
  variables: async (pluginId, userId) => {
    const plugin = await bundledPlugin(pluginId, userId);
    return plugin ? pluginService.getPluginVariables(plugin, userId) : {};
  },
});

export const workAgentRunner = new WorkAgentCliRunner({
  driver: () => workRuntimeService.driver,
  proxy: workEgressProxy,
  toolchain: workAgentToolchain,
});

export interface WorkAgentModelEntry {
  /** Work selection model: `<cli>` (its default) or `<cli>:<model>`. */
  readonly id: string;
  readonly label: string;
}

export interface WorkAgentOffer {
  readonly id: WorkAgentCliId;
  readonly name: string;
  /** Whether a credential this user can use is configured. */
  readonly configured: boolean;
  readonly models: readonly WorkAgentModelEntry[];
}

export interface WorkAgentAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly agents: readonly WorkAgentOffer[];
}

const PROVIDER_PLUGINS: Record<WorkAgentProviderFamily, string> = {
  openrouter: 'openrouter',
  anthropic: 'anthropic',
  openai: 'openai',
};

/** Why agent CLIs are unavailable to this user right now, if they are. */
export async function workAgentUnavailableReason(
  userId: string
): Promise<string | undefined> {
  if (!(await userIdHasWorkAgentAccess(userId))) {
    return 'Agent CLIs in Work are not enabled for this account.';
  }
  return workAgentToolchain.unavailableReason() ?? undefined;
}

async function providerModels(
  cli: WorkAgentCliSpec,
  userId: string
): Promise<WorkAgentModelEntry[]> {
  const entries: WorkAgentModelEntry[] = [];
  for (const slot of cli.credentials) {
    if (!slot.family) continue;
    const credential = await workAgentCredentials.resolve(
      cli,
      `${slot.family}/model`,
      userId
    );
    if (!credential) continue;
    const plugin = await pluginService.getPlugin(
      PROVIDER_PLUGINS[slot.family],
      userId
    );
    for (const model of (plugin?.model_map ?? []).slice(
      0,
      MAX_PROVIDER_MODELS
    )) {
      const qualified = `${slot.family}/${model}`;
      entries.push({ id: `${cli.id}:${qualified}`, label: qualified });
    }
  }
  return entries;
}

/** The agent entries this user may pick in Work, configured or not. */
export async function listWorkAgents(
  userId: string
): Promise<WorkAgentAvailability> {
  const reason = await workAgentUnavailableReason(userId);
  if (reason) return { enabled: false, reason, agents: [] };
  const agents: WorkAgentOffer[] = [];
  for (const id of WORK_AGENT_CLI_IDS) {
    const cli = WORK_AGENT_CLIS[id];
    try {
      if (cli.requiresModel) {
        const models = await providerModels(cli, userId);
        agents.push({
          id,
          name: cli.name,
          configured: models.length > 0,
          models,
        });
        continue;
      }
      const configured = await workAgentCredentials.isConfigured(
        cli,
        undefined,
        userId
      );
      agents.push({
        id,
        name: cli.name,
        configured,
        models: [
          { id, label: cli.name },
          ...cli.modelOptions.map(option => ({
            id: `${id}:${option.id}`,
            label: option.label,
          })),
        ],
      });
    } catch (error) {
      logger.warn(`Could not list ${cli.name} for Work`, error);
      agents.push({ id, name: cli.name, configured: false, models: [] });
    }
  }
  return { enabled: true, agents };
}

export interface PreparedWorkAgentRun {
  readonly cli: WorkAgentCliSpec;
  readonly model: string | undefined;
  readonly credential: ResolvedWorkAgentCredential;
}

/**
 * Everything a run needs before its sandbox starts, or an error that says
 * what an administrator has to set up. Checked again at run time because
 * access, keys, and settings can all change after the task was created.
 */
export async function prepareWorkAgentRun(
  modelSelection: string,
  provider: WorkProviderSelection,
  userId: string
): Promise<PreparedWorkAgentRun> {
  const cliId = provider.providerId;
  if (provider.providerType !== 'agent' || !isWorkAgentCliId(cliId)) {
    throw new WorkRuntimeError(
      'Unknown agent CLI for Work.',
      422,
      'WORK_AGENT_UNKNOWN'
    );
  }
  const reason = await workAgentUnavailableReason(userId);
  if (reason) {
    throw new WorkRuntimeError(reason, 403, 'WORK_AGENT_UNAVAILABLE');
  }
  const cli = WORK_AGENT_CLIS[cliId];
  const trimmed = modelSelection.trim();
  if (trimmed !== cli.id && !trimmed.startsWith(`${cli.id}:`)) {
    throw new WorkRuntimeError(
      `The model "${trimmed}" does not belong to ${cli.name}.`,
      422,
      'WORK_AGENT_MODEL_INVALID'
    );
  }
  const model = parseWorkAgentModel(cli.id, trimmed);
  if (model !== undefined && !/^[\w./:@+-]{1,200}$/.test(model)) {
    throw new WorkRuntimeError(
      `The model "${model}" is not a valid ${cli.name} model name.`,
      422,
      'WORK_AGENT_MODEL_INVALID'
    );
  }
  if (cli.requiresModel && workAgentCredentialSlots(cli, model).length === 0) {
    throw new WorkRuntimeError(
      `${cli.name} in Work needs a model from OpenRouter, Anthropic, or OpenAI.`,
      422,
      'WORK_AGENT_MODEL_INVALID'
    );
  }
  const credential = await workAgentCredentials.resolve(cli, model, userId);
  if (!credential) {
    const names = workAgentCredentialSlots(cli, model).map(slot => slot.env);
    throw new WorkRuntimeError(
      `${cli.name} has no credential for Work. An administrator can add ${names.join(' or ')} under Settings → Work → Agent CLIs.`,
      409,
      'WORK_AGENT_CREDENTIAL_MISSING'
    );
  }
  return { cli, model, credential };
}
