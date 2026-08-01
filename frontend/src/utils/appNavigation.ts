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

import { useChatStore } from '@/store/chatStore';
import { useWorkStore } from '@/store/workStore';
import { advanceWelcomePrompt } from '@/utils/welcomePrompts';

type NavigateFn = (path: string) => void;

/**
 * Shared entry points for the tab bar, Home, the command palette, and the
 * keyboard shortcuts, so every "new chat" starts from the same clean state.
 */
export const startNewChat = (navigate: NavigateFn) => {
  advanceWelcomePrompt();
  useChatStore.getState().setCurrentSession(null);
  sessionStorage.setItem('forceWelcomeScreen', 'true');
  navigate('/chat');
};

export const startNewWork = (navigate: NavigateFn) => {
  useWorkStore.getState().clearError();
  navigate('/work');
};
