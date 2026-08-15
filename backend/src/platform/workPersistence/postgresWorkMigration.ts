/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import crypto from 'node:crypto';
import type { PostgresMigration } from '../../persistence/postgresMigrationTypes.js';

const version = 6;
const name = 'work-persistence';
const sql = `
CREATE TABLE IF NOT EXISTS work_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  image TEXT,
  memory_limit TEXT,
  cpu_limit TEXT,
  pids_limit INTEGER,
  network_default SMALLINT,
  workspace_size TEXT,
  idle_timeout_ms BIGINT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT work_policies_network_default_check
    CHECK (network_default IS NULL OR network_default IN (0, 1))
);

CREATE TABLE IF NOT EXISTS work_tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  model TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'ollama',
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'idle',
  network_enabled SMALLINT NOT NULL DEFAULT 1 CHECK (network_enabled IN (0, 1)),
  volume_name TEXT NOT NULL UNIQUE,
  container_name TEXT NOT NULL UNIQUE,
  host_path TEXT,
  policy_id TEXT REFERENCES work_policies(id) ON DELETE SET NULL,
  preview_url TEXT,
  preview_status TEXT NOT NULL DEFAULT 'stopped',
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  CONSTRAINT work_tasks_status_check CHECK (
    status IN ('idle', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'needs_input')
  ),
  CONSTRAINT work_tasks_preview_status_check CHECK (
    preview_status IN ('stopped', 'starting', 'running', 'failed')
  )
);

CREATE TABLE IF NOT EXISTS work_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  model TEXT NOT NULL,
  provider_type TEXT NOT NULL DEFAULT 'ollama',
  provider_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT,
  CONSTRAINT work_runs_status_check CHECK (
    status IN ('queued', 'preparing', 'running', 'completed', 'failed', 'cancelled', 'needs_input')
  )
);

CREATE TABLE IF NOT EXISTS work_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES work_tasks(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES work_runs(id) ON DELETE SET NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  metadata TEXT,
  message_index INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (task_id, message_index)
);

CREATE INDEX IF NOT EXISTS idx_work_tasks_user_updated
  ON work_tasks(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_work_runs_task_created
  ON work_runs(task_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_runs_one_active
  ON work_runs(task_id)
  WHERE status IN ('queued', 'preparing', 'running');
CREATE INDEX IF NOT EXISTS idx_work_messages_task_index
  ON work_messages(task_id, message_index);
`;

export const POSTGRES_WORK_PERSISTENCE_MIGRATION: PostgresMigration = {
  version,
  name,
  checksum: crypto
    .createHash('sha256')
    .update(`${version}\n${name}\n${sql}`)
    .digest('hex'),
  sql,
  rollbackPlan:
    'Application rollback keeps Work tables additive. Restore a verified backup before destructive removal after all supported binaries stop reading them.',
  minimumCompatibleVersion: 6,
};
