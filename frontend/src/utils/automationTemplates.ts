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

import type { AutomationTrigger } from '@/types';

/**
 * Starter automations. Names and descriptions localize through
 * `automations.templates.<id>.*`; instructions stay in English because they
 * are prompts for the model, and the user can rewrite them before saving.
 */
export interface AutomationTemplate {
  id: string;
  instructions: string;
  triggers: AutomationTrigger[];
}

export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'morningBrief',
    instructions:
      'Put together my morning brief: the top world, business, and tech ' +
      'headlines from the last 24 hours with one-line summaries, and one ' +
      'story worth reading in depth and why. Keep the whole thing scannable.',
    triggers: [{ kind: 'daily', hour: 7, minute: 30 }],
  },
  {
    id: 'newsDigest',
    instructions:
      'Summarize the most important AI news from the last 24 hours: model ' +
      'releases, notable research papers, funding rounds, and policy ' +
      'changes. For each item add one sentence on why it matters. Skip ' +
      'minor product updates and rumors.',
    triggers: [{ kind: 'daily', hour: 8, minute: 0 }],
  },
  {
    id: 'weeklyReview',
    instructions:
      'Help me wrap the week: prompt me to reflect on what I accomplished, ' +
      'what is still open, and what the top priorities for next week should ' +
      'be. Structure it as a short template I can fill in.',
    triggers: [{ kind: 'weekly', dayOfWeek: 5, hour: 16, minute: 0 }],
  },
  {
    id: 'monthlyReport',
    instructions:
      'Draft a monthly status report outline: key accomplishments, metrics ' +
      'to review, risks, and goals for the next month. Leave placeholders ' +
      'where my specifics belong.',
    triggers: [{ kind: 'monthly', dayOfMonth: 1, hour: 9, minute: 0 }],
  },
];
