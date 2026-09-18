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

/** Native session settings shared with DSH's session controller. */
import type { Session } from '@deepseek-ai/dsh-session';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import type { EngineSessionSettings } from '../contracts.js';
import { isProviderModelIdentity } from './model-identity.js';

// This native event is already in the pinned DSH persistence vocabulary. Its
// declaration otherwise lives in the optional dsh-api-session package.
// See upstream packages/api/session-controller/src/types.ts.
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'model/selection': {
      readonly provider: string;
      readonly model: string;
      readonly reasoningEffort?: string;
    };
  }
}

export function sessionSettings(session: Session): EngineSessionSettings {
  let model: string | undefined;
  let explicitlySelected: string | undefined;
  let permissionMode: EngineSessionSettings['permissionMode'] = 'read-only';
  for (const event of session.snapshotEvents()) {
    if (event.type === 'sandbox/mode') {
      permissionMode =
        event.data.mode === 'workspace-write' ? 'workspace-write' : 'read-only';
    } else if (event.type === 'model/selection') {
      explicitlySelected = isProviderModelIdentity(event.data.model)
        ? event.data.model
        : undefined;
      model = explicitlySelected;
    } else if (event.type === 'request/header') {
      const historical = event.data.header.config.model;
      // Old builds logged persona/agent selectors as provider models. Ignore
      // that fallback without changing history or abandoning a real selection.
      model = isProviderModelIdentity(historical)
        ? historical
        : explicitlySelected;
    }
  }
  return { ...(model ? { model } : {}), permissionMode };
}

export function appendSessionSettings(
  session: Session,
  settings: Partial<EngineSessionSettings>,
  provider: string
): void {
  if (settings.permissionMode !== undefined)
    setSandboxMode(session, settings.permissionMode);
  if (settings.model !== undefined)
    session.append('model/selection', { provider, model: settings.model });
}
