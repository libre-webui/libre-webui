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

import type { PromptInput } from '@/utils/api/promptsApi';

/**
 * Starter prompts. Card names and descriptions localize through
 * `promptsPage.templates.<id>.*`; the template content stays in English
 * because it is written for the model, and the user edits it before saving.
 */
export interface PromptTemplate {
  id: string;
  input: PromptInput;
}

export const PROMPT_TEMPLATES: readonly PromptTemplate[] = [
  {
    id: 'reviewPr',
    input: {
      slug: 'review-pr',
      title: 'Pull request review',
      description: 'Structured code review with adjustable strictness.',
      content:
        'Review the following {{language}} changes with {{strictness}} ' +
        'strictness. Point out bugs first, style second, and end with a ' +
        'one-line verdict.',
      variables: [
        { name: 'language', type: 'text', label: 'Language', required: true },
        {
          name: 'strictness',
          type: 'select',
          label: 'Strictness',
          default: 'normal',
          options: ['low', 'normal', 'pedantic'],
        },
      ],
      tags: ['code', 'review'],
    },
  },
  {
    id: 'summarize',
    input: {
      slug: 'summarize',
      title: 'Summarize for an audience',
      description: 'Bullet-point summary tuned to a reader.',
      content:
        'Summarize the following in at most {{points}} bullet points for ' +
        '{{audience}}. Keep every bullet self-contained, lead with the most ' +
        'important point, and end with a one-sentence takeaway.',
      variables: [
        { name: 'points', type: 'number', label: 'Bullets', default: '5' },
        {
          name: 'audience',
          type: 'text',
          label: 'Audience',
          default: 'a technical reader',
        },
      ],
      tags: ['writing'],
    },
  },
  {
    id: 'translate',
    input: {
      slug: 'translate',
      title: 'Translate',
      description: 'Translation that preserves tone and formatting.',
      content:
        'Translate the following into {{target_language}}. Preserve tone, ' +
        'formatting, and markup exactly; keep code, identifiers, and proper ' +
        'names untranslated. If a phrase is ambiguous, pick the most natural ' +
        'reading and note the alternative in brackets.',
      variables: [
        {
          name: 'target_language',
          type: 'text',
          label: 'Target language',
          required: true,
        },
      ],
      tags: ['writing', 'translation'],
    },
  },
  {
    id: 'explainCode',
    input: {
      slug: 'explain-code',
      title: 'Explain code',
      description: 'Walkthrough plus edge cases and risks.',
      content:
        'Explain what the following {{language}} code does, step by step ' +
        'but briefly. Then list edge cases it mishandles, hidden ' +
        'assumptions, and the one change you would make first.',
      variables: [
        { name: 'language', type: 'text', label: 'Language', required: true },
      ],
      tags: ['code'],
    },
  },
];
