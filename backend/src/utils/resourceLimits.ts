/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

export const MAX_NOTES_PER_USER = 100;
export const MAX_NOTE_REVISIONS_PER_NOTE = 50;
export const MAX_NOTE_ATTACHMENTS_PER_NOTE = 10;
export const MAX_NOTE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_NOTE_ASSIST_INSTRUCTION_LENGTH = 4000;
export const MAX_NOTE_TITLE_LENGTH = 200;
export const MAX_NOTE_CONTENT_LENGTH = 200_000;
export const MAX_SESSION_FOLDERS_PER_USER = 100;
export const MAX_SESSION_FOLDER_NAME_LENGTH = 120;
export const MAX_CALENDAR_EVENTS_PER_USER = 2000;
export const MAX_CALENDAR_EVENT_TITLE_LENGTH = 200;
export const MAX_CALENDAR_EVENT_NOTES_LENGTH = 10_000;
export const MAX_AUTOMATIONS_PER_USER = 50;
export const MAX_AUTOMATION_NAME_LENGTH = 200;
export const MAX_AUTOMATION_INSTRUCTIONS_LENGTH = 20_000;
export const MAX_AUTOMATION_TRIGGERS = 5;
export const MAX_TOOL_SERVERS = 50;
export const MAX_TOOL_SERVER_NAME_LENGTH = 120;
export const MAX_TOOL_SERVER_DESCRIPTION_LENGTH = 2000;
export const MAX_TOOL_SERVER_SPEC_BYTES = 1_000_000;
export const MAX_TOOL_SERVER_TOOLS = 128;
export const MAX_TOOL_SERVER_SECRET_LENGTH = 4096;
export const MAX_PROMPTS_PER_USER = 200;
export const MAX_PROMPT_SLUG_LENGTH = 64;
export const MAX_PROMPT_TITLE_LENGTH = 200;
export const MAX_PROMPT_DESCRIPTION_LENGTH = 2000;
export const MAX_PROMPT_CONTENT_LENGTH = 50_000;
export const MAX_PROMPT_VARIABLES = 20;
export const MAX_PROMPT_TAGS = 20;
export const MAX_PROMPT_VERSIONS = 50;
export const MAX_SKILLS_PER_USER = 100;
export const MAX_SKILL_SLUG_LENGTH = 64;
export const MAX_SKILL_NAME_LENGTH = 200;
export const MAX_SKILL_DESCRIPTION_LENGTH = 1000;
export const MAX_SKILL_INSTRUCTIONS_LENGTH = 100_000;
export const MAX_SKILL_VERSIONS = 50;
export const MAX_SKILL_FILES = 32;
export const MAX_SKILL_FILE_PATH_LENGTH = 200;
export const MAX_SKILL_FILE_CONTENT_LENGTH = 200_000;
export const MAX_SKILL_FILES_TOTAL_BYTES = 1_000_000;

export class ResourcePolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409
  ) {
    super(message);
    this.name = 'ResourcePolicyError';
  }
}
