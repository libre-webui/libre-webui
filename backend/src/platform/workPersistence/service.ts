/*
 * Libre WebUI
 * Copyright (C) 2025 Kroonen AI, Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import type { WorkPersistenceRepository } from './types.js';
import {
  getPostgresAdapterDatabase,
  getSQLiteAdapterDatabase,
} from '../../persistence/index.js';
import { PostgresWorkPersistence } from './postgresWorkPersistence.js';
import { SQLiteWorkPersistence } from './sqliteWorkPersistence.js';

let repository: WorkPersistenceRepository | undefined;

export const initializeWorkPersistence = (
  next: WorkPersistenceRepository
): WorkPersistenceRepository => {
  if (repository) throw new Error('Work persistence is already initialized.');
  repository = next;
  return next;
};

export const initializeSelectedWorkPersistence = (
  dialect: 'sqlite' | 'postgres'
): WorkPersistenceRepository =>
  initializeWorkPersistence(
    dialect === 'postgres'
      ? new PostgresWorkPersistence(getPostgresAdapterDatabase())
      : new SQLiteWorkPersistence(getSQLiteAdapterDatabase())
  );

export const getWorkPersistence = (): WorkPersistenceRepository => {
  if (!repository) throw new Error('Work persistence is not initialized.');
  return repository;
};

export const resetWorkPersistenceForTests = (): void => {
  repository = undefined;
};
