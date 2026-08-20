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

import type { SkillInput } from '@/utils/api/skillsApi';

/**
 * Starter skills. Card names and descriptions localize through
 * `skillsPage.templates.<id>.*`; the skill fields themselves stay in English
 * because the model reads them, and the user edits before saving.
 */
export interface SkillTemplate {
  id: string;
  input: SkillInput;
}

export const SKILL_TEMPLATES: readonly SkillTemplate[] = [
  {
    id: 'citeSources',
    input: {
      slug: 'cite-sources',
      name: 'Cite sources',
      description:
        'How to cite evidence: numbered references with URLs, no ' +
        'unreferenced claims.',
      instructions:
        '# Citing sources\n\n' +
        '- Every factual claim gets a numbered reference like [1].\n' +
        '- End with a References section: number, title, URL.\n' +
        '- If no source exists, say so instead of inventing one.\n',
    },
  },
  {
    id: 'releaseNotes',
    input: {
      slug: 'release-notes',
      name: 'Release notes style',
      description:
        'How release notes are written: grouped, user-facing, no internal ' +
        'ticket ids.',
      instructions:
        '# Release notes style\n\n' +
        '- Group entries under Added, Changed, and Fixed.\n' +
        '- Write for the user: what they can do now, not how it was built.\n' +
        '- One line per entry, plain language, no internal ticket ids.\n' +
        '- Call out breaking changes first, with the migration step.\n',
    },
  },
  {
    id: 'meetingNotes',
    input: {
      slug: 'meeting-notes',
      name: 'Meeting notes format',
      description:
        'How to turn a transcript into decisions, actions, and open ' +
        'questions.',
      instructions:
        '# Meeting notes format\n\n' +
        '- Start with a two-sentence summary of the meeting.\n' +
        '- Then three sections: Decisions, Action items (owner + due date ' +
        'if stated), Open questions.\n' +
        '- Keep attribution: who decided or committed to what.\n' +
        '- Drop small talk entirely; never invent owners or dates.\n',
    },
  },
];
