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

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * Team-collaboration schema: named calendars with shared scopes and
 * reminders, channel conversations (membership, messages, threads,
 * reactions, attachments), durable in-app notifications, and outbound
 * webhook targets.
 */
// CHECK expressions use the exact form PostgreSQL reconstructs in
// pg_get_constraintdef, so the schema inspector's declared and actual
// constraint texts normalize identically.
export const POSTGRES_TEAM_COLLABORATION_SQL = `ALTER TABLE calendar_events ADD COLUMN calendar_id text;
ALTER TABLE calendar_events ADD COLUMN reminder_minutes bigint;
ALTER TABLE calendar_events ADD COLUMN last_reminded_occurrence bigint;

CREATE INDEX idx_calendar_scoped_events
  ON calendar_events(calendar_id);

CREATE TABLE calendars (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_calendars_owner
  ON calendars(user_id, updated_at);

CREATE TABLE channels (
  id text PRIMARY KEY,
  type text NOT NULL CHECK (type IN ('public', 'private', 'dm')),
  name text NOT NULL,
  description text,
  dm_key text UNIQUE,
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  archived_at bigint
);

CREATE TABLE channel_members (
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  joined_at bigint NOT NULL,
  last_read_at bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX idx_channel_members_user
  ON channel_members(user_id);

CREATE TABLE channel_messages (
  id text PRIMARY KEY,
  channel_id text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id text,
  parent_id text,
  author_kind text NOT NULL DEFAULT 'user' CHECK (author_kind IN ('user', 'model')),
  model text,
  content text NOT NULL,
  metadata text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  edited_at bigint,
  deleted_at bigint,
  pinned_at bigint,
  pinned_by text
);

CREATE INDEX idx_channel_messages_timeline
  ON channel_messages(channel_id, created_at, id);

CREATE INDEX idx_channel_messages_thread
  ON channel_messages(parent_id);

CREATE TABLE channel_reactions (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL,
  created_at bigint NOT NULL,
  UNIQUE (message_id, user_id, emoji)
);

CREATE TABLE channel_attachments (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  blob_id text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size bigint NOT NULL,
  created_by text,
  created_at bigint NOT NULL
);

CREATE INDEX idx_channel_attachments_message
  ON channel_attachments(message_id);

CREATE TABLE notifications (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  href text,
  source_key text,
  created_at bigint NOT NULL,
  read_at bigint,
  UNIQUE (user_id, source_key)
);

CREATE INDEX idx_notifications_user
  ON notifications(user_id, created_at);

CREATE TABLE webhook_targets (
  id text PRIMARY KEY,
  name text NOT NULL,
  url text NOT NULL,
  secret text,
  events text NOT NULL,
  enabled bigint NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_by text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);`;

const version = 18;
const name = 'team-collaboration';

export const POSTGRES_TEAM_COLLABORATION_MIGRATION: PostgresMigration =
  Object.freeze({
    version,
    name,
    checksum: createHash('sha256')
      .update(`${version}\n${name}\n${POSTGRES_TEAM_COLLABORATION_SQL}`)
      .digest('hex'),
    sql: POSTGRES_TEAM_COLLABORATION_SQL,
    rollbackPlan:
      'DROP TABLE webhook_targets, notifications, channel_attachments, ' +
      'channel_reactions, channel_messages, channel_members, channels, ' +
      'calendars; ALTER TABLE calendar_events DROP COLUMN calendar_id, ' +
      'DROP COLUMN reminder_minutes, DROP COLUMN last_reminded_occurrence; ' +
      'delete ledger row 18. Calendars fall back to the single per-user ' +
      'calendar; channels and notifications stop existing.',
    minimumCompatibleVersion: 18,
  });
