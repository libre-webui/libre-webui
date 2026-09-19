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

import type { DshEngine } from '../contracts.js';
import type { BridgeModel } from './librewebui-llm-adapter.js';
import { getAgentCliModelsEnabled } from '../../services/agentAccessService.js';
import { userModel } from '../../models/userModel.js';
import { readCompositionFile } from '../host/composition.js';
import {
  isProviderModelIdentity,
  parseNativeDshModelId,
} from './model-identity.js';
import {
  libreWebUiProviderHandler,
  resolveCordisProviderTarget,
  resolveEngineDefaultModel,
} from './provider-handler.js';

const DSH_PREFIX = 'dsh:';
const PROVIDER_ROUTE = 'libre-webui';

/** Decode only the agent envelope; the provider route stays qualified. */
export function dshProviderModel(selector: string): string | undefined {
  if (selector === 'dsh') return undefined;
  const model = selector.startsWith(DSH_PREFIX)
    ? selector.slice(DSH_PREFIX.length)
    : '';
  if (
    selector.length > 2048 ||
    (!model.startsWith('lwui:') && !model.startsWith('native:')) ||
    !isProviderModelIdentity(model)
  ) {
    throw new Error('Choose a valid DeepSeek Harness provider model.');
  }
  return model;
}

async function requireDshChatAccess(userId: string): Promise<void> {
  const user = await userModel.getUserById(userId);
  if (user?.role !== 'admin' || user.status !== 'active')
    throw new Error('DeepSeek Harness requires an active administrator.');
  if (!(await getAgentCliModelsEnabled()))
    throw new Error('Agent CLI models are disabled on this server.');
  const { isCordisBridgeEnabled } = await import('../runtime.js');
  if (!(await isCordisBridgeEnabled()))
    throw new Error('The DeepSeek Harness engine is not available.');
}

/** Discovery reads configuration but never starts the optional engine. */
export async function dshChatModelChoices(
  userId: string
): Promise<readonly BridgeModel[]> {
  await requireDshChatAccess(userId);
  const { cordisRuntimeConfig } = await import('../runtime.js');
  const { BRIDGE_ENTRY_ID } = await import('../host/host.js');
  const config = cordisRuntimeConfig();
  const row = readCompositionFile(config.configPath).find(
    entry => entry.id === BRIDGE_ENTRY_ID
  );
  if (!row || row.disabled) return [];
  const rowConfig =
    row.config && typeof row.config === 'object' && !Array.isArray(row.config)
      ? (row.config as Record<string, unknown>)
      : {};
  // A row pin wins over host defaults, including an unknown !!js expression.
  // Such compositions keep their base profile rather than advertise a route
  // that may not be the one their engine will execute.
  const provider = Object.prototype.hasOwnProperty.call(
    rowConfig,
    'defaultProvider'
  )
    ? rowConfig.defaultProvider
    : config.model.provider === 'libre-webui'
      ? PROVIDER_ROUTE
      : config.model.route;
  if (provider !== PROVIDER_ROUTE) return [];
  return libreWebUiProviderHandler.listModels(userId);
}

/** Validate a saved choice before starting an engine or allocating a session. */
export async function resolveDshSelectedModel(
  selector: string,
  userId: string
): Promise<string | undefined> {
  const model = dshProviderModel(selector);
  await requireDshChatAccess(userId);
  if (
    model &&
    !(await dshChatModelChoices(userId)).some(
      candidate => candidate.id === model
    )
  )
    throw new Error('The selected DeepSeek Harness model is unavailable.');
  return model;
}

export function requireDshProviderRoute(engine: DshEngine): void {
  if (engine.modelConfiguration().provider !== PROVIDER_ROUTE)
    throw new Error(
      'This DeepSeek Harness composition does not use Libre WebUI model providers.'
    );
}

/** Titles and summaries use the selected LLM directly, without an agent turn. */
export async function resolveDshProviderTarget(
  selector: string,
  userId: string
): Promise<{
  model: string;
  providerType: 'ollama' | 'plugin' | 'dsh';
  providerId: string | null;
}> {
  const selected = await resolveDshSelectedModel(selector, userId);
  if (selected && parseNativeDshModelId(selected))
    return resolveCordisProviderTarget(selected, userId);
  const { getCordisEngine } = await import('../runtime.js');
  const result = await getCordisEngine();
  if (!result.ok)
    throw new Error(
      `The DeepSeek Harness engine is not available: ${result.reason}`
    );
  requireDshProviderRoute(result.engine);
  const configured = result.engine.modelConfiguration().model;
  const model =
    selected ??
    (isProviderModelIdentity(configured)
      ? configured
      : await resolveEngineDefaultModel(userId));
  if (!model)
    throw new Error('No DeepSeek Harness provider model is available.');
  return resolveCordisProviderTarget(model, userId);
}
