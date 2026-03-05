-- Libre WebUI - PostgreSQL initial schema
-- This migration creates all tables, indexes, and seed data.

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  avatar TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  name TEXT NOT NULL,
  description TEXT,
  model TEXT NOT NULL,
  parameters TEXT NOT NULL,
  avatar TEXT,
  background TEXT,
  embedding_model TEXT,
  memory_settings TEXT,
  mutation_settings TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  persona_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp BIGINT NOT NULL,
  message_index INTEGER NOT NULL,
  model TEXT,
  images TEXT,
  statistics TEXT,
  artifacts TEXT,
  parent_id TEXT,
  branch_index INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  filename TEXT NOT NULL,
  title TEXT,
  content TEXT,
  metadata TEXT,
  uploaded_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS document_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  start_char INTEGER,
  end_char INTEGER,
  embedding TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, key)
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS plugin_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  plugin_id TEXT NOT NULL,
  api_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, plugin_id)
);

CREATE TABLE IF NOT EXISTS plugin_variables (
  id TEXT PRIMARY KEY,
  user_id TEXT DEFAULT 'default',
  plugin_id TEXT NOT NULL,
  variable_name TEXT NOT NULL,
  variable_value TEXT NOT NULL,
  is_encrypted INTEGER DEFAULT 0,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE(user_id, plugin_id, variable_name)
);

CREATE TABLE IF NOT EXISTS generated_images (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL DEFAULT 'default',
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  image_data TEXT NOT NULL,
  size TEXT,
  quality TEXT,
  created_at BIGINT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persona_memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding BYTEA,
  timestamp BIGINT NOT NULL,
  context TEXT,
  importance_score DOUBLE PRECISION DEFAULT 0.5,
  memory_type TEXT DEFAULT 'general',
  access_count INTEGER DEFAULT 0,
  last_accessed BIGINT,
  decay_factor DOUBLE PRECISION DEFAULT 1.0,
  consolidated_from TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS persona_states (
  persona_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  runtime_state TEXT NOT NULL,
  mutation_log TEXT NOT NULL,
  last_updated BIGINT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_timestamp ON session_messages(timestamp);
CREATE INDEX IF NOT EXISTS idx_session_messages_parent_id ON session_messages(parent_id);
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_uploaded_at ON documents(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_id ON document_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_document_chunks_index ON document_chunks(chunk_index);
CREATE INDEX IF NOT EXISTS idx_user_preferences_user_id ON user_preferences(user_id);
CREATE INDEX IF NOT EXISTS idx_user_preferences_key ON user_preferences(key);
CREATE INDEX IF NOT EXISTS idx_personas_user_id ON personas(user_id);
CREATE INDEX IF NOT EXISTS idx_personas_name ON personas(name);
CREATE INDEX IF NOT EXISTS idx_plugin_credentials_user_id ON plugin_credentials(user_id);
CREATE INDEX IF NOT EXISTS idx_plugin_credentials_plugin_id ON plugin_credentials(plugin_id);
CREATE INDEX IF NOT EXISTS idx_plugin_variables_user_id ON plugin_variables(user_id);
CREATE INDEX IF NOT EXISTS idx_plugin_variables_plugin_id ON plugin_variables(plugin_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON generated_images(created_at);
CREATE INDEX IF NOT EXISTS idx_persona_memories_user_persona ON persona_memories(user_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_persona_memories_timestamp ON persona_memories(timestamp);
CREATE INDEX IF NOT EXISTS idx_persona_memories_importance ON persona_memories(importance_score);
CREATE INDEX IF NOT EXISTS idx_persona_memories_type ON persona_memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_persona_memories_last_accessed ON persona_memories(last_accessed);
CREATE INDEX IF NOT EXISTS idx_persona_states_user ON persona_states(user_id);
CREATE INDEX IF NOT EXISTS idx_persona_states_updated ON persona_states(last_updated);

-- Seed system settings
INSERT INTO system_settings (key, value, updated_at)
VALUES ('allow_user_model_pull', 'true', EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (key) DO NOTHING;

-- Seed default user for single-user mode
INSERT INTO users (id, username, email, password_hash, role, created_at, updated_at)
VALUES ('default', 'admin', NULL, 'default', 'admin',
        EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
        EXTRACT(EPOCH FROM NOW())::BIGINT * 1000)
ON CONFLICT (id) DO NOTHING;
