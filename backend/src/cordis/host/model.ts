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
 * Model-provider selection for the embedded engine.
 *
 * The engine reaches models through the provider layer this deployment already
 * has: the composition mounts an adapter row that registers the `libre-webui`
 * route, and the host asks that route's provider for calls. Nothing else needs
 * mounting, which is why there is no adapter controller here any more —
 * swapping providers is a matter of what the provider layer serves, not of
 * reloading a provider package.
 *
 * A provider package can still be mounted directly by naming it in the
 * composition. That is the composition's business, not the host's.
 *
 * @module cordis/host/model
 */

import type { CordisHostConfig, ModelAdapterConfig } from './config.js';

/**
 * Route the engine addresses Libre WebUI's provider layer by.
 *
 * The engine must always name a route: an agent with no provider refuses every
 * turn. In `libre-webui` mode this is the route regardless of what `route`
 * says, because that field describes a provider package's own route.
 */
export const LIBRE_WEBUI_ROUTE = 'libre-webui';

/** Provider modes that expect a package to be installed. */
const PACKAGE_MODES: Readonly<Record<string, string>> = {
  deepseek: '@deepseek-ai/dsh-llm-deepseek',
  'pi-ai': '@deepseek-ai/dsh-llm-pi-ai',
};

/**
 * Describe a model configuration the host cannot serve itself.
 *
 * The provider packages are not dependencies of this backend: carrying every
 * provider SDK pulled in a large tree, including deprecated packages for
 * capabilities the engine never reaches. A deployment that wants one installs
 * it and mounts it through the composition, so the fix belongs in the message
 * rather than in a hard dependency.
 *
 * @param config - the resolved adapter configuration.
 * @returns the package that must be installed, or undefined when nothing is
 *   required beyond the provider layer.
 */
export function requiredProviderPackage(
  config: ModelAdapterConfig
): string | undefined {
  return PACKAGE_MODES[config.provider];
}

/**
 * Whether a configuration is served without an extra provider package.
 * @param config - the resolved host configuration.
 * @returns true when the host can serve the configured route as it stands.
 */
export function isServedByProviderLayer(config: CordisHostConfig): boolean {
  return (
    config.model.provider === 'none' || config.model.provider === 'libre-webui'
  );
}
