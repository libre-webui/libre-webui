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

import type { ChatSession } from '../types/index.js';

export interface AssistantBranchingFields {
  parentId?: string;
  branchIndex?: number;
  isActive?: boolean;
}

export function buildAssistantBranchingFields(
  session: ChatSession,
  regenerate?: boolean,
  originalMessageId?: string
): AssistantBranchingFields {
  if (!regenerate || !originalMessageId) {
    return {};
  }

  const originalMsg = session.messages.find(
    message => message.id === originalMessageId
  );
  const parentId = originalMsg?.parentId || originalMessageId;
  const siblingCount = session.messages.filter(
    message => message.id === parentId || message.parentId === parentId
  ).length;

  return {
    parentId,
    branchIndex: siblingCount,
    isActive: true,
  };
}
