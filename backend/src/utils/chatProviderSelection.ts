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

import type {
  ChatProviderSelection,
  ChatProviderType,
} from '../types/index.js';

export interface QualifiedChatProviderSelection {
  providerType: ChatProviderType;
  providerId?: string;
}

export class ChatProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatProviderSelectionError';
  }
}

type ChatProviderSelectionInput = {
  providerType?: unknown;
  providerId?: unknown;
};

export function normalizeChatProviderSelection(
  selection?: ChatProviderSelectionInput | ChatProviderSelection | null
): QualifiedChatProviderSelection | undefined {
  if (!selection) {
    return undefined;
  }

  const rawProviderType = selection.providerType;
  const rawProviderId = selection.providerId;
  const hasProviderType =
    rawProviderType !== undefined &&
    rawProviderType !== null &&
    rawProviderType !== '';
  const hasProviderId =
    rawProviderId !== undefined &&
    rawProviderId !== null &&
    String(rawProviderId).trim() !== '';

  if (!hasProviderType) {
    if (hasProviderId) {
      throw new ChatProviderSelectionError(
        'providerId requires providerType to be set.'
      );
    }
    return undefined;
  }

  if (rawProviderType !== 'ollama' && rawProviderType !== 'plugin') {
    throw new ChatProviderSelectionError(
      'providerType must be "ollama" or "plugin".'
    );
  }

  if (rawProviderType === 'ollama') {
    if (hasProviderId) {
      throw new ChatProviderSelectionError(
        'providerId is only valid when providerType is "plugin".'
      );
    }
    return { providerType: 'ollama' };
  }

  if (typeof rawProviderId !== 'string' || !rawProviderId.trim()) {
    throw new ChatProviderSelectionError(
      'providerId is required when providerType is "plugin".'
    );
  }

  const providerId = rawProviderId.trim();
  if (providerId.length > 200) {
    throw new ChatProviderSelectionError(
      'providerId exceeds the 200 character limit.'
    );
  }

  return { providerType: 'plugin', providerId };
}
