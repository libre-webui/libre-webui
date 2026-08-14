/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { createHash } from 'node:crypto';
import type { PostgresMigration } from './postgresMigrationTypes.js';

/**
 * PostgreSQL schema for the domains that have crossed the repository boundary:
 * identity, chats/messages, notes, folders, collections, and preferences.
 */
export const POSTGRES_CORE_PERSISTENCE_SQL = `
CREATE TABLE users (
  id text PRIMARY KEY,
  username text NOT NULL UNIQUE,
  email text UNIQUE,
  email_lookup text UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  account_status text NOT NULL DEFAULT 'active'
    CHECK (account_status IN ('pending', 'active')),
  approved_at bigint,
  approved_by text,
  avatar text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE personas (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  model text NOT NULL,
  parameters text NOT NULL,
  avatar text,
  background text,
  embedding_model text,
  memory_settings text,
  mutation_settings text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE session_folders (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE knowledge_collections (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE sessions (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  model text NOT NULL,
  persona_id text REFERENCES personas(id) ON DELETE SET NULL,
  provider_type text,
  provider_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  archived smallint NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  settings text,
  folder_id text REFERENCES session_folders(id) ON DELETE SET NULL,
  pinned smallint NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1))
);

CREATE TABLE session_messages (
  id text PRIMARY KEY,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role text NOT NULL,
  content text NOT NULL,
  thinking text,
  timestamp bigint NOT NULL,
  message_index integer NOT NULL,
  model text,
  provider_metadata text,
  images text,
  statistics text,
  artifacts text,
  parent_id text REFERENCES session_messages(id) ON DELETE SET NULL,
  branch_index integer NOT NULL DEFAULT 0,
  is_active smallint NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  rating integer
);

CREATE TABLE notes (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  content text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE documents (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  filename text NOT NULL,
  title text,
  content text,
  file_type text,
  size bigint,
  session_id text REFERENCES sessions(id) ON DELETE SET NULL,
  collection_id text REFERENCES knowledge_collections(id) ON DELETE SET NULL,
  metadata text,
  uploaded_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE document_chunks (
  id text PRIMARY KEY,
  document_id text NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  start_char integer,
  end_char integer,
  embedding text,
  created_at bigint NOT NULL,
  UNIQUE (document_id, chunk_index)
);

CREATE TABLE user_preferences (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  UNIQUE (user_id, key)
);

CREATE TABLE system_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at bigint NOT NULL
);

CREATE INDEX idx_personas_user_id ON personas(user_id);
CREATE INDEX idx_sessions_user_updated ON sessions(user_id, updated_at DESC);
CREATE INDEX idx_sessions_folder ON sessions(user_id, folder_id);
CREATE INDEX idx_session_messages_order
  ON session_messages(session_id, message_index, branch_index);
CREATE INDEX idx_session_messages_parent ON session_messages(parent_id);
CREATE INDEX idx_notes_user_updated ON notes(user_id, updated_at DESC);
CREATE INDEX idx_session_folders_user_name
  ON session_folders(user_id, lower(name));
CREATE INDEX idx_knowledge_collections_user_name
  ON knowledge_collections(user_id, lower(name));
CREATE INDEX idx_documents_user_updated ON documents(user_id, updated_at DESC);
CREATE INDEX idx_documents_collection
  ON documents(user_id, collection_id);
CREATE INDEX idx_document_chunks_document
  ON document_chunks(document_id, chunk_index);
CREATE INDEX idx_user_preferences_user_key
  ON user_preferences(user_id, key);
`;

const version = 1;
const name = 'core-persistence';

export const POSTGRES_CORE_MIGRATION: PostgresMigration = Object.freeze({
  version,
  name,
  checksum: createHash('sha256')
    .update(`${version}\n${name}\n${POSTGRES_CORE_PERSISTENCE_SQL}`)
    .digest('hex'),
  sql: POSTGRES_CORE_PERSISTENCE_SQL,
  rollbackPlan:
    'Stop Libre, export and verify the PostgreSQL database, then downgrade the application before dropping only empty core tables in reverse foreign-key order. In-place destructive rollback is unsupported.',
  minimumCompatibleVersion: 1,
});
