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
 * Public surface of the Libre WebUI Cordis bridge.
 *
 * Route handlers import from here and nowhere deeper: the host, the bridge
 * plugin, and the contract types are one unit of API so that the internal file
 * layout stays free to change.
 *
 * @module cordis
 */

export {
  DSH_ENGINE_SERVICE,
  type DshEngine,
  type EngineAgentSummary,
  type EngineCreateAgentOptions,
  type EngineCreateSessionOptions,
  type EngineMessage,
  type EngineMessageRole,
  type EngineServiceState,
  type EngineServiceStatus,
  type EngineSession,
  type EngineSessionSummary,
  type EngineStreamChunk,
  type EngineStreamHandle,
  type EngineStreamSubscription,
  type EngineToolSummary,
} from './contracts.js';

export {
  CORDIS_PATCH_FILENAME,
  readConfigDocument,
  resolveCordisHostConfig,
  type CordisHostConfig,
  type EngineFeatures,
  type ModelAdapterConfig,
  type ModelProviderMode,
} from './host/config.js';

export {
  ENGINE_ENTRY_ID,
  requiredServices,
  startCordisHost,
  type CordisHost,
  type CordisHostStatus,
  type RequiredService,
} from './host/host.js';

export {
  isServedByProviderLayer,
  requiredProviderPackage,
} from './host/model.js';
