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
 * Agent CLIs in Work, assembled: the shared toolchain, the host logins,
 * egress proxy, and runner wired to this deployment's runtime, plus the two
 * questions the rest of Work asks: which agent entries a user may pick, and
 * whether a selected agent can run now.
 *
 * Work offers exactly what Chat offers. An agent is listed when its CLI is
 * installed on this server, with the same model choices, and runs under the
 * same login the CLI uses for Chat. When it cannot run, the entry stays
 * visible with the reason.
 */

import { createLogger } from '../utils/logger.js';
import { findInstalledAgentCli } from './agentCliService.js';
import {
  WORK_AGENT_CLI_IDS,
  WORK_AGENT_CLIS,
  isWorkAgentCliId,
  parseWorkAgentModel,
  type WorkAgentCliId,
  type WorkAgentCliSpec,
} from './workAgentCatalog.js';
import { WorkAgentCliRunner } from './workAgentCliRunner.js';
import {
  createWorkAgentHostLogins,
  type WorkAgentHostLogin,
} from './workAgentHostLogins.js';
import { userIdHasWorkAgentAccess } from './workAgentAccessService.js';
import { WorkAgentToolchainService } from './workAgentToolchainService.js';
import { workEgressProxy } from './workEgressProxy.js';
import { DockerWorkRuntimeDriver } from './workRuntimeDriver.js';
import workRuntimeService from './workRuntimeService.js';
import { WorkRuntimeError } from './workRuntimeShared.js';
import type { WorkProviderSelection } from '../types/work.js';

const logger = createLogger('services:work-agents');

export const workAgentToolchain = new WorkAgentToolchainService(() => {
  const driver = workRuntimeService.driver;
  if (!(driver instanceof DockerWorkRuntimeDriver)) return undefined;
  return (args, options) =>
    driver.docker(args, { ...options, acceptFailure: true });
});

export const workAgentHostLogins = createWorkAgentHostLogins();

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
  /** Whether the agent can run now: installed and signed in. */
  readonly configured: boolean;
  /** Why it cannot, in the words Chat's failure would use. */
  readonly reason?: string;
  readonly models: readonly WorkAgentModelEntry[];
}

export interface WorkAgentAvailability {
  readonly enabled: boolean;
  readonly reason?: string;
  readonly agents: readonly WorkAgentOffer[];
}

/** Why agent CLIs are unavailable to this user right now, if they are. */
export async function workAgentUnavailableReason(
  userId: string
): Promise<string | undefined> {
  if (!(await userIdHasWorkAgentAccess(userId))) {
    return 'Agent CLIs in Work are not enabled for this account.';
  }
  return workAgentToolchain.unavailableReason() ?? undefined;
}

function notInstalled(cli: WorkAgentCliSpec): string {
  const command = cli.id === 'kiro' ? 'kiro-cli' : cli.executable;
  return `${cli.name} is not installed on this server: \`${command}\` is not on the PATH of the process running Libre WebUI.`;
}

/** Whether one CLI can run in Work now, and if not, why. */
async function agentReadiness(cli: WorkAgentCliSpec): Promise<{
  installed: Awaited<ReturnType<typeof findInstalledAgentCli>>;
  reason?: string;
}> {
  const installed = await findInstalledAgentCli(cli.id);
  if (!installed) return { installed, reason: notInstalled(cli) };
  const status = await workAgentHostLogins[cli.id].status();
  return status.ready ? { installed } : { installed, reason: status.reason };
}

/** The agent entries this user may pick in Work: the ones Chat lists. */
export async function listWorkAgents(
  userId: string
): Promise<WorkAgentAvailability> {
  const reason = await workAgentUnavailableReason(userId);
  if (reason) return { enabled: false, reason, agents: [] };
  const agents = await Promise.all(
    WORK_AGENT_CLI_IDS.map(async (id): Promise<WorkAgentOffer> => {
      const cli = WORK_AGENT_CLIS[id];
      try {
        const { installed, reason: problem } = await agentReadiness(cli);
        const models: WorkAgentModelEntry[] = [
          ...(installed?.requiresModel ? [] : [{ id, label: cli.name }]),
          ...(installed?.options ?? []).map(option => ({
            id: `${id}:${option.id}`,
            label: option.label,
          })),
        ];
        return {
          id,
          name: cli.name,
          configured: !problem,
          ...(problem ? { reason: problem } : {}),
          // An agent that is not installed still shows, once, with why.
          models: models.length > 0 ? models : [{ id, label: cli.name }],
        };
      } catch (error) {
        logger.warn(`Could not list ${cli.name} for Work`, error);
        return {
          id,
          name: cli.name,
          configured: false,
          reason: `${cli.name} could not be checked on this server.`,
          models: [{ id, label: cli.name }],
        };
      }
    })
  );
  return { enabled: true, agents };
}

export interface PreparedWorkAgentRun {
  readonly cli: WorkAgentCliSpec;
  readonly model: string | undefined;
  readonly login: WorkAgentHostLogin;
}

/**
 * Everything a run needs before its sandbox starts, or an error that says
 * what is missing. Checked again at run time because access, installs, and
 * logins can all change after the task was created. The login itself is
 * refreshed and turned into a sandbox login by the runner.
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
  const { installed, reason: problem } = await agentReadiness(cli);
  if (problem) {
    throw new WorkRuntimeError(
      problem,
      installed ? 409 : 503,
      installed ? 'WORK_AGENT_NOT_SIGNED_IN' : 'WORK_AGENT_NOT_INSTALLED'
    );
  }
  if (installed?.requiresModel && model === undefined) {
    throw new WorkRuntimeError(
      `${cli.name} needs a model chosen in the picker.`,
      422,
      'WORK_AGENT_MODEL_INVALID'
    );
  }
  return { cli, model, login: workAgentHostLogins[cli.id] };
}
