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
export const MAX_PROMPT_QUEUE_ENTRIES = 20;
export const MAX_PROMPT_QUEUE_CONTENT_LENGTH = 8000;
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
export const MAX_CHANNELS_PER_USER = 50;
export const MAX_CHANNELS_LISTED = 200;
export const MAX_CHANNEL_NAME_LENGTH = 80;
export const MAX_CHANNEL_DESCRIPTION_LENGTH = 500;
export const MAX_CHANNEL_MEMBERS = 200;
export const MAX_CHANNEL_MESSAGES = 50_000;
export const MAX_CHANNEL_MESSAGE_LENGTH = 8_000;
export const MAX_CHANNEL_REACTIONS_PER_MESSAGE = 200;
export const MAX_CHANNEL_EMOJI_LENGTH = 16;
export const MAX_CHANNEL_PAGE_SIZE = 100;
export const MAX_CHANNEL_THREAD_PAGE_SIZE = 200;
export const MAX_CHANNEL_PINNED_LISTED = 100;
export const MAX_CHANNEL_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_CHANNEL_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHANNEL_MENTION_CONTEXT_MESSAGES = 30;
export const MAX_NOTIFICATIONS_PER_USER = 500;
export const MAX_NOTIFICATION_TITLE_LENGTH = 200;
export const MAX_NOTIFICATION_BODY_LENGTH = 1_000;
export const MAX_NOTIFICATION_PAGE_SIZE = 100;
export const MAX_WEBHOOK_TARGETS = 20;
export const MAX_WEBHOOK_NAME_LENGTH = 120;
export const MAX_WEBHOOK_URL_LENGTH = 2_000;
export const MAX_WEBHOOK_SECRET_LENGTH = 256;
export const MAX_CALENDARS_PER_USER = 20;
export const MAX_CALENDAR_NAME_LENGTH = 80;
export const MAX_CALENDAR_COLOR_LENGTH = 24;
export const MAX_CALENDAR_REMINDER_MINUTES = 60 * 24 * 14;
export const MAX_ICS_IMPORT_BYTES = 2_000_000;
export const MAX_ICS_IMPORT_EVENTS = 1_000;

export class ResourcePolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409
  ) {
    super(message);
    this.name = 'ResourcePolicyError';
  }
}
