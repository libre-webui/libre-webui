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

export class ResourcePolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409
  ) {
    super(message);
    this.name = 'ResourcePolicyError';
  }
}
