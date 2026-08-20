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

/** Per-turn tool selection shared by the composer and the chat page. */

export interface ComposerToolsValue {
  enabled: boolean;
  /** Null means every available entry; a list narrows the turn to it. */
  builtinTools: string[] | null;
  serverIds: string[] | null;
}

export const DEFAULT_COMPOSER_TOOLS: ComposerToolsValue = {
  enabled: false,
  builtinTools: null,
  serverIds: null,
};

/** The request fields the composer sends for one turn. */
export const composerToolsRequest = (
  value: ComposerToolsValue
): {
  tools?: true;
  toolSelection?: { builtinTools?: string[]; serverIds?: string[] };
} => {
  if (!value.enabled) return {};
  const selection = {
    ...(value.builtinTools !== null
      ? { builtinTools: value.builtinTools }
      : {}),
    ...(value.serverIds !== null ? { serverIds: value.serverIds } : {}),
  };
  return {
    tools: true,
    ...(Object.keys(selection).length > 0 ? { toolSelection: selection } : {}),
  };
};
